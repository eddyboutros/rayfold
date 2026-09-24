import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { bindingsOf, createBindingHandler, type BindingOptions } from "./bindings.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
import { HTTP_STATUS, type Frame } from "./protocol.ts";
import type { Resolvers } from "./executor.ts";
import { mcpTools } from "./mcp.ts";

const KEY = "key-0123456789abcdef";
const KEY2 = "key-fedcba9876543210";
const U1 = { authorization: "Bearer u1" };
const U2 = { authorization: "Bearer u2" };
const ADMIN = { authorization: "Bearer admin" };
const FALLTHROUGH = "host 404";

const AUTHOR_A1 = { $type: "Author", id: "a1", name: "Ursula K. Le Guin" };
const BOOK_B1 = { $type: "Book", id: "b1", title: "The Dispossessed", format: "PAPERBACK", price: "12.99", stock: 5, author: AUTHOR_A1 };
const REVIEW_R1 = { $type: "Review", id: "r1", rating: 5, body: "Ambiguous utopia, unambiguous masterpiece.", reviewerId: "u2", version: 1 };
const ORDER_O1 = { $type: "Order", id: "o1", status: "PLACED", total: "16.00", items: [{ qty: 2, unitPrice: "8.00", book: { $type: "Book", id: "b3", title: "Kindred" } }] };
const ORDER_O1_ROW = { id: "o1", status: "PLACED" as const, customerId: "u1", items: [{ bookId: "b3", qty: 2, unitPrice: "8.00" }], total: "16.00" };
const ETAG = /^"sha256-[0-9a-f]{64}"$/;

function viewerOf(req: IncomingMessage): unknown {
  const auth = req.headers.authorization;
  if (auth === "Bearer admin") return { id: "u9", role: "admin" };
  if (auth?.startsWith("Bearer ")) return { id: auth.slice(7), role: "customer" };
  return null;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        }),
    ),
  );
});

/** Mounted the way e2e/harness.ts mounts it: the handler answers bound routes, the host answers everything else. */
async function serve(server: RayfoldServer, opts: BindingOptions = {}): Promise<string> {
  const handler = createBindingHandler(server, { viewer: viewerOf, ...opts });
  const http = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) res.writeHead(404, { "content-type": "text/plain" }).end(FALLTHROUGH);
    });
  });
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

function send(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return fetch(url, init);
}

function problemOf(code: string, status: number, detail: string): Record<string, unknown> {
  return { type: `https://eddyboutros.github.io/rayfold/errors/${code}`, title: code.replace(/_/g, " "), status, detail, code };
}

const ITEMS_SCHEMA = `
entity Item { id: ID n: Int }
entity Note { id: ID title: String body: String @lazy parent: Note? }
enum Format { A B }
input ItemFilter { min: Int? }
query items(limit: Int, flag: Boolean, format: Format?, where: ItemFilter?): [Item] @http(method: GET, path: "/items")
query item(n: Int): Item? @http(method: GET, path: "/items/{n}")
query file(name: String): Item? @http(method: GET, path: "/files/{name}.json")
query note(id: ID): Note? @http(method: GET, path: "/notes/{id}")
command free(n: Int): Item @idempotent(false) @http(method: POST, path: "/free", body: "*")
command keyed(n: Int): Item @http(method: POST, path: "/keyed", body: "*")
command drop(id: ID): Item? @http(method: "delete", path: "/items/{id}")
`;

/** A small schema whose resolvers record exactly the arguments they received. */
function itemsServer(): { server: RayfoldServer; seen: Array<[string, unknown]> } {
  const seen: Array<[string, unknown]> = [];
  const resolvers: Resolvers = {
    Query: {
      items: (args: Record<string, unknown>) => {
        seen.push(["items", args]);
        return [{ id: "i1", n: 1 }];
      },
      item: (args: { n: number }) => {
        seen.push(["item", args]);
        return { id: `i${args.n}`, n: args.n };
      },
      file: (args: { name: string }) => {
        seen.push(["file", args]);
        return { id: args.name, n: 0 };
      },
      note: (args: { id: string }) => ({ id: args.id, title: "T", body: "B", parent: { id: "p", title: "PT", body: "PB", parent: null } }),
    },
    Command: {
      free: (args: { n: number }) => {
        seen.push(["free", args]);
        return { id: `f${seen.length}`, n: args.n };
      },
      keyed: (args: { n: number }) => {
        seen.push(["keyed", args]);
        return { id: "k", n: args.n };
      },
      drop: () => null,
    },
  };
  return { server: createRayfoldServer({ schema: ITEMS_SCHEMA, resolvers }), seen };
}

describe("GET bindings", () => {
  it("GET /books/{id}: default view, Cache-Control from @cache, an ETag, and 304 on a matching If-None-Match", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const res = await fetch(`${base}/books/b1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("vary")).toBe("Rayfold-Client, Accept, Authorization");
    expect(res.headers.get("location")).toBeNull();
    const etag = String(res.headers.get("etag"));
    expect(etag).toMatch(ETAG);
    expect(await res.json()).toEqual(BOOK_B1);

    const again = await fetch(`${base}/books/b1`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    // The ETag is derived from the result, so a revalidation still runs the resolver.
    expect(bs.store.calls["Query.book"]).toBe(2);
  });

  it("GET with a foreign or outdated If-None-Match gets a full 200 with the current ETag", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const first = await fetch(`${base}/books/b1`);
    const etag = String(first.headers.get("etag"));

    const foreign = await fetch(`${base}/books/b1`, { headers: { "if-none-match": `"sha256-${"0".repeat(64)}"` } });
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get("etag")).toBe(etag);
    expect(await foreign.json()).toEqual(BOOK_B1);

    const row = bs.store.books.get("b1");
    if (!row) throw new Error("seed has no b1");
    row.stock = 4;
    const changed = await fetch(`${base}/books/b1`, { headers: { "if-none-match": etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).toMatch(ETAG);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(await changed.json()).toEqual({ ...BOOK_B1, stock: 4 });
  });

  it("GET answers 304 to the weak ETag a compressing proxy hands out, to a list naming it, and to *", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const etag = String((await fetch(`${base}/books/b1`)).headers.get("etag"));
    for (const header of [`W/${etag}`, `"sha256-${"0".repeat(64)}", ${etag}`, "*"]) {
      const res = await fetch(`${base}/books/b1`, { headers: { "if-none-match": header } });
      expect(res.status, header).toBe(304);
      expect(await res.text()).toBe("");
    }
    // guard: a weak list that names only other tags gets the full answer
    const other = await fetch(`${base}/books/b1`, { headers: { "if-none-match": `W/"sha256-${"0".repeat(64)}", W/"x"` } });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual(BOOK_B1);
  });

  it("a Long path or query parameter past 2^53 reaches the resolver digit for digit, as text; one that fits a number is a number", async () => {
    const seen: unknown[] = [];
    const server = createRayfoldServer({
      schema: `entity L { id: ID n: Long } query byN(n: Long): L? @http(method: GET, path: "/longs/{n}") query longs(n: Long): [L] @http(method: GET, path: "/longs")`,
      resolvers: {
        Query: {
          byN: (args: { n: number | string }) => (seen.push(args.n), { id: "l", n: args.n }),
          longs: (args: { n: number | string }) => (seen.push(args.n), []),
        },
      },
    });
    const base = await serve(server);
    const path = await fetch(`${base}/longs/9007199254740993`);
    expect(path.status).toBe(200);
    expect(await path.json()).toEqual({ $type: "L", id: "l", n: "9007199254740993" });
    expect((await fetch(`${base}/longs?n=-9223372036854775808`)).status).toBe(200);
    expect((await fetch(`${base}/longs/42`)).status).toBe(200);
    expect(seen).toEqual(["9007199254740993", "-9223372036854775808", 42]);
    // guard: past the Long range it is still refused, and the resolver never runs
    const over = await fetch(`${base}/longs/9223372036854775808`);
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual(problemOf("invalid_argument", 400, "byN().n: expected Long"));
    expect(seen).toHaveLength(3);
  });

  it("GET ?shape= projects the requested shape instead of the default view, with its own ETag", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const res = await fetch(`${base}/books/b1?shape=${encodeURIComponent("{ id author { name } }")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await res.json()).toEqual({ $type: "Book", id: "b1", author: { $type: "Author", name: "Ursula K. Le Guin" } });
    const byDefault = await fetch(`${base}/books/b1`);
    expect(res.headers.get("etag")).toMatch(ETAG);
    expect(res.headers.get("etag")).not.toBe(byDefault.headers.get("etag"));
  });

  it("GET /reviews/{id} and /orders/{id} answer 200 without Location; Cache-Control and visibility follow @cache and the viewer", async () => {
    const bs = createBookstore();
    bs.store.orders.set("o1", structuredClone(ORDER_O1_ROW));
    const base = await serve(bs.server);

    const review = await fetch(`${base}/reviews/r1`);
    expect(review.status).toBe(200);
    expect(review.headers.get("location")).toBeNull();
    expect(review.headers.get("cache-control")).toBe("public, max-age=0, no-cache");
    expect(await review.json()).toEqual(REVIEW_R1);

    const owner = await fetch(`${base}/orders/o1`, { headers: U1 });
    expect(owner.status).toBe(200);
    expect(owner.headers.get("location")).toBeNull();
    expect(owner.headers.get("cache-control")).toBe("private, max-age=0, no-cache");
    expect(await owner.json()).toEqual(ORDER_O1);

    // Default views never fail on a type policy: another customer sees null, not the order.
    const stranger = await fetch(`${base}/orders/o1`, { headers: U2 });
    expect(stranger.status).toBe(200);
    expect(await stranger.json()).toBeNull();

    const anonymous = await fetch(`${base}/orders/o1`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("content-type")).toBe("application/problem+json");
    expect(await anonymous.json()).toEqual(problemOf("unauthenticated", 401, "Sign in to access order()"));

    const missing = await fetch(`${base}/books/zzz`);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toBeNull();
    expect(bs.store.calls).toEqual({ "Query.review": 1, "Query.order": 2, "Query.book": 1, "OrderItem.book": 1 });
  });

  it("GET query-string values are coerced by declared type: Int, Boolean, enum text and a JSON-encoded input", async () => {
    const { server, seen } = itemsServer();
    const base = await serve(server);
    const where = encodeURIComponent(JSON.stringify({ min: 2 }));
    const res = await fetch(`${base}/items?limit=-3&flag=false&format=B&where=${where}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ $type: "Item", id: "i1", n: 1 }]);
    const other = await fetch(`${base}/items?limit=7&flag=true`);
    expect(other.status).toBe(200);
    expect(seen).toEqual([
      ["items", { limit: -3, flag: false, format: "B", where: { min: 2 } }],
      ["items", { limit: 7, flag: true }],
    ]);
  });

  it("a query-string value that does not fit its declared type is a 400 invalid_argument before the resolver runs", async () => {
    const { server, seen } = itemsServer();
    const base = await serve(server);
    const cases: Array<[string, string]> = [
      ["limit=ten&flag=true", "items().limit: expected Int"],
      ["limit=1.5&flag=true", "items().limit: expected Int"],
      ["limit=1&flag=yes", "items().flag: expected Boolean"],
      ["limit=1&flag=true&format=C", "items().format: expected one of A, B"],
      ["limit=1&flag=true&bogus=1", "items().bogus: unknown argument"],
    ];
    for (const [qs, detail] of cases) {
      const res = await fetch(`${base}/items?${qs}`);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await res.json()).toEqual(problemOf("invalid_argument", 400, detail));
    }
    expect(seen).toEqual([]);

    const valid = await fetch(`${base}/items?limit=1&flag=true`);
    expect(valid.status).toBe(200);
    expect(seen).toEqual([["items", { limit: 1, flag: true }]]);
  });

  it("an Int path parameter is coerced to a number, is percent-decoded, and wins over a same-named query parameter", async () => {
    const { server, seen } = itemsServer();
    const base = await serve(server);
    const res = await fetch(`${base}/items/42?n=9`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ $type: "Item", id: "i42", n: 42 });

    const bad = await fetch(`${base}/items/abc`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual(problemOf("invalid_argument", 400, "item().n: expected Int"));

    const decoded = await fetch(`${base}/files/a%20b.json`);
    expect(decoded.status).toBe(200);
    expect(await decoded.json()).toEqual({ $type: "Item", id: "a b", n: 0 });
    expect(seen).toEqual([
      ["item", { n: 42 }],
      ["file", { name: "a b" }],
    ]);
  });

  it("GET folds deferred @lazy `at` frames into the JSON body, at the root and at a nested path", async () => {
    const { server } = itemsServer();
    const base = await serve(server);
    const shape = "{ id body parent { id body } }";
    const res = await fetch(`${base}/notes/n1?shape=${encodeURIComponent(shape)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ $type: "Note", id: "n1", body: "B", parent: { $type: "Note", id: "p", body: "PB" } });

    // The same op over Rayfold really does split the lazy fields into `at` frames, so the body above was folded.
    const frames = await server.collect({ ops: [{ id: 1, op: "note", args: { id: "n1" }, shape }] });
    expect(frames.filter((f) => "at" in f)).toEqual([
      { id: 1, at: "", data: { body: "B" } },
      { id: 1, at: "parent", data: { body: "PB" } },
    ]);

    const eager = await fetch(`${base}/notes/n1?shape=${encodeURIComponent("{ id title }")}`);
    expect(await eager.json()).toEqual({ $type: "Note", id: "n1", title: "T" });
  });
});

describe("QUERY bindings", () => {
  it("QUERY /books spreads a JSON object body into the arguments, matching a direct Rayfold call, and revalidates with 304", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const args = { filter: { format: "PAPERBACK" }, page: { first: 1 } };
    const res = await send(`${base}/books`, "QUERY", args);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const etag = String(res.headers.get("etag"));
    expect(etag).toMatch(ETAG);
    const body = await res.json();
    expect(body).toMatchObject({ items: [{ id: "b1" }], cursor: "b1", hasMore: true, total: 2 });
    expect(bs.store.calls["Query.books"]).toBe(1);

    const [frame] = await bs.server.collect({ ops: [{ id: 1, op: "books", args }] });
    expect(frame).toMatchObject({ id: 1, fin: true });
    expect(body).toEqual((frame as { data: unknown }).data);

    const again = await send(`${base}/books`, "QUERY", args, { "if-none-match": etag });
    expect(again.status).toBe(304);
  });

  it("QUERY with an empty body runs with the declared defaults", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const res = await fetch(`${base}/books`, { method: "QUERY" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ cursor: "b4", hasMore: false, total: 4 });
    expect(body.items.map((b: { id: string }) => b.id)).toEqual(["b1", "b2", "b3", "b4"]);
    const [frame] = await bs.server.collect({ ops: [{ id: 1, op: "books" }] });
    expect(body).toEqual((frame as { data: unknown }).data);
  });

  it("QUERY rejects a JSON body that is not an object, and malformed JSON, with 400 before the resolver runs", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    for (const raw of ["[1,2]", '"text"', "null", "42"]) {
      const res = await send(`${base}/books`, "QUERY", raw);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(await res.json()).toEqual(problemOf("invalid_argument", 400, "Body must be a JSON object"));
    }
    const malformed = await send(`${base}/books`, "QUERY", "{nope");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual(problemOf("invalid_argument", 400, "Body is not valid JSON"));
    expect(bs.store.calls["Query.books"]).toBeUndefined();

    const valid = await send(`${base}/books`, "QUERY", {});
    expect(valid.status).toBe(200);
    expect(bs.store.calls["Query.books"]).toBe(1);
  });
});

describe("POST bindings", () => {
  it("POST /orders without a valid Idempotency-Key is a 400 and places no order", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const order = { lines: [{ bookId: "b3", qty: 2 }] };
    const missing = await send(`${base}/orders`, "POST", order, U1);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual(problemOf("invalid_argument", 400, "POST /orders requires an Idempotency-Key header (16-128 characters)"));
    const short = await send(`${base}/orders`, "POST", order, { ...U1, "idempotency-key": "short" });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual(problemOf("invalid_argument", 400, "placeOrder(): commands require an idempotency key of 16-128 characters"));
    expect(bs.store.orders.size).toBe(0);
    expect(bs.store.books.get("b3")?.stock).toBe(100);
    expect(bs.store.calls["Command.placeOrder"]).toBeUndefined();

    const keyed = await send(`${base}/orders`, "POST", order, { ...U1, "idempotency-key": KEY });
    expect(keyed.status).toBe(201);
    expect(bs.store.orders.size).toBe(1);
  });

  it("POST /orders with a key answers 201 + Location; the same key replays it, a new key places another order", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const order = { lines: [{ bookId: "b3", qty: 2 }] };
    const first = await send(`${base}/orders`, "POST", order, { ...U1, "idempotency-key": KEY });
    expect(first.status).toBe(201);
    expect(first.headers.get("location")).toBe("/orders/o1");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("etag")).toBeNull();
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const placed = await first.json();
    expect(placed).toEqual(ORDER_O1);
    expect(bs.store.orders.get("o1")).toEqual(ORDER_O1_ROW);
    expect(bs.store.books.get("b3")?.stock).toBe(98);

    const replay = await send(`${base}/orders`, "POST", order, { ...U1, "idempotency-key": KEY });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("location")).toBe("/orders/o1");
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.json()).toEqual(placed);
    expect(bs.store.orders.size).toBe(1);
    expect(bs.store.books.get("b3")?.stock).toBe(98);
    expect(bs.store.calls["Command.placeOrder"]).toBe(1);

    const second = await send(`${base}/orders`, "POST", order, { ...U1, "idempotency-key": KEY2 });
    expect(second.status).toBe(201);
    expect(second.headers.get("location")).toBe("/orders/o2");
    expect(second.headers.get("idempotent-replayed")).toBeNull();
    expect(bs.store.orders.size).toBe(2);
    expect(bs.store.calls["Command.placeOrder"]).toBe(2);
  });

  it("POST on an @idempotent(false) command runs without a key, while a sibling command without the opt-out is refused", async () => {
    const { server, seen } = itemsServer();
    const base = await serve(server);
    const free = await send(`${base}/free`, "POST", { n: 3 });
    expect(free.status).toBe(200);
    expect(free.headers.get("location")).toBeNull();
    expect(free.headers.get("cache-control")).toBe("no-store");
    expect(await free.json()).toEqual({ $type: "Item", id: "f1", n: 3 });
    const again = await send(`${base}/free`, "POST", { n: 3 });
    expect(await again.json()).toEqual({ $type: "Item", id: "f2", n: 3 });

    const keyed = await send(`${base}/keyed`, "POST", { n: 3 });
    expect(keyed.status).toBe(400);
    expect(await keyed.json()).toEqual(problemOf("invalid_argument", 400, "POST /keyed requires an Idempotency-Key header (16-128 characters)"));
    expect(seen).toEqual([
      ["free", { n: 3 }],
      ["free", { n: 3 }],
    ]);
  });

  it("POST /orders/{id}/pay answers 200 without Location; a declared domain error is a 422 problem carrying its type and data", async () => {
    const bs = createBookstore();
    bs.store.orders.set("o1", structuredClone(ORDER_O1_ROW));
    const base = await serve(bs.server);
    const paid = await send(`${base}/orders/o1/pay`, "POST", undefined, { ...U1, "idempotency-key": KEY });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("location")).toBeNull();
    expect(paid.headers.get("cache-control")).toBe("no-store");
    expect(await paid.json()).toEqual({ ...ORDER_O1, status: "PAID" });
    expect(bs.store.orders.get("o1")?.status).toBe("PAID");

    const twice = await send(`${base}/orders/o1/pay`, "POST", undefined, { ...U1, "idempotency-key": KEY2 });
    expect(HTTP_STATUS.domain).toBe(422);
    expect(twice.status).toBe(HTTP_STATUS.domain);
    expect(twice.headers.get("content-type")).toBe("application/problem+json");
    expect(await twice.json()).toEqual({ type: "https://eddyboutros.github.io/rayfold/errors/NotPayable", title: "NotPayable", status: 422, detail: "Order is PAID", code: "domain", data: { status: "PAID" } });
    expect(bs.store.calls["Command.payOrder"]).toBe(2);
  });
});

describe("PUT bindings", () => {
  const EDIT = { rating: 4, body: "Better on a reread." };
  const EDITED = { ...REVIEW_R1, rating: 4, body: "Better on a reread.", version: 2 };

  it("PUT /reviews/{id} with an If-Match that matches the version answers 200 with the new version as ETag", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const res = await send(`${base}/reviews/r1`, "PUT", EDIT, { ...U2, "if-match": '"1"' });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"2"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toEqual(EDITED);
    expect(bs.store.reviews.get("r1")).toEqual({ id: "r1", rating: 4, body: "Better on a reread.", bookId: "b1", reviewerId: "u2", version: 2 });
  });

  it("PUT with a stale If-Match is a 412 VersionConflict whose data.current is the review as stored, and changes nothing", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    expect((await send(`${base}/reviews/r1`, "PUT", EDIT, { ...U2, "if-match": '"1"' })).status).toBe(200);

    const stale = await send(`${base}/reviews/r1`, "PUT", { rating: 1, body: "Changed my mind." }, { ...U2, "if-match": '"1"' });
    expect(stale.status).toBe(412);
    expect(stale.headers.get("content-type")).toBe("application/problem+json");
    expect(await stale.json()).toEqual({
      type: "https://eddyboutros.github.io/rayfold/errors/VersionConflict",
      title: "VersionConflict",
      status: 412,
      detail: "Review:r1 is at version 2, not 1",
      code: "failed_precondition",
      data: { key: "Review:r1", expected: 1, actual: 2, current: EDITED },
    });
    expect(bs.store.reviews.get("r1")).toMatchObject({ rating: 4, body: "Better on a reread.", version: 2 });
  });

  it("PUT accepts a weak ETag W/\"n\" as If-Match, and compares a non-numeric If-Match as a string (412)", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const weak = await send(`${base}/reviews/r1`, "PUT", EDIT, { ...U2, "if-match": 'W/"1"' });
    expect(weak.status).toBe(200);
    expect(weak.headers.get("etag")).toBe('"2"');

    const text = await send(`${base}/reviews/r1`, "PUT", EDIT, { ...U2, "if-match": '"abc"' });
    expect(text.status).toBe(412);
    expect(await text.json()).toMatchObject({ title: "VersionConflict", detail: "Review:r1 is at version 2, not abc", data: { key: "Review:r1", expected: "abc", actual: 2 } });
    expect(bs.store.reviews.get("r1")?.version).toBe(2);
  });

  it("PUT runs without an Idempotency-Key (every call runs), and with a key a retry replays the first response", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const url = `${base}/reviews/r1`;
    const a = await send(url, "PUT", EDIT, U2);
    const b = await send(url, "PUT", EDIT, U2);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.headers.get("etag"), b.headers.get("etag")]).toEqual(['"2"', '"3"']);
    expect(b.headers.get("idempotent-replayed")).toBeNull();
    expect(bs.store.calls["Command.editReview"]).toBe(2);

    const c = await send(url, "PUT", EDIT, { ...U2, "idempotency-key": KEY });
    const d = await send(url, "PUT", EDIT, { ...U2, "idempotency-key": KEY });
    expect([c.status, d.status]).toEqual([200, 200]);
    expect(c.headers.get("idempotent-replayed")).toBeNull();
    expect(d.headers.get("idempotent-replayed")).toBe("true");
    expect(d.headers.get("etag")).toBe('"4"');
    expect(await d.json()).toEqual(await c.json());
    expect(bs.store.calls["Command.editReview"]).toBe(3);
    expect(bs.store.reviews.get("r1")?.version).toBe(4);
  });
});

describe("PATCH bindings", () => {
  it("PATCH /books/{id} applies a merge patch: absent fields stay, an explicit null the resolver refuses is a 400 with its message", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const merge = { ...ADMIN, "content-type": "application/merge-patch+json" };
    const res = await send(`${base}/books/b1`, "PATCH", { price: "10.00" }, merge);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
    expect(await res.json()).toEqual({ ...BOOK_B1, price: "10.00" });
    expect(bs.store.books.get("b1")).toEqual({ id: "b1", title: "The Dispossessed", format: "PAPERBACK", price: "10.00", stock: 5, authorId: "a1", costPrice: "6.10", ownerId: "u1" });

    const cleared = await send(`${base}/books/b1`, "PATCH", { title: null }, merge);
    expect(cleared.status).toBe(400);
    expect(await cleared.json()).toEqual(problemOf("invalid_argument", 400, "updateBook().patch.title: cannot be cleared"));
    expect(bs.store.books.get("b1")?.title).toBe("The Dispossessed");
    expect(bs.store.calls["Command.updateBook"]).toBe(2);
  });

  it("a numeric-looking String is range-checked by length, not value: PATCH title \"1984\" is accepted, 201 characters are not", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const merge = { ...ADMIN, "content-type": "application/merge-patch+json" };
    const res = await send(`${base}/books/b1`, "PATCH", { title: "1984" }, merge);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "b1", title: "1984" });
    const long = await send(`${base}/books/b1`, "PATCH", { title: "x".repeat(201) }, merge);
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual(problemOf("invalid_argument", 400, "updateBook().patch.title: must be <= 200"));
    expect(bs.store.books.get("b1")?.title).toBe("1984");
  });

  it("a malformed percent-escape in a path parameter is a 400, not a 500; a well-formed one still decodes (guard)", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const bad = await send(`${base}/books/%E0%A4%A`, "GET");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual(problemOf("invalid_argument", 400, "Path parameter id is not valid percent-encoding"));
    expect(bs.store.calls).toEqual({});
    const good = await send(`${base}/books/b%31`, "GET");
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ id: "b1" });
  });

  it("a malformed percent-escape in a query string is a 400, as on the JVM, and the resolver never runs", async () => {
    const seen: string[] = [];
    const server = createRayfoldServer({
      schema: `entity Item { id: ID n: Int }\nquery search(q: String): [Item] @http(method: GET, path: "/search")`,
      resolvers: { Query: { search: ({ q }: { q: string }) => (seen.push(q), []) } },
    });
    const base = await serve(server);
    for (const qs of ["q=%zz", "q=a%2", "q=ok&shape=%7B%20id%zz"]) {
      const res = await fetch(`${base}/search?${qs}`);
      expect(res.status, qs).toBe(400);
      expect(res.headers.get("content-type"), qs).toBe("application/problem+json");
      expect(await res.json(), qs).toEqual(problemOf("invalid_argument", 400, "Query string is not valid percent-encoding"));
    }
    expect(seen).toEqual([]);
  });

  it("guard: well-formed escapes in a query string still decode (%20 and %2F)", async () => {
    const seen: string[] = [];
    const server = createRayfoldServer({
      schema: `entity Item { id: ID n: Int }\nquery search(q: String): [Item] @http(method: GET, path: "/search")`,
      resolvers: { Query: { search: ({ q }: { q: string }) => (seen.push(q), []) } },
    });
    const base = await serve(server);
    const res = await fetch(`${base}/search?q=a%20b%2Fc&shape=%7B%20id%20%7D`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(seen).toEqual(["a b/c"]);
  });

  it("PATCH policy (write: viewer.role == \"admin\"): anonymous 401, customer 403, admin 200", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const patch = { stock: 7 };
    const anonymous = await send(`${base}/books/b1`, "PATCH", patch);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual(problemOf("unauthenticated", 401, "Sign in to access updateBook()"));
    const customer = await send(`${base}/books/b1`, "PATCH", patch, U1);
    expect(customer.status).toBe(403);
    expect(await customer.json()).toEqual(problemOf("permission_denied", 403, "Not allowed to access updateBook()"));
    expect(bs.store.books.get("b1")?.stock).toBe(5);
    expect(bs.store.calls["Command.updateBook"]).toBeUndefined();

    const admin = await send(`${base}/books/b1`, "PATCH", patch, ADMIN);
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({ ...BOOK_B1, stock: 7 });
    expect(bs.store.books.get("b1")?.stock).toBe(7);
    expect(bs.store.calls["Command.updateBook"]).toBe(1);
  });
});

describe("DELETE bindings", () => {
  it("DELETE /reviews/{id}: a non-author is refused, the author gets the deleted review, and a second DELETE is 404", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const denied = await send(`${base}/reviews/r1`, "DELETE", undefined, U1);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual(problemOf("permission_denied", 403, "Only the author of a review can delete it"));
    expect(bs.store.reviews.has("r1")).toBe(true);

    const res = await send(`${base}/reviews/r1`, "DELETE", undefined, U2);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('"1"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(REVIEW_R1);
    expect(bs.store.reviews.has("r1")).toBe(false);
    expect(bs.store.reviews.size).toBe(3);

    const again = await send(`${base}/reviews/r1`, "DELETE", undefined, U2);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual(problemOf("not_found", 404, "Review r1 not found"));
  });

  it("DELETE retried with the same Idempotency-Key replays its first success instead of 404", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const headers = { ...U2, "idempotency-key": KEY };
    const first = await send(`${base}/reviews/r1`, "DELETE", undefined, headers);
    const retry = await send(`${base}/reviews/r1`, "DELETE", undefined, headers);
    expect([first.status, retry.status]).toEqual([200, 200]);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await retry.json()).toEqual(REVIEW_R1);
    expect(bs.store.calls["Command.deleteReview"]).toBe(1);
    expect(bs.store.reviews.has("r1")).toBe(false);
  });
});

describe("routing", () => {
  it("a bound path with an unbound method is a 405 whose Allow lists the bound methods in declaration order", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    const post = await send(`${base}/books/b1`, "POST", {});
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, PATCH");
    expect(post.headers.get("content-type")).toBe("application/problem+json");
    expect(await post.json()).toEqual({ type: "https://eddyboutros.github.io/rayfold/errors/unimplemented", title: "unimplemented", status: 405, detail: "POST is not bound on /books/b1", code: "unimplemented" });

    const allowOf = async (method: string, path: string) => {
      const res = await send(`${base}${path}`, method);
      expect(res.status).toBe(405);
      return res.headers.get("allow");
    };
    expect(await allowOf("POST", "/reviews/r1")).toBe("GET, PUT, DELETE");
    expect(await allowOf("GET", "/books")).toBe("QUERY");
    expect(await allowOf("GET", "/orders")).toBe("POST");
    expect(await allowOf("GET", "/orders/o1/pay")).toBe("POST");
    expect(bs.store.calls).toEqual({});
  });

  it("an unbound path makes the handler return false, so the host's own 404 answers", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server);
    for (const path of ["/authors/a1", "/books/b1/reviews", "/", "/rayfold"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(FALLTHROUGH);
    }
    expect(bs.store.calls).toEqual({});
    expect((await fetch(`${base}/books/b1`)).status).toBe(200);
  });

  it("prefix: /api/books/b1 is served, bare and look-alike paths fall through, and Location carries the prefix", async () => {
    const bs = createBookstore();
    const base = await serve(bs.server, { prefix: "/api" });
    const res = await fetch(`${base}/api/books/b1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BOOK_B1);
    for (const path of ["/books/b1", "/apix/books/b1"]) {
      const miss = await fetch(`${base}${path}`);
      expect(miss.status).toBe(404);
      expect(await miss.text()).toBe(FALLTHROUGH);
    }
    const placed = await send(`${base}/api/orders`, "POST", { lines: [{ bookId: "b3", qty: 1 }] }, { ...U1, "idempotency-key": KEY });
    expect(placed.status).toBe(201);
    expect(placed.headers.get("location")).toBe("/api/orders/o1");
  });

  it("maxBody: a body one byte over the limit is a 413 payload_too_large problem and never reaches the resolver; a body exactly at the limit is served", async () => {
    const body = JSON.stringify({ filter: { titleContains: "earthsea" } });
    const size = Buffer.byteLength(body);

    const over = createBookstore();
    const overBase = await serve(over.server, { maxBody: size - 1 });
    const refused = await send(`${overBase}/books`, "QUERY", body);
    expect(refused.status).toBe(413); // Content Too Large, not 429: retrying the same body cannot help
    expect(refused.headers.get("content-type")).toBe("application/problem+json");
    expect(await refused.json()).toEqual({ type: "https://eddyboutros.github.io/rayfold/errors/payload_too_large", title: "payload too large", status: 413, detail: `Body exceeds ${size - 1} bytes`, code: "resource_exhausted" });
    expect(over.store.calls["Query.books"]).toBeUndefined();

    // Far over the limit the body arrives in many chunks; the refusal must still arrive and the server keep serving.
    const huge = JSON.stringify({ filter: { titleContains: "x".repeat(256 * 1024) } });
    const flood = await send(`${overBase}/books`, "QUERY", huge);
    expect(flood.status).toBe(413);
    expect(await flood.json()).toEqual({ type: "https://eddyboutros.github.io/rayfold/errors/payload_too_large", title: "payload too large", status: 413, detail: `Body exceeds ${size - 1} bytes`, code: "resource_exhausted" });
    expect(over.store.calls["Query.books"]).toBeUndefined();
    expect((await fetch(`${overBase}/books/b1`)).status).toBe(200);

    const at = createBookstore();
    const atBase = await serve(at.server, { maxBody: size });
    const res = await send(`${atBase}/books`, "QUERY", body);
    expect(res.status).toBe(200);
    expect((await res.json()).items.map((b: { id: string }) => b.id)).toEqual(["b4"]);
    expect(at.store.calls["Query.books"]).toBe(1);
  });
});

describe("bindingsOf", () => {
  it("reads method, path, params, body and location from every @http op of the bookstore, and nothing else", () => {
    const bs = createBookstore();
    const bindings = bindingsOf(bs.server.ir);
    expect(bindings.map(({ op, regex: _regex, ...b }) => ({ op: op.name, ...b }))).toStrictEqual([
      { op: "books", method: "QUERY", path: "/books", params: [], body: "*" },
      { op: "book", method: "GET", path: "/books/{id}", params: ["id"] },
      { op: "review", method: "GET", path: "/reviews/{id}", params: ["id"] },
      { op: "order", method: "GET", path: "/orders/{id}", params: ["id"] },
      { op: "placeOrder", method: "POST", path: "/orders", params: [], body: "input", location: "/orders/{id}" },
      { op: "payOrder", method: "POST", path: "/orders/{id}/pay", params: ["id"] },
      { op: "editReview", method: "PUT", path: "/reviews/{id}", params: ["id"], body: "input" },
      { op: "updateBook", method: "PATCH", path: "/books/{id}", params: ["id"], body: "patch" },
      { op: "deleteReview", method: "DELETE", path: "/reviews/{id}", params: ["id"] },
    ]);
    const pay = bindings.find((b) => b.op.name === "payOrder");
    expect(pay?.regex.exec("/orders/o1/pay")?.slice(1)).toEqual(["o1"]);
    expect(pay?.regex.test("/orders/o1")).toBe(false);
    expect(pay?.regex.test("/orders/a/b/pay")).toBe(false);
    const book = bindings.find((b) => b.op.name === "book");
    expect(book?.regex.test("/books/")).toBe(false);
    expect(book?.regex.test("/books/b1/x")).toBe(false);
  });

  it("upper-cases a method given as a string and escapes literal regex characters in the path", () => {
    const { server } = itemsServer();
    const bindings = bindingsOf(server.ir);
    expect(bindings.find((b) => b.op.name === "drop")).toMatchObject({ method: "DELETE", path: "/items/{id}", params: ["id"] });
    const file = bindings.find((b) => b.op.name === "file");
    expect(file?.regex.exec("/files/a.json")?.slice(1)).toEqual(["a"]);
    expect(file?.regex.test("/files/aXjson")).toBe(false);
  });
});

describe("wire names: @http(name:) on arguments and input fields", () => {
  const WIRE_SCHEMA = `
entity Hit { id: ID }
input Near { maxKm: Int @http(name: "max-km") }
input Where { zipCode: String? @http(name: "zip-code") near: Near? @http(name: "near-by") }
query find(firstName: String? @http(name: "first-name"), maxCount: Int? @http(name: "max-count")): Hit @http(method: GET, path: "/find")
query hit(hitId: ID @http(name: "hit-id")): Hit @http(method: GET, path: "/hits/{hitId}")
query search(firstName: String? @http(name: "first-name"), where: Where?): Hit @http(method: QUERY, path: "/search", body: "*")
command tag(hitId: ID @http(name: "hit-id"), where: Where @http(name: "the-where")): Hit @http(method: PUT, path: "/hits/{hitId}", body: where)
`;
  function wireServer(): { server: RayfoldServer; seen: Array<[string, unknown]> } {
    const seen: Array<[string, unknown]> = [];
    const record = (op: string) => (args: unknown) => (seen.push([op, args]), { id: "h1" });
    const server = createRayfoldServer({ schema: WIRE_SCHEMA, resolvers: { Query: { find: record("find"), hit: record("hit"), search: record("search") }, Command: { tag: record("tag") } } });
    return { server, seen };
  }
  const detail = async (res: Response) => [res.status, ((await res.json()) as { detail: string }).detail];

  it("reads query-string parameters and path parameters under their wire names", async () => {
    const { server, seen } = wireServer();
    const base = await serve(server);
    expect((await send(`${base}/find?first-name=Ada&max-count=2`, "GET")).status).toBe(200);
    expect((await send(`${base}/hits/h3`, "GET")).status).toBe(200);
    expect(seen).toEqual([
      ["find", { firstName: "Ada", maxCount: 2 }],
      ["hit", { hitId: "h3" }],
    ]);
  });

  it("reads a spread body and the input types inside it under their wire names, at any depth", async () => {
    const { server, seen } = wireServer();
    const base = await serve(server);
    const res = await send(`${base}/search`, "QUERY", { "first-name": "Ada", where: { "zip-code": "02139", "near-by": { "max-km": 5 } } });
    expect(res.status).toBe(200);
    expect(seen).toEqual([["search", { firstName: "Ada", where: { zipCode: "02139", near: { maxKm: 5 } } }]]);
  });

  it("reads a body bound to one argument by its input type's wire names", async () => {
    const { server, seen } = wireServer();
    const base = await serve(server);
    const res = await send(`${base}/hits/h7`, "PUT", { "zip-code": "02139", "near-by": { "max-km": 5 } });
    expect(res.status).toBe(200);
    expect(seen).toEqual([["tag", { hitId: "h7", where: { zipCode: "02139", near: { maxKm: 5 } } }]]);
  });

  it("reports an invalid value under the name the client sent, in the query, the path and the body", async () => {
    const { server, seen } = wireServer();
    const base = await serve(server);
    expect(await detail(await send(`${base}/find?max-count=many`, "GET"))).toEqual([400, "find().max-count: expected Int"]);
    expect(await detail(await send(`${base}/hits/%E0`, "GET"))).toEqual([400, "Path parameter hit-id is not valid percent-encoding"]);
    expect(await detail(await send(`${base}/search`, "QUERY", { where: { "near-by": { "max-km": "far" } } }))).toEqual([400, "search().where.near-by.max-km: expected Int"]);
    expect(await detail(await send(`${base}/hits/h7`, "PUT", { "near-by": {} }))).toEqual([400, "tag().the-where.near-by.max-km: required"]);
    expect(seen).toEqual([]);
  });

  it("guard - a binding reads only the wire name: the schema name is an unknown argument, at any depth", async () => {
    const { server, seen } = wireServer();
    const base = await serve(server);
    expect(await detail(await send(`${base}/find?firstName=Ada`, "GET"))).toEqual([400, "find().firstName: unknown argument"]);
    expect(await detail(await send(`${base}/search`, "QUERY", { firstName: "Ada" }))).toEqual([400, "search().firstName: unknown argument"]);
    expect(await detail(await send(`${base}/search`, "QUERY", { where: { zipCode: "02139" } }))).toEqual([400, "search().where.zipCode: unknown argument"]);
    expect(await detail(await send(`${base}/hits/h7`, "PUT", { "near-by": { maxKm: 5 } }))).toEqual([400, "tag().the-where.near-by.maxKm: unknown argument"]);
    expect(seen).toEqual([]);
  });

  it("guard - the Rayfold protocol and the MCP bridge keep the schema names", async () => {
    const { server, seen } = wireServer();
    const run = async (args: Record<string, unknown>) => {
      const frames: Frame[] = [];
      for await (const f of server.execute({ ops: [{ id: 1, op: "search", args }] })) frames.push(f);
      return frames[0] as Record<string, unknown>;
    };
    expect((await run({ firstName: "Ada", where: { zipCode: "02139", near: { maxKm: 5 } } }))["data"]).toEqual({ $type: "Hit", id: "h1" });
    expect(seen).toEqual([["search", { firstName: "Ada", where: { zipCode: "02139", near: { maxKm: 5 } } }]]);
    expect((await run({ where: { "zip-code": "02139" } }))["error"]).toMatchObject({ code: "invalid_argument", message: "search().where.zip-code: unknown argument" });

    const tool = mcpTools(server).find((t) => t.name === "search")!;
    expect(Object.keys(tool.inputSchema["properties"] as object)).toEqual(["firstName", "where"]);
    const defs = tool.inputSchema["$defs"] as Record<string, { properties: object }>;
    expect(Object.keys(defs["Where"]!.properties)).toEqual(["zipCode", "near"]);
    expect(Object.keys(defs["Near"]!.properties)).toEqual(["maxKm"]);
  });
});
