/**
 * The bindings tested the way an application tests its own use of them, with no network: the bookshop server in this
 * process, a client that calls it directly, and an injector that provides that client. angular.test.ts covers the
 * bindings themselves, over HTTP.
 */
import { afterEach, expect, it } from "vitest";
import { Injector, runInInjectionContext, type DestroyableInjector } from "@angular/core";
import { createWatch } from "@angular/core/primitives/signals";
import { RayfoldClient, createLocalTransport } from "@rayfold/client";
import { collect, type Collected } from "@rayfold/client/testing";
import { createBookshop, type Viewer } from "../../../examples/typescript/src/bookshop.ts";
import { injectCommand, injectLive, injectQuery, provideRayfold } from "./index.ts";

interface Book {
  id: string;
  title: string;
  stock: number;
}

// #region test-setup
let injector: DestroyableInjector | undefined;
afterEach(() => injector?.destroy()); // ends what the test left subscribed

/** A bookshop of its own and an injector whose client calls it directly, as `viewer`. Nothing listens on a port. */
function start(viewer: Viewer | null = { id: "u1", role: "customer" }) {
  const { server, store } = createBookshop();
  const as = (who: Viewer | null) => new RayfoldClient({ transport: createLocalTransport(server, () => who) });
  const providing = Injector.create({ providers: provideRayfold(as(viewer)) });
  injector = providing;
  return { injector: providing, store, as };
}
// #endregion test-setup

// #region test-wait
/** What `read` returns, now and again each time a signal it reads changes. */
function following<T>(read: () => T): Collected<T> {
  return collect<T>((next) => {
    // an injector on its own runs no effects, so this follows the signals directly
    const watch = createWatch(() => next(read()), (dirty) => queueMicrotask(() => dirty.run()), false);
    watch.run();
    return () => watch.destroy();
  });
}
// #endregion test-wait

// #region test-query
it("injectQuery is loading from the moment it is injected, then holds the book", async () => {
  const { injector } = start();
  const book = runInInjectionContext(injector, () =>
    injectQuery<Book>("book", { id: "b1" }, { shape: "{ id title stock }" }),
  );
  expect([book.loading(), book.data(), book.error()]).toEqual([true, undefined, undefined]);

  const loading = following(() => book.loading());
  expect(await loading.next("the query in flight")).toBe(true);
  expect(await loading.next("the query settled")).toBe(false);
  loading.stop();

  expect(book.data()).toEqual({ $type: "Book", id: "b1", title: "A Wizard of Earthsea", stock: 3 });
  expect(book.error()).toBeUndefined();
});
// #endregion test-query

it("injectQuery keeps a refusal in its error signal, and holds no data", async () => {
  const { injector } = start();
  const [priced, titled] = runInInjectionContext(injector, () => [
    injectQuery<Book>("book", { id: "b3" }, { shape: "{ id costPrice }" }),
    injectQuery<Book>("book", { id: "b3" }, { shape: "{ id title }" }),
  ]);
  const refusal = following(() => priced.error());
  const title = following(() => titled.data()?.title);

  expect(await refusal.next("the refused query in flight")).toBeUndefined();
  expect(await refusal.next("the refusal")).toMatchObject({ code: "permission_denied", path: "costPrice" });
  refusal.stop();
  expect([priced.loading(), priced.data()]).toEqual([false, undefined]);

  // guard: the same book without that field is not refused
  expect(await title.next("the other query in flight")).toBeUndefined();
  expect(await title.next("the title")).toBe("Dune");
  title.stop();
  expect([titled.loading(), titled.error()]).toEqual([false, undefined]);
});

// #region test-command
it("injectCommand runs a restock, and the query showing that book follows it", async () => {
  const { injector, store } = start({ id: "s1", role: "staff" });
  const [book, restock] = runInInjectionContext(injector, () => [
    injectQuery<Book>("book", { id: "b2" }, { shape: "{ id stock }" }),
    injectCommand<Book>("restock"),
  ]);
  const stock = following(() => book.data()?.stock);
  expect(await stock.next("the query in flight")).toBeUndefined();
  expect(await stock.next("the book")).toBe(0);

  const done = restock.run({ bookId: "b2", qty: 4 });
  expect(restock.running()).toBe(true);
  await done;
  expect([restock.running(), restock.data()?.stock, restock.error()]).toEqual([false, 4, undefined]);

  expect(await stock.next("the restocked book")).toBe(4);
  stock.stop();
  expect(store.books.get("b2")?.stock).toBe(4);
});
// #endregion test-command

it("injectCommand keeps a declared error in its signals, by name and with its payload", async () => {
  const { injector, store } = start();
  const buy = runInInjectionContext(injector, () => injectCommand<Book>("buy"));

  await expect(buy.run({ bookId: "b1", qty: 5 })).rejects.toMatchObject({ type: "OutOfStock" });
  expect([buy.running(), buy.data(), buy.error()]).toMatchObject([false, undefined, { code: "domain", type: "OutOfStock", data: { bookId: "b1", available: 3 } }]);
  expect(store.books.get("b1")?.stock).toBe(3);

  // guard: a purchase the shop accepts clears the error, from the moment it starts, and holds the book
  const accepted = buy.run({ bookId: "b1", qty: 3 });
  expect([buy.running(), buy.error()]).toEqual([true, undefined]);
  await accepted;
  expect([buy.running(), buy.data()?.stock, buy.error()]).toEqual([false, 0, undefined]);
  expect(store.books.get("b1")?.stock).toBe(0);
});

// #region test-live
it("injectLive follows a restock someone else makes", async () => {
  const { injector, as } = start();
  const book = runInInjectionContext(injector, () =>
    injectLive<Book>("book", { id: "b3" }, { shape: "{ id stock }" }),
  );
  const stock = following(() => book.data()?.stock);
  expect(await stock.next("the query opening")).toBeUndefined();
  expect(await stock.next("the stock when the query opened")).toBe(7);

  await as({ id: "s1", role: "staff" }).command("restock", { bookId: "b3", qty: 5 });

  expect(await stock.next("the restock")).toBe(12);
  stock.stop();
  expect(stock.values).toEqual([undefined, 7, 12]);
});
// #endregion test-live

it("injectQuery shows what the cache already holds for the same call at once, while it asks the server again", async () => {
  const { injector } = start();
  const first = runInInjectionContext(injector, () => injectQuery<Book>("book", { id: "b3" }, { shape: "{ id stock }" }));
  const stock = following(() => first.data()?.stock);
  expect(await stock.next("the first query in flight")).toBeUndefined();
  expect(await stock.next("the first query's answer")).toBe(7);
  stock.stop();

  const again = runInInjectionContext(injector, () => injectQuery<Book>("book", { id: "b3" }, { shape: "{ id stock }" }));
  expect([again.loading(), again.data()]).toEqual([true, { $type: "Book", id: "b3", stock: 7 }]);
  // guard: a call the cache holds nothing for starts empty
  const other = runInInjectionContext(injector, () => injectQuery<Book>("book", { id: "b1" }, { shape: "{ id stock }" }));
  expect([other.loading(), other.data()]).toEqual([true, undefined]);
});

it("injectCommand passes the options given to one run, so a retry under the same key is answered from its record", async () => {
  const { injector, store } = start({ id: "s1", role: "staff" });
  const restock = runInInjectionContext(injector, () => injectCommand<Book>("restock"));

  const first = await restock.run({ bookId: "b2", qty: 4 }, { key: "delivery-0017-b2" });
  expect(await restock.run({ bookId: "b2", qty: 4 }, { key: "delivery-0017-b2" })).toEqual(first);
  expect(store.books.get("b2")?.stock).toBe(4);
  // guard: under another key it is another restock
  await restock.run({ bookId: "b2", qty: 4 }, { key: "delivery-0018-b2" });
  expect(store.books.get("b2")?.stock).toBe(8);
});
