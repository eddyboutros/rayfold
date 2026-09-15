import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RayfoldClient, RayfoldClientError, createFetchTransport } from "@rayfold/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookshopHttp, createBookshop, type Store } from "./bookshop.ts";

let http: Server;
let store: Store;
let base: string;

beforeEach(async () => {
  const shop = createBookshop();
  store = shop.store;
  http = bookshopHttp(shop.server);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
});

const clientFor = (token?: string) =>
  new RayfoldClient({ transport: createFetchTransport({ url: `${base}/rayfold`, headers: () => (token ? { authorization: `Bearer ${token}` } : {}) }) });

async function rejection(p: Promise<unknown>): Promise<RayfoldClientError> {
  const e = await p.then(
    () => new Error("expected the call to fail"),
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(RayfoldClientError);
  return e as RayfoldClientError;
}

/** The first value `watch` reports that passes `test`, or a failure after 5 s. */
function watched<T>(client: RayfoldClient, op: string, args: Record<string, unknown>, shape: string, test: (v: T) => boolean): { value: Promise<T>; stop: () => void } {
  let stop = () => {};
  const value = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no matching ${op} value within 5 s`)), 5000);
    stop = client.watch<T>(op, args, { shape }, (v) => {
      if (!test(v)) return;
      clearTimeout(timer);
      resolve(v);
    }, reject);
  });
  return { value, stop };
}

describe("the bookshop over HTTP", () => {
  it("reads a book with the fields and the author it was asked for", async () => {
    const book = await clientFor().query("book", { id: "b1" }, { shape: "{ title stock author { name } }" });
    expect(book).toMatchObject({ title: "A Wizard of Earthsea", stock: 3, author: { name: "Ursula K. Le Guin" } });
  });

  it("pages through the books with a cursor", async () => {
    const client = clientFor();
    type Page = { items: Array<{ id: string }>; cursor: string | null; hasMore: boolean; total: number };
    const first = await client.query<Page>("books", { page: { first: 2 } }, { shape: "{ items { id } cursor hasMore total }" });
    expect(first).toMatchObject({ items: [{ id: "b1" }, { id: "b2" }], hasMore: true, total: 3 });
    const second = await client.query<Page>("books", { page: { first: 2, after: first.cursor } }, { shape: "{ items { id } hasMore }" });
    expect(second).toMatchObject({ items: [{ id: "b3" }], hasMore: false });
  });

  it("buying lowers the stock, and a watching client sees it from the command's patch", async () => {
    const client = clientFor("customer");
    const watch = watched<{ stock: number }>(client, "book", { id: "b1" }, "{ id stock }", (b) => b.stock === 2);
    await client.command("buy", { bookId: "b1", qty: 1 });
    await expect(watch.value).resolves.toMatchObject({ stock: 2 });
    watch.stop();
    expect(store.books.get("b1")?.stock).toBe(2);
  });

  it("buying more than there is fails with OutOfStock and how many are left, and sells nothing", async () => {
    const e = await rejection(clientFor("customer").command("buy", { bookId: "b1", qty: 5 }));
    expect(e.is("OutOfStock")).toBe(true);
    expect(e.data).toEqual({ bookId: "b1", available: 3 });
    expect(store.books.get("b1")?.stock).toBe(3);
  });

  it("refuses a purchase from someone who is not signed in", async () => {
    const e = await rejection(clientFor().command("buy", { bookId: "b1" }));
    expect(["permission_denied", "unauthenticated"]).toContain(e.code);
    expect(store.books.get("b1")?.stock).toBe(3);
  });

  it("lets staff restock and refuses a customer", async () => {
    const refused = await rejection(clientFor("customer").command("restock", { bookId: "b2", qty: 4 }));
    expect(refused.code).toBe("permission_denied");
    expect(store.books.get("b2")?.stock).toBe(0);

    await expect(clientFor("staff").command("restock", { bookId: "b2", qty: 4 })).resolves.toMatchObject({ stock: 4 });
    expect(store.books.get("b2")?.stock).toBe(4);
  });

  it("shows the cost price to staff and not to a customer", async () => {
    const staff = await clientFor("staff").query("book", { id: "b3" }, { shape: "{ id costPrice }" });
    expect(staff).toMatchObject({ costPrice: "6.00" });

    const e = await rejection(clientFor("customer").query("book", { id: "b3" }, { shape: "{ id costPrice }" }));
    expect(e.code).toBe("permission_denied");
  });

  it("a live query hears about a restock someone else makes", async () => {
    const seen: number[] = [];
    let stop = () => {};
    const restocked = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no live update within 5 s, saw ${seen.join(", ")}`)), 5000);
      stop = clientFor("customer").live<{ stock: number }>("book", { id: "b3" }, { shape: "{ id stock }" }, (b, { initial }) => {
        seen.push(b.stock);
        if (initial) void clientFor("staff").command("restock", { bookId: "b3", qty: 2 });
        else if (b.stock === 9) {
          clearTimeout(timer);
          resolve();
        }
      }, reject);
    });
    await restocked;
    stop();
    expect(seen).toEqual([7, 9]);
  });

  it("serves the explorer beside the endpoint and nothing else", async () => {
    const page = await fetch(`${base}/rayfold/explorer`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
  });
});
