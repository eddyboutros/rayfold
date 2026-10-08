import { beforeEach, describe, expect, it } from "vitest";
import { bookstoreResolvers, bookstoreSchemaText, createBookstore, seed } from "../../../examples/bookstore-ts/src/index.ts";
import { Signal, bounded } from "../../../e2e/wait.ts";
import { createRayfoldServer, type Resolvers } from "./index.ts";
import { RayfoldError, type Frame } from "./protocol.ts";
import { MemoryCounters } from "./counters.ts";
import { diffResults } from "./live.ts";
import { ok } from "./executor.ts";
import { parseShapeText } from "@rayfold/schema";

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

describe("fields that belong to the selection (spec 07 §3)", () => {
  it("a live query whose aliased field changed gets its result again, and one whose plain field changed a patch naming it", async () => {
    // a `set` patch names entity fields: `{ set: "Book:b1", value: { left: 3 } }` would give every client cache a
    // field `left` on the book, overwriting whatever another result keeps under that name
    const live = startLive([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock left: stock }", live: true }]);
    await live.until(1);
    await bs.server.collect({ ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 2 }] } }, key: KEY }] }, { viewer: u1 });
    await live.until(2);
    expect(live.frames[1]).toEqual({ id: 1, data: { $type: "Book", id: "b1", stock: 3, left: 3 }, meta: { cost: 1 } });
    await live.stop();

    // guard: without the alias, the same change is still the patch it always was
    const plain = startLive([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true }]);
    await plain.until(1);
    await bs.server.collect({ ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 1 }] } }, key: KEY + "2" }] }, { viewer: u1 });
    await plain.until(2);
    expect(plain.frames[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 2 } }] });
    await plain.stop();
  });

  it("a command's own set patch leaves out an alias and a field asked for with arguments, and keeps the entity's fields", async () => {
    const frames = await bs.server.collect(
      { ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY, shape: "{ id stock left: stock reviews(page: { first: 1 }) { items { id } } }" }] },
      { viewer: admin },
    );
    const patch = (frames[0] as { patch: Array<{ set: string; value: Record<string, unknown> }> }).patch;
    expect(patch.find((p) => p.set === "Book:b1")?.value).toEqual({ $type: "Book", id: "b1", stock: 6 });
    // guard: the entities inside the page are still the reviews' own, and patched as such
    expect(patch.find((p) => p.set === "Review:r1")?.value).toEqual({ $type: "Review", id: "r1" });
  });

  it("the diff alone: a changed field under an alias resends, an unchanged one does not stand in the way of a patch", () => {
    const shape = parseShapeText("{ id stock left: stock }");
    const before = { $type: "Book", id: "b1", stock: 5, left: 5 };
    expect(diffResults(before, { ...before, stock: 3, left: 3 }, shape)).toEqual({ data: { $type: "Book", id: "b1", stock: 3, left: 3 } });
    const other = parseShapeText("{ id stock title: stock }");
    expect(diffResults({ ...before, title: 5 }, { ...before, title: 5, stock: 4 }, other)).toEqual({ patch: [{ set: "Book:b1", value: { stock: 4 } }] });
  });
});

describe("diffResults describes structure", () => {
  const row = (id: string, state = "TODO") => ({ $type: "Issue", id, state });
  const page = (ids: string[], state = "TODO") => ({ items: ids.map((id) => row(id, state)), total: ids.length });

  it("a row added to a list costs the row, not the page", () => {
    const prev = page(["i1", "i2", "i3", "i4", "i5"]);
    const next = { items: [row("i9"), ...prev.items], total: 6 };
    expect(diffResults(prev, next)).toEqual({
      patch: [
        { list: "items", ins: [{ at: 0, value: row("i9") }] },
        { at: "", value: { total: 6 } },
      ],
    });
    // the inserted row travels once: it is not repeated as a `set`
    expect(JSON.stringify(diffResults(prev, next)).length).toBeLessThan(JSON.stringify(next).length);
  });

  it("a row removed costs its position, and rows that only move are described as a move", () => {
    const prev = page(["i1", "i2", "i3", "i4", "i5", "i6"]);
    const next = { items: prev.items.filter((_, n) => n !== 2), total: 5 };
    expect(diffResults(prev, next)).toEqual({
      patch: [
        { list: "items", del: [2] },
        { at: "", value: { total: 5 } },
      ],
    });
    // the same rows in another order: a removal and an insertion, not the whole page
    const reordered = { items: [prev.items[1]!, prev.items[0]!, ...prev.items.slice(2)], total: 6 };
    expect(diffResults(prev, reordered)).toEqual({ patch: [{ list: "items", del: [1], ins: [{ at: 0, value: row("i2") }] }] });
    // guard: a result that gained a field cannot be described as operations, so the whole result is sent
    const widened = { ...prev, cursor: "c1" };
    expect(diffResults(prev, widened)).toEqual({ data: widened });
  });

  it("a board: the moved row and the two counts, not the six columns", () => {
    const column = (state: string, ids: string[]) => ({ state, count: ids.length, issues: page(ids, state) });
    const rest = [column("REVIEW", ["i17", "i18"]), column("DONE", ["i19", "i20"]), column("TRIAGE", ["i21"]), column("BACKLOG", ["i22"])];
    const todo = ["i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8"];
    const doing = ["i9", "i10", "i11", "i12", "i13", "i14", "i15", "i16"];
    const prev = { columns: [column("TODO", todo), column("DOING", doing), ...rest] };
    const next = { columns: [column("TODO", todo.slice(1)), column("DOING", ["i1", ...doing]), ...rest] };
    const diff = diffResults(prev, next) as { patch: unknown[] };
    expect(diff).toEqual({
      patch: [
        { list: "columns.0.issues.items", del: [0] },
        { at: "columns.0.issues", value: { total: 7 } },
        { at: "columns.0", value: { count: 7 } },
        { list: "columns.1.issues.items", ins: [{ at: 0, value: row("i1", "DOING") }] },
        { at: "columns.1.issues", value: { total: 9 } },
        { at: "columns.1", value: { count: 9 } },
      ],
    });
    // the moved row travels once; the other five columns do not travel at all
    expect(JSON.stringify(diff).length).toBeLessThan(JSON.stringify(next).length / 4);
  });

  it("still sends a plain `set` when only an entity field changed", () => {
    const prev = page(["i1", "i2", "i3", "i4", "i5"]);
    const next = { ...prev, items: [{ ...prev.items[0]!, state: "DONE" }, ...prev.items.slice(1)] };
    expect(diffResults(prev, next)).toEqual({ patch: [{ set: "Issue:i1", value: { state: "DONE" } }] });
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

  it("a live query's deferred part comes after its first result, as it does for any query, and once", async () => {
    // bio is @lazy, so deferred: the first frame must not already carry it, or it was never deferred at all
    const live = startLive([{ id: 1, op: "author", args: { id: "a1" }, shape: "{ id name bio }", live: true }]);
    await live.until(2);
    expect(live.frames.slice(0, 2)).toEqual([
      { id: 1, data: { $type: "Author", id: "a1", name: "Ursula K. Le Guin" }, meta: { cost: 1 } },
      { id: 1, at: "", data: { bio: "American author of speculative fiction." } },
    ]);
    // the folded result still counts the deferred part, so a change to it reaches the query
    bs.store.authors.set("a1", { ...bs.store.authors.get("a1")!, bio: "Wrote Earthsea." });
    bs.server.changes.publish({ keys: new Set(["Author:a1"]), ops: new Set() });
    await live.until(3);
    expect(live.frames[2]).toEqual({ id: 1, patch: [{ set: "Author:a1", value: { bio: "Wrote Earthsea." } }] });
    await live.stop();
  });

  it("guard: a one-shot query delivers its deferred part the same way, then ends", async () => {
    const frames = await bs.server.collect({ ops: [{ id: 1, op: "author", args: { id: "a1" }, shape: "{ id name bio }" }] });
    expect(frames).toEqual([
      { id: 1, data: { $type: "Author", id: "a1", name: "Ursula K. Le Guin" }, meta: { cost: 1 } },
      { id: 1, at: "", data: { bio: "American author of speculative fiction." } },
      { id: 1, fin: true },
    ]);
  });

  it("a re-run loads a field again rather than answering it from the batch's memo", async () => {
    // the author is a loaded field: the first run loads it once for the batch. a re-run is a new read, and the row
    // the loader would answer from has changed underneath: the re-run has to show it.
    const live = startLive([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id author { id name } }", live: true }]);
    await live.until(1);
    expect(live.frames[0]).toEqual({ id: 1, data: { $type: "Book", id: "b1", author: { $type: "Author", id: "a1", name: "Ursula K. Le Guin" } }, meta: { cost: 2 } });
    expect(bs.store.calls["Book.author"]).toBe(1);
    bs.store.books.set("b1", { ...bs.store.books.get("b1")!, authorId: "a2" });
    bs.server.changes.publish({ keys: new Set(["Book:b1"]), ops: new Set() });
    await live.until(2);
    expect(live.frames[1]).toEqual({ id: 1, patch: [{ set: "Author:a2", value: { $type: "Author", id: "a2", name: "Italo Calvino" } }, { set: "Book:b1", value: { author: { $ref: "Author:a2" } } }] });
    expect(bs.store.calls["Book.author"]).toBe(2);
    await live.stop();
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

/**
 * A live query subscribes to the change bus and reads. Whichever order those happen in, the window between them is
 * a hole: a command committed inside it changes rows the read had already looked at, and the client is told
 * nothing. Nothing later is obliged to touch the same rows again, so the screen stays wrong until something
 * unrelated happens to disturb it. These park the first read so the window is wide open and deterministic.
 */
describe("a change committed while the first read is still running", () => {
  /** A bookstore whose `Query.book` reads, then parks until the test releases it, then returns what it read. */
  function parkedFirstRead() {
    const store = seed();
    const base = bookstoreResolvers(store);
    const parked = new Signal<true>();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    let held = true;
    const book = base.Query!["book"] as (args: { id: string }, ctx: unknown) => unknown;
    const resolvers: Resolvers = {
      ...base,
      Query: {
        ...base.Query,
        book: async (args: { id: string }, ctx: unknown) => {
          // Copied, not referenced: a real datastore hands back the row it read, and this one would otherwise
          // alias the command's own mutation and so never be stale at all.
          const read = book(args, ctx) as Record<string, unknown> | null;
          const row = read && { ...read };
          if (held) {
            held = false;
            parked.push(true);
            await gate;
          }
          return row;
        },
      },
    };
    return {
      server: createRayfoldServer({ schema: bookstoreSchemaText(), resolvers }),
      store,
      reading: () => parked.atLeast(1, "the first read reached the store"),
      release: () => release?.(),
    };
  }

  it("reaches the client, rather than waiting for something unrelated to disturb the same rows", async () => {
    const gated = parkedFirstRead();
    bs = { server: gated.server, store: gated.store };
    const live = startLive([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true }]);
    await gated.reading();
    // the read has seen stock 5 and has not returned yet; this is the window
    await bs.server.collect({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 2 }, key: KEY }] }, { viewer: admin });
    gated.release();

    await live.until(1);
    expect(live.frames[0]).toEqual({ id: 1, data: { $type: "Book", id: "b1", stock: 5 }, meta: { cost: 1 } }); // the value the read saw
    await live.until(2);
    expect(live.frames[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 7 } }] });
    await live.stop();
    expect(bs.server.changes.size).toBe(0);
  });

  it("sends nothing when it misses the read set, so the guard is not blanket", async () => {
    const gated = parkedFirstRead();
    bs = { server: gated.server, store: gated.store };
    const live = startLive([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true }]);
    await gated.reading();
    await bs.server.collect({ ops: [{ id: 1, op: "restock", args: { bookId: "b2", qty: 2 }, key: KEY }] }, { viewer: admin }); // another row
    gated.release();
    await live.until(1);

    await bs.server.collect({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 2 }, key: KEY + "x" }] }, { viewer: admin });
    await live.until(2);
    // the b1 patch is the very next frame, so the b2 change in the window sent nothing
    expect(live.frames[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 7 } }] });
    await live.stop();
  });
});

describe("a live query's re-runs", () => {
  /** A shelf whose `book` read can be parked or made to fail on a chosen run; the first run is run 1. */
  function shelf(opts: { park?: number; fail?: number } = {}) {
    const books = new Map([["b1", { id: "b1", stock: 3 }]]);
    const parked = new Signal<number>();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let reads = 0;
    const counters = new MemoryCounters();
    const server = createRayfoldServer({
      schema: `entity Book { id: ID stock: Int } query book(id: ID): Book command restock(id: ID, qty: Int): Book @idempotent(false)`,
      counters,
      resolvers: {
        Query: {
          book: async ({ id }: { id: string }) => {
            const run = ++reads;
            if (run === opts.fail) throw new RayfoldError("unavailable", "the shelf went away");
            const row = { ...books.get(id)! }; // what this run read, before it was parked
            if (run === opts.park) {
              parked.push(run);
              await gate;
            }
            return row;
          },
        },
        Command: {
          restock: ({ id, qty }: { id: string; qty: number }) => {
            const book = books.get(id)!;
            book.stock += qty;
            return { ...book };
          },
        },
      },
    });
    const restock = () => server.collect({ ops: [{ id: 1, op: "restock", args: { id: "b1", qty: 1 } }] });
    const ac = new AbortController();
    const frames = new Signal<Frame>();
    const done = (async () => {
      for await (const f of server.execute({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true }] }, { signal: ac.signal })) frames.push(f);
    })();
    const live = () => counters.snapshot().filter((e) => e.name.startsWith("rayfold.live.")).map((e) => [e.name, e.count]);
    return { frames, done, restock, parked, release: () => release(), reads: () => reads, abort: () => ac.abort(), live };
  }

  it("a change that lands while a re-run is in progress runs it again once that re-run ends", async () => {
    const s = shelf({ park: 2 });
    await s.frames.atLeast(1, "the first answer");
    await s.restock(); // stock 4: re-run 2 reads it and is parked
    await s.parked.atLeast(1, "re-run 2 parked after its read");
    await s.restock(); // stock 5, while re-run 2 is still in progress
    s.release();
    await s.frames.atLeast(3, "re-run 2's patch and the re-run the second change asked for");
    s.abort();
    await bounded(s.done, "the live query ending on abort");
    expect(s.frames.items).toEqual([
      { id: 1, data: { $type: "Book", id: "b1", stock: 3 }, meta: { cost: 1 } },
      { id: 1, patch: [{ set: "Book:b1", value: { stock: 4 } }] },
      { id: 1, patch: [{ set: "Book:b1", value: { stock: 5 } }] },
      { id: 1, error: { code: "canceled", message: "Canceled" }, fin: true },
    ]);
    expect(s.reads()).toBe(3);
    expect(s.live()).toEqual([
      ["rayfold.live.closed", 1],
      ["rayfold.live.opened", 1],
      ["rayfold.live.reran", 2],
    ]);
  });

  it("a re-run that fails ends the op with its error, and nothing re-runs after it", async () => {
    const s = shelf({ fail: 2 });
    await s.frames.atLeast(1, "the first answer");
    await s.restock();
    await bounded(s.done, "the live query ending on the failed re-run");
    expect(s.frames.items).toEqual([
      { id: 1, data: { $type: "Book", id: "b1", stock: 3 }, meta: { cost: 1 } },
      { id: 1, error: { code: "unavailable", message: "the shelf went away" }, fin: true },
    ]);
    await s.restock(); // guard: the ended query is no longer listening, so this reads nothing
    expect(s.reads()).toBe(2);
    expect(s.live()).toEqual([
      ["rayfold.live.closed", 1],
      ["rayfold.live.opened", 1],
      ["rayfold.live.reran", 1],
    ]);
  });
});

describe("which changes wake a live query", () => {
  /** A live query over `server`; `next()` waits for the next frame, `stop()` ends it and checks it unsubscribed. */
  function open(server: ReturnType<typeof createRayfoldServer>, op: Record<string, unknown>) {
    const ac = new AbortController();
    const frames = new Signal<Frame>();
    const done = (async () => {
      for await (const f of server.execute({ ops: [{ id: 1, live: true, ...op } as never] }, { signal: ac.signal })) frames.push(f);
    })();
    return {
      frames,
      stop: async () => {
        ac.abort();
        await bounded(done, "the live query ending on abort");
        expect(server.changes.size).toBe(0);
      },
    };
  }
  const change = (server: ReturnType<typeof createRayfoldServer>, ...keys: string[]) => server.changes.publish({ keys: new Set(keys), ops: new Set() });

  it("a new entity of a type the result holds below its root may join it, so it re-runs", async () => {
    const books = [{ id: "b1" }];
    const s = createRayfoldServer({
      schema: `entity Shelf { id: ID books: [Book] } entity Book { id: ID } query shelf: Shelf`,
      resolvers: { Query: { shelf: () => ({ id: "s1", books: [...books] }) } },
    });
    const live = open(s, { op: "shelf", shape: "{ id books { id } }" });
    await live.frames.atLeast(1, "the first answer");
    books.push({ id: "b9" });
    change(s, "Book:b9"); // in no read set: only its type says it may belong
    await live.frames.atLeast(2, "the re-run the new book asked for");
    expect(live.frames.items).toEqual([
      { id: 1, data: { $type: "Shelf", id: "s1", books: [{ $type: "Book", id: "b1" }] }, meta: { cost: 2 } },
      { id: 1, patch: [{ set: "Book:b9", value: { $type: "Book", id: "b9" } }, { set: "Shelf:s1", value: { books: [{ $ref: "Book:b1" }, { $ref: "Book:b9" }] } }] },
    ]);
    await live.stop();
  });

  it("an interface position wakes for a new entity of a type that implements it", async () => {
    const people = [{ $type: "Person", id: "p1", name: "Ada" }];
    const s = createRayfoldServer({
      schema: `object Named @interface { id: ID name: String } entity Person implements Named { id: ID name: String } entity Robot { id: ID } query people: [Named]`,
      resolvers: { Query: { people: () => [...people] } },
    });
    const live = open(s, { op: "people", shape: "{ id name }" });
    await live.frames.atLeast(1, "the first answer");
    change(s, "Robot:r1"); // guard: a type that cannot appear here wakes nothing; the next frame shows it
    people.push({ $type: "Person", id: "p2", name: "Bo" });
    change(s, "Person:p2");
    await live.frames.atLeast(2, "the re-run the new person asked for");
    expect(live.frames.items[1]).toEqual({ id: 1, patch: [{ list: "", ins: [{ at: 1, value: { $type: "Person", id: "p2", name: "Bo" } }] }] });
    await live.stop();
  });

  it("listens for what the result holds after each re-run, not what it held first", async () => {
    // an entity this deep is past what the query watches by type, so only its key, in the read set, hears it
    let person = { id: "p1", name: "Ada" };
    const s = createRayfoldServer({
      schema: `object L0 { n: L1 } object L1 { n: L2 } object L2 { n: L3 } object L3 { n: L4 } object L4 { p: Person } entity Person { id: ID name: String } query deep: L0`,
      resolvers: { Query: { deep: () => ({ n: { n: { n: { n: { p: { ...person } } } } } }) } },
    });
    const at = (p: unknown) => ({ n: { n: { n: { n: { p } } } } });
    const live = open(s, { op: "deep", shape: "{ n { n { n { n { p { id name } } } } } }" });
    await live.frames.atLeast(1, "the first answer");
    person = { id: "p2", name: "Bo" };
    change(s, "Person:p1");
    await live.frames.atLeast(2, "the re-run that found p2");
    person = { id: "p2", name: "Bea" };
    change(s, "Person:p2");
    await live.frames.atLeast(3, "the change to p2, heard because p2 is now in the result");
    expect(live.frames.items).toEqual([
      { id: 1, data: at({ $type: "Person", id: "p1", name: "Ada" }), meta: { cost: 6 } },
      { id: 1, data: at({ $type: "Person", id: "p2", name: "Bo" }), meta: { cost: 6 } },
      { id: 1, patch: [{ set: "Person:p2", value: { name: "Bea" } }] },
    ]);
    await live.stop();
  });
});

describe("@live(false)", () => {
  const SCHEMA = `
entity Hit { id: ID  title: String }
query search(q: String): [Hit] @live(false)
query hits: [Hit]
`;
  const server = () =>
    createRayfoldServer({
      schema: SCHEMA,
      resolvers: { Query: { search: () => [{ id: "h1", title: "One" }], hits: () => [{ id: "h1", title: "One" }] } },
    });

  it("refuses to open a query the schema opted out of, and still opens one that did not", async () => {
    // declared in examples/workspace-ts/workspace.rayfold and enforced nowhere, so the runtime opened it live anyway
    const refused = await server().collect({ ops: [{ id: 1, op: "search", args: { q: "x" }, shape: "{ id }", live: true }] }, {});
    expect(refused).toEqual([{ error: { code: "invalid_argument", message: "ops[0].live: search is declared @live(false)" }, fin: true }]);

    // guard: the opt-out is per operation, not a refusal of live queries on this server
    const ac = new AbortController();
    const frames = new Signal<Frame>();
    const done = (async () => {
      for await (const f of server().execute({ ops: [{ id: 1, op: "hits", shape: "{ id }", live: true }] }, { signal: ac.signal })) frames.push(f);
    })();
    await frames.atLeast(1, "the live hits query answering");
    expect(frames.items).toEqual([{ id: 1, data: [{ $type: "Hit", id: "h1" }], meta: { cost: 1 } }]); // no fin: it stays open
    ac.abort();
    await bounded(done, "the live hits query ending on abort");
    // guard: nor is it a refusal of the query itself, which still answers once
    expect(await server().collect({ ops: [{ id: 1, op: "search", args: { q: "x" }, shape: "{ id }" }] }, {})).toEqual([{ id: 1, data: [{ $type: "Hit", id: "h1" }], meta: { cost: 1 }, fin: true }]);
  });
});

describe("diffResults, in its corners", () => {
  const book = (id: string, extra: Record<string, unknown> = {}) => ({ $type: "Book", id, ...extra });

  it("an entity met at two places is one entity: a change seen at either place is a patch", () => {
    const prev = { a: book("b1", { title: "T" }), b: book("b1", { stock: 1 }) };
    expect(diffResults(prev, { a: book("b1", { title: "U" }), b: book("b1", { stock: 1 }) })).toEqual({ patch: [{ set: "Book:b1", value: { title: "U" } }] });
  });

  it("a plain object that lost a field is resent whole; one whose field changed is patched in place (guard)", () => {
    const pad = "x".repeat(200); // large enough that describing a change costs less than resending it
    expect(diffResults({ o: { a: pad, b: 2 } }, { o: { a: pad } })).toEqual({ data: { o: { a: pad } } });
    expect(diffResults({ o: { a: pad, b: 2 } }, { o: { a: pad, b: 3 } })).toEqual({ patch: [{ at: "o", value: { b: 3 } }] });
  });

  it("rows removed from the end of a list are each a deletion", () => {
    expect(diffResults({ items: [book("1"), book("2"), book("3")] }, { items: [book("1")] })).toEqual({ patch: [{ list: "items", del: [1, 2] }] });
  });

  it("plain values in a list are told apart by their content", () => {
    const tags = ["a", "b", "c", "d"].map((t) => t.repeat(40));
    expect(diffResults({ tags }, { tags: tags.slice(1) })).toEqual({ patch: [{ list: "tags", del: [0] }] });
  });

  it("an aliased field of a plain object is the object's own, and changes as an `at` patch", () => {
    const shape = parseShapeText("{ o { n al: n pad } }");
    const pad = "x".repeat(200);
    expect(diffResults({ o: { n: 1, al: 1, pad } }, { o: { n: 2, al: 2, pad } }, shape)).toEqual({ patch: [{ at: "o", value: { n: 2, al: 2 } }] });
  });

  it("with a shape, a structure that cannot be patched resends the whole result, its selection's own fields included", () => {
    const shape = parseShapeText("{ b { id left: stock } o { a } }");
    const b = { $type: "Book", id: "b1", left: 3 };
    const next = { b, o: { a: 1, z: 2 } }; // a plain object that gained a field
    expect(diffResults({ b, o: { a: 1 } }, next, shape)).toEqual({ data: next });
  });
});

describe("what a command's patch tells live queries", () => {
  it("a del names the entity, an invOp names the operation, and both are heard", async () => {
    const s = createRayfoldServer({
      schema: `entity Book { id: ID } command drop(id: ID): Book? @idempotent(false) command touch: Book? @idempotent(false)`,
      resolvers: {
        Command: {
          drop: (a: { id: string }) => ok(null, { patch: [{ del: `Book:${a.id}` }] }),
          touch: () => ok(null, { patch: [{ invOp: ["books"] }, { inv: ["Book:b2"] }] }),
        },
      } as never,
    });
    const heard: Array<{ keys: string[]; ops: string[] }> = [];
    s.changes.subscribe((c) => heard.push({ keys: [...c.keys], ops: [...c.ops] }));
    await s.collect({ ops: [{ id: 1, op: "drop", args: { id: "b1" } }, { id: 2, op: "touch" }] });
    expect(heard).toEqual([{ keys: ["Book:b1"], ops: [] }, { keys: ["Book:b2"], ops: ["books"] }]);
  });
});
