/**
 * The reference bookstore's own behaviour, through the real server. Most of the repository's suites use this store as
 * a fixture and assert on the protocol around it; these assert on what the store itself decides: who may change what,
 * what a dry run leaves alone, what each command patches and announces, and what the bundled catalogues hold.
 */
import { RayfoldClient, RayfoldClientError, createLocalTransport } from "@rayfold/client";
import type { Frame } from "@rayfold/server";
import { beforeEach, describe, expect, it } from "vitest";
import { BookTable, CATALOGUE_SIZE, bookPage, createBookstore, gutenbergData, seed, withCatalogue, withGutenberg, type Bookstore } from "./index.ts";

let bs: Bookstore;
beforeEach(() => {
  bs = createBookstore();
});

type Who = { id: string; role: "admin" | "customer" };
const u1: Who = { id: "u1", role: "customer" };
const u2: Who = { id: "u2", role: "customer" };
const admin: Who = { id: "u9", role: "admin" };
const as = (who: Who) => new RayfoldClient({ transport: createLocalTransport(bs.server, () => who) });

let keyN = 0;
/** One command through the server, with what it answered, patched and emitted. */
async function run(who: Who, op: string, args: Record<string, unknown>, o: { simulate?: boolean; shape?: string } = {}) {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const offs = ["OrderPlaced", "StockChanged"].map((event) => bs.server.events.on(event, (payload) => emitted.push({ event, payload })));
  try {
    const frames = await bs.server.collect({ ops: [{ id: 1, op, args, key: `key-${String(++keyN).padStart(12, "0")}`, ...o }] }, { viewer: who });
    return { frame: frames[0] as Frame & { ok?: unknown; patch?: unknown; error?: { code: string; type?: string; data?: unknown; message: string } }, emitted };
  } finally {
    for (const off of offs) off();
  }
}

async function failure(p: Promise<unknown>): Promise<RayfoldClientError> {
  const e = await p.then(
    () => new Error("expected the call to fail"),
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(RayfoldClientError);
  return e as RayfoldClientError;
}

const order = (lines: Array<[string, number]>) => ({ input: { lines: lines.map(([bookId, qty]) => ({ bookId, qty })) } });

describe("placeOrder", () => {
  it("takes the stock, patches each book and announces the order and every stock change", async () => {
    const { frame, emitted } = await run(u1, "placeOrder", order([["b1", 2], ["b3", 1]]), { shape: "{ id status total }" });
    const ok = { $type: "Order", id: "o1", status: "PLACED", total: "33.98" };
    expect([frame.ok, frame.patch]).toEqual([ok, [{ set: "Order:o1", value: ok }, { set: "Book:b1", value: { stock: 3 } }, { set: "Book:b3", value: { stock: 99 } }]]);
    expect(emitted).toMatchObject([
      { event: "OrderPlaced", payload: { orderId: "o1", customerId: "u1" } },
      { event: "StockChanged", payload: { bookId: "b1", stock: 3 } },
      { event: "StockChanged", payload: { bookId: "b3", stock: 99 } },
    ]);
    expect([bs.store.books.get("b1")!.stock, bs.store.books.get("b3")!.stock, bs.store.orders.size, bs.store.nextId]).toEqual([3, 99, 1, 2]);
  });

  it("a dry run reports the same order and effects and writes nothing", async () => {
    const { frame, emitted } = await run(u1, "placeOrder", order([["b1", 2]]), { shape: "{ id total }", simulate: true });
    const ok = { $type: "Order", id: "o1", total: "25.98" };
    expect([frame.ok, frame.patch]).toEqual([ok, [{ set: "Order:o1", value: ok }, { set: "Book:b1", value: { stock: 3 } }]]);
    expect(emitted).toEqual([]);
    expect([bs.store.books.get("b1")!.stock, bs.store.orders.size, bs.store.nextId]).toEqual([5, 0, 1]);
  });

  it("refuses an unknown book, too few copies, and a total over the card limit, changing nothing; guard: exactly the stock sells", async () => {
    const missing = await failure(as(u1).command("placeOrder", order([["b1", 1], ["b99", 1]])));
    expect([missing.code, missing.message]).toEqual(["not_found", "Book b99 not found"]);
    const short = await failure(as(u1).command("placeOrder", order([["b2", 3]])));
    expect([short.type, short.data]).toEqual(["OutOfStock", { bookId: "b2", available: 2 }]);
    // 26 copies at 19.50 is 507.00, over the 500 the card allows
    bs.store.books.get("b2")!.stock = 100;
    const declined = await failure(as(u1).command("placeOrder", order([["b2", 26]])));
    expect([declined.type, declined.data]).toEqual(["PaymentDeclined", { reason: "limit" }]);
    expect([bs.store.books.get("b1")!.stock, bs.store.books.get("b2")!.stock, bs.store.orders.size]).toEqual([5, 100, 0]);
    // 25 copies is 487.50, under it; and every copy there is may be bought
    expect(await as(u1).command("placeOrder", order([["b2", 25]]), { shape: "{ total }" })).toEqual({ $type: "Order", total: "487.50" });
    expect(await as(u1).command("placeOrder", order([["b1", 5]]), { shape: "{ total }" })).toEqual({ $type: "Order", total: "64.95" });
    expect(bs.store.books.get("b1")!.stock).toBe(0);
  });
});

describe("orders after they are placed", () => {
  const place = async (who: Who, lines: Array<[string, number]>) => (await as(who).command<{ id: string }>("placeOrder", order(lines), { shape: "{ id }" })).id;

  it("myOrders lists the viewer's own orders only", async () => {
    const a = await place(u1, [["b1", 1]]);
    await place(u2, [["b3", 1]]);
    const c = await place(u1, [["b3", 2]]);
    expect(await as(u1).query("myOrders", {}, { shape: "{ items { id } total }" })).toEqual({ items: [{ $type: "Order", id: a }, { $type: "Order", id: c }], total: 2 });
    expect(await as(u2).query("myOrders", {}, { shape: "{ items { id } total }" })).toEqual({ items: [{ $type: "Order", id: "o2" }], total: 1 });
  });

  it("cancelOrder gives the copies back once; a dry run leaves the order placed; someone else's order is not found", async () => {
    const id = await place(u1, [["b1", 2], ["b3", 3]]);
    expect([bs.store.books.get("b1")!.stock, bs.store.books.get("b3")!.stock]).toEqual([3, 97]);

    const theirs = await failure(as(u2).command("cancelOrder", { id }));
    expect([theirs.code, theirs.message]).toEqual(["not_found", `Order ${id} not found`]);
    const dry = await run(u1, "cancelOrder", { id }, { shape: "{ status }", simulate: true });
    expect(dry.frame).toMatchObject({ ok: { status: "CANCELLED" } });
    expect([bs.store.orders.get(id)!.status, bs.store.books.get("b1")!.stock]).toEqual(["PLACED", 3]);

    const { frame } = await run(u1, "cancelOrder", { id }, { shape: "{ status }" });
    expect(frame.patch).toEqual([{ set: "Book:b1", value: { stock: 5 } }, { set: "Book:b3", value: { stock: 100 } }]);
    expect([bs.store.books.get("b1")!.stock, bs.store.books.get("b3")!.stock]).toEqual([5, 100]);
    const twice = await failure(as(u1).command("cancelOrder", { id }));
    expect([twice.type, twice.data]).toEqual(["NotCancellable", { status: "CANCELLED" }]);
    expect(bs.store.books.get("b1")!.stock).toBe(5);
    // guard: an admin may cancel anyone's
    const other = await place(u2, [["b3", 1]]);
    expect(await as(admin).command("cancelOrder", { id: other }, { shape: "{ status }" })).toEqual({ $type: "Order", status: "CANCELLED" });
  });

  it("payOrder pays a placed order once, under the card limit; a dry run pays nothing", async () => {
    const id = await place(u1, [["b1", 1]]);
    expect(await as(u1).command("payOrder", { id }, { shape: "{ status }", simulate: true })).toEqual({ $type: "Order", status: "PAID" });
    expect(bs.store.orders.get(id)!.status).toBe("PLACED");
    expect(await as(u1).command("payOrder", { id }, { shape: "{ status }" })).toEqual({ $type: "Order", status: "PAID" });
    const again = await failure(as(u1).command("payOrder", { id }));
    expect([again.type, again.data]).toEqual(["NotPayable", { status: "PAID" }]);
    expect((await failure(as(u2).command("payOrder", { id }))).code).toBe("not_found");

    // 21 copies at 19.50 is 409.50: placed, under the order limit, but over what a payment may be
    bs.store.books.get("b2")!.stock = 100;
    const big = await place(u1, [["b2", 21]]);
    const declined = await failure(as(u1).command("payOrder", { id: big }));
    expect([declined.type, declined.data, declined.message]).toEqual(["PaymentDeclined", { reason: "limit" }, "Payment exceeds the card limit"]);
    // guard: 20 copies, 390.00, is paid
    const fine = await place(u1, [["b2", 20]]);
    expect(await as(u1).command("payOrder", { id: fine }, { shape: "{ status }" })).toEqual({ $type: "Order", status: "PAID" });
  });

  it("an order line names its book, and a review its book", async () => {
    const id = await place(u1, [["b3", 2]]);
    expect(await as(u1).query("order", { id }, { shape: "{ items { qty unitPrice book { id title } } }" })).toEqual({ $type: "Order", items: [{ qty: 2, unitPrice: "8.00", book: { $type: "Book", id: "b3", title: "Kindred" } }] });
    expect(await as(u1).query("review", { id: "r3" }, { shape: "{ id book { id title } }" })).toEqual({ $type: "Review", id: "r3", book: { $type: "Book", id: "b3", title: "Kindred" } });
  });
});

describe("reviews", () => {
  it("addReview keeps it under a fresh id and invalidates the book lists; a dry run keeps nothing and uses up no id", async () => {
    const seeded = new Map(bs.store.reviews);
    const input = { input: { bookId: "b3", rating: 4, body: "Gripping." } };
    const dry = await run(u1, "addReview", input, { shape: "{ id }", simulate: true });
    expect(dry.frame.ok).toEqual({ $type: "Review", id: "r5" });
    expect([bs.store.reviews.size, bs.store.nextId]).toEqual([4, 1]);
    const { frame } = await run(u1, "addReview", input, { shape: "{ id rating reviewerId }" });
    // the seed holds r1-r4, so the first new review is r5, and none of the seed's is replaced
    const ok = { $type: "Review", id: "r5", rating: 4, reviewerId: "u1" };
    expect([frame.ok, frame.patch]).toEqual([ok, [{ set: "Review:r5", value: ok }, { invOp: ["books"] }]]);
    expect(bs.store.reviews.get("r5")).toMatchObject({ bookId: "b3", body: "Gripping.", version: 1 });
    for (const [id, row] of seeded) expect(bs.store.reviews.get(id), id).toEqual(row);
    expect(bs.store.nextId).toBe(6);
    // an order placed after it takes the next number after the review's
    expect(await as(u1).command("placeOrder", order([["b3", 1]]), { shape: "{ id }" })).toEqual({ $type: "Order", id: "o6" });
    expect((await failure(as(u1).command("addReview", { input: { bookId: "b99", rating: 4, body: "?" } }))).code).toBe("not_found");
  });

  it("editReview: only its author or an admin, against the current version; a dry run changes nothing", async () => {
    const edit = { id: "r2", input: { rating: 2, body: "Less dreamlike than I remembered." } };
    const refused = await failure(as(u2).command("editReview", edit));
    expect([refused.code, refused.message]).toEqual(["permission_denied", "Only the author of a review can edit it"]);
    expect(await as(u1).command("editReview", edit, { shape: "{ rating version }", simulate: true })).toEqual({ $type: "Review", rating: 2, version: 2 });
    expect(bs.store.reviews.get("r2")).toMatchObject({ rating: 4, version: 1 });
    expect(await as(u1).command("editReview", edit, { shape: "{ rating version }", ifVersion: 1 })).toEqual({ $type: "Review", rating: 2, version: 2 });
    const stale = await failure(as(u1).command("editReview", edit, { ifVersion: 1 }));
    expect([stale.type, stale.data]).toMatchObject(["VersionConflict", { key: "Review:r2", expected: 1, actual: 2 }]);
    expect(await as(admin).command("editReview", { ...edit, input: { rating: 1, body: "Moderated." } }, { shape: "{ rating version }" })).toEqual({ $type: "Review", rating: 1, version: 3 });
  });

  it("deleteReview: only its author or an admin; a dry run deletes nothing; the real one patches it away", async () => {
    const refused = await failure(as(u2).command("deleteReview", { id: "r2" }));
    expect([refused.code, refused.message]).toEqual(["permission_denied", "Only the author of a review can delete it"]);
    const dry = await run(u1, "deleteReview", { id: "r2" }, { shape: "{ id }", simulate: true });
    expect(dry.frame.ok).toEqual({ $type: "Review", id: "r2" });
    expect(bs.store.reviews.has("r2")).toBe(true);
    const { frame } = await run(u1, "deleteReview", { id: "r2" }, { shape: "{ id }" });
    expect(frame.patch).toEqual([{ set: "Review:r2", value: { $type: "Review", id: "r2" } }, { del: "Review:r2" }]);
    expect(bs.store.reviews.has("r2")).toBe(false);
    expect((await failure(as(u1).command("deleteReview", { id: "r2" }))).code).toBe("not_found");
    await as(admin).command("deleteReview", { id: "r4" });
    expect([...bs.store.reviews.keys()]).toEqual(["r1", "r3"]);
  });
});

describe("books", () => {
  it("updateBook changes only the fields sent, refuses clearing one, and a dry run changes nothing", async () => {
    const shape = { shape: "{ id title price stock }" };
    expect(await as(admin).command("updateBook", { id: "b1", patch: { price: "13.50" } }, { ...shape, simulate: true })).toEqual({ $type: "Book", id: "b1", title: "The Dispossessed", price: "13.50", stock: 5 });
    expect(bs.store.books.get("b1")!.price).toBe("12.99");
    expect(await as(admin).command("updateBook", { id: "b1", patch: { price: "13.50" } }, shape)).toEqual({ $type: "Book", id: "b1", title: "The Dispossessed", price: "13.50", stock: 5 });
    expect(bs.store.books.get("b1")).toMatchObject({ price: "13.50", title: "The Dispossessed" });
    const cleared = await failure(as(admin).command("updateBook", { id: "b1", patch: { title: null } }));
    expect([cleared.code, cleared.message]).toEqual(["invalid_argument", "updateBook().patch.title: cannot be cleared"]);
    expect((await failure(as(u1).command("updateBook", { id: "b1", patch: { price: "1.00" } }))).code).toBe("permission_denied");
    expect(bs.store.books.get("b1")!.price).toBe("13.50");
  });

  it("restock adds copies and announces them; a dry run announces nothing and adds none", async () => {
    const dry = await run(admin, "restock", { bookId: "b4", qty: 3 }, { shape: "{ stock }", simulate: true });
    expect([dry.frame.ok, dry.emitted, bs.store.books.get("b4")!.stock]).toEqual([{ $type: "Book", stock: 3 }, [], 0]);
    const real = await run(admin, "restock", { bookId: "b4", qty: 3 }, { shape: "{ stock }" });
    expect([real.frame.ok, real.emitted, bs.store.books.get("b4")!.stock]).toEqual([{ $type: "Book", stock: 3 }, [{ event: "StockChanged", payload: { bookId: "b4", stock: 3, seq: 1 } }], 3]);
  });

  it("the book table re-sorts its ids only when an id comes or goes, and never serves a stale row", () => {
    const t = new BookTable(seed().books);
    const ids = () => [...t.sortedIds()];
    expect([ids(), ids(), t.sorts]).toEqual([["b1", "b2", "b3", "b4"], ["b1", "b2", "b3", "b4"], 1]);
    t.set("b2", { ...t.get("b2")!, title: "Renamed" });
    expect([ids(), t.sorts]).toEqual([["b1", "b2", "b3", "b4"], 1]);
    t.set("b10", { ...t.get("b1")!, id: "b10" });
    expect([ids(), t.sorts]).toEqual([["b1", "b10", "b2", "b3", "b4"], 2]);
    t.delete("b3");
    t.delete("b3"); // not there any more: no re-sort owed
    expect([ids(), t.sorts]).toEqual([["b1", "b10", "b2", "b4"], 3]);
    t.clear();
    expect([ids(), t.sorts]).toEqual([[], 4]);
  });

  it("a page past an unknown cursor is empty, an offset starts the page, and hasMore is false on the last full page", () => {
    const store = withCatalogue(seed());
    const all = [...store.books.keys()].sort();
    const page = (p: { first: number; after?: string; offset?: number }) => {
      const r = bookPage(store, null, p);
      return { ids: r.items.map((b) => b.id), cursor: r.cursor, hasMore: r.hasMore, total: r.total };
    };
    expect(page({ first: 2, after: "zzz" })).toEqual({ ids: [], cursor: null, hasMore: false, total: 36 });
    expect(page({ first: 3, offset: 5 })).toEqual({ ids: all.slice(5, 8), cursor: all[7], hasMore: true, total: 36 });
    expect(page({ first: 4, after: all[31]! })).toEqual({ ids: all.slice(32), cursor: all[35], hasMore: false, total: 36 });
    // and with a filter, the same rules over the matches only
    const cheap = bookPage(store, { maxPrice: "6.99" }, { first: 50 }).items.map((b) => `${b.id}:${b.price}`);
    expect(cheap).toEqual(["b12:6.99", "b18:4.99", "b27:5.99", "b29:6.49", "b32:5.49", "b34:6.99"]);
  });
});

describe("the bundled catalogues", () => {
  it("the demo catalogue adds its books, authors and reviews beside the seed, which it leaves alone", () => {
    const store = withCatalogue(seed());
    expect([store.books.size, store.authors.size, store.reviews.size]).toEqual([CATALOGUE_SIZE.books, CATALOGUE_SIZE.authors, CATALOGUE_SIZE.reviews]);
    expect(CATALOGUE_SIZE).toEqual({ books: 36, authors: 12, reviews: 24 });
    expect(store.books.get("b1")).toEqual(seed().books.get("b1"));
    expect(store.books.get("b7")).toEqual({ id: "b7", title: "One Hundred Years of Solitude", authorId: "a5", format: "PAPERBACK", price: "11.99", stock: 20, ownerId: "u1", costPrice: "5.40" });
    expect(store.reviews.get("r16")).toEqual({ id: "r16", bookId: "b21", rating: 5, body: "Best worldbuilding I have read in years.", reviewerId: "u3", version: 1 });
    // a store's rows are its own: changing one leaves the next catalogue untouched
    store.authors.get("a4")!.name = "changed";
    expect(withCatalogue(seed()).authors.get("a4")!.name).toBe("Toni Morrison");
  });

  it("the Gutenberg catalogue loads the first n books by ebook number with exactly their authors, free and unlimited", () => {
    const data = gutenbergData();
    const store = withGutenberg(seed(), { limit: 50 });
    const first = data.books.slice(0, 50);
    expect(store.books.size).toBe(4 + 50);
    expect(store.authors.size).toBe(3 + new Set(first.map((b) => b[2])).size);
    const [no, title, author] = first[0]!;
    expect(store.books.get(`g${no}`)).toEqual({ id: `g${no}`, title, format: "EBOOK", price: "0.00", stock: 1_000_000, authorId: `ga${author}`, costPrice: null, ownerId: "gutenberg" });
    expect(store.authors.get(`ga${author}`)).toEqual({ id: `ga${author}`, name: data.authors[author]![0], bio: data.authors[author]![1] });
    for (const [n, , a] of first) expect(store.authors.has(store.books.get(`g${n}`)!.authorId), `ga${a}`).toBe(true);
    expect(store.books.get("b1")).toEqual(seed().books.get("b1"));
    expect(withGutenberg(seed()).books.size).toBe(4 + data.books.length);
  });
});
