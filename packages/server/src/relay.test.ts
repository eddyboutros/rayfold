import { describe, expect, it } from "vitest";
import type { RayfoldContext } from "./context.ts";
import { ok } from "./executor.ts";
import type { Frame, RequestEnvelope } from "./protocol.ts";
import { MemoryRelay, type Relay } from "./relay.ts";
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
    const refused: unknown[] = [];
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
    await bounded(
      new Promise<void>((resolve) => {
        const tick = () => (refused.length >= 2 ? resolve() : setTimeout(tick, 0));
        tick();
      }),
      "both refusals being reported",
    );
    expect(refused.map((e) => (e as Error).message)).toEqual(["the relay is down", "the relay is down"]);
    expect((a.server.relayFailure as Error).message).toBe("the relay is down");
  });

  it("ready() waits until the server hears the others, and rejects with what stopped it", async () => {
    let listening = () => {};
    const slow: Relay = {
      publish: async () => {},
      subscribe: () => new Promise((resolve) => (listening = () => resolve(async () => {}))),
    };
    const a = instance(shelf(), { relay: slow });
    let ready = false;
    const waiting = a.server.ready().then(() => (ready = true));
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
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
