/**
 * The bookshop tested with no network: the real schema and resolvers behind a server in this process, and clients
 * that call it directly. bookshop.test.ts runs the same shop over HTTP, tokens included.
 */
import { readFileSync } from "node:fs";
import { RayfoldClient, createLocalTransport } from "@rayfold/client";
import { collect } from "@rayfold/client/testing";
import { createRayfoldServer, type RayfoldServerOptions } from "@rayfold/server";
import { expect, it, vi } from "vitest";
import { resolvers, seed, type Store, type Viewer } from "./resolvers.ts";

// #region test-setup
const schema = readFileSync(new URL("./bookshop.rayfold", import.meta.url), "utf8");

/** The shop and a client for each kind of caller. Nothing listens on a port, and every test gets a shop of its own. */
function bookshop(options: Partial<RayfoldServerOptions> = {}, store: Store = seed()) {
  const server = createRayfoldServer({ schema, resolvers: resolvers(store), ...options });
  // the viewer is who the caller is, which over HTTP the server reads from their token
  const as = (viewer: Viewer | null) => new RayfoldClient({ transport: createLocalTransport(server, () => viewer) });
  return {
    server,
    store,
    anonymous: as(null),
    customer: as({ id: "u1", role: "customer" }),
    staff: as({ id: "s1", role: "staff" }),
  };
}
// #endregion test-setup

// #region test-resolver
it("reads a book with the fields and the author it was asked for", async () => {
  const { anonymous, store } = bookshop();
  store.books.set("b4", { id: "b4", title: "Kindred", stock: 12, authorId: "a3", costPrice: "3.80" });
  store.authors.set("a3", { id: "a3", name: "Octavia E. Butler" });

  const book = await anonymous.query("book", { id: "b4" }, { shape: "{ id title stock author { name } }" });

  expect(book).toEqual({
    $type: "Book",
    id: "b4",
    title: "Kindred",
    stock: 12,
    author: { $type: "Author", name: "Octavia E. Butler" },
  });
  await expect(anonymous.query("book", { id: "b5" })).resolves.toBeNull();
});
// #endregion test-resolver

// #region test-policy
it("lets staff restock, and refuses a customer and someone who is not signed in", async () => {
  const { anonymous, customer, staff, store } = bookshop();
  const restock = (client: RayfoldClient) => client.command("restock", { bookId: "b2", qty: 4 });

  await expect(restock(anonymous)).rejects.toMatchObject({ code: "unauthenticated" });
  await expect(restock(customer)).rejects.toMatchObject({ code: "permission_denied" });
  expect(store.books.get("b2")?.stock).toBe(0);

  await expect(restock(staff)).resolves.toMatchObject({ id: "b2", stock: 4 });
  expect(store.books.get("b2")?.stock).toBe(4);
});
// #endregion test-policy

it("shows the cost price to staff, and refuses a customer that one field", async () => {
  const { customer, staff } = bookshop();
  const priced = (client: RayfoldClient) => client.query("book", { id: "b3" }, { shape: "{ id costPrice }" });

  await expect(priced(customer)).rejects.toMatchObject({ code: "permission_denied", path: "costPrice" });
  await expect(priced(staff)).resolves.toEqual({ $type: "Book", id: "b3", costPrice: "6.00" });
  // guard: it is the field that is refused, not the book
  await expect(customer.query("book", { id: "b3" }, { shape: "{ id title }" })).resolves.toEqual({ $type: "Book", id: "b3", title: "Dune" });
});

// #region test-error
it("refuses to sell more than there is, with OutOfStock and how many are left", async () => {
  const { customer, store } = bookshop();

  await expect(customer.command("buy", { bookId: "b1", qty: 5 })).rejects.toMatchObject({
    code: "domain",
    type: "OutOfStock",
    data: { bookId: "b1", available: 3 },
    message: "Only 3 left",
  });
  expect(store.books.get("b1")?.stock).toBe(3);

  // guard: what is there does sell
  await expect(customer.command("buy", { bookId: "b1", qty: 3 })).resolves.toMatchObject({ id: "b1", stock: 0 });
  expect(store.books.get("b1")?.stock).toBe(0);
});
// #endregion test-error

it("announces StockChanged with the new count after a purchase and a restock, and nothing for one it refuses", async () => {
  const { server, customer, staff } = bookshop();
  const changes = collect<unknown>((next) => server.events.on("StockChanged", next));

  await customer.command("buy", { bookId: "b1", qty: 2 });
  await staff.command("restock", { bookId: "b3", qty: 5 });
  await expect(customer.command("buy", { bookId: "b1", qty: 2 })).rejects.toMatchObject({ type: "OutOfStock" });
  await expect(staff.command("restock", { bookId: "b9", qty: 1 })).rejects.toMatchObject({ code: "not_found", message: "No book b9" });
  // guard: the next purchase is announced, right after the first two
  await customer.command("buy", { bookId: "b1" });

  expect([await changes.next("the purchase"), await changes.next("the restock"), await changes.next("the last purchase")]).toEqual([
    // seq numbers the server's events: one apart, nothing was announced in between
    { bookId: "b1", stock: 1, seq: 1 },
    { bookId: "b3", stock: 12, seq: 2 },
    { bookId: "b1", stock: 0, seq: 3 },
  ]);
  changes.stop();
});

// #region test-replay
it("runs a purchase once however often it is sent under one idempotency key, and again under another", async () => {
  const store = seed();
  const shop = resolvers(store);
  const buy = vi.fn(shop.Command!["buy"]!);
  const { customer } = bookshop({ resolvers: { ...shop, Command: { ...shop.Command, buy } } }, store);

  const first = await customer.command("buy", { bookId: "b1" }, { key: "order-1001-payment" });
  const again = await customer.command("buy", { bookId: "b1" }, { key: "order-1001-payment" });
  expect(buy).toHaveBeenCalledTimes(1);
  expect(again).toEqual(first);
  expect(store.books.get("b1")?.stock).toBe(2);

  await customer.command("buy", { bookId: "b1" }, { key: "order-1002-payment" });
  expect(buy).toHaveBeenCalledTimes(2);
  expect(store.books.get("b1")?.stock).toBe(1);
});
// #endregion test-replay

// #region test-live
it("a live query hears a restock someone else makes", async () => {
  const { customer, staff } = bookshop();
  const stock = collect<{ stock: number }>((next, fail) =>
    customer.live("book", { id: "b3" }, { shape: "{ id stock }" }, next, fail),
  );
  // each next() waits for one more value, for 4 seconds at most, and fails the test if none comes
  expect(await stock.next("the stock when the query opened")).toEqual({ $type: "Book", id: "b3", stock: 7 });

  await staff.command("restock", { bookId: "b3", qty: 2 });
  expect(await stock.next("the restock")).toEqual({ $type: "Book", id: "b3", stock: 9 });

  stock.stop();
  expect(stock.values.map((book) => book.stock)).toEqual([7, 9]);
});
// #endregion test-live

// #region test-clock
it("answers a repeated purchase from its record for 24 hours, by the server's clock", async () => {
  let now = Date.parse("2026-03-01T09:00:00Z");
  const { customer, store } = bookshop({ now: () => now });
  const order = { key: "order-1001-payment" };

  await customer.command("buy", { bookId: "b1" }, order);
  expect(store.books.get("b1")?.stock).toBe(2);

  now += 24 * 3_600_000 - 1; // a millisecond short of a day: still the first purchase's answer
  await customer.command("buy", { bookId: "b1" }, order);
  expect(store.books.get("b1")?.stock).toBe(2);

  now += 1; // a day old, the record has expired, so the key is a new purchase
  await customer.command("buy", { bookId: "b1" }, order);
  expect(store.books.get("b1")?.stock).toBe(1);
});
// #endregion test-clock

// #region test-client
it("shows a purchase before the shop has answered, and takes it back when the shop refuses", async () => {
  const { customer, staff } = bookshop();
  const stock = collect<{ stock: number }>((next, fail) =>
    customer.watch("book", { id: "b1" }, { shape: "{ id stock }" }, next, fail),
  );
  expect(await stock.next("the book")).toMatchObject({ stock: 3 });
  // sold out since, which this customer's client has not heard
  await staff.command("buy", { bookId: "b1", qty: 3 });

  const predicted = [{ set: "Book:b1", value: { stock: 2 } }];
  const refused = customer.command("buy", { bookId: "b1" }, { optimistic: predicted });
  expect(await stock.next("the predicted stock")).toMatchObject({ stock: 2 });
  await expect(refused).rejects.toMatchObject({ type: "OutOfStock", data: { bookId: "b1", available: 0 } });
  // back to what the server last told this client
  expect(await stock.next("the prediction taken back")).toMatchObject({ stock: 3 });

  stock.stop();
  expect(stock.values.map((book) => book.stock)).toEqual([3, 2, 3]);
});
// #endregion test-client

it("a purchase the shop accepts ends at the shop's own count, not the predicted one", async () => {
  const { customer, staff, store } = bookshop();
  const stock = collect<{ stock: number }>((next, fail) =>
    customer.watch("book", { id: "b1" }, { shape: "{ id stock }" }, next, fail),
  );
  expect(await stock.next("the book")).toMatchObject({ stock: 3 });
  // one sold since, so a prediction made from 3 is one too many
  await staff.command("buy", { bookId: "b1" });

  const predicted = [{ set: "Book:b1", value: { stock: 2 } }];
  const bought = customer.command("buy", { bookId: "b1" }, { optimistic: predicted });
  expect(await stock.next("the predicted stock")).toMatchObject({ stock: 2 });
  await expect(bought).resolves.toMatchObject({ id: "b1", stock: 1 });

  stock.stop();
  expect(stock.values.at(-1)).toEqual({ $type: "Book", id: "b1", stock: 1 });
  expect(store.books.get("b1")?.stock).toBe(1);
});
