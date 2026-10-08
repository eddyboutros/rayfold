import { afterEach, describe, expect, it, vi } from "vitest";
import { createRayfoldServer, ok, type RayfoldContext } from "@rayfold/server";
import { RayfoldClient, RayfoldClientError } from "./client.ts";
import { collect, type Collected } from "./testing.ts";
import { createLocalTransport } from "./transport.ts";

const SCHEMA = `
entity Book { id: ID  title: String  stock: Int }
event StockChanged { bookId: ID, stock: Int }
query book(id: ID): Book?
command restock(id: ID, qty: Int): Book emits StockChanged
stream stockChanges(bookId: ID): StockChanged
stream countdown(from: Int): StockChanged
stream staffOnly: StockChanged @allow(read: viewer.role == "staff")
`;

interface Book { id: string; title: string; stock: number }
interface Change { bookId: string; stock: number }

/** A server in this process, what it counted as it went, and what its stream resolver did, each as it happened. */
function start() {
  const books = new Map<string, Book>([["b1", { id: "b1", title: "Dune", stock: 3 }]]);
  let count: (name: string) => void = () => {};
  const counted = collect<string>((next) => ((count = next), () => {}));
  let mark: (what: string) => void = () => {};
  const stream = collect<string>((next) => ((mark = next), () => {}));
  const server = createRayfoldServer({
    schema: SCHEMA,
    counters: { add: (name) => count(name) },
    resolvers: {
      Query: { book: ({ id }: { id: string }) => books.get(id) ?? null },
      Command: {
        restock: ({ id, qty }: { id: string; qty: number }) => {
          const book = books.get(id)!;
          book.stock += qty;
          return ok(book, { emit: [{ event: "StockChanged", payload: { bookId: id, stock: book.stock } }] });
        },
      },
      Stream: {
        stockChanges: ({ bookId }: { bookId: string }, ctx: RayfoldContext) =>
          (async function* () {
            // listening before the first item is out, so whoever has read that item can rely on the rest arriving
            const changes = ctx.events.subscribe<Change>("StockChanged", ctx.signal)[Symbol.asyncIterator]();
            try {
              yield { bookId, stock: books.get(bookId)!.stock };
              for (let r = await changes.next(); !r.done; r = await changes.next()) yield { bookId: r.value.bookId, stock: r.value.stock };
            } finally {
              mark("ended");
            }
          })(),
        countdown: ({ from }: { from: number }) =>
          (async function* () {
            for (let n = from; n > 0; n--) yield { bookId: "b1", stock: n };
          })(),
        staffOnly: () => (async function* () {})(),
      },
    } as never,
  });
  const as = (id: string) => new RayfoldClient({ transport: createLocalTransport(server, () => ({ id, role: "customer" })) });
  return { server, books, counted, stream, reader: as("u1"), writer: as("u2") };
}

/** Reads on, bounded by `next`, until `wanted` is what was reported. */
async function reach(from: Collected<string>, wanted: string): Promise<void> {
  while ((await from.next(wanted)) !== wanted);
}

/** Whether `p` has settled once everything already queued has run, without waiting for it. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return done;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("collect, on the client's own subscriptions", () => {
  it("watch: hands out the first result, then what a command changed, and keeps both", async () => {
    const { reader } = start();
    const stock = collect<Book>((next, fail) => reader.watch("book", { id: "b1" }, { shape: "{ id stock }" }, next, fail));
    expect(await stock.next("the watched book")).toEqual({ $type: "Book", id: "b1", stock: 3 });
    await reader.command("restock", { id: "b1", qty: 2 });
    expect(await stock.next("the restock")).toEqual({ $type: "Book", id: "b1", stock: 5 });
    stock.stop();
    expect(stock.values).toEqual([{ $type: "Book", id: "b1", stock: 3 }, { $type: "Book", id: "b1", stock: 5 }]);
  });

  it("watch: a query the server refuses rejects next() with the server's error", async () => {
    const { reader } = start();
    const stock = collect<Book>((next, fail) => reader.watch("book", { id: "b1" }, { shape: "{ id nope }" }, next, fail));
    const error = await stock.next("the refusal").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RayfoldClientError);
    expect((error as RayfoldClientError).code).toBe("invalid_argument");
    expect(stock.values).toEqual([]);
    stock.stop();
  });

  it("live: hears another client's command, and stop() ends the subscription on the server", async () => {
    const { server, reader, writer, counted } = start();
    const stock = collect<Book>((next, fail) => reader.live("book", { id: "b1" }, { shape: "{ id stock }" }, next, fail));
    expect(await stock.next("the stock when the query opened")).toEqual({ $type: "Book", id: "b1", stock: 3 });
    await writer.command("restock", { id: "b1", qty: 4 });
    expect(await stock.next("the restock")).toEqual({ $type: "Book", id: "b1", stock: 7 });
    expect(server.changes.size).toBe(1);

    stock.stop();
    await reach(counted, "rayfold.live.closed");
    expect(server.changes.size).toBe(0);
    await writer.command("restock", { id: "b1", qty: 1 });
    expect(stock.values.map((b) => b.stock)).toEqual([3, 7]);
  });

  it("stream: hands out items as they come, and stop() aborts the signal, which ends the stream on the server", async () => {
    const { reader, writer, stream } = start();
    const changes = collect<Change>((_next, _fail, signal) => reader.stream("stockChanges", { bookId: "b1" }, { signal }));
    expect(await changes.next("the opening item")).toEqual({ bookId: "b1", stock: 3 });
    await writer.command("restock", { id: "b1", qty: 2 });
    expect(await changes.next("the restock")).toEqual({ bookId: "b1", stock: 5 });

    changes.stop();
    expect(await stream.next("the resolver ending")).toBe("ended");
    expect(changes.values.map((c) => c.stock)).toEqual([3, 5]);
  });

  it("stream: once it has ended, next() fails at once and says what was seen; the items before the end are handed out", async () => {
    const { reader } = start();
    const ticks = collect<Change>((_next, _fail, signal) => reader.stream("countdown", { from: 2 }, { signal }));
    expect([(await ticks.next("the first")).stock, (await ticks.next("the second")).stock]).toEqual([2, 1]);
    await expect(ticks.next("a third")).rejects.toThrow('the stream ended before a third: saw [{"bookId":"b1","stock":2},{"bookId":"b1","stock":1}]');
    // stopping what has already ended changes nothing: it is still the end that next() reports
    ticks.stop();
    await expect(ticks.next("a third")).rejects.toThrow("the stream ended before a third");
  });

  it("stream: one the server refuses rejects next() with the server's error, then says the stream failed", async () => {
    const { reader } = start();
    const refused = collect<Change>((_next, _fail, signal) => reader.stream("staffOnly", {}, { signal }));
    await expect(refused.next("an item")).rejects.toMatchObject({ name: "RayfoldClientError", code: "permission_denied" });
    await expect(refused.next("an item")).rejects.toThrow("the stream failed before an item: saw nothing");
  });
});

describe("collect, waiting", () => {
  it("fails after 4 s by default, and after the bound it is given, naming what it waited for and what it saw", async () => {
    vi.useFakeTimers();
    let report: (n: number) => void = () => {};
    const numbers = collect<number>((next) => ((report = next), () => {}));
    report(1);
    expect(await numbers.next()).toBe(1);

    const byDefault = numbers.next("the second number");
    vi.advanceTimersByTime(3999);
    expect(await settled(byDefault)).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(byDefault).rejects.toThrow("no value within 4000 ms: the second number: saw [1]");

    const sooner = numbers.next("the second number", 200);
    vi.advanceTimersByTime(199);
    expect(await settled(sooner)).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(sooner).rejects.toThrow("no value within 200 ms: the second number: saw [1]");

    // guard: a wait that gave up is out of the way, so the value that comes later goes to the next call
    report(2);
    expect(await numbers.next()).toBe(2);
  });

  it("guard: a value that comes before the bound is handed out, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    let report: (n: number) => void = () => {};
    const numbers = collect<number>((next) => ((report = next), () => {}));
    const first = numbers.next("the first number");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3999);
    report(7);
    expect(await first).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands out values in the order they were reported, to the calls in the order they were made", async () => {
    let report: (n: number) => void = () => {};
    const numbers = collect<number>((next) => {
      report = next;
      next(1); // reported while subscribing, as a watch does for a result it already holds
      return () => {};
    });
    report(2);
    const waiting = [numbers.next(), numbers.next(), numbers.next(), numbers.next()];
    report(3);
    report(4);
    expect(await Promise.all(waiting)).toEqual([1, 2, 3, 4]);
    expect(numbers.values).toEqual([1, 2, 3, 4]);
  });

  it("a failure is handed out in its place among the values, and what follows it still arrives", async () => {
    let report: (n: number) => void = () => {};
    let refuse: (e: unknown) => void = () => {};
    const numbers = collect<number>((next, fail) => ((report = next), (refuse = fail), () => {}));
    report(1);
    refuse(new Error("connection lost"));
    report(2);
    expect(await numbers.next()).toBe(1);
    await expect(numbers.next()).rejects.toThrow("connection lost");
    expect(await numbers.next()).toBe(2);
    expect(numbers.values).toEqual([1, 2]);
  });

  it("stop() ends the subscription once, fails whoever is waiting, and keeps nothing reported after it", async () => {
    vi.useFakeTimers();
    let report: (n: number) => void = () => {};
    const end = vi.fn();
    let aborted: AbortSignal | undefined;
    const numbers = collect<number>((next, _fail, signal) => ((report = next), (aborted = signal), end));
    report(1);
    expect(await numbers.next()).toBe(1);
    // guard: nothing is ended before stop() says so
    expect([end.mock.calls.length, aborted?.aborted]).toEqual([0, false]);

    const waiting = numbers.next("the second number");
    numbers.stop();
    await expect(waiting).rejects.toThrow("stopped before the second number: saw [1]");
    expect(vi.getTimerCount()).toBe(0); // the failed wait's bound went with it
    expect([end.mock.calls.length, aborted?.aborted]).toEqual([1, true]);
    report(2);
    expect(numbers.values).toEqual([1]);
    await expect(numbers.next("the second number")).rejects.toThrow("stopped before the second number: saw [1]");
  });

  it("values reported before stop() and not yet asked for are still handed out, and only then does next() fail", async () => {
    let report: (n: number) => void = () => {};
    const numbers = collect<number>((next) => ((report = next), () => {}));
    report(1);
    report(2);
    numbers.stop();
    expect([await numbers.next(), await numbers.next()]).toEqual([1, 2]);
    await expect(numbers.next("a third number")).rejects.toThrow("stopped before a third number: saw [1,2]");
  });
});
