import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { RayfoldClient, RayfoldClientError, createFetchTransport } from "@rayfold/client";
import { createRayfoldServer, type RayfoldServer } from "@rayfold/server";
import { SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bookshopHttp, createBookshop, devToken, resolvers, seed, type Book, type Store } from "./bookshop.ts";

let http: Server;
let store: Store;
let base: string;

async function serve(server: RayfoldServer): Promise<void> {
  http = bookshopHttp(server);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  const shop = createBookshop();
  store = shop.store;
  await serve(shop.server);
});

const close = () =>
  new Promise<void>((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });

afterEach(close);

/** Tokens as the identity provider issues them at sign-in, one per role. */
const tokens: Record<"customer" | "staff", string> = { customer: "", staff: "" };
beforeAll(async () => {
  tokens.customer = await devToken("u1", "customer");
  tokens.staff = await devToken("s1", "staff");
});

/** A client signed in as `role`, or anonymous, that also records the op names of every request it sends. */
function recordingClient(role?: "customer" | "staff", bearer = role && tokens[role]): { client: RayfoldClient; requests: string[][] } {
  const requests: string[][] = [];
  const client = new RayfoldClient({
    transport: createFetchTransport({
      url: `${base}/rayfold`,
      headers: () => (bearer ? { authorization: `Bearer ${bearer}` } : {}),
      fetch: (input, init) => {
        requests.push((JSON.parse(String(init?.body)) as { ops: Array<{ op: string }> }).ops.map((o) => o.op));
        return fetch(input, init);
      },
    }),
  });
  return { client, requests };
}

const clientFor = (role?: "customer" | "staff") => recordingClient(role).client;

async function rejection(p: Promise<unknown>): Promise<RayfoldClientError> {
  const e = await p.then(
    () => new Error("expected the call to fail"),
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(RayfoldClientError);
  return e as RayfoldClientError;
}

/** Watches `op` and keeps every value it reports; `reach` waits, at most 5 s, for one that passes `test`. */
function watched<T>(client: RayfoldClient, op: string, args: Record<string, unknown>, shape: string) {
  const values: T[] = [];
  let waiters: Array<{ test: (v: T) => boolean; done: (error?: unknown) => void }> = [];
  const stop = client.watch<T>(op, args, { shape }, (v) => {
    values.push(v);
    waiters = waiters.filter((w) => !w.test(v) || (w.done(), false));
  }, (error) => waiters.splice(0).forEach((w) => w.done(error)));
  const reach = (test: (v: T) => boolean, what: string) =>
    new Promise<void>((resolve, reject) => {
      if (values.some(test)) return resolve();
      const timer = setTimeout(() => reject(new Error(`no ${what} within 5 s, saw ${JSON.stringify(values)}`)), 5000);
      waiters.push({ test, done: (error) => (clearTimeout(timer), error === undefined ? resolve() : reject(error)) });
    });
  return { values, reach, stop };
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

  it("a page of three books asks for their authors in one loader call, and a page without authors makes none", async () => {
    const store = seed();
    const shop = resolvers(store);
    const author = vi.fn((shop["Book"] as { author: (books: Book[]) => unknown }).author);
    await close();
    await serve(createRayfoldServer({ schema: readFileSync(new URL("./bookshop.rayfold", import.meta.url), "utf8"), resolvers: { ...shop, Book: { author } } }));
    const client = clientFor();

    const page = await client.query("books", { page: { first: 3 } }, { shape: "{ items { id author { id name } } }" });
    expect(page).toEqual({
      items: [
        { $type: "Book", id: "b1", author: { $type: "Author", id: "a1", name: "Ursula K. Le Guin" } },
        { $type: "Book", id: "b2", author: { $type: "Author", id: "a1", name: "Ursula K. Le Guin" } },
        { $type: "Book", id: "b3", author: { $type: "Author", id: "a2", name: "Frank Herbert" } },
      ],
    });
    expect(author).toHaveBeenCalledTimes(1);
    expect(author.mock.calls[0]![0].map((b) => b.id)).toEqual(["b1", "b2", "b3"]);

    await client.query("books", { page: { first: 3 } }, { shape: "{ items { id title } }" });
    expect(author).toHaveBeenCalledTimes(1);
  });

  it("buying lowers the stock, and a watching client sees it from the command's patch, without another request", async () => {
    const { client, requests } = recordingClient("customer");
    const b1 = watched<{ stock: number }>(client, "book", { id: "b1" }, "{ id stock }");
    await b1.reach((b) => b.stock === 3, "the watched book");
    expect(requests).toEqual([["book"]]);
    await client.command("buy", { bookId: "b1", qty: 1 });
    await b1.reach((b) => b.stock === 2, "the stock after buying");
    b1.stop();
    expect(b1.values).toEqual([{ $type: "Book", id: "b1", stock: 3 }, { $type: "Book", id: "b1", stock: 2 }]);
    expect(store.books.get("b1")?.stock).toBe(2);
    expect(requests).toEqual([["book"], ["buy"]]);
  });

  it("buying more than there is fails with OutOfStock and how many are left, and sells nothing", async () => {
    const e = await rejection(clientFor("customer").command("buy", { bookId: "b1", qty: 5 }));
    expect(e.is("OutOfStock")).toBe(true);
    expect(e.data).toEqual({ bookId: "b1", available: 3 });
    expect(store.books.get("b1")?.stock).toBe(3);
  });

  it("a quantity outside @range(min: 1, max: 10) is refused before the resolver runs; one inside it sells", async () => {
    const client = clientFor("customer");
    const zero = await rejection(client.command("buy", { bookId: "b1", qty: 0 }));
    expect([zero.code, zero.message]).toEqual(["invalid_argument", "buy().qty: must be >= 1"]);
    const eleven = await rejection(client.command("buy", { bookId: "b1", qty: 11 }));
    expect([eleven.code, eleven.message]).toEqual(["invalid_argument", "buy().qty: must be <= 10"]);
    expect(store.books.get("b1")?.stock).toBe(3);
    await expect(client.command("buy", { bookId: "b1", qty: 3 })).resolves.toEqual({ $type: "Book", id: "b1", title: "A Wizard of Earthsea", stock: 0 });
    expect(store.books.get("b1")?.stock).toBe(0);
  });

  it("refuses a purchase from someone who is not signed in", async () => {
    const e = await rejection(clientFor().command("buy", { bookId: "b1" }));
    expect([e.code, e.message]).toEqual(["unauthenticated", "Sign in to access buy()"]);
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

  it("believes a role only from a token that verifies: a forged, expired or foreign one is refused before anything runs", async () => {
    const restock = (bearer: string) => rejection(recordingClient(undefined, bearer).client.command("restock", { bookId: "b2", qty: 4 }));
    const signed = (key: string, claims: { iss?: string; aud?: string; exp?: number | string } = {}) =>
      new SignJWT({ role: "staff" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("s1")
        .setIssuer(claims.iss ?? "http://localhost:4000/dev")
        .setAudience(claims.aud ?? "bookshop")
        .setExpirationTime(claims.exp ?? "1h")
        .sign(new TextEncoder().encode(key));
    const refused = [
      await restock("staff"), // the role's name is not a credential
      await restock(await signed("a key the server does not hold")),
      await restock(await signed("bookshop development key, not a secret", { exp: 1 })), // expired in 1970
      await restock(await signed("bookshop development key, not a secret", { iss: "https://someone-else.example" })),
      await restock(await signed("bookshop development key, not a secret", { aud: "another-app" })),
    ];
    expect(refused.map((e) => [e.code, e.message])).toEqual(Array(5).fill(["unauthenticated", "Invalid or expired token"]));
    expect(store.books.get("b2")?.stock).toBe(0);
    // guard: the same claims, signed with the key and for this issuer and audience, are believed
    await expect(recordingClient(undefined, await signed("bookshop development key, not a secret")).client.command("restock", { bookId: "b2", qty: 4 })).resolves.toMatchObject({ stock: 4 });
  });

  it("serves the explorer beside the endpoint and nothing else", async () => {
    const page = await fetch(`${base}/rayfold/explorer`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
  });
});
