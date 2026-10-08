import { describe, expect, it } from "vitest";
import type { RayfoldContext } from "./context.ts";
import { ok } from "./executor.ts";
import type { Frame, RequestEnvelope } from "./protocol.ts";
import { MemoryRelay, type Relay, type RelayMessage } from "./relay.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
import { bounded, Signal } from "../../../e2e/wait.ts";

/**
 * Two servers behind one load balancer share a database and nothing else. A command run on one must reach a live
 * query or a stream open on the other, and neither server may hear its own change a second time.
 */
const SCHEMA = `
  entity Book { id: ID title: String stock: Int }
  event StockChanged { bookId: ID, stock: Int }
  query book(id: ID): Book?
  command restock(id: ID, qty: Int): Book emits StockChanged
  stream stockUpdates(bookIds: [ID]): StockChanged
`;
const KEY = "0123456789abcdef";
const viewer = { id: "u1" };

interface Instance {
  server: RayfoldServer;
  /** How many times this server ran the `book` query: a live query re-running is one call. */
  reads: () => number;
}

/** A server over the shared `books`, as one instance behind the balancer. */
function instance(books: Map<string, { id: string; title: string; stock: number }>, opts: { relay?: Relay; onRelayError?: (e: unknown) => void } = {}): Instance {
  let reads = 0;
  const server = createRayfoldServer({
    schema: SCHEMA,
    ...opts,
    resolvers: {
      Query: {
        book: ({ id }: { id: string }) => {
          reads++;
          return books.get(id) ?? null;
        },
      },
      Command: {
        restock: ({ id, qty }: { id: string; qty: number }) => {
          const book = books.get(id);
          if (!book) throw new Error(`no book ${id}`);
          book.stock += qty;
          return ok({ ...book }, { emit: [{ event: "StockChanged", payload: { bookId: book.id, stock: book.stock } }] });
        },
      },
      Stream: {
        stockUpdates: (args: { bookIds: string[] }, ctx: RayfoldContext) => {
          const wanted = new Set(args.bookIds);
          const source = ctx.events.subscribe<{ bookId: string; stock: number }>("StockChanged", ctx.signal);
          return (async function* () {
            for await (const ev of source) if (wanted.has(ev.bookId)) yield ev;
          })();
        },
      },
    },
  });
  return { server, reads: () => reads };
}

const shelf = () => new Map([["b1", { id: "b1", title: "Dune", stock: 3 }]]);

/** Opens an op that stays open (a live query or a stream) and records its frames until `stop()`. */
function open(server: RayfoldServer, op: Omit<RequestEnvelope["ops"][number], "id">): { frames: Signal<Frame>; stop: () => Promise<void> } {
  const ac = new AbortController();
  const frames = new Signal<Frame>();
  const ended = (async () => {
    for await (const f of server.execute({ ops: [{ id: 1, ...op }] }, { viewer, signal: ac.signal })) frames.push(f);
  })();
  return {
    frames,
    stop: async () => {
      ac.abort();
      await bounded(ended, "the open op ending on abort");
    },
  };
}

const live = (server: RayfoldServer) => open(server, { op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true });
const restock = (server: RayfoldServer, key: string, qty = 1) => server.collect({ ops: [{ id: 1, op: "restock", args: { id: "b1", qty }, key }] }, { viewer });

describe("changes and events cross a relay between servers", () => {
  it("a command run on one server updates a live query open on another, and each server hears each change exactly once", async () => {
    const books = shelf();
    const relay = new MemoryRelay();
    const a = instance(books, { relay: relay.join() });
    const b = instance(books, { relay: relay.join() });
    await Promise.all([a.server.ready(), b.server.ready()]);
    const onA = live(a.server);
    const onB = live(b.server);
    await onA.frames.atLeast(1, "a's live query answering");
    await onB.frames.atLeast(1, "b's live query answering");
    expect(onB.frames.items[0]).toMatchObject({ id: 1, data: { id: "b1", stock: 3 } });

    await restock(a.server, KEY + "1");
    await onB.frames.atLeast(2, "b hearing a's change over the relay");
    // the shape names `id`, so the result is an entity and the patch is keyed to it: every cached view of Book:b1 applies it
    expect(onB.frames.items[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 4 } }] });

    // a second change is the barrier: once both servers have delivered it, every earlier delivery has happened too
    await restock(b.server, KEY + "2");
    await onA.frames.atLeast(3, "a hearing b's change over the relay");
    await onB.frames.atLeast(3, "b hearing its own change");
    expect(onA.frames.items.slice(1)).toEqual([{ id: 1, patch: [{ set: "Book:b1", value: { stock: 4 } }] }, { id: 1, patch: [{ set: "Book:b1", value: { stock: 5 } }] }]);
    // one read to answer, one per change: a relay that echoed a server's own change back would make it read again
    expect(a.reads()).toBe(3);
    expect(b.reads()).toBe(3);
    await Promise.all([onA.stop(), onB.stop()]);
  });

  it("an event raised on one server reaches a stream open on another", async () => {
    const books = shelf();
    const relay = new MemoryRelay();
    const a = instance(books, { relay: relay.join() });
    const b = instance(books, { relay: relay.join() });
    await b.server.ready();
    // the stream subscribes as it starts; watch for that before opening it, so the command comes after
    const subscribed = new Signal<string>();
    const on = b.server.events.on.bind(b.server.events);
    b.server.events.on = (name, fn) => {
      subscribed.push(name);
      return on(name, fn);
    };
    const stream = open(b.server, { op: "stockUpdates", args: { bookIds: ["b1"] } });
    await subscribed.until((names) => names.includes("StockChanged"), "the stream subscribing");

    await restock(a.server, KEY + "1", 2);
    await stream.frames.atLeast(1, "b's stream delivering a's event");
    expect(stream.frames.items[0]).toEqual({ id: 1, item: { bookId: "b1", stock: 5 } });
    await stream.stop();
  });

  it("guard: without a relay, a server hears only itself", async () => {
    const books = shelf();
    const a = instance(books);
    const b = instance(books);
    const onB = live(b.server);
    await onB.frames.atLeast(1, "b's live query answering");

    await restock(a.server, KEY + "1"); // stock 4, and b has no way to know
    await restock(b.server, KEY + "2"); // stock 5: the barrier, and the first change b can hear
    await onB.frames.atLeast(2, "b hearing its own change");
    expect(onB.frames.items.slice(1)).toEqual([{ id: 1, patch: [{ set: "Book:b1", value: { stock: 5 } }] }]); // straight from 3 to 5
    expect(b.reads()).toBe(2);
    await onB.stop();
  });

  it("a relay that refuses a message reports it, and the command that made the change still succeeds", async () => {
    const refused = new Signal<unknown>();
    const down: Relay = {
      publish: async () => {
        throw new Error("the relay is down");
      },
      subscribe: async () => async () => {},
    };
    const a = instance(shelf(), { relay: down, onRelayError: (e) => refused.push(e) });
    const [frame] = await restock(a.server, KEY + "1");
    expect(frame).toMatchObject({ ok: { id: "b1", stock: 4 } });

    // the change and the event were both refused: two messages, two reports
    await refused.atLeast(2, "both refusals being reported");
    expect(refused.items.map((e) => (e as Error).message)).toEqual(["the relay is down", "the relay is down"]);
    expect((a.server.relayFailure as Error).message).toBe("the relay is down");
  });

  it("ready() waits until the server hears the others, and rejects with what stopped it", async () => {
    let listening = () => {};
    const asked = new Signal<true>();
    const slow: Relay = {
      publish: async () => {},
      subscribe: () =>
        new Promise((resolve) => {
          listening = () => resolve(async () => {});
          asked.push(true);
        }),
    };
    const a = instance(shelf(), { relay: slow });
    let ready = false;
    const waiting = a.server.ready().then(() => (ready = true));
    await asked.atLeast(1, "the server asking the relay to listen");
    expect(ready).toBe(false);
    listening();
    await bounded(waiting, "ready() resolving once the relay listens");
    expect(ready).toBe(true);

    const refused: unknown[] = [];
    const broken: Relay = {
      publish: async () => {},
      subscribe: async () => {
        throw new Error("LISTEN failed");
      },
    };
    const b = instance(shelf(), { relay: broken, onRelayError: (e) => refused.push(e) });
    await expect(b.server.ready()).rejects.toThrow("LISTEN failed");
    expect((b.server.relayFailure as Error).message).toBe("LISTEN failed");
    expect(refused).toHaveLength(1);
  });

  it("close() stops hearing the other servers; until then they are heard", async () => {
    const books = shelf();
    const relay = new MemoryRelay();
    const a = instance(books, { relay: relay.join() });
    const b = instance(books, { relay: relay.join() });
    await Promise.all([a.server.ready(), b.server.ready()]);
    expect(relay.size).toBe(2);
    const onB = live(b.server);
    await onB.frames.atLeast(1, "b's live query answering");

    await restock(a.server, KEY + "1"); // heard: stock 4
    await onB.frames.atLeast(2, "b hearing a's change before close");
    await b.server.close();
    expect(relay.size).toBe(1);

    await restock(a.server, KEY + "2"); // stock 5, no longer heard
    await restock(b.server, KEY + "3"); // stock 6: the barrier
    await onB.frames.atLeast(3, "b hearing its own change");
    expect(onB.frames.items.slice(1)).toEqual([{ id: 1, patch: [{ set: "Book:b1", value: { stock: 4 } }] }, { id: 1, patch: [{ set: "Book:b1", value: { stock: 6 } }] }]);
    await onB.stop();
  });
});

describe("what a relay carries, and losing it", () => {
  it("a change naming an operation reaches a live query on another server by that name", async () => {
    const relay = new MemoryRelay();
    const books = shelf();
    const a = instance(books, { relay: relay.join() });
    const b = instance(books, { relay: relay.join() });
    await Promise.all([a.server.ready(), b.server.ready()]);
    const watching = live(b.server);
    await watching.frames.atLeast(1, "the live query on b answering");
    books.get("b1")!.stock = 9; // changed behind the runtime's back, as a migration or another process would
    a.server.changes.publish({ keys: new Set(), ops: new Set(["book"]) });
    await watching.frames.atLeast(2, "b re-running on the operation a named");
    expect(watching.frames.items[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 9 } }] });
    await watching.stop();
    await Promise.all([a.server.close(), b.server.close()]);
  });

  it("a relay that stops listening after it started makes the server not ready, and says why", async () => {
    let lose: (e: unknown) => void = () => {};
    const relay: Relay = {
      publish: async () => {},
      subscribe: async (_onMessage, onLost) => {
        lose = (e) => onLost?.(e);
        return async () => {};
      },
    };
    const failures: unknown[] = [];
    const { server } = instance(shelf(), { relay, onRelayError: (e) => failures.push(e) });
    await server.ready();
    expect(server.readiness()).toEqual({ ready: true, reasons: [] });
    const dropped = new Error("connection dropped");
    lose(dropped);
    expect(server.readiness()).toEqual({ ready: false, reasons: ["relay: connection dropped"] });
    expect(failures).toEqual([dropped]);
    expect(server.relayFailure).toBe(dropped);
  });
});

describe("a relay end", () => {
  /** Opens a stream on `server` and waits until it has subscribed, so an event sent after this reaches it. */
  async function subscribedStream(server: RayfoldServer) {
    const subscribed = new Signal<string>();
    const on = server.events.on.bind(server.events);
    server.events.on = (name, fn) => {
      subscribed.push(name);
      return on(name, fn);
    };
    const stream = open(server, { op: "stockUpdates", args: { bookIds: ["b1"] } });
    await subscribed.until((names) => names.includes("StockChanged"), "the stream subscribing");
    return stream;
  }

  it("never hands a server back an event it raised itself", async () => {
    const relay = new MemoryRelay();
    const books = shelf();
    const a = instance(books, { relay: relay.join() });
    const b = instance(books, { relay: relay.join() });
    await Promise.all([a.server.ready(), b.server.ready()]);
    const onA = await subscribedStream(a.server);
    await restock(a.server, KEY + "1");
    await restock(b.server, KEY + "2"); // the barrier: once a has heard this, anything a echoed to itself is in too
    await onA.frames.atLeast(2, "a hearing its own event and then b's");
    expect(onA.frames.items).toEqual([{ id: 1, item: { bookId: "b1", stock: 4 } }, { id: 1, item: { bookId: "b1", stock: 5 } }]);
    await Promise.all([onA.stop(), a.server.close(), b.server.close()]);
  });

  it("subscribed twice is one listener, the later one", async () => {
    const relay = new MemoryRelay();
    const end = relay.join();
    const heard: string[] = [];
    await end.subscribe(() => heard.push("first"));
    await end.subscribe(() => heard.push("second"));
    expect(relay.size).toBe(1);
    await relay.join().publish({ kind: "change", keys: ["Book:b1"], ops: [] });
    expect(heard).toEqual(["second"]);
  });
});

describe("what goes over the relay", () => {
  it("a change that names nothing is not sent at all", async () => {
    const sent: unknown[] = [];
    const relay: Relay = { publish: async (m) => void sent.push(m), subscribe: async () => async () => {} };
    const { server } = instance(shelf(), { relay });
    await server.ready();
    server.changes.publish({ keys: new Set(), ops: new Set() });
    server.changes.publish({ keys: new Set(["Book:b1"]), ops: new Set() }); // guard
    expect(sent).toEqual([{ kind: "change", keys: ["Book:b1"], ops: [] }]);
  });

  it("each receiver gets its own copy, so a sender editing its message afterwards changes nothing it already sent", async () => {
    const relay = new MemoryRelay();
    const got: RelayMessage[] = [];
    await relay.join().subscribe((m) => got.push(m));
    const message: RelayMessage = { kind: "change", keys: ["Book:b1"], ops: [] };
    await relay.join().publish(message);
    message.keys.push("Book:b2");
    expect(got).toEqual([{ kind: "change", keys: ["Book:b1"], ops: [] }]);
  });
});
