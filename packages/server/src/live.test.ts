import { beforeEach, describe, expect, it } from "vitest";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { Signal, bounded } from "../../../e2e/wait.ts";
import type { Frame } from "./protocol.ts";
import { diffResults } from "./live.ts";

type Bookstore = ReturnType<typeof createBookstore>;
let bs: Bookstore;
beforeEach(() => {
  bs = createBookstore();
});

const KEY = "0123456789abcdef";
const admin = { id: "u9", role: "admin" };
const u1 = { id: "u1", role: "customer" };
const ebook = { id: "b9", title: "New", format: "EBOOK" as const, price: "1.00", stock: 1, authorId: "a1", costPrice: null, ownerId: "u1" };

/** Start a live query; `until(n)` waits (bounded) for the nth frame, `stop()` aborts and waits for the op to end. */
function startLive(ops: Parameters<Bookstore["server"]["execute"]>[0]["ops"], viewer?: unknown) {
  const ac = new AbortController();
  const frames = new Signal<Frame>();
  const done = (async () => {
    for await (const f of bs.server.execute({ ops }, { viewer, signal: ac.signal })) frames.push(f);
  })();
  return {
    frames: frames.items,
    until: (n: number) => frames.atLeast(n, `live frame ${n}`),
    stop: async () => {
      ac.abort();
      await bounded(done, "live op ended after abort");
    },
  };
}

describe("diffResults", () => {
  it("emits a patch when only entity fields changed, data when the structure changed, null when equal", () => {
    const a = { items: [{ $type: "Book", id: "b1", stock: 5 }, { $type: "Book", id: "b2", stock: 1 }] };
    expect(diffResults(a, a)).toBeNull();
    expect(diffResults(a, { items: [{ $type: "Book", id: "b1", stock: 3 }, { $type: "Book", id: "b2", stock: 1 }] })).toEqual({ patch: [{ set: "Book:b1", value: { stock: 3 } }] });
    const reordered = { items: [{ $type: "Book", id: "b2", stock: 1 }, { $type: "Book", id: "b1", stock: 5 }] };
    expect(diffResults(a, reordered)).toEqual({ data: reordered });
  });
});

describe("live queries", () => {
  it("re-runs on a command patch touching its read set and sends a minimal patch", async () => {
    const live = startLive([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true }]);
    await live.until(1);
    expect(live.frames[0]).toEqual({ id: 1, data: { $type: "Book", id: "b1", stock: 5 }, meta: { cost: 1 } }); // no fin: still open
    await bs.server.collect({ ops: [{ id: 1, op: "restock", args: { bookId: "b2", qty: 1 }, key: KEY + "x" }] }, { viewer: admin }); // same type, other row: re-run, no frame
    await bs.server.collect({ ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 2 }] } }, key: KEY }] }, { viewer: u1 });
    await live.until(2);
    // the b1 patch is the very next frame, so the b2 re-run sent nothing
    expect(live.frames[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 3 } }] });
    expect(bs.store.calls["Query.book"]).toBe(3);
    await live.stop();
    expect(live.frames.slice(2)).toEqual([{ id: 1, error: { code: "canceled", message: "Canceled" }, fin: true }]);
    expect(bs.server.changes.size).toBe(0);
  });

  it("sends nothing when a re-run gives the same result, a full data frame when membership changes, and honours invOp", async () => {
    const live = startLive([{ id: 1, op: "books", args: { filter: { format: "EBOOK" }, page: { first: 5 } }, shape: "{ items { id } }", live: true }]);
    await live.until(1);
    expect(live.frames[0]).toEqual({ id: 1, data: { items: [{ $type: "Book", id: "b3" }] }, meta: { cost: 11 } });
    // addReview patches invOp:["books"], so the query re-runs; its result is unchanged, which must produce no frame
    await bs.server.collect({ ops: [{ id: 1, op: "addReview", args: { input: { bookId: "b3", rating: 5, body: "!" } }, key: KEY }] }, { viewer: u1 });
    // sentinel: a real membership change. Its frame must be the very next one after the initial data.
    bs.store.books.set("b9", ebook);
    bs.server.changes.publish({ keys: new Set(), ops: new Set(["books"]) });
    await live.until(2);
    expect(live.frames[1]).toEqual({ id: 1, data: { items: [{ $type: "Book", id: "b3" }, { $type: "Book", id: "b9" }] }, meta: { cost: 11 } }); // the planned cost, same as the first frame
    expect(bs.store.calls["Query.books"]).toBe(3); // initial, the silent re-run after addReview, the membership re-run
    await live.stop();
    expect(live.frames).toHaveLength(3);
  });

  it("live queries respect policies and coexist with commands in the same batch", async () => {
    const denied = await bs.server.collect({ ops: [{ id: 1, op: "myOrders", live: true }] });
    expect(denied).toEqual([{ id: 1, error: { code: "unauthenticated", message: "Sign in to access myOrders()" }, fin: true }]);
    const live = startLive([
      { id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: KEY },
      { id: 2, op: "myOrders", shape: "{ items { id status } }", live: true },
    ], u1);
    await live.until(2);
    expect(live.frames.map((f) => ("ok" in f ? "ok" : "data" in f ? "data" : "?")).sort()).toEqual(["data", "ok"]); // independent ops may interleave
    // Whether the live query saw the order initially or via a membership re-run, it converges on [o1].
    await live.until(live.frames.some((f) => "data" in f && JSON.stringify(f.data).includes("o1")) ? live.frames.length : 3);
    const before = live.frames.length;
    await bs.server.collect({ ops: [{ id: 1, op: "cancelOrder", args: { id: "o1" }, key: KEY + "c" }] }, { viewer: u1 });
    await live.until(before + 1);
    expect(live.frames[before]).toEqual({ id: 2, patch: [{ set: "Order:o1", value: { status: "CANCELLED" } }] });
    await live.stop();
  });
});

describe("compact live queries", () => {
  it("send a compact first frame and then minimal patches (reads are tracked on the typed result)", async () => {
    const live = startLive([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock author { id name } }", live: true, compact: true }]);
    await live.until(1);
    expect(live.frames[0]).toEqual({ id: 1, data: { id: "b1", stock: 5, author: { id: "a1", name: "Ursula K. Le Guin" } } });
    await bs.server.collect({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 2 }, key: KEY }] }, { viewer: admin });
    await live.until(2);
    expect(live.frames[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 7 } }] });
    await live.stop();
    expect(live.frames).toHaveLength(3);
    expect(bs.server.changes.size).toBe(0);
  });

  it("re-send a list in compact form after a membership change (no $type, no meta)", async () => {
    const live = startLive([{ id: 1, op: "books", args: { filter: { format: "EBOOK" }, page: { first: 5 } }, shape: "{ items { id } }", live: true, compact: true }]);
    await live.until(1);
    expect(live.frames[0]).toEqual({ id: 1, data: { items: [{ id: "b3" }] } });
    bs.store.books.set("b9", ebook);
    bs.server.changes.publish({ keys: new Set(), ops: new Set(["books"]) });
    await live.until(2);
    expect(live.frames[1]).toEqual({ id: 1, data: { items: [{ id: "b3" }, { id: "b9" }] } });
    await live.stop();
  });
});
