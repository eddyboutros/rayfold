import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import type { Frame, RequestEnvelope } from "./protocol.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
import { RayfoldError } from "./protocol.ts";
import { MemoryIdempotencyStore } from "./context.ts";
import { stripTypes } from "./executor.ts";
import { FrameSink } from "./batch.ts";
import { hasPolicy, pushableFilter } from "./policy.ts";
import type { RayfoldContext } from "./context.ts";
import { Signal, bounded } from "../../../e2e/wait.ts";

const KEY = "0123456789abcdef";
const idOf = (f: Frame): number | undefined => ("id" in f ? f.id : undefined);
const admin = { id: "u9", role: "admin" };
const u1 = { id: "u1", role: "customer" };
const u2 = { id: "u2", role: "customer" };

type Bookstore = ReturnType<typeof createBookstore>;
let bs: Bookstore;
beforeEach(() => {
  bs = createBookstore();
});

const run = (ops: RequestEnvelope["ops"], viewer?: unknown, meta?: RequestEnvelope["meta"]) =>
  bs.server.collect(meta ? { ops, meta } : { ops }, { viewer });
const one = async (op: RequestEnvelope["ops"][number], viewer?: unknown): Promise<Frame> => {
  const frames = await run([op], viewer);
  expect(frames).toHaveLength(1);
  return frames[0]!;
};

describe("queries and default views", () => {
  it("returns the declared default view when no shape is sent", async () => {
    const f = await one({ id: 1, op: "book", args: { id: "b1" } });
    expect(f).toEqual({
      id: 1,
      data: { $type: "Book", id: "b1", title: "The Dispossessed", format: "PAPERBACK", price: "12.99", stock: 5, author: { $type: "Author", id: "a1", name: "Ursula K. Le Guin" } },
      meta: { cost: 2 },
      fin: true,
    });
  });

  it("returns null for a missing nullable result and coerces int ids", async () => {
    const f = await one({ id: 1, op: "book", args: { id: 404 } });
    expect(f).toMatchObject({ id: 1, data: null, fin: true });
  });

  it("resolves a nested shape with one loader call per level (no N+1)", async () => {
    const f = await one({
      id: 1,
      op: "books",
      args: { page: { first: 3 } },
      shape: "{ items { id title author { name } reviews(page: { first: 2 }) { items { rating } hasMore } } hasMore cursor }",
    });
    expect(f).toMatchObject({ fin: true });
    const data = (f as { data: { items: unknown[]; hasMore: boolean; cursor: string } }).data;
    expect(data.items).toHaveLength(3);
    expect(data.hasMore).toBe(true);
    expect(data.cursor).toBe("b3");
    expect(data.items[0]).toEqual({
      $type: "Book",
      id: "b1",
      title: "The Dispossessed",
      author: { $type: "Author", name: "Ursula K. Le Guin" },
      reviews: { items: [{ $type: "Review", rating: 5 }, { $type: "Review", rating: 3 }], hasMore: false },
    });
    expect(bs.store.calls).toEqual({ "Query.books": 1, "Book.author": 1, "Book.reviews": 1 });
  });

  it("supports aliases, view spreads and shape variables", async () => {
    const f = await one({ id: 1, op: "book", args: { id: "b1" }, shape: "{ ...Book.default name: title reviews(page: { first: $n }) { items { id } } }", vars: { n: 1 } });
    const d = (f as { data: Record<string, unknown> }).data;
    expect(d["name"]).toBe("The Dispossessed");
    expect(d["title"]).toBe("The Dispossessed");
    expect(d["reviews"]).toEqual({ items: [{ $type: "Review", id: "r1" }] });
  });

  it("rejects unknown fields, bad args and missing variables as invalid_argument", async () => {
    expect(await one({ id: 1, op: "book", args: { id: "b1" }, shape: "{ nope }" })).toMatchObject({ id: 1, error: { code: "invalid_argument" }, fin: true });
    expect(await one({ id: 1, op: "books", args: { page: { first: "x" } } })).toMatchObject({ error: { code: "invalid_argument", message: expect.stringContaining("page.first") } });
    expect(await one({ id: 1, op: "books", args: { page: { first: 2, offset: -1 } } })).toMatchObject({ error: { code: "invalid_argument", message: "books().page.offset: must be >= 0" } });
    // guard: an offset of 0 or more is a valid page
    const ids = (...xs: string[]) => ({ items: xs.map((id) => ({ $type: "Book", id })) });
    expect(await one({ id: 1, op: "books", args: { page: { first: 2, offset: 0 } }, shape: "{ items { id } }" })).toEqual({ id: 1, data: ids("b1", "b2"), meta: { cost: 8 }, fin: true });
    expect(await one({ id: 1, op: "books", args: { page: { first: 2, offset: 1 } }, shape: "{ items { id } }" })).toEqual({ id: 1, data: ids("b2", "b3"), meta: { cost: 8 }, fin: true });
    expect(await one({ id: 1, op: "books", args: { nope: 1 } })).toMatchObject({ error: { code: "invalid_argument", message: expect.stringContaining("unknown argument") } });
    expect(await one({ id: 1, op: "book", args: { id: "b1" }, shape: "{ reviews(page: { first: $n }) { items { id } } }" })).toMatchObject({ error: { code: "invalid_argument", message: expect.stringContaining("$n") } });
  });
});

describe("commands, pipelining and patches", () => {
  it("places an order and reads it back in one batch via $ref", async () => {
    const frames = await run(
      [
        { id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 2 }] } }, key: KEY },
        { id: 2, op: "order", args: { id: { $ref: "1.id" } }, shape: "{ id status total items { qty book { id stock } } }" },
      ],
      u1,
    );
    expect(frames.map(idOf)).toEqual([1, 2]);
    const okFrame = frames[0] as Extract<Frame, { ok: unknown }>;
    expect(okFrame.ok).toMatchObject({ $type: "Order", id: "o1", status: "PLACED", total: "25.98" });
    expect(okFrame.patch).toEqual([
      { set: "Order:o1", value: { $type: "Order", id: "o1", status: "PLACED", total: "25.98", items: [{ qty: 2, unitPrice: "12.99", book: { $ref: "Book:b1" } }] } },
      { set: "Book:b1", value: { $type: "Book", id: "b1", title: "The Dispossessed" } },
      { set: "Book:b1", value: { stock: 3 } },
    ]);
    expect(frames[1]).toMatchObject({ id: 2, data: { id: "o1", status: "PLACED", items: [{ qty: 2, book: { id: "b1", stock: 3 } }] }, fin: true });
  });

  it("fails dependents when the referenced op fails (typed domain error)", async () => {
    const frames = await run(
      [
        { id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b4", qty: 1 }] } }, key: KEY },
        { id: 2, op: "order", args: { id: { $ref: "1.id" } } },
      ],
      u1,
    );
    expect(frames[0]).toEqual({ id: 1, error: { code: "domain", type: "OutOfStock", message: "Only 0 of A Wizard of Earthsea left", data: { bookId: "b4", available: 0 } }, fin: true });
    expect(frames[1]).toMatchObject({ id: 2, error: { code: "failed_precondition", type: "DependencyFailed", data: { op: 1 } }, fin: true });
    expect(bs.store.orders.size).toBe(0);
  });

  it("requires an idempotency key, replays on repeat and rejects reuse with other args", async () => {
    expect(await one({ id: 1, op: "restock", args: { bookId: "b1", qty: 1 } }, admin)).toMatchObject({ error: { code: "invalid_argument", message: expect.stringContaining("idempotency") } });
    const first = await one({ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY }, admin);
    const again = await one({ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY }, admin);
    expect(first).toMatchObject({ ok: { stock: 6 }, meta: { cost: 2 } });
    expect(again).toEqual({ ...first, meta: { cost: 2, replay: true } });
    expect(bs.store.books.get("b1")!.stock).toBe(6);
    expect(bs.store.calls["Command.restock"]).toBe(1);
    expect(await one({ id: 1, op: "restock", args: { bookId: "b1", qty: 2 }, key: KEY }, admin)).toMatchObject({ error: { code: "already_exists" } });
  });

  it("executes commands serially in id order even when independent", async () => {
    const frames = await run(
      [
        { id: 3, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY + "3" },
        { id: 1, op: "restock", args: { bookId: "b1", qty: 10 }, key: KEY + "1" },
        { id: 2, op: "restock", args: { bookId: "b1", qty: 100 }, key: KEY + "2" },
      ],
      admin,
    );
    // ok frames arrive in id order: 5+10=15, +100=115, +1=116
    expect(frames.map((f) => [idOf(f), (f as { ok: { stock: number } }).ok.stock])).toEqual([[1, 15], [2, 115], [3, 116]]);
  });

  it("simulate runs the command without committing, recording, publishing events or waking live queries", async () => {
    const events: unknown[] = [];
    const changed: string[] = [];
    bs.server.events.on("OrderPlaced", (p) => events.push(p));
    bs.server.changes.subscribe((c) => changed.push(...c.keys, ...c.ops));
    const place = { id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 1 }] } }, key: KEY };
    const f = await one({ ...place, simulate: true }, u1);
    expect(f).toMatchObject({ ok: { status: "PLACED", total: "12.99" } });
    expect(bs.store.orders.size).toBe(0);
    expect(bs.store.books.get("b1")!.stock).toBe(5);
    expect(events).toEqual([]);
    expect(changed).toEqual([]);
    // guard: the same command for real does every one of those things, so the silence above is specific to simulate
    const real = await one(place, u1);
    expect((real as { meta: { replay?: boolean } }).meta.replay).toBeUndefined();
    expect(bs.store.orders.size).toBe(1);
    expect(bs.store.books.get("b1")!.stock).toBe(4);
    expect(events).toEqual([{ orderId: "o1", customerId: "u1", seq: 1 }]);
    expect(changed).toContain("Book:b1");
  });

  it("publishes declared events and converts undeclared domain errors to internal", async () => {
    const seen: unknown[] = [];
    bs.server.events.on("OrderPlaced", (p) => seen.push(p));
    await one({ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: KEY }, u1);
    expect(seen).toEqual([{ orderId: "o1", customerId: "u1", seq: 1 }]);

    const rogue = createRayfoldServer({
      schema: `entity A { id: ID } command boom(x: Int): A @idempotent(false)`,
      resolvers: { Command: { boom: () => { throw RayfoldError.domain("Nope", {}); } } },
    });
    expect(await rogue.collect({ ops: [{ id: 1, op: "boom", args: { x: 1 } }] })).toEqual([{ id: 1, error: { code: "internal", message: "boom raised undeclared error Nope" }, fin: true }]);
  });
});

describe("schema constraints and compact frames", () => {
  it("@range on input fields rejects bad values before any resolver runs", async () => {
    expect(await one({ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 0 }] } }, key: KEY }, u1)).toMatchObject({ error: { code: "invalid_argument", message: "placeOrder().input.lines.0.qty: must be >= 1" } });
    expect(await one({ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 101 }] } }, key: KEY }, u1)).toMatchObject({ error: { code: "invalid_argument", message: "placeOrder().input.lines.0.qty: must be <= 100" } });
    expect(await one({ id: 1, op: "addReview", args: { input: { bookId: "b1", rating: 6, body: "x" } }, key: KEY }, u1)).toMatchObject({ error: { code: "invalid_argument", message: "addReview().input.rating: must be <= 5" } });
    expect(await one({ id: 1, op: "addReview", args: { input: { bookId: "b1", rating: 5, body: "" } }, key: KEY }, u1)).toMatchObject({ error: { code: "invalid_argument", message: "addReview().input.body: must be >= 1" } });
    expect(bs.store.calls).toEqual({});
    expect(await one({ id: 1, op: "addReview", args: { input: { bookId: "b1", rating: 5, body: "fine" } }, key: KEY }, u1)).toMatchObject({ ok: { rating: 5 } });
    // guard: the bounds are inclusive, so the edge values pass (b3 repriced so 100 copies stay under the example's card limit)
    bs.store.books.get("b3")!.price = "1.00";
    expect(await one({ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 100 }] } }, key: KEY + "max" }, u1)).toMatchObject({ ok: { items: [{ qty: 100 }] } });
    expect(await one({ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 1 }] } }, key: KEY + "min" }, u1)).toMatchObject({ ok: { items: [{ qty: 1 }] } });
  });

  it("@range compares numbers and Decimals by value, strings and lists by length", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID } command set(name: String @range(min: 1, max: 4), price: Decimal @range(min: 0, max: 10), n: Int @range(max: 3), tags: [String] @range(max: 2)): A @idempotent(false)`,
      resolvers: { Command: { set: () => ({ id: "a" }) } },
    });
    const outcome = async (args: Record<string, unknown>) => {
      const f = (await s.collect({ ops: [{ id: 1, op: "set", args }] }))[0]!;
      return "error" in f ? f.error.message : "ok";
    };
    const good = { name: "1984", price: "10.00", n: 3, tags: ["a", "b"] };
    expect(await outcome(good)).toBe("ok"); // "1984" is four characters; its numeric value is irrelevant
    expect(await outcome({ ...good, name: "12345" })).toBe("set().name: must be <= 4");
    expect(await outcome({ ...good, price: "10.01" })).toBe("set().price: must be <= 10");
    expect(await outcome({ ...good, price: "-0.5" })).toBe("set().price: must be >= 0");
    expect(await outcome({ ...good, n: 4 })).toBe("set().n: must be <= 3");
    expect(await outcome({ ...good, tags: ["a", "b", "c"] })).toBe("set().tags: must be <= 2");
  });

  it("compact frames drop $type where the schema fixes it and drop meta; patches keep full identity", async () => {
    const f = await one({ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title author { id name } }", compact: true });
    expect(f).toEqual({ id: 1, data: { id: "b1", title: "The Dispossessed", author: { id: "a1", name: "Ursula K. Le Guin" } }, fin: true });
    const c = await one({ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY + "c", compact: true }, admin);
    expect(c).toMatchObject({ ok: { id: "b1", stock: 6 }, fin: true });
    expect((c as { patch: unknown[] }).patch).toEqual([]); // patches that only restate `ok` are omitted in compact mode
    expect((c as { ok: Record<string, unknown> }).ok).not.toHaveProperty("$type");
    expect(c).not.toHaveProperty("meta");
    const frames = await run([{ id: 1, op: "author", args: { id: "a1" }, shape: "{ id name bio }", compact: true }]);
    expect(frames).toEqual([{ id: 1, data: { id: "a1", name: "Ursula K. Le Guin" } }, { id: 1, at: "", data: { bio: "American author of speculative fiction." } }, { id: 1, fin: true }]);
    const union = createRayfoldServer({
      schema: `entity Book { id: ID title: String } entity Author { id: ID name: String } union Hit = Book | Author query search: [Hit]`,
      resolvers: { Query: { search: () => [{ $type: "Book", id: "b1", title: "T" }, { $type: "Author", id: "a1", name: "A" }] } },
    });
    expect(await union.collect({ ops: [{ id: 1, op: "search", compact: true }] })).toEqual([{ id: 1, data: [{ $type: "Book", id: "b1", title: "T" }, { $type: "Author", id: "a1", name: "A" }], fin: true }]);
  });

  it("an interface position resolves the concrete type from $type, and refuses a value without one", async () => {
    const schema = `object Named @interface { id: ID name: String } entity Person implements Named { id: ID name: String email: String } entity Note { id: ID author: Named } query note: Note`;
    const untagged = createRayfoldServer({ schema, resolvers: { Query: { note: () => ({ id: "n1" }) }, Note: { author: () => [{ id: "p1", name: "Ada", email: "a@x.dev" }] } } });
    expect(await untagged.collect({ ops: [{ id: 1, op: "note", shape: "{ id author { name } }" }] })).toMatchObject([{ id: 1, error: { code: "internal", path: "author" } }]);
    // guard: the same value carrying its $type projects, including the fields only Person declares
    const tagged = createRayfoldServer({ schema, resolvers: { Query: { note: () => ({ id: "n1" }) }, Note: { author: () => [{ $type: "Person", id: "p1", name: "Ada", email: "a@x.dev" }] } } });
    expect(await tagged.collect({ ops: [{ id: 1, op: "note", shape: "{ id author { name ...on Person { email } } }" }] })).toEqual([
      { id: 1, data: { $type: "Note", id: "n1", author: { $type: "Person", name: "Ada", email: "a@x.dev" } }, meta: { cost: 2 }, fin: true },
    ]);
  });
});

describe("loads shared across a batch", () => {
  it("an entity one op loaded is not loaded again by another op of the same request", async () => {
    const frames = await bs.server.collect({
      ops: [
        { id: 1, op: "book", args: { id: "b1" }, shape: "{ id author { id name } }" },
        { id: 2, op: "book", args: { id: "b1" }, shape: "{ title author { id } }" },
      ],
    });
    // both ops are queries, so they finish in whichever order they finish: take each one's own result frame
    const dataOf = (id: number) => (frames.find((f) => (f as { id: number }).id === id && "data" in f && !("at" in f)) as { data: Record<string, unknown> }).data;
    expect((dataOf(1)["author"] as { name: string }).name).toBe("Ursula K. Le Guin");
    expect((dataOf(2)["author"] as { id: string }).id).toBe("a1");
    expect(bs.store.calls["Book.author"]).toBe(1); // one load serves both ops
    expect(bs.store.calls["Query.book"]).toBe(2); // the ops themselves still run: the memo is for field loads

    // guard: the memo belongs to the request, so the next one loads it again rather than serving stale values
    await bs.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ author { id } }" }] });
    expect(bs.store.calls["Book.author"]).toBe(2);
  });

  it("a command's own result, and every op after it, load again: what was loaded before it ran may be what it changed", async () => {
    // spec 03 §3: "do A, then B" means B sees A. A loader-backed field served from the memo answered the command with
    // the stock from before it ran, and that stale value went into its patch and into every client cache.
    const store = { b1: { id: "b1", stock: 1 } };
    let loads = 0;
    const shop = createRayfoldServer({
      schema: `entity Book { id: ID stock: Int } query book(id: ID): Book? command restock(id: ID, qty: Int): Book @simulate`,
      resolvers: {
        Query: { book: ({ id }: { id: "b1" }) => ({ id }) },
        Command: {
          restock: ({ id, qty }: { id: "b1"; qty: number }, ctx: { simulate: boolean }) => {
            if (!ctx.simulate) store[id].stock += qty;
            return { id };
          },
        },
        Book: { stock: (books: Array<{ id: "b1" }>) => (loads++, books.map((b) => store[b.id].stock)) },
      } as never,
    });
    const run = async (simulate: boolean) =>
      shop.collect(
        {
          ops: [
            { id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }" },
            { id: 2, op: "restock", args: { id: "b1", qty: 10 }, shape: "{ id stock }", key: `restock-000000000${simulate ? 1 : 2}`, ...(simulate ? { simulate: true } : {}) },
            { id: 3, op: "book", args: { id: { $ref: "2.id" } }, shape: "{ id stock }" },
          ],
        },
        { viewer: { id: "u1" } },
      );
    const stockIn = (frames: Frame[], id: number) => frames.map((f) => f as { id?: number; data?: { stock: number }; ok?: { stock: number } }).find((f) => f.id === id)!;

    // guard: a dry run changed nothing, so the op after it keeps the load the first op made; the dry run's own answer
    // describes what would happen, which that load does not know, so it loads for itself
    const dry = await run(true);
    expect([stockIn(dry, 1).data?.stock, stockIn(dry, 2).ok?.stock, stockIn(dry, 3).data?.stock]).toEqual([1, 1, 1]);
    expect(loads).toBe(2);

    loads = 0;
    const frames = await run(false);
    expect([stockIn(frames, 1).data?.stock, stockIn(frames, 2).ok?.stock, stockIn(frames, 3).data?.stock]).toEqual([1, 11, 11]);
    expect(frames.find((f) => (f as { id?: number }).id === 2)).toMatchObject({ patch: [{ set: "Book:b1", value: { stock: 11 } }] });
    expect(loads).toBe(2); // before the command, then once for the command's result and the op after it
  });

  it("a dry run answers what would happen, not what an earlier op loaded", async () => {
    // spec 03: a dry run's "result and patches describe what would happen". The memo held the author op 1 loaded for
    // Book:b1, and the would-be book points at another author.
    const authors: Record<string, { id: string; name: string }> = { a1: { id: "a1", name: "Ann" }, a2: { id: "a2", name: "Bob" } };
    const shop = createRayfoldServer({
      schema: `entity Author { id: ID name: String } entity Book { id: ID author: Author } query book(id: ID): Book? command move(id: ID, authorId: ID): Book @simulate`,
      resolvers: {
        Query: { book: ({ id }: { id: string }) => ({ id, authorId: "a1" }) },
        Command: { move: ({ id, authorId }: { id: string; authorId: string }) => ({ id, authorId }) },
        Book: { author: (books: Array<{ authorId: string }>) => books.map((b) => authors[b.authorId]) },
      } as never,
    });
    const frames = await shop.collect(
      {
        ops: [
          { id: 1, op: "book", args: { id: "b1" }, shape: "{ id author { name } }" },
          { id: 2, op: "move", args: { id: { $ref: "1.id" }, authorId: "a2" }, shape: "{ author { name } }", key: "move-0000000000001", simulate: true },
        ],
      },
      { viewer: { id: "u1" } },
    );
    expect(frames.find((f) => (f as { id?: number }).id === 1)).toMatchObject({ data: { author: { name: "Ann" } } });
    expect(frames.find((f) => (f as { id?: number }).id === 2)).toMatchObject({ ok: { author: { name: "Bob" } } });
  });

  it("the same entity twice at one level is loaded once", async () => {
    const frames = await bs.server.collect({
      ops: [{ id: 1, op: "books", args: { filter: { authorId: "a1" }, page: { first: 10 } }, shape: "{ items { id author { name } } }" }],
    });
    const items = (frames[0] as { data: { items: Array<{ author: { name: string } }> } }).data.items;
    expect(items.length).toBeGreaterThan(1); // several books by one author
    expect(items.every((b) => b.author.name === "Ursula K. Le Guin")).toBe(true);
    expect(bs.store.calls["Book.author"]).toBe(1);
  });
});

describe("authorization", () => {
  const costShape = "{ id costPrice }";
  it("op-level policy: unauthenticated vs allowed", async () => {
    expect(await one({ id: 1, op: "myOrders" })).toMatchObject({ error: { code: "unauthenticated" } });
    expect(await one({ id: 1, op: "myOrders" }, u1)).toMatchObject({ data: { items: [], hasMore: false }, fin: true });
    expect(await one({ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY }, u1)).toMatchObject({ error: { code: "permission_denied" } });
  });

  it("field-level policy: explicit shapes fail atomically, owner and admin pass", async () => {
    expect(await one({ id: 1, op: "book", args: { id: "b1" }, shape: costShape })).toMatchObject({ error: { code: "unauthenticated", path: "costPrice" } });
    expect(await one({ id: 1, op: "book", args: { id: "b1" }, shape: costShape }, u2)).toMatchObject({ error: { code: "permission_denied", path: "costPrice" } });
    expect(await one({ id: 1, op: "book", args: { id: "b1" }, shape: costShape }, u1)).toMatchObject({ data: { costPrice: "6.10" } });
    expect(await one({ id: 1, op: "book", args: { id: "b1" }, shape: costShape }, admin)).toMatchObject({ data: { costPrice: "6.10" } });
  });

  it("field-level policy inside a list fails with the element path", async () => {
    const f = await one({ id: 1, op: "books", shape: "{ items { id costPrice } }" }, u2);
    // b1 is owned by u1, so the first element is denied
    expect(f).toMatchObject({ error: { code: "permission_denied", path: "items.0.costPrice" } });
  });

  it("@partial turns a denied field into null plus an error entry", async () => {
    const f = await one({ id: 1, op: "book", args: { id: "b1" }, shape: "{ id costPrice @partial }" }, u2);
    expect(f).toEqual({ id: 1, data: { $type: "Book", id: "b1", costPrice: null }, meta: { cost: 1 }, errors: [{ code: "permission_denied", message: "Not allowed to access Book.costPrice", path: "costPrice" }], fin: true });
  });

  it("entity-level policy: another customer's order reads null like a missing one, even with a shape; owner and admin see it", async () => {
    await one({ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: KEY }, u1);
    const shaped = await one({ id: 1, op: "order", args: { id: "o1" }, shape: "{ id status }" }, u2);
    expect(shaped).toMatchObject({ data: null, fin: true });
    expect(shaped).toEqual(await one({ id: 1, op: "order", args: { id: "o404" }, shape: "{ id status }" }, u2)); // existence is not revealed
    expect(await one({ id: 1, op: "order", args: { id: "o1" } }, u2)).toMatchObject({ data: null, fin: true });
    expect(await one({ id: 1, op: "order", args: { id: "o1" } }, u1)).toMatchObject({ data: { id: "o1", status: "PLACED" } });
    expect(await one({ id: 1, op: "order", args: { id: "o1" } }, admin)).toMatchObject({ data: { id: "o1" } });
  });
});

describe("entity policies at a non-null position", () => {
  it("still fail loudly: a null cannot stand in for a value the schema promises (guard for the nullable rule)", async () => {
    const s = createRayfoldServer({
      schema: `entity S @allow(read: viewer != null) { id: ID } query must: S query may: S?`,
      resolvers: { Query: { must: () => ({ id: "s" }), may: () => ({ id: "s" }) } },
    });
    expect(await s.collect({ ops: [{ id: 1, op: "must", shape: "{ id }" }] })).toMatchObject([{ id: 1, error: { code: "unauthenticated", path: "" } }]);
    expect(await s.collect({ ops: [{ id: 1, op: "may", shape: "{ id }" }] })).toMatchObject([{ id: 1, data: null, fin: true }]);
    expect(await s.collect({ ops: [{ id: 1, op: "may", shape: "{ id }" }] }, { viewer: u1 })).toMatchObject([{ id: 1, data: { id: "s" } }]);
  });
});

describe("deferred delivery", () => {
  it("@lazy fields arrive in a later frame unless @eager", async () => {
    const frames = await run([{ id: 1, op: "author", args: { id: "a1" }, shape: "{ id name bio }" }]);
    expect(frames).toEqual([
      { id: 1, data: { $type: "Author", id: "a1", name: "Ursula K. Le Guin" }, meta: { cost: 1 } },
      { id: 1, at: "", data: { bio: "American author of speculative fiction." } },
      { id: 1, fin: true },
    ]);
    const eager = await run([{ id: 1, op: "author", args: { id: "a1" }, shape: "{ id bio @eager }" }]);
    expect(eager).toEqual([{ id: 1, data: { $type: "Author", id: "a1", bio: "American author of speculative fiction." }, meta: { cost: 1 }, fin: true }]);
  });

  it("@defer blocks inside lists are addressed by path", async () => {
    const frames = await run([{ id: 1, op: "books", args: { page: { first: 2 } }, shape: "{ items { id @defer { title } } }" }]);
    expect(frames).toEqual([
      { id: 1, data: { items: [{ $type: "Book", id: "b1" }, { $type: "Book", id: "b2" }] }, meta: { cost: 8 } },
      { id: 1, at: "items.0", data: { title: "The Dispossessed" } },
      { id: 1, at: "items.1", data: { title: "Invisible Cities" } },
      { id: 1, fin: true },
    ]);
  });
});

describe("streams", () => {
  it("delivers projected items and ends with a canceled error on abort", async () => {
    const ac = new AbortController();
    const frames = new Signal<Frame>();
    const subscribed = new Signal<string>();
    const on = bs.server.events.on.bind(bs.server.events);
    vi.spyOn(bs.server.events, "on").mockImplementation((name, fn) => {
      const off = on(name, fn);
      subscribed.push(name);
      return off;
    });
    const consumer = (async () => {
      for await (const f of bs.server.execute({ ops: [{ id: 1, op: "stockUpdates", args: { bookIds: ["b1"] } }] }, { signal: ac.signal })) frames.push(f);
    })();
    await subscribed.until((names) => names.includes("StockChanged"), "stream subscribed to StockChanged");
    await bs.server.collect({ ops: [{ id: 1, op: "restock", args: { bookId: "b2", qty: 1 }, key: KEY + "a" }] }, { viewer: admin }); // filtered out
    await bs.server.collect({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY + "b" }] }, { viewer: admin });
    await frames.atLeast(1, "stream item"); // b2's change came first, so a broken filter would put b2 here
    ac.abort();
    await bounded(consumer, "stream ended on abort");
    expect(frames.items).toEqual([{ id: 1, item: { bookId: "b1", stock: 6 } }, { id: 1, error: { code: "canceled", message: "Canceled" }, fin: true }]);
  });

  it("a stream whose resolver ignores the signal still ends at its deadline, and is asked to finish once it can", async () => {
    // the resolver waits on something that never comes; awaiting its return() queued behind that wait for good
    let release = () => {};
    const stuck = new Promise<void>((r) => (release = r));
    const cleaned = new Signal<true>();
    const server = createRayfoldServer({
      schema: `event Tick { n: Int } stream ticks: Tick`,
      resolvers: {
        Stream: {
          ticks: async function* () {
            try {
              yield { n: 1 };
              await stuck;
              yield { n: 2 };
            } finally {
              cleaned.push(true);
            }
          },
        },
      } as never,
    });
    const frames = await bounded(server.collect({ ops: [{ id: 1, op: "ticks", deadline: 50 }] }), "the stream ending at its deadline");
    expect(frames).toEqual([
      { id: 1, item: { n: 1 } },
      { id: 1, error: { code: "deadline_exceeded", message: "Deadline exceeded" }, fin: true },
    ]);
    // guard: the generator is still asked to return, so its cleanup runs as soon as it wakes, and it yields no more
    release();
    await cleaned.atLeast(1, "the generator's finally block");
  });

  it("stream items are projected like query data: $type in full frames, stripped in compact ones except on union members", async () => {
    const feed = createRayfoldServer({
      schema: `entity Book { id: ID title: String } entity Author { id: ID name: String } union Hit = Book | Author stream books: Book stream hits: Hit`,
      resolvers: {
        Stream: {
          books: async function* () {
            yield { id: "b1", title: "T", internal: "not in the schema" };
          },
          hits: async function* () {
            yield { $type: "Author", id: "a1", name: "A" };
          },
        },
      },
    });
    expect(await feed.collect({ ops: [{ id: 1, op: "books" }] })).toEqual([{ id: 1, item: { $type: "Book", id: "b1", title: "T" } }, { id: 1, fin: true }]);
    expect(await feed.collect({ ops: [{ id: 1, op: "books", compact: true }] })).toEqual([{ id: 1, item: { id: "b1", title: "T" } }, { id: 1, fin: true }]);
    expect(await feed.collect({ ops: [{ id: 1, op: "hits", compact: true }] })).toEqual([{ id: 1, item: { $type: "Author", id: "a1", name: "A" } }, { id: 1, fin: true }]);
  });
});

describe("batch-level rules", () => {
  it("rejects malformed envelopes without executing anything", async () => {
    expect(await bs.server.collect({ ops: [] })).toEqual([{ error: { code: "invalid_argument", message: "ops must not be empty" }, fin: true }]);
    expect(await run([{ id: 1, op: "book", args: { id: { $ref: "2.id" } } }, { id: 2, op: "book", args: { id: "b1" } }])).toMatchObject([{ error: { code: "invalid_argument", message: expect.stringContaining("earlier op") } }]);
    expect(await run([{ id: 1, op: "book", args: { id: "b1" } }, { id: 1, op: "book", args: { id: "b1" } }])).toMatchObject([{ error: { code: "invalid_argument", message: expect.stringContaining("duplicate") } }]);
    expect(await run([{ id: 1, op: "nope" }])).toMatchObject([{ error: { code: "invalid_argument" } }]);
    expect(bs.store.calls).toEqual({});
  });

  it("a batch over maxOps is refused whole and nothing runs; a batch of exactly maxOps runs (guard)", async () => {
    const two = createBookstore({ maxOps: 2 });
    const book = (id: number) => ({ id, op: "book", args: { id: "b1" }, shape: "{ id }" });
    expect(await two.server.collect({ ops: [book(1), book(2), book(3)] })).toEqual([{ error: { code: "resource_exhausted", message: "At most 2 ops per batch" }, fin: true }]);
    expect(two.store.calls).toEqual({});
    expect(await two.server.collect({ ops: [book(1), book(2)] })).toEqual([
      { id: 1, data: { $type: "Book", id: "b1" }, meta: { cost: 1 }, fin: true },
      { id: 2, data: { $type: "Book", id: "b1" }, meta: { cost: 1 }, fin: true },
    ]);
  });

  it("a shape selecting more than maxFields is refused before its op runs; exactly maxFields runs (guard)", async () => {
    const three = createBookstore({ maxFields: 3 });
    const book = (shape: string) => three.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape }] });
    expect(await book("{ id title stock price }")).toEqual([{ id: 1, error: { code: "resource_exhausted", message: "Shape selects 4 fields, max 3" }, fin: true }]);
    expect(three.store.calls).toEqual({});
    expect(await book("{ id title stock }")).toEqual([{ id: 1, data: { $type: "Book", id: "b1", title: "The Dispossessed", stock: 5 }, meta: { cost: 1 }, fin: true }]);
  });

  it("timing adds meta.ms, measured on the server's clock from the op's start; off by default (guard)", async () => {
    let t = 1_000;
    const timed = (timing?: boolean) =>
      createRayfoldServer({
        schema: `entity A { id: ID } query a: A`,
        resolvers: { Query: { a: () => { t += 7; return { id: "a" }; } } },
        now: () => t,
        ...(timing === undefined ? {} : { timing }),
      });
    expect(await timed(true).collect({ ops: [{ id: 1, op: "a" }] })).toEqual([{ id: 1, data: { $type: "A", id: "a" }, meta: { cost: 1, ms: 7 }, fin: true }]);
    expect(await timed().collect({ ops: [{ id: 1, op: "a" }] })).toEqual([{ id: 1, data: { $type: "A", id: "a" }, meta: { cost: 1 }, fin: true }]);
  });

  it("enforces the cost budget for the whole batch", async () => {
    const small = createBookstore({ budget: 10 });
    const frames = await small.server.collect({ ops: [{ id: 1, op: "books", args: { page: { first: 50 } } }] });
    expect(frames).toEqual([{ error: { code: "resource_exhausted", message: "Batch cost 106 exceeds budget 10", data: { cost: 106, budget: 10 } }, fin: true }]);
  });

  it("charges rows and loads, not columns: scalars are free, an object field costs 1, a page 1 more per row", async () => {
    const cost = async (shape: string) => ((await bs.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape }] }))[0] as { meta: { cost: number } }).meta.cost;
    expect(await cost("{ id title format price stock }")).toBe(1);
    expect(await cost("{ id author { name } }")).toBe(2);
    // book 1 + reviews 1 + 3 rows + items 1; the rows' scalars are free
    expect(await cost("{ reviews(page: { first: 3 }) { items { rating body } } }")).toBe(6);
    // guard: rows are still charged, so 200 rows of scalars are not free
    expect(await cost("{ reviews(page: { first: 200 }) { items { rating body } } }")).toBe(203);
    // guard: a scalar with its own @cost is charged it, so the free default is not blanket
    const priced = createRayfoldServer({ schema: `entity A { id: ID n: Int @cost(base: 3) } query a: A`, resolvers: { Query: { a: () => ({ id: "a", n: 1 }) } } });
    expect(await priced.collect({ ops: [{ id: 1, op: "a", shape: "{ id n }" }] })).toMatchObject([{ meta: { cost: 4 } }]);
    expect(await priced.collect({ ops: [{ id: 1, op: "a", shape: "{ id }" }] })).toMatchObject([{ meta: { cost: 1 } }]);
  });

  it("trusted-shapes mode accepts only registered shape ids", async () => {
    const prod = createBookstore({ trustedShapes: true });
    const id = prod.server.registerShape("{ id title }");
    expect(id).toMatch(/^sha256:/);
    expect(await prod.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] })).toMatchObject([{ error: { code: "permission_denied" } }]);
    expect(await prod.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: id }] })).toMatchObject([{ data: { id: "b1", title: "The Dispossessed" } }]);
    expect(await prod.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "sha256:" + "0".repeat(64) }] })).toMatchObject([{ error: { code: "not_found" } }]);
  });

  it("independent queries run concurrently and frames may interleave", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = createRayfoldServer({
      schema: `entity A { id: ID } query slow: A query fast: A`,
      resolvers: { Query: { slow: async () => { await gate; return { id: "s" }; }, fast: () => ({ id: "f" }) } },
    });
    const frames = slow.execute({ ops: [{ id: 1, op: "slow" }, { id: 2, op: "fast" }] })[Symbol.asyncIterator]();
    // op 1 cannot produce a frame while it is gated, so receiving any frame at all proves op 2 was not held back
    expect((await bounded(frames.next(), "a frame while op 1 is gated")).value).toEqual({ id: 2, data: { $type: "A", id: "f" }, meta: { cost: 1 }, fin: true });
    release();
    expect((await bounded(frames.next(), "op 1 after release")).value).toEqual({ id: 1, data: { $type: "A", id: "s" }, meta: { cost: 1 }, fin: true });
    expect((await bounded(frames.next(), "end of batch")).done).toBe(true);
  });
});

describe("deadlines", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("batch deadline cancels unfinished ops with deadline_exceeded", async () => {
    const hang = createRayfoldServer({
      schema: `entity A { id: ID } query hang: A`,
      resolvers: { Query: { hang: (_a, ctx) => new Promise((_r, rej) => ctx.signal.addEventListener("abort", () => rej(ctx.signal.reason))) } },
    });
    const p = hang.collect({ ops: [{ id: 1, op: "hang" }], meta: { deadline: 50 } });
    await vi.advanceTimersByTimeAsync(60);
    expect(await p).toEqual([{ id: 1, error: { code: "deadline_exceeded", message: "Batch deadline exceeded" }, fin: true }]);
  });

  it("an op that finishes before the batch deadline is left alone and the timer is cleared (guard)", async () => {
    const quick = createRayfoldServer({
      schema: `entity A { id: ID } query quick: A`,
      resolvers: { Query: { quick: () => new Promise((r) => setTimeout(() => r({ id: "q" }), 40)) } },
    });
    const p = quick.collect({ ops: [{ id: 1, op: "quick" }], meta: { deadline: 50 } });
    await vi.advanceTimersByTimeAsync(40);
    expect(await p).toEqual([{ id: 1, data: { $type: "A", id: "q" }, meta: { cost: 1 }, fin: true }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a deferred part still running at the deadline does not take back what already arrived", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID slow: String? @lazy } query a: A`,
      resolvers: {
        Query: { a: () => ({ id: "a1" }) },
        A: { slow: (_p: unknown[], _a: unknown, ctx: { signal: AbortSignal }) => new Promise((_r, rej) => ctx.signal.addEventListener("abort", () => rej(ctx.signal.reason))) },
      },
    });
    const p = s.collect({ ops: [{ id: 1, op: "a", shape: "{ id slow }" }], meta: { deadline: 50 } });
    await vi.advanceTimersByTimeAsync(60);
    const frames = await p;
    // the page arrived before the deadline and stands; only the part that was still being fetched fails
    expect(frames[0]).toMatchObject({ id: 1, data: { $type: "A", id: "a1" } });
    expect(frames.at(-1)).toMatchObject({ id: 1, error: { code: "deadline_exceeded" }, fin: true });
  });

  it("a per-op deadline cancels only that op; its batch sibling completes", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID } query hang: A query quick: A`,
      resolvers: {
        Query: {
          hang: (_a, ctx) => new Promise((_r, rej) => ctx.signal.addEventListener("abort", () => rej(ctx.signal.reason))),
          quick: () => new Promise((r) => setTimeout(() => r({ id: "q" }), 80)),
        },
      },
    });
    const p = s.collect({ ops: [{ id: 1, op: "hang", deadline: 30 }, { id: 2, op: "quick" }] });
    await vi.advanceTimersByTimeAsync(80);
    expect(await p).toEqual([
      { id: 1, error: { code: "deadline_exceeded", message: "Deadline exceeded" }, fin: true },
      { id: 2, data: { $type: "A", id: "q" }, meta: { cost: 1 }, fin: true },
    ]);
  });
});

describe("argument presence reaches the resolver unchanged", () => {
  const echo = (seen: Array<Record<string, unknown>>) =>
    createRayfoldServer({
      schema: `entity A { id: ID } command set(id: ID, note: String?, tag: String? = "t", n: Int = 1): A @idempotent(false)`,
      resolvers: {
        Command: {
          set: (args: Record<string, unknown>) => {
            seen.push({ ...args });
            return { id: "a" };
          },
        },
      },
    });
  const set = (args: Record<string, unknown>) => ({ ops: [{ id: 1, op: "set", args }] });

  it("absent stays absent, null stays null, and a default fills only an absent value", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const s = echo(seen);
    await s.collect(set({ id: "a" }));
    await s.collect(set({ id: "a", note: null, tag: null }));
    await s.collect(set({ id: "a", note: "x", tag: "y", n: 3 }));
    expect(seen).toEqual([{ id: "a", tag: "t", n: 1 }, { id: "a", note: null, tag: null, n: 1 }, { id: "a", note: "x", tag: "y", n: 3 }]);
    expect(Object.keys(seen[0]!).sort()).toEqual(["id", "n", "tag"]); // `note` is absent, not present-and-undefined
  });

  it("null on a non-null argument is rejected before the resolver runs, even when the argument has a default", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const s = echo(seen);
    expect(await s.collect(set({ id: "a", n: null }))).toEqual([{ id: 1, error: { code: "invalid_argument", message: "set().n: must not be null" }, fin: true }]);
    expect(await s.collect(set({ id: null }))).toEqual([{ id: 1, error: { code: "invalid_argument", message: "set().id: required" }, fin: true }]);
    expect(seen).toEqual([]);
  });
});

describe("conditional commands (ifVersion) through the batch pipeline", () => {
  const edit = (ifVersion?: string | number, extra: Record<string, unknown> = {}) => ({
    id: 1,
    op: "editReview",
    args: { id: "r2", input: { rating: 2, body: "Changed my mind." } },
    key: KEY,
    shape: "{ id rating version }",
    ...(ifVersion === undefined ? {} : { ifVersion }),
    ...extra,
  });

  it("a matching ifVersion applies the write and bumps the version", async () => {
    expect(await one(edit(1), u1)).toMatchObject({ ok: { $type: "Review", id: "r2", rating: 2, version: 2 } });
    expect(bs.store.reviews.get("r2")).toMatchObject({ rating: 2, version: 2 });
  });

  it("a stale ifVersion fails with the stored entity in the op's shape and writes nothing", async () => {
    expect(await one(edit(7), u1)).toEqual({
      id: 1,
      error: { code: "failed_precondition", type: "VersionConflict", message: "Review:r2 is at version 1, not 7", data: { key: "Review:r2", expected: 7, actual: 1, current: { $type: "Review", id: "r2", rating: 4, version: 1 } } },
      fin: true,
    });
    expect(bs.store.reviews.get("r2")).toMatchObject({ rating: 4, version: 1 });
  });

  it("versions compare as text: \"1\" matches version 1, \"01\" does not", async () => {
    expect(await one(edit("01"), u1)).toMatchObject({ error: { type: "VersionConflict", data: { expected: "01", actual: 1 } } });
    expect(await one(edit("1"), u1)).toMatchObject({ ok: { version: 2 } });
  });

  it("without ifVersion the write is unconditional (guard)", async () => {
    expect(await one(edit(), u1)).toMatchObject({ ok: { rating: 2, version: 2 } });
  });

  it("a conflict is not recorded under the idempotency key, so the corrected retry with the same key runs", async () => {
    expect(await one(edit(7), u1)).toMatchObject({ error: { type: "VersionConflict" } });
    const retry = await one(edit(1), u1);
    expect(retry).toMatchObject({ ok: { version: 2 } });
    expect((retry as { meta?: { replay?: boolean } }).meta?.replay).toBeUndefined();
    expect(bs.store.calls["Command.editReview"]).toBe(2);
  });

  it("a compact op's conflict still carries a fully typed current entity, for the client cache", async () => {
    expect(await one(edit(7, { compact: true }), u1)).toMatchObject({ error: { data: { current: { $type: "Review", id: "r2", rating: 4, version: 1 } } } });
  });

  it("a conflict on an entity that no longer exists carries current: null", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID v: Int @version } command put(id: ID): A @idempotent(false)`,
      resolvers: {
        Command: {
          put: (_a, ctx) => {
            ctx.checkVersion("A:x", 3, null);
            return { id: "x", v: 4 };
          },
        },
      },
    });
    expect(await s.collect({ ops: [{ id: 1, op: "put", args: { id: "x" }, ifVersion: 2 }] })).toEqual([
      { id: 1, error: { code: "failed_precondition", type: "VersionConflict", message: "A:x is at version 3, not 2", data: { key: "A:x", expected: 2, actual: 3, current: null } }, fin: true },
    ]);
  });
});

describe("keyOptional (set only by transports for idempotent HTTP methods)", () => {
  const del = { id: 1, op: "deleteReview", args: { id: "r2" } };

  it("cannot be switched on from the wire envelope", async () => {
    const frames = await bs.server.collect({ ops: [{ ...del, keyOptional: true } as never], keyOptional: true } as never, { viewer: u1 });
    expect(frames).toEqual([{ id: 1, error: { code: "invalid_argument", message: "deleteReview(): commands require an idempotency key of 16-128 characters" }, fin: true }]);
    expect(bs.store.reviews.has("r2")).toBe(true);
  });

  it("lets a transport run a command without a key (guard: the same op now runs)", async () => {
    expect(await bs.server.collect({ ops: [del] }, { viewer: u1, keyOptional: true })).toMatchObject([{ id: 1, ok: { id: "r2" } }]);
    expect(bs.store.reviews.has("r2")).toBe(false);
  });

  it("still honours a key when one is sent", async () => {
    const first = await bs.server.collect({ ops: [{ ...del, key: KEY }] }, { viewer: u1, keyOptional: true });
    const again = await bs.server.collect({ ops: [{ ...del, key: KEY }] }, { viewer: u1, keyOptional: true });
    expect(again).toEqual([{ ...first[0], meta: { ...(first[0] as { meta: object }).meta, replay: true } }]);
    expect(bs.store.calls["Command.deleteReview"]).toBe(1);
  });
});

describe("idempotency records", () => {
  type Ok = { ok: Record<string, unknown>; patch: unknown[]; meta?: Record<string, unknown> };
  const restock = (key: string, compact = false) => ({ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key, ...(compact ? { compact: true } : {}) });

  it("a replay answers in the form the retry asks for, whichever form the first call used", async () => {
    const compactFirst = (await one(restock(KEY + "1", true), admin)) as Ok;
    const plainRetry = (await one(restock(KEY + "1"), admin)) as Ok;
    const compactRetry = (await one(restock(KEY + "1", true), admin)) as Ok;
    expect(compactFirst).toMatchObject({ ok: { id: "b1", stock: 6 }, patch: [] });
    expect(compactFirst.ok).not.toHaveProperty("$type");
    expect(plainRetry.ok).toMatchObject({ $type: "Book", author: { $type: "Author" } });
    expect(stripTypes(plainRetry.ok)).toEqual(compactFirst.ok);
    expect(plainRetry.patch[0]).toEqual({ set: "Book:b1", value: expect.objectContaining({ $type: "Book", stock: 6 }) });
    expect(plainRetry.meta).toEqual({ cost: 2, replay: true });
    expect(compactRetry).toEqual({ ...compactFirst, meta: { replay: true } });

    const plainFirst = (await one(restock(KEY + "2"), admin)) as Ok;
    expect(await one(restock(KEY + "2", true), admin)).toEqual({ id: 1, ok: stripTypes(plainFirst.ok), patch: [], meta: { replay: true }, fin: true });
    expect(await one(restock(KEY + "2"), admin)).toEqual({ ...plainFirst, meta: { cost: 2, replay: true } });
    expect(bs.store.calls["Command.restock"]).toBe(2);
    expect(bs.store.books.get("b1")!.stock).toBe(7);
  });

  it("a replay answers under the retrying op's id and still feeds a later $ref", async () => {
    const place = { op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 1 }] } }, key: KEY };
    const first = await one({ id: 1, ...place }, u1);
    const frames = await run([{ id: 1, op: "book", args: { id: "b2" }, shape: "{ id }" }, { id: 2, ...place }, { id: 3, op: "order", args: { id: { $ref: "2.id" } }, shape: "{ id status }" }], u1);
    expect(frames.filter((f) => "ok" in f)).toEqual([{ ...first, id: 2, meta: { ...(first as { meta: object }).meta, replay: true } }]);
    expect(frames.find((f) => idOf(f) === 3)).toMatchObject({ data: { id: "o1", status: "PLACED" } });
    expect(frames.map(idOf).sort()).toEqual([1, 2, 3]);
    expect(bs.store.orders.size).toBe(1);
  });

  it("a record replays while it is younger than its TTL, and is forgotten at that age", async () => {
    let t = 1_000;
    const b = createBookstore({ idempotency: new MemoryIdempotencyStore(60_000, () => t), now: () => t });
    const call = async () => ((await b.server.collect({ ops: [restock(KEY)] }, { viewer: admin }))[0] as Ok).meta;
    expect(await call()).toEqual({ cost: 2 });
    t += 59_999;
    expect(await call()).toEqual({ cost: 2, replay: true });
    t += 1;
    expect(await call()).toEqual({ cost: 2 });
    expect(b.store.calls["Command.restock"]).toBe(2);
    expect(b.store.books.get("b1")!.stock).toBe(7);
  });

  it("the server clock drives the default store's 24 h TTL", async () => {
    let t = 0;
    const b = createBookstore({ now: () => t });
    const call = async () => ((await b.server.collect({ ops: [restock(KEY)] }, { viewer: admin }))[0] as Ok).meta;
    expect(await call()).toEqual({ cost: 2 });
    t = 24 * 3_600_000 - 1;
    expect(await call()).toEqual({ cost: 2, replay: true });
    t += 1;
    expect(await call()).toEqual({ cost: 2 });
    expect(b.store.calls["Command.restock"]).toBe(2);
  });
});

// ------------------------------------------------------------------ security (spec 12)
import { MemoryShapeRegistry as SecRegistry } from "./views.ts";
import { loadSchema as secLoadSchema } from "@rayfold/schema";
import { bookstoreSchemaText as secSchemaText } from "../../../examples/bookstore-ts/src/index.ts";

describe("security: bounded memory", () => {
  /** A finished key, as a command leaves it: claimed, then recorded under that claim's token. */
  const finish = async (store: MemoryIdempotencyStore, key: string, at: number) => {
    const claim = await store.claim("s", key, 1_000);
    if (claim.state !== "owned") throw new Error(`${key} was not free: ${claim.state}`);
    await store.put("s", key, { argsHash: "h", frame: {}, at }, claim.token);
  };

  it("the idempotency store sweeps expired records on write and never holds more than its cap", async () => {
    let t = 0;
    const store = new MemoryIdempotencyStore(1_000, () => t, 3);
    for (const k of ["a", "b", "c", "d"]) await finish(store, k, t);
    expect(store.size).toBe(3);
    expect(await store.get("s", "a")).toBeUndefined(); // the oldest went first
    expect(await store.get("s", "d")).toEqual({ argsHash: "h", frame: {}, at: t });
    t = 1_001;
    await finish(store, "e", t);
    expect(store.size).toBe(1); // b, c and d expired and were swept by the write
  });

  // spec 03 section 4: a record has expired once it is as old as its time to live. Reading, claiming and sweeping each
  // draw the line themselves, so each is held to it, from both sides.
  it("a read answers a millisecond short of the record's time to live, and nothing at it", async () => {
    let t = 5_000;
    const store = new MemoryIdempotencyStore(1_000, () => t);
    await finish(store, "a", t);
    t = 5_999;
    expect(await store.get("s", "a")).toEqual({ argsHash: "h", frame: {}, at: 5_000 });
    t = 6_000;
    expect(await store.get("s", "a")).toBeUndefined();
  });

  it("a claim finds the record a millisecond short of its time to live, and takes the key at it", async () => {
    let t = 5_000;
    const store = new MemoryIdempotencyStore(1_000, () => t);
    await finish(store, "a", t);
    t = 5_999;
    expect(await store.claim("s", "a", 100)).toEqual({ state: "done", record: { argsHash: "h", frame: {}, at: 5_000 } });
    t = 6_000;
    expect(await store.claim("s", "a", 100)).toEqual({ state: "owned", token: expect.any(String) });
  });

  it("a write sweeps nothing a millisecond short of a record's time to live, and the record at it", async () => {
    let t = 5_000;
    const store = new MemoryIdempotencyStore(1_000, () => t);
    await finish(store, "old", t);
    t = 5_999;
    await finish(store, "young", t);
    expect(store.size).toBe(2);
    t = 6_000;
    await finish(store, "new", t);
    expect(store.size).toBe(2); // old went, without anyone reading it; young has 999 ms left
    t = 5_999; // looked at from before it expired, so that the read itself drops nothing
    expect(await store.get("s", "old")).toBeUndefined();
    expect(await store.get("s", "young")).toEqual({ argsHash: "h", frame: {}, at: 5_999 });
  });

  it("a read that finds a record expired drops it, so a key nobody writes again does not stay in memory", async () => {
    let t = 5_000;
    const store = new MemoryIdempotencyStore(1_000, () => t);
    await finish(store, "a", t);
    t = 5_999;
    await store.get("s", "a");
    expect(store.size).toBe(1); // guard: a read short of the line drops nothing
    t = 6_000;
    await store.get("s", "a");
    expect(store.size).toBe(0);
  });

  it("a record is as old as the time it carries, and the sweep measures it by the store's clock", async () => {
    let t = 5_000;
    const store = new MemoryIdempotencyStore(1_000, () => t);
    await finish(store, "old", t);
    // finished at 5_500 by the store's clock, but recorded as of 5_200, when the command answered
    t = 5_500;
    await finish(store, "answered", 5_200);
    t = 6_199;
    expect(await store.get("s", "answered")).toEqual({ argsHash: "h", frame: {}, at: 5_200 });
    t = 6_200;
    expect(await store.get("s", "answered")).toBeUndefined();

    // a write stamped earlier than the store's own time still sweeps what that time has expired
    t = 6_000;
    const late = await store.claim("s", "late", 1_000);
    if (late.state !== "owned") throw new Error(`expected to own the key, got ${late.state}`);
    await store.put("s", "late", { argsHash: "h", frame: {}, at: 5_900 }, late.token);
    t = 5_000;
    expect(await store.get("s", "old")).toBeUndefined();
  });

  it("a record finished after a younger one is swept in its turn, not held back behind it", async () => {
    let t = 0;
    const store = new MemoryIdempotencyStore(1_000, () => t);
    const slow = await store.claim("s", "slow", 5_000);
    if (slow.state !== "owned") throw new Error(`expected to own the key, got ${slow.state}`);
    await finish(store, "quick", t);
    t = 500;
    await store.put("s", "slow", { argsHash: "h", frame: {}, at: t }, slow.token);
    t = 1_000;
    await finish(store, "new", t);
    t = 0; // looked at from before anything expired, so that the reads themselves drop nothing
    expect(await store.get("s", "quick")).toBeUndefined();
    expect(await store.get("s", "slow")).toEqual({ argsHash: "h", frame: {}, at: 500 });
    expect(store.size).toBe(2);
  });

  it("a claim is in flight until its lease runs out, and the key is free at that moment, past the TTL included", async () => {
    let t = 0;
    const store = new MemoryIdempotencyStore(1_000, () => t);
    const running = await store.claim("s", "k", 500);
    if (running.state !== "owned") throw new Error(`expected to own the key, got ${running.state}`);
    t = 400;
    expect(await store.renew("s", "k", running.token, 1_600)).toBe(true); // held until 2_000, twice the TTL
    t = 1_999;
    expect(await store.claim("s", "k", 100)).toEqual({ state: "inflight", heldUntil: 2_000 });
    // a write at that moment does not sweep the claim either
    await finish(store, "other", t);
    expect(store.size).toBe(2);
    t = 2_000;
    expect(await store.claim("s", "k", 100)).toEqual({ state: "owned", token: expect.any(String) });
  });

  it("a write sweeps a claim whose lease ran out at that moment", async () => {
    let t = 0;
    const store = new MemoryIdempotencyStore(1_000, () => t);
    await store.claim("s", "dead", 300);
    t = 299;
    await finish(store, "a", t);
    expect(store.size).toBe(2); // guard: a millisecond before, the claim stays
    t = 300;
    await finish(store, "b", t);
    expect(store.size).toBe(2); // the dead claim went; a and b are there
    expect(await store.claim("s", "dead", 100)).toEqual({ state: "owned", token: expect.any(String) });
  });

  it("a claim whose holder died and whose key nobody retried does not block the sweep behind it", async () => {
    let t = 0;
    const store = new MemoryIdempotencyStore(1_000, () => t, 2);
    const dead = await store.claim("s", "gone", 10); // never renewed, never recorded, never retried
    if (dead.state !== "owned") throw new Error(`expected to own the key, got ${dead.state}`);
    t = 11; // its lease has run out
    for (const k of ["a", "b", "c", "d"]) await finish(store, k, t);
    expect(store.size).toBe(2); // the dead claim went with the oldest records
    expect(await store.get("s", "a")).toBeUndefined();
    expect(await store.get("s", "d")).toEqual({ argsHash: "h", frame: {}, at: t });
  });

  it("guard: a claim still in flight is never swept, and the answer it records afterwards replays", async () => {
    let t = 0;
    const store = new MemoryIdempotencyStore(1_000, () => t, 2);
    const live = await store.claim("s", "running", 1_000);
    if (live.state !== "owned") throw new Error(`expected to own the key, got ${live.state}`);
    for (const k of ["a", "b", "c", "d"]) await finish(store, k, t);
    expect(store.size).toBe(2); // the claim counts against the cap and the records made room for it
    expect(await store.get("s", "c")).toBeUndefined();
    expect(await store.get("s", "d")).toEqual({ argsHash: "h", frame: {}, at: t });
    expect(await store.claim("s", "running", 1_000)).toEqual({ state: "inflight", heldUntil: 1_000 });
    await store.put("s", "running", { argsHash: "h", frame: { ok: 1 }, at: t }, live.token);
    expect(await store.get("s", "running")).toMatchObject({ frame: { ok: 1 } });
  });

  it("through the server, a capped store forgets the oldest key while the newest still replays (guard)", async () => {
    const b = createBookstore({ idempotency: new MemoryIdempotencyStore(60_000, () => 0, 2) });
    const restock = (key: string) => b.server.collect({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key }] }, { viewer: admin });
    for (const k of ["1", "2", "3"]) await restock(KEY + k);
    expect(((await restock(KEY + "3"))[0] as { meta: { replay?: boolean } }).meta.replay).toBe(true);
    expect(((await restock(KEY + "1"))[0] as { meta: { replay?: boolean } }).meta.replay).toBeUndefined(); // evicted: it ran again
    expect(b.store.calls["Command.restock"]).toBe(4);
  });

  it("the shape registry keeps a bounded number of learned shapes, never rejected ones, and always keeps pinned ones", async () => {
    const registry = new SecRegistry(secLoadSchema(secSchemaText()).ir, 2);
    const b = createBookstore({ shapes: registry });
    const pinned = b.server.registerShape("{ id title }");
    const ask = (shape: string) => b.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape }] });
    for (const s of ["{ id }", "{ id stock }", "{ id format }"]) await ask(s);
    expect(registry.size).toBe(3); // one pinned + the two most recent learned shapes
    expect(await ask("{ " + "author { books { items { ".repeat(4) + "id" + " } } }".repeat(4) + " }")).toMatchObject([{ error: { code: "resource_exhausted" } }]);
    expect(registry.size).toBe(3); // the rejected shape was not remembered
    expect(await ask(pinned)).toMatchObject([{ data: { id: "b1", title: "The Dispossessed" } }]);
  });
});

describe("security: cost cannot be lowered by bad input", () => {
  const books = (first: unknown, id = 1) => ({ id, op: "books", args: { page: { first } }, shape: "{ items { id } }" });
  const costOf = async (op: RequestEnvelope["ops"][number]) => ((await bs.server.collect({ ops: [op] }))[0] as { meta: { cost: number } }).meta.cost;

  it("an op with invalid arguments never runs and costs nothing; the valid op is charged in full", async () => {
    const c = await costOf(books(3));
    const tight = createBookstore({ budget: c });
    const three = { id: 1, data: { items: ["b1", "b2", "b3"].map((id) => ({ $type: "Book", id })) }, meta: { cost: c }, fin: true };
    expect(await tight.server.collect({ ops: [books(3)] })).toEqual([three]);
    const withJunk = await tight.server.collect({ ops: [books(3), books(-100000, 2)] });
    expect(withJunk.find((f) => idOf(f) === 2)).toMatchObject({ error: { code: "invalid_argument", message: "books().page.first: must be >= 0" } });
    expect(withJunk.find((f) => idOf(f) === 1)).toEqual(three);
    // guard: two real ops are both charged, so the same budget refuses them
    expect(await tight.server.collect({ ops: [books(3), books(3, 2)] })).toMatchObject([{ error: { code: "resource_exhausted", message: `Batch cost ${2 * c} exceeds budget ${c}` } }]);
  });

  it("a page size that comes from a $ref is costed as the largest page", async () => {
    const small = await costOf(books(3));
    const largest = await costOf(books(200));
    const tight = createBookstore({ budget: small + 20 });
    const frames = await tight.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ stock }" }, { id: 2, op: "books", args: { page: { first: { $ref: "1.stock" } } }, shape: "{ items { id } }" }] });
    const stock = await costOf({ id: 1, op: "book", args: { id: "b1" }, shape: "{ stock }" });
    const cost = stock + largest; // the $ref op charged as the largest page, not as the 5 the stock turns out to be
    expect(frames).toEqual([{ error: { code: "resource_exhausted", message: `Batch cost ${cost} exceeds budget ${small + 20}`, data: { cost, budget: small + 20 } }, fin: true }]);
  });
});

describe("security: a shape cannot slip past the cost model", () => {
  const SCHEMA = `
    entity Book { id: ID title: String reviews(page: PageArgs = { first: 10 }): Page<Review> }
    entity Review { id: ID book: Book }
    entity Author { id: ID name: String }
    union Hit = Book | Author
    query hit: Hit
    query named(page: PageArgs = { first: 10 }): Page<Book>
    query picks(p: PageArgs = { first: 10 }): Page<Book>
    query list(first: Int = 20, after: String?): Page<Book>
    query top(first: Int): [Book]
  `;
  const seen: Array<Record<string, unknown>> = [];
  const book = { $type: "Book", id: "b1", title: "Dune", reviews: { items: [], hasMore: false } };
  const page = (args: Record<string, unknown>) => (seen.push(args), { items: [book], hasMore: false });
  const shop = (opts: { budget?: number; maxDepth?: number; maxFields?: number } = {}) =>
    createRayfoldServer({ schema: SCHEMA, ...opts, resolvers: { Query: { hit: () => book, named: page, picks: page, list: page, top: (a: Record<string, unknown>) => (seen.push(a), [book]) } } });
  const frame = async (server: RayfoldServer, op: RequestEnvelope["ops"][number]) => (await server.collect({ ops: [op] }))[0] as { meta?: { cost: number }; error?: { code: string; message: string } };
  const reviews = (first: number, inner: string) => `reviews(page: { first: ${first} }) { items { id book { ${inner} } } }`;

  it("fields asked of a union are charged as each member would answer them, the dearest member counting", async () => {
    // the executor hands the bare fields to every member; looked up on the union they found nothing and cost 1
    const body = reviews(20, "id");
    const bare = await frame(shop(), { id: 1, op: "hit", shape: `{ ${body} }` });
    const onBook = await frame(shop(), { id: 1, op: "hit", shape: `{ ...on Book { ${body} } }` });
    expect(bare.meta?.cost).toBe(onBook.meta?.cost);
    expect(bare.meta?.cost).toBe(1 + 1 + 20 + 1 + 20); // hit, the reviews page and its 20 rows, items, a book on each row
  });

  it("so a union can no longer nest pages past the depth and field limits or the budget", async () => {
    const deep = `{ ${reviews(20, reviews(20, reviews(20, reviews(20, "id"))))} }`;
    expect(await frame(shop({ maxDepth: 8 }), { id: 1, op: "hit", shape: deep })).toMatchObject({ error: { code: "resource_exhausted", message: "Shape depth 13 exceeds 8" } });
    const wide = `{ ${reviews(200, reviews(200, "id"))} }`;
    expect((await shop({ budget: 1000 }).collect({ ops: [{ id: 1, op: "hit", shape: wide }] }))[0]).toMatchObject({ error: { code: "resource_exhausted" } });
    // guard: the same shape under a budget it fits runs
    expect((await frame(shop(), { id: 1, op: "hit", shape: `{ ${reviews(2, "id")} }` })).meta?.cost).toBe(1 + 1 + 2 + 1 + 2);
  });

  it("a PageArgs argument is read by its type, whatever it is called", async () => {
    const named = await frame(shop(), { id: 1, op: "named", args: { page: { first: 200 } }, shape: "{ items { id } }" });
    const picks = await frame(shop(), { id: 1, op: "picks", args: { p: { first: 200 } }, shape: "{ items { id } }" });
    expect(picks.meta?.cost).toBe(named.meta?.cost); // `p` was charged as a page of 20
    expect(picks.meta?.cost).toBe(1 + 200 + 1);
    // guard: its own default still applies when it is not sent
    expect((await frame(shop(), { id: 1, op: "picks", shape: "{ items { id } }" })).meta?.cost).toBe(1 + 10 + 1);
  });

  it("a page's own `first` argument is capped before the resolver sees it, and a negative one refused", async () => {
    seen.length = 0;
    await frame(shop(), { id: 1, op: "list", args: { first: 1_000_000 }, shape: "{ items { id } }" });
    expect(seen).toEqual([{ first: 200 }]);
    expect(await frame(shop(), { id: 1, op: "list", args: { first: -1 }, shape: "{ items { id } }" })).toMatchObject({ error: { code: "invalid_argument", message: "list().first: must be >= 0" } });
    // guard: a `first` on an op that returns no page means something else, and is left as sent
    seen.length = 0;
    await frame(shop(), { id: 1, op: "top", args: { first: 1_000 }, shape: "{ id }" });
    expect(seen).toEqual([{ first: 1_000 }]);
  });
});

describe("security: idempotency keys", () => {
  const notes = (seen: string[]) =>
    createRayfoldServer({
      schema: `entity N { id: ID text: String } command note(text: String): N command ping: N @idempotent(false)`,
      resolvers: {
        Command: {
          note: (args: { text: string }) => {
            seen.push(args.text);
            return { id: `n${seen.length}`, text: args.text };
          },
          ping: () => {
            seen.push("ping");
            return { id: "p", text: "pong" };
          },
        },
      },
    });

  it("an anonymous caller cannot use a key, since all anonymous callers would share one replay scope", async () => {
    const seen: string[] = [];
    const s = notes(seen);
    expect(await s.collect({ ops: [{ id: 1, op: "note", args: { text: "hi" }, key: KEY }] })).toEqual([{ id: 1, error: { code: "unauthenticated", message: "note(): idempotency keys need an identified caller" }, fin: true }]);
    expect(seen).toEqual([]);
    // guards: an identified caller uses the key and gets a replay; an unkeyed command still runs anonymously
    await s.collect({ ops: [{ id: 1, op: "note", args: { text: "hi" }, key: KEY }] }, { viewer: u1 });
    expect(await s.collect({ ops: [{ id: 1, op: "note", args: { text: "hi" }, key: KEY }] }, { viewer: u1 })).toMatchObject([{ meta: { replay: true } }]);
    expect(await s.collect({ ops: [{ id: 1, op: "ping" }] })).toMatchObject([{ ok: { text: "pong" } }]);
    expect(seen).toEqual(["hi", "ping"]);
  });

  it("a key is bound to its operation: another command with the same key is refused and never runs", async () => {
    await one({ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: KEY + "p" }, u1);
    await one({ id: 1, op: "payOrder", args: { id: "o1" }, key: KEY }, u1);
    expect(await one({ id: 1, op: "cancelOrder", args: { id: "o1" }, key: KEY }, u1)).toMatchObject({ error: { code: "already_exists", message: `Idempotency key ${KEY} was used for another operation or other arguments` } });
    expect(bs.store.calls["Command.cancelOrder"]).toBeUndefined();
    expect(bs.store.orders.get("o1")!.status).toBe("PAID");
    // guard: the same operation with the same key replays
    expect(await one({ id: 1, op: "payOrder", args: { id: "o1" }, key: KEY }, u1)).toMatchObject({ ok: { status: "PAID" }, meta: { replay: true } });
  });

  it("two retries that arrive together execute once; the second waits and replays the first result", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const store = new MemoryIdempotencyStore();
    const claims = new Signal<string>();
    const claim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementation(async (scope: string, key: string, lease: number) => {
      const c = await claim(scope, key, lease);
      claims.push(c.state);
      return c;
    });
    const s = createRayfoldServer({
      schema: `entity A { id: ID } command slow(n: Int): A`,
      resolvers: { Command: { slow: async () => { runs++; await gate; return { id: `a${runs}` }; } } },
      idempotency: store,
    });
    const call = () => s.collect({ ops: [{ id: 1, op: "slow", args: { n: 1 }, key: KEY }] }, { viewer: u1 });
    const first = call();
    const second = call();
    // released only once the second has found the key held, so the replay below is one that waited for the first
    await claims.until((c) => c.includes("owned") && c.includes("inflight"), "the second retry finding the key held");
    expect(runs).toBe(1);
    release();
    const [a, b] = await bounded(Promise.all([first, second]), "both retries answered");
    expect(runs).toBe(1);
    expect(a).toEqual([{ id: 1, ok: { $type: "A", id: "a1" }, patch: [{ set: "A:a1", value: { $type: "A", id: "a1" } }], meta: { cost: 1 }, fin: true }]);
    expect(b).toEqual([{ id: 1, ok: { $type: "A", id: "a1" }, patch: [{ set: "A:a1", value: { $type: "A", id: "a1" } }], meta: { cost: 1, replay: true }, fin: true }]);
    vi.restoreAllMocks();
  });
});

describe("security: dry runs, deadlines, $ref paths and numbers", () => {
  it("simulate is refused for a command that does not declare @simulate, so a careless resolver cannot write", async () => {
    let writes = 0;
    const s = createRayfoldServer({
      schema: `entity A { id: ID } command careless: A @idempotent(false) command careful: A @idempotent(false) @simulate`,
      resolvers: { Command: { careless: () => { writes++; return { id: "a" }; }, careful: (_a, ctx) => { if (!ctx.simulate) writes++; return { id: "b" }; } } },
    });
    expect(await s.collect({ ops: [{ id: 1, op: "careless", simulate: true }] })).toEqual([{ id: 1, error: { code: "failed_precondition", message: "careless() does not support dry runs" }, fin: true }]);
    expect(writes).toBe(0);
    expect(await s.collect({ ops: [{ id: 1, op: "careful", simulate: true }] })).toMatchObject([{ ok: { id: "b" } }]); // guard
    expect(writes).toBe(0);
  });

  it("deadlines must be whole milliseconds from 0 to 600000", async () => {
    const book = { id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" };
    for (const deadline of [-1, 600_001, 1.5]) {
      expect(await bs.server.collect({ ops: [book], meta: { deadline } })).toEqual([{ error: { code: "invalid_argument", message: "meta.deadline: expected whole milliseconds from 0 to 600000" }, fin: true }]);
    }
    expect(await bs.server.collect({ ops: [{ ...book, deadline: -5 }] })).toEqual([{ id: 1, error: { code: "invalid_argument", message: "deadline: expected whole milliseconds from 0 to 600000" }, fin: true }]);
    expect(await bs.server.collect({ ops: [{ ...book, deadline: 600_000 }], meta: { deadline: 600_000 } })).toMatchObject([{ data: { id: "b1" } }]); // guard
  });

  it("a $ref path reaches only the earlier result's own data, never its prototype", async () => {
    for (const path of ["__proto__", "constructor", "toString"]) {
      const frames = await run([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }, { id: 2, op: "book", args: { id: { $ref: `1.${path}` } } }]);
      expect(frames[1]).toMatchObject({ id: 2, error: { code: "invalid_argument", message: `ops.2.args.id: $ref 1.${path} resolved to nothing` } });
    }
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    const ok = await run([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }, { id: 2, op: "book", args: { id: { $ref: "1.id" } }, shape: "{ title }" }]);
    expect(ok[1]).toMatchObject({ data: { title: "The Dispossessed" } }); // guard
  });

  it("numbers that would silently lose digits are refused instead of rounded", async () => {
    expect(await one({ id: 1, op: "book", args: { id: 9007199254740993 } })).toMatchObject({ error: { code: "invalid_argument", message: "book().id: expected ID" } });
    expect(await one({ id: 1, op: "books", args: { filter: { maxPrice: 1e21 } } })).toMatchObject({ error: { code: "invalid_argument", message: "books().filter.maxPrice: expected Decimal" } });
    expect(await one({ id: 1, op: "books", args: { filter: { maxPrice: 10.5 } }, shape: "{ items { id } }" })).toEqual({ id: 1, data: { items: [{ $type: "Book", id: "b3" }, { $type: "Book", id: "b4" }] }, meta: { cost: 26 }, fin: true }); // guard
  });
});

describe("security: policies compare values exactly and fail closed", () => {
  const guarded = () =>
    createRayfoldServer({
      schema: `entity A { id: ID }
        command pay(amount: Decimal): A @idempotent(false) @deny(write: args.amount > 1000)
        command big(n: Long): A @idempotent(false) @deny(write: args.n > 9007199254740992)
        query odd(flag: Boolean): A @allow(read: args.flag > 1)
        query odder(flag: Boolean): A @deny(read: args.flag > 1)`,
      resolvers: { Command: { pay: () => ({ id: "p" }), big: () => ({ id: "b" }) }, Query: { odd: () => ({ id: "o" }), odder: () => ({ id: "o" }) } },
    });
  const code = async (op: string, args: Record<string, unknown>) => {
    const f = (await guarded().collect({ ops: [{ id: 1, op, args }] }, { viewer: u1 }))[0]!;
    return "error" in f ? f.error.code : "ok";
  };

  it("a Decimal sent as text is compared by value, so a deny rule on large amounts holds", async () => {
    expect(await code("pay", { amount: "5000" })).toBe("permission_denied");
    expect(await code("pay", { amount: "1000.01" })).toBe("permission_denied");
    expect(await code("pay", { amount: "999.99" })).toBe("ok"); // guard
  });

  it("a Long beyond 2^53 is compared exactly", async () => {
    expect(await code("big", { n: "9007199254740993" })).toBe("permission_denied");
    expect(await code("big", { n: "9007199254740992" })).toBe("ok"); // guard
  });

  it("a rule that cannot be evaluated fails closed, whether it allows or denies", async () => {
    expect(await code("odd", { flag: true })).toBe("permission_denied");
    expect(await code("odder", { flag: true })).toBe("permission_denied");
  });
});

describe("read policies handed to loaders (spec 06 section 4)", () => {
  it("a query and a field loader see the pushable read policy of the entity they load; others see none", async () => {
    const seen: Record<string, unknown> = {};
    const s = createRayfoldServer({
      schema: `entity Doc @allow(read: viewer.id == ownerId) { id: ID ownerId: ID } entity Note @deny(read: viewer == null) { id: ID } entity Shelf { id: ID docs: [Doc] } query docs: [Doc] query shelf: Shelf query notes: [Note]`,
      resolvers: {
        Query: {
          docs: (_a, ctx) => ((seen["docs"] = ctx.policy.filter), [{ id: "d1", ownerId: "u1" }]),
          shelf: (_a, ctx) => ((seen["shelf"] = ctx.policy.filter), { id: "s1" }),
          notes: (_a, ctx) => ((seen["notes"] = ctx.policy.filter), []),
        },
        Shelf: { docs: (parents: unknown[], _a: unknown, ctx: RayfoldContext) => ((seen["shelfDocs"] = ctx.policy.filter), parents.map(() => [{ id: "d1", ownerId: "u1" }])) },
      },
    });
    const frames = await s.collect({ ops: [{ id: 1, op: "docs", shape: "{ id }" }, { id: 2, op: "shelf", shape: "{ docs { id } }" }, { id: 3, op: "notes", shape: "{ id }" }] }, { viewer: { id: "u1" } });
    expect(frames.filter((f) => "error" in f)).toEqual([]);
    const docPolicy = pushableFilter(s.ir.types["Doc"]!.annotations);
    expect(docPolicy).toBeDefined();
    expect(seen["docs"]).toEqual(docPolicy);
    expect(seen["shelfDocs"]).toEqual(docPolicy);
    expect(seen["shelf"]).toBeUndefined(); // guard: a type with no policy
    expect(seen["notes"]).toBeUndefined(); // guard: a deny cannot be pushed down
  });
});

describe("a field with arguments and no loader", () => {
  const schema = `entity Author { id: ID name: String books(page: PageArgs = { first: 10 }): Page<Book> } entity Book { id: ID } query author(id: ID): Author?`;
  const books = { items: [{ id: "b1" }], total: 3, hasMore: true, cursor: "b1" };

  it("serves the value the op's resolver already put on the parent, under every alias", async () => {
    const s = createRayfoldServer({ schema, resolvers: { Query: { author: () => ({ id: "a1", name: "Ursula", books }) } } });
    const frames = await s.collect({ ops: [{ id: 1, op: "author", args: { id: "a1" }, shape: "{ name books(page: { first: 1 }) { total items { id } } shelf: books(page: { first: 1 }) { hasMore } }" }] });
    expect(frames).toEqual([{ id: 1, data: { $type: "Author", name: "Ursula", books: { total: 3, items: [{ $type: "Book", id: "b1" }] }, shelf: { hasMore: true } }, meta: { cost: 6 }, fin: true }]);
  });

  it("guard: when the parent does not carry the value, the op fails as unimplemented instead of answering null", async () => {
    const s = createRayfoldServer({ schema, resolvers: { Query: { author: () => ({ id: "a1", name: "Ursula" }) } } });
    const frames = await s.collect({ ops: [{ id: 1, op: "author", args: { id: "a1" }, shape: "{ name books(page: { first: 1 }) { total } }" }] });
    expect(frames).toEqual([{ id: 1, error: { code: "unimplemented", message: "No loader for Author.books", path: "books" }, fin: true }]);
  });
});

describe("envelope rules, each refused whole with its own message", () => {
  const refused = (ops: unknown[]) => bs.server.collect({ ops } as never);
  const book = { op: "book", args: { id: "b1" }, shape: "{ id }" };

  it("ids are positive integers: 0 is not one", async () => {
    expect(await refused([{ id: 0, ...book }])).toEqual([{ error: { code: "invalid_argument", message: "ops[0].id: expected a positive integer" }, fin: true }]);
    expect(await refused([{ id: 1, ...book }])).toEqual([{ id: 1, data: { $type: "Book", id: "b1" }, meta: { cost: 1 }, fin: true }]); // guard
  });

  it("a $ref names an earlier op that is in the batch: not itself, not a missing one", async () => {
    const ref = (to: number) => ({ op: "book", args: { id: { $ref: `${to}.id` } }, shape: "{ id }" });
    expect(await refused([{ id: 2, ...book }, { id: 3, ...ref(3) }])).toEqual([{ error: { code: "invalid_argument", message: "ops[1].args: $ref to op 3 must point to an earlier op" }, fin: true }]);
    expect(await refused([{ id: 2, ...book }, { id: 5, ...ref(1) }])).toEqual([{ error: { code: "invalid_argument", message: "ops[1].args: $ref to unknown op 1" }, fin: true }]);
    expect(bs.store.calls).toEqual({});
    // guard: an earlier op that stands later in the list is still an earlier op
    expect((await refused([{ id: 5, ...ref(2) }, { id: 2, ...book }])).map(idOf)).toEqual([2, 5]);
  });

  it("args is an object and shape is text", async () => {
    expect(await refused([{ id: 1, op: "book", args: ["b1"] }])).toEqual([{ error: { code: "invalid_argument", message: "ops[0].args: expected an object" }, fin: true }]);
    expect(await refused([{ id: 1, op: "book", args: { id: "b1" }, shape: 5 }])).toEqual([{ error: { code: "invalid_argument", message: "ops[0].shape: expected a string" }, fin: true }]);
  });

  it("args nested 64 deep are refused before anything walks them, and 63 deep are read as usual (guard)", async () => {
    const nest = (levels: number): unknown => (levels === 0 ? "x" : { a: nest(levels - 1) });
    // args itself is level 0, so the innermost object here is at level 64
    expect(await refused([{ id: 1, op: "book", args: nest(65) }])).toEqual([{ error: { code: "invalid_argument", message: "ops[0].args: nested deeper than 64 levels" }, fin: true }]);
    expect(await refused([{ id: 1, op: "book", args: nest(64) }])).toEqual([{ id: 1, error: { code: "invalid_argument", message: "book().a: unknown argument" }, fin: true }]);
  });
});

describe("idempotency keys are 16 to 128 characters", () => {
  const restock = (key: string, opts: { keyOptional?: boolean } = {}) =>
    bs.server.collect({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key, shape: "{ stock }" }] }, { viewer: admin, ...opts });
  const tooShortOrLong = [{ id: 1, error: { code: "invalid_argument", message: "restock(): commands require an idempotency key of 16-128 characters" }, fin: true }];

  it("both bounds included, one past either refused", async () => {
    expect(await restock("k".repeat(15))).toEqual(tooShortOrLong);
    expect(await restock("k".repeat(129))).toEqual(tooShortOrLong);
    expect(bs.store.calls).toEqual({});
    expect(await restock("k".repeat(16))).toMatchObject([{ id: 1, ok: { stock: 6 } }]);
    expect(await restock("k".repeat(128))).toMatchObject([{ id: 1, ok: { stock: 7 } }]);
  });

  it("a transport that makes the key optional still refuses a malformed one that was sent", async () => {
    expect(await restock("short", { keyOptional: true })).toEqual(tooShortOrLong);
    expect(bs.store.calls).toEqual({});
  });
});

describe("cancellation that came before the batch", () => {
  it("a signal already aborted ends every op canceled, and no resolver runs", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await bs.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" } }, { id: 2, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY }] }, { viewer: admin, signal: ac.signal })).toEqual([
      { id: 1, error: { code: "canceled", message: "Canceled" }, fin: true },
      { id: 2, error: { code: "canceled", message: "Canceled" }, fin: true },
    ]);
    expect(bs.store.calls).toEqual({});
  });

  it("an op signal already aborted ends that op alone; its sibling runs (guard)", async () => {
    const ac = new AbortController();
    ac.abort(new RayfoldError("canceled", "Canceled by the client"));
    expect(await bs.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }, { id: 2, op: "book", args: { id: "b2" }, shape: "{ id }" }] }, { opSignals: new Map([[1, ac.signal]]) })).toEqual([
      { id: 1, error: { code: "canceled", message: "Canceled by the client" }, fin: true },
      { id: 2, data: { $type: "Book", id: "b2" }, meta: { cost: 1 }, fin: true },
    ]);
    expect(bs.store.calls).toEqual({ "Query.book": 1 });
  });
});

describe("commands keep their order when one in the middle ends early", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a later command waits for the earlier one even after the one between them ran out of time", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const ran: string[] = [];
    const s = createRayfoldServer({
      schema: `entity A { id: ID } command slow: A @idempotent(false) command quick(n: Int): A @idempotent(false)`,
      resolvers: { Command: { slow: async () => (ran.push("slow"), await held, { id: "s" }), quick: (a: { n: number }) => (ran.push(`quick ${a.n}`), { id: `q${a.n}` }) } },
    });
    const p = s.collect({ ops: [{ id: 1, op: "slow", shape: "{ id }" }, { id: 2, op: "quick", args: { n: 2 }, deadline: 10, shape: "{ id }" }, { id: 3, op: "quick", args: { n: 3 }, shape: "{ id }" }] });
    await vi.advanceTimersByTimeAsync(20); // op 2's deadline passed while it waited for op 1
    expect(ran).toEqual(["slow"]); // op 3 still waits for op 1, though op 2 is over
    release();
    expect((await p).map((f) => [idOf(f), "error" in f ? f.error.code : "ok"])).toEqual([[2, "deadline_exceeded"], [1, "ok"], [3, "ok"]]);
    expect(ran).toEqual(["slow", "quick 3"]);
  });

  it("a batch deadline reports itself, whatever the resolver threw when it was stopped", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID } query hang: A`,
      resolvers: { Query: { hang: (_a, ctx) => new Promise((_r, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("socket closed")))) } },
    });
    const p = s.collect({ ops: [{ id: 1, op: "hang" }], meta: { deadline: 50 } });
    await vi.advanceTimersByTimeAsync(60);
    expect(await p).toEqual([{ id: 1, error: { code: "deadline_exceeded", message: "Batch deadline exceeded" }, fin: true }]);
  });
});

describe("planning", () => {
  it("a shape refused when its op is planned is not remembered, though the batch is within budget", async () => {
    const shapes = new SecRegistry(secLoadSchema(secSchemaText()).ir);
    const b = createBookstore({ shapes, maxFields: 2 });
    expect(await b.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title stock }" }] })).toEqual([
      { id: 1, error: { code: "resource_exhausted", message: "Shape selects 3 fields, max 2" }, fin: true },
    ]);
    expect(shapes.size).toBe(0);
    await b.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title }" }] }); // guard
    expect(shapes.size).toBe(1);
  });
});

describe("FrameSink", () => {
  it("passes one terminal frame per op and nothing after it closes", async () => {
    const sink = new FrameSink();
    sink.push({ id: 1, data: 1 });
    sink.push({ id: 1, fin: true });
    sink.push({ id: 1, error: { code: "internal", message: "late" }, fin: true }); // a second end for op 1
    sink.push({ id: 2, data: 2, fin: true }); // guard: another op is unaffected
    sink.close();
    sink.push({ id: 3, data: 3, fin: true });
    const read: Frame[] = [];
    for await (const f of sink) read.push(f);
    expect(read).toEqual([{ id: 1, data: 1 }, { id: 1, fin: true }, { id: 2, data: 2, fin: true }]);
    expect(sink.frames).toEqual(read);
  });
});

describe("a stream is bounded", () => {
  const SCHEMA = `
event Tick { id: ID  n: Int }
query nothing: Int
stream ticks: Tick
`;

  /** A resolver that never stops, which is what the bound exists for. */
  const endless = () => ({
    Query: { nothing: () => 0 },
    Stream: {
      ticks: async function* () {
        for (let n = 0; ; n++) yield { id: `t${n}`, n };
      },
    },
  });

  it("fails with resource_exhausted rather than yielding for ever", async () => {
    // spec 04 §5: a server emits items as its resolver yields them, bounded by its own per-stream item limit.
    // TypeScript had no bound at all, so an endless resolver produced frames until the process gave out.
    const server = createRayfoldServer({ schema: SCHEMA, resolvers: endless() as never, maxStreamItems: 5 });
    const frames = await server.collect({ ops: [{ id: 1, op: "ticks", shape: "{ id n }" }] }, {});
    const items = frames.filter((f) => "item" in (f as object));
    expect(items).toHaveLength(5);
    expect(frames[frames.length - 1]).toMatchObject({ id: 1, error: { code: "resource_exhausted" }, fin: true });
  });

  it("guard: a resolver that stops on its own is not truncated or failed", async () => {
    const server = createRayfoldServer({
      schema: SCHEMA,
      resolvers: {
        Query: { nothing: () => 0 },
        Stream: { ticks: async function* () { yield { id: "t0", n: 0 }; yield { id: "t1", n: 1 }; } },
      } as never,
      maxStreamItems: 5,
    });
    const frames = await server.collect({ ops: [{ id: 1, op: "ticks", shape: "{ id n }" }] }, {});
    expect(frames.filter((f) => "item" in (f as object))).toHaveLength(2);
    expect(frames[frames.length - 1]).toMatchObject({ id: 1, fin: true });
    expect(frames.some((f) => "error" in (f as object))).toBe(false);
  });
});

describe("the manifest and the event bus", () => {
  it("the manifest says whether only registered shapes are accepted", () => {
    expect(createBookstore({ trustedShapes: true }).server.manifest().limits).toEqual({ budget: 1000, maxOps: 50, maxDepth: 8, maxFields: 500, trustedShapes: true });
    expect(bs.server.manifest().limits).toEqual({ budget: 1000, maxOps: 50, maxDepth: 8, maxFields: 500, trustedShapes: false }); // guard
  });

  it("an event subscription opened with a signal that already aborted ends at once, and one opened without hears events (guard)", async () => {
    const ac = new AbortController();
    ac.abort();
    const ended = bs.server.events.subscribe("StockChanged", ac.signal)[Symbol.asyncIterator]();
    expect(await bounded(ended.next(), "the ended subscription answering")).toEqual({ value: undefined, done: true });
    const open = bs.server.events.subscribe("StockChanged")[Symbol.asyncIterator]();
    bs.server.events.publish("StockChanged", { bookId: "b1", stock: 1 });
    expect(await bounded(open.next(), "the event")).toEqual({ value: { bookId: "b1", stock: 1, seq: 1 }, done: false });
    await open.return?.();
  });
});

describe("argument values at the boundary", () => {
  const SCHEMA = `entity A { id: ID }
    input Opts { size: Int = 3 tag: String? }
    scalar Colour
    command take(id: ID?, when: Instant?, day: Date?, wait: Duration?, raw: Bytes?, n: Long?, colour: Colour?, opts: Opts?, page: PageArgs?): A @idempotent(false)`;
  const seen: Array<Record<string, unknown>> = [];
  const s = createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { take: (a: Record<string, unknown>) => (seen.push(a), { id: "a" }) } } });
  const outcome = async (args: unknown) => {
    seen.length = 0;
    const f = (await s.collect({ ops: [{ id: 1, op: "take", args: args as Record<string, unknown>, shape: "{ id }" }] }))[0]!;
    return "error" in f ? f.error.message : seen[0];
  };

  it("each scalar is refused in a form it does not take, and taken in the form it does (guards)", async () => {
    expect(await outcome({ id: "" })).toBe("take().id: expected ID");
    expect(await outcome({ when: "2026-09-13" })).toBe("take().when: expected Instant (RFC 3339)");
    expect(await outcome({ when: "2026-09-13T10:00:00Z" })).toEqual({ when: "2026-09-13T10:00:00Z" });
    expect(await outcome({ day: "13/09/2026" })).toBe("take().day: expected Date (YYYY-MM-DD)");
    expect(await outcome({ day: "2026-09-13" })).toEqual({ day: "2026-09-13" });
    expect(await outcome({ wait: -1 })).toBe("take().wait: expected Duration");
    expect(await outcome({ wait: "5x" })).toBe("take().wait: expected Duration");
    expect(await outcome({ wait: "5s" })).toEqual({ wait: "5s" });
    expect(await outcome({ raw: "ab+/" })).toBe("take().raw: expected Bytes (base64url)");
    expect(await outcome({ raw: "ab-_" })).toEqual({ raw: "ab-_" });
    expect(await outcome({ n: 2 ** 60 })).toBe("take().n: expected Long");
    expect(await outcome({ colour: { r: 1 } })).toBe("take().colour: expected scalar Colour");
    expect(await outcome({ colour: "red" })).toEqual({ colour: "red" });
  });

  it("an input type's defaults fill what was left out, and a page inside one is capped", async () => {
    expect(await outcome({ opts: {} })).toEqual({ opts: { size: 3 } });
    expect(await outcome({ page: { first: 5_000 } })).toEqual({ page: { first: 200 } });
  });

  it("an object with $ref and anything else beside it is a plain value, not a reference", async () => {
    // a real $ref beside it, so the arguments are read only once op 1 has answered, through the reference resolver
    const frames = await s.collect({ ops: [{ id: 1, op: "take", args: { id: "x" }, shape: "{ id }" }, { id: 2, op: "take", args: { id: { $ref: "1.id" }, opts: { $ref: "1.id", size: 2 } as never }, shape: "{ id }" }] });
    expect(frames[1]).toEqual({ id: 2, error: { code: "invalid_argument", message: "take().opts.$ref: unknown argument" }, fin: true });
  });

  it("a __proto__ in the arguments is an argument like any other, refused as unknown, never a prototype", async () => {
    expect(await outcome(JSON.parse('{"__proto__":{"id":"smuggled"}}'))).toBe("take().__proto__: unknown argument");
    expect(await outcome(JSON.parse('{"opts":{"__proto__":{"size":9}}}'))).toBe("take().opts.__proto__: unknown argument");
    // and the same when the arguments wait on a $ref, and so pass through the reference resolver first
    const args = JSON.parse('{"id":{"$ref":"1.id"},"__proto__":{"colour":"smuggled"}}') as Record<string, unknown>;
    const frames = await s.collect({ ops: [{ id: 1, op: "take", args: { id: "x" }, shape: "{ id }" }, { id: 2, op: "take", args, shape: "{ id }" }] });
    expect(frames[1]).toEqual({ id: 2, error: { code: "invalid_argument", message: "take().__proto__: unknown argument" }, fin: true });
  });
});

describe("the cost a batch is charged", () => {
  const SCHEMA = `entity Book { id: ID title: String author: Author reviews(page: PageArgs = { first: 10 }): Page<Review> }
    entity Author { id: ID name: String } entity Review { id: ID }
    view Book.card = { id author { name } }
    query free: Int @cost(base: 0)
    query top(first: Int = 5): Page<Book>
    query book(id: ID): Book`;
  const book = { id: "b1", title: "T", author: { id: "a1", name: "A" }, reviews: { items: [], hasMore: false } };
  const shop = (budget = 1000) => createRayfoldServer({ schema: SCHEMA, budget, resolvers: { Query: { free: () => 1, top: () => ({ items: [], hasMore: false }), book: () => book } } });
  const cost = async (op: Record<string, unknown>) => {
    const f = (await shop().collect({ ops: [{ id: 1, ...op } as never] }))[0] as { meta?: { cost: number }; error?: unknown };
    return f.meta?.cost ?? f.error;
  };

  it("is never below 1, even for an op declared free", async () => {
    expect(await cost({ op: "free" })).toBe(1);
  });

  it("a page's own first argument with a default is charged at that default", async () => {
    expect(await cost({ op: "top", shape: "{ items { id } }" })).toBe(1 + 5 + 1);
  });

  it("a view spread is charged for what it selects", async () => {
    expect(await cost({ op: "book", args: { id: "b1" }, shape: "{ ...Book.card }" })).toBe(2);
    expect(await cost({ op: "book", args: { id: "b1" }, shape: "{ id }" })).toBe(1); // guard
  });

  it("a page size from a variable is charged as sent when it is a whole number up to 200, and as 200 otherwise", async () => {
    const reviews = (n: unknown) => cost({ op: "book", args: { id: "b1" }, shape: "{ reviews(page: { first: $n }) { items { id } } }", vars: { n } });
    expect(await reviews(3)).toBe(1 + 1 + 3 + 1);
    expect(await reviews(1_000)).toBe(1 + 1 + 200 + 1);
    // a fraction never runs, but its batch is charged for the largest page first
    expect(await shop(10).collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ reviews(page: { first: $n }) { items { id } } }", vars: { n: 2.5 } }] })).toEqual([
      { error: { code: "resource_exhausted", message: "Batch cost 203 exceeds budget 10", data: { cost: 203, budget: 10 } }, fin: true },
    ]);
  });

  it("a page argument sent as null is charged as the largest page, since nothing says how many rows it asks for", async () => {
    const s = createRayfoldServer({ schema: `entity Book { id: ID } query list(page: PageArgs?): Page<Book>`, resolvers: { Query: { list: () => ({ items: [], hasMore: false }) } } });
    expect(await s.collect({ ops: [{ id: 1, op: "list", args: { page: null }, shape: "{ items { id } }" }] })).toEqual([{ id: 1, data: { items: [] }, meta: { cost: 1 + 200 + 1 }, fin: true }]);
  });

  it("a deferred block is charged like any other selection", async () => {
    expect(await cost({ op: "book", args: { id: "b1" }, shape: "{ id @defer { author { name } } }" })).toBe(2);
  });
});

describe("default views and the shape registry", () => {
  it("a default view leaves out a scalar field that takes arguments", async () => {
    let loads = 0;
    const s = createRayfoldServer({
      schema: `entity A { id: ID label(upper: Boolean): String } query a: A`,
      resolvers: { Query: { a: () => ({ id: "a" }) }, A: { label: (ps: unknown[]) => (loads++, ps.map(() => "L")) } } as never,
    });
    expect(await s.collect({ ops: [{ id: 1, op: "a" }] })).toEqual([{ id: 1, data: { $type: "A", id: "a" }, meta: { cost: 1 }, fin: true }]);
    expect(loads).toBe(0);
  });

  it("the shape registry forgets the least recently used learned shape, counting a lookup as a use", () => {
    const registry = new SecRegistry(secLoadSchema(secSchemaText()).ir, 2);
    const a = registry.register({ items: [{ kind: "field", name: "id" }] });
    const b = registry.register({ items: [{ kind: "field", name: "title" }] });
    expect(registry.get(a)).toEqual({ items: [{ kind: "field", name: "id" }] });
    registry.register({ items: [{ kind: "field", name: "stock" }] });
    expect(registry.get(b)).toBeUndefined();
    expect(registry.get(a)).toEqual({ items: [{ kind: "field", name: "id" }] });
  });

  it("a learned shape that is already pinned is kept once, as the pinned one", () => {
    const registry = new SecRegistry(secLoadSchema(secSchemaText()).ir, 2);
    const shape = { items: [{ kind: "field" as const, name: "id" }] };
    const id = registry.register(shape, true);
    expect(registry.register(shape)).toBe(id);
    expect(registry.size).toBe(1);
  });
});

describe("policies, from the batch", () => {
  it("a deny that does not read the viewer refuses an anonymous caller as forbidden, not as unauthenticated", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID } query locked: A @deny(read: true) query mine: A @deny(read: viewer == null)`,
      resolvers: { Query: { locked: () => ({ id: "a" }), mine: () => ({ id: "a" }) } },
    });
    expect(await s.collect({ ops: [{ id: 1, op: "locked", shape: "{ id }" }, { id: 2, op: "mine", shape: "{ id }" }] })).toEqual([
      { id: 1, error: { code: "permission_denied", message: "Not allowed to access locked()" }, fin: true },
      { id: 2, error: { code: "unauthenticated", message: "Sign in to access mine()" }, fin: true },
    ]);
  });

  it("a read policy is handed to a loader only when all of it can be pushed down", async () => {
    const seen: Record<string, unknown> = {};
    const s = createRayfoldServer({
      schema: `entity Both @allow(read: viewer.id == ownerId) @deny(read: archived == true) { id: ID ownerId: ID archived: Boolean }
        entity Clock @allow(read: expiresAt > now()) { id: ID expiresAt: Instant }
        query both: [Both] query clocks: [Clock]`,
      resolvers: { Query: { both: (_a, ctx) => ((seen["both"] = ctx.policy.filter), []), clocks: (_a, ctx) => ((seen["clocks"] = ctx.policy.filter), []) } },
    });
    await s.collect({ ops: [{ id: 1, op: "both", shape: "{ id }" }, { id: 2, op: "clocks", shape: "{ id }" }] }, { viewer: u1 });
    expect(seen).toEqual({ both: undefined, clocks: undefined });
  });
});

describe("an event subscription that is returned", () => {
  it("ends, and hears nothing after", async () => {
    const it = bs.server.events.subscribe("StockChanged")[Symbol.asyncIterator]();
    await it.return?.();
    bs.server.events.publish("StockChanged", { bookId: "b1", stock: 1 });
    expect(await bounded(it.next(), "the returned subscription answering")).toEqual({ value: undefined, done: true });
  });
});

describe("errors on the wire", () => {
  const s = (thrown: () => unknown) =>
    createRayfoldServer({
      schema: `entity A { id: ID name: String } query a: A query b: A`,
      resolvers: {
        Query: { a: () => { throw thrown(); }, b: () => ({ id: "b" }) },
        A: { name: () => { throw thrown(); } },
      } as never,
    });

  it("say retryable only when it differs from what the code implies, and keep saying it once a path is attached", async () => {
    const busy = () => new RayfoldError("internal", "Busy", { retryable: true });
    expect(await s(busy).collect({ ops: [{ id: 1, op: "a" }, { id: 2, op: "b", shape: "{ name }" }] })).toEqual([
      { id: 1, error: { code: "internal", message: "Busy", retryable: true }, fin: true },
      { id: 2, error: { code: "internal", message: "Busy", path: "name", retryable: true }, fin: true },
    ]);
    // guard: a code that is retryable by its nature carries no flag
    expect(await s(() => new RayfoldError("aborted", "Conflict")).collect({ ops: [{ id: 1, op: "a" }] })).toEqual([{ id: 1, error: { code: "aborted", message: "Conflict" }, fin: true }]);
    expect(new RayfoldError("aborted", "x").retryable).toBe(true);
    expect(new RayfoldError("internal", "x").retryable).toBe(false);
  });

  it("an AbortError a resolver lets escape is a cancellation, anything else it throws is internal (guard)", async () => {
    expect(await s(() => new DOMException("The operation was aborted.", "AbortError")).collect({ ops: [{ id: 1, op: "a" }] })).toEqual([{ id: 1, error: { code: "canceled", message: "Canceled" }, fin: true }]);
    expect(await s(() => new TypeError("x")).collect({ ops: [{ id: 1, op: "a" }] })).toEqual([{ id: 1, error: { code: "internal", message: "Internal error" }, fin: true }]);
  });
});

describe("odds and ends of the batch", () => {
  it("a page's own first argument with a default is charged at that default when the arguments wait on a $ref", async () => {
    const s = createRayfoldServer({
      schema: `entity Book { id: ID } query book: Book query top(after: ID, first: Int = 5): Page<Book>`,
      resolvers: { Query: { book: () => ({ id: "b1" }), top: () => ({ items: [], hasMore: false }) } },
    });
    const frames = await s.collect({ ops: [{ id: 1, op: "book", shape: "{ id }" }, { id: 2, op: "top", args: { after: { $ref: "1.id" } }, shape: "{ items { id } }" }] });
    expect(frames[1]).toEqual({ id: 2, data: { items: [] }, meta: { cost: 1 + 5 + 1 }, fin: true });
  });

  it("a query that checks a version it was sent fails with the conflict and its data", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID v: Int } query a: A`,
      resolvers: { Query: { a: (_x, ctx) => (ctx.checkVersion("A:a", 3, null), { id: "a", v: 3 }) } },
    });
    expect(await s.collect({ ops: [{ id: 1, op: "a", ifVersion: 2 }] })).toEqual([
      { id: 1, error: { code: "failed_precondition", type: "VersionConflict", message: "A:a is at version 3, not 2", data: { key: "A:a", expected: 2, actual: 3 } }, fin: true },
    ]);
  });

  it("hasPolicy sees a deny as a policy, as it sees an allow", () => {
    const ir = secLoadSchema(`entity A @deny(read: viewer == null) { id: ID } entity B @allow(write: true) { id: ID } entity C { id: ID } query a: A`).ir;
    expect(["A", "B", "C"].map((t) => hasPolicy(ir.types[t]!.annotations, "read"))).toEqual([true, false, false]);
  });
});
