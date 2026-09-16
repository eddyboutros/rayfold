import { PGlite } from "@electric-sql/pglite";
import { createRayfoldServer, ok, type RayfoldContext, type RayfoldServer, type RelayMessage, type RequestEnvelope } from "@rayfold/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgRelay, pgliteNotifications, type Notifications, type Queryable } from "./index.ts";
import { bounded, Signal } from "../../../e2e/wait.ts";

/**
 * The relay over a real LISTEN/NOTIFY: two servers on one PGlite, each with its own relay, sharing nothing else. What
 * crosses the wire is pinned byte for byte, since a JVM server must be able to share the same channel.
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

let db: PGlite;
let sql: Queryable;
let notifications: Notifications;
let now = 1_000;

beforeEach(async () => {
  db = new PGlite();
  sql = { query: async (text, params) => (await db.query(text, params)) as never };
  notifications = pgliteNotifications(db);
  now = 1_000;
});

afterEach(async () => {
  await db.close();
});

async function relay(origin: string, opts: { ttlMs?: number; maxInline?: number } = {}): Promise<PgRelay> {
  const r = new PgRelay(notifications, sql, { origin, now: () => now, ...opts });
  await r.migrate();
  return r;
}

/** A relay end that records what reaches it. */
async function listener(origin: string): Promise<{ received: Signal<RelayMessage>; stop: () => Promise<void> }> {
  const received = new Signal<RelayMessage>();
  const stop = await (await relay(origin)).subscribe((m) => received.push(m));
  return { received, stop };
}

const change = (key: string): RelayMessage => ({ kind: "change", keys: [key], ops: [] });
const rows = async (): Promise<number[]> => (await sql.query<{ id: string | number }>("SELECT id FROM rayfold_relay ORDER BY id")).rows.map((r) => Number(r.id));

function instance(books: Map<string, { id: string; title: string; stock: number }>, r: PgRelay): RayfoldServer {
  return createRayfoldServer({
    schema: SCHEMA,
    relay: r,
    resolvers: {
      Query: { book: ({ id }: { id: string }) => books.get(id) ?? null },
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
}

function open(server: RayfoldServer, op: Omit<RequestEnvelope["ops"][number], "id">) {
  const ac = new AbortController();
  const frames = new Signal<Record<string, unknown>>();
  const ended = (async () => {
    for await (const f of server.execute({ ops: [{ id: 1, ...op }] }, { viewer, signal: ac.signal })) frames.push(f as Record<string, unknown>);
  })();
  return {
    frames,
    stop: async () => {
      ac.abort();
      await bounded(ended, "the open op ending on abort");
    },
  };
}

describe("the relay over Postgres", () => {
  it("a command on one server reaches a live query and a stream open on another, through NOTIFY", async () => {
    const books = new Map([["b1", { id: "b1", title: "Dune", stock: 3 }]]);
    const a = instance(books, await relay("a"));
    const b = instance(books, await relay("b"));
    await Promise.all([a.ready(), b.ready()]);
    // the stream subscribes as it starts; watch for that before opening it, so the command comes after
    const subscribed = new Signal<string>();
    const on = b.events.on.bind(b.events);
    b.events.on = (name, fn) => {
      subscribed.push(name);
      return on(name, fn);
    };
    const live = open(b, { op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true });
    const stream = open(b, { op: "stockUpdates", args: { bookIds: ["b1"] } });
    await live.frames.atLeast(1, "b's live query answering");
    await subscribed.until((names) => names.includes("StockChanged"), "b's stream subscribing");

    await a.collect({ ops: [{ id: 1, op: "restock", args: { id: "b1", qty: 2 }, key: KEY }] }, { viewer });
    await live.frames.atLeast(2, "b's live query hearing a's change");
    await stream.frames.atLeast(1, "b's stream hearing a's event");
    expect(live.frames.items[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 5 } }] });
    expect(stream.frames.items[0]).toEqual({ id: 1, item: { bookId: "b1", stock: 5 } });
    expect(await rows()).toEqual([]); // both messages fit a payload: nothing went through the table
    await Promise.all([live.stop(), stream.stop(), a.close(), b.close()]);
  });

  it("puts exactly this on the wire, so a server in the other runtime can share the channel", async () => {
    const sent: Array<[string, string]> = [];
    const spy: Notifications = {
      listen: async () => async () => {},
      notify: async (channel, payload) => void sent.push([channel, payload]),
    };
    const r = new PgRelay(spy, sql, { origin: "a" });
    await r.publish({ kind: "change", keys: ["Book:b1", "Author:a1"], ops: ["books"] });
    await r.publish({ kind: "event", name: "StockChanged", payload: { bookId: "b1", stock: 4 } });
    expect(sent).toEqual([
      ["rayfold", '{"from":"a","change":{"keys":["Book:b1","Author:a1"],"ops":["books"]}}'],
      ["rayfold", '{"from":"a","event":{"name":"StockChanged","payload":{"bookId":"b1","stock":4}}}'],
    ]);
  });

  it("a message too large for a payload goes through the table and arrives whole; a small one leaves no row", async () => {
    const a = await relay("a");
    const b = await listener("b");
    const blob = "x".repeat(20_000);
    await a.publish({ kind: "event", name: "Imported", payload: { blob } });
    await b.received.atLeast(1, "the oversized event arriving");
    expect(b.received.items[0]).toEqual({ kind: "event", name: "Imported", payload: { blob } });
    expect(await rows()).toEqual([1]);

    await a.publish(change("Book:b1"));
    await b.received.atLeast(2, "the small change arriving");
    expect(b.received.items[1]).toEqual(change("Book:b1"));
    expect(await rows()).toEqual([1]); // it fit: no row
    await b.stop();
  });

  it("sweeps table rows past their lifetime as new ones are written", async () => {
    const a = await relay("a", { ttlMs: 1_000, maxInline: 10 });
    const b = await listener("b");
    await a.publish(change("Book:b1")); // every change is over 10 bytes, so each is a row
    now += 1_000;
    await a.publish(change("Book:b2"));
    expect(await rows()).toEqual([1, 2]); // row 1 is exactly its lifetime old: kept
    now += 1;
    await a.publish(change("Book:b3"));
    expect(await rows()).toEqual([2, 3]); // one millisecond past: swept; row 2 is a millisecond old
    now += 1_001;
    await a.publish(change("Book:b4"));
    expect(await rows()).toEqual([4]);
    await b.received.atLeast(4, "every change arriving, swept afterwards or not");
    expect(b.received.items.map((m) => (m.kind === "change" ? m.keys[0] : ""))).toEqual(["Book:b1", "Book:b2", "Book:b3", "Book:b4"]);
    await b.stop();
  });

  it("drops what it published itself, and hears what others publish", async () => {
    const a = await relay("a");
    const heardByA = new Signal<RelayMessage>();
    const stopA = await a.subscribe((m) => heardByA.push(m));
    const b = await relay("b");
    await a.publish(change("Book:mine"));
    await b.publish(change("Book:theirs")); // the barrier: a's own message was sent before it
    await heardByA.atLeast(1, "a hearing b");
    expect(heardByA.items).toEqual([change("Book:theirs")]);
    await stopA();
  });

  it("stops delivering once unsubscribed, and delivered until then", async () => {
    const a = await relay("a");
    const b = await listener("b");
    await a.publish(change("Book:1"));
    await b.received.atLeast(1, "b hearing the first change");
    await b.stop();
    await a.publish(change("Book:2"));
    const c = await listener("c"); // subscribed after the second change: the third is the barrier
    await a.publish(change("Book:3"));
    await c.received.atLeast(1, "c hearing the third change");
    expect(c.received.items).toEqual([change("Book:3")]);
    expect(b.received.items).toEqual([change("Book:1")]);
    await c.stop();
  });

  it("reports a message it cannot read instead of failing silently, and keeps listening", async () => {
    const errors: unknown[] = [];
    const r = new PgRelay(notifications, sql, { origin: "b", onError: (e) => errors.push(e) });
    await r.migrate();
    const received = new Signal<RelayMessage>();
    const stop = await r.subscribe((m) => received.push(m));
    await notifications.notify("rayfold", '{"from":"a","ref":999}'); // a row that was swept before b read it
    await notifications.notify("rayfold", '{"from":"a","change":{"keys":["Book:b1"],"ops":[]}}');
    await received.atLeast(1, "the readable message after the unreadable one");
    expect(received.items).toEqual([change("Book:b1")]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("rayfold relay: message 999 is gone from rayfold_relay");
    await stop();
  });
});
