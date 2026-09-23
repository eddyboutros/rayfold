/**
 * End-to-end comparison harness: the same bookstore served three ways, each behind real HTTP.
 * REST and GraphQL are written the way careful teams write them (ETags, DataLoader-style batching,
 * Idempotency-Key convention, SSE subscriptions) so the comparison is against good practice, not straw men.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { buildSchema, graphql, parse, subscribe, version as graphqlVersion, type ExecutionResult } from "graphql";
import { createHttpHandler, attachWebSocket, createMcpHandler, createBindingHandler } from "@rayfold/server";
import { seed, createBookstore, withCatalogue, bookPage, authorBookPages, type Store, type AuthorRow, type BookRow, type BookFilter, type Page, type ReviewRow } from "../examples/bookstore-ts/src/index.ts";
import { EventEmitter } from "node:events";
import { renameSync, writeFileSync } from "node:fs";

export interface Counters {
  originRequests: number;
  loaderCalls: Record<string, number>;
}

export interface Stack {
  name: "REST" | "GraphQL" | "Rayfold";
  base: string;
  server: Server;
  counters: Counters;
  store: Store;
  close(): Promise<void>;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
const etagOf = (body: string) => `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
const viewerOf = (auth: string | undefined) => (auth === "Bearer admin" ? { id: "u9", role: "admin" as const } : auth?.startsWith("Bearer ") ? { id: auth.slice(7), role: "customer" as const } : null);

function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown): Promise<Server> {
  const s = createServer((req, res) => void handler(req, res));
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}
const close = (s: Server) =>
  new Promise<void>((r) => {
    s.close(() => r());
    s.closeAllConnections(); // aborted SSE/live streams would otherwise hold close() open until the socket times out
  });
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res(b));
  });
}

// ------------------------------------------------------------------ REST
export async function startRest(store: Store): Promise<Stack> {
  const counters: Counters = { originRequests: 0, loaderCalls: {} };
  const events = new EventEmitter();
  const idem = new Map<string, { status: number; body: string }>();
  const bookOut = (b: BookRow, viewer: ReturnType<typeof viewerOf>) => {
    const out: Record<string, unknown> = { id: b.id, title: b.title, format: b.format, price: b.price, stock: b.stock, authorId: b.authorId, ownerId: b.ownerId };
    if (viewer && (viewer.role === "admin" || viewer.id === b.ownerId)) out["costPrice"] = b.costPrice; // field-level auth by hand
    return out;
  };
  const reviewOut = (r: ReviewRow) => ({ id: r.id, rating: r.rating, body: r.body, bookId: r.bookId, reviewerId: r.reviewerId });
  // A list request that uses only the original parameters (limit, format, maxPrice) gets the original { items, total }
  // body byte for byte, so existing clients and caches see no change; the cursor fields come with the parameters added
  // alongside them. `after=` with no value starts a cursor walk at the first book.
  const listOut = (p: Page<BookRow>, cursorFields: boolean, viewer: ReturnType<typeof viewerOf>) => {
    const items = p.items.map((b) => bookOut(b, viewer));
    return cursorFields ? { items, total: p.total, hasMore: p.hasMore, cursor: p.cursor } : { items, total: p.total };
  };
  const server = await listen(async (req, res) => {
    counters.originRequests++;
    const url = new URL(req.url ?? "/", "http://x");
    const viewer = viewerOf(req.headers.authorization);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const text = JSON.stringify(body);
      if ((req.method === "GET" || req.method === "QUERY") && status === 200) {
        const etag = etagOf(text);
        const cc = headers["cache-control"] ?? "public, max-age=60";
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { etag, "cache-control": cc }).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json", etag, "cache-control": cc, ...headers }).end(text);
        return;
      }
      res.writeHead(status, { "content-type": "application/json", ...headers }).end(text);
    };
    const m = url.pathname.match(/^\/(books|authors|reviews|orders|openapi\.json|events)(?:\/([^/]+))?(?:\/(pay|books))?$/);
    if (!m) return send(404, { error: "not_found" });
    const [, coll, id, action] = m;
    if (action === "books" && coll !== "authors") return send(404, { error: "not_found" });
    if (coll === "openapi.json") return send(200, { openapi: "3.1.0", paths: { "/books": {}, "/books/{id}": {}, "/authors/{id}": {}, "/reviews": {}, "/orders": {}, "/orders/{id}": {} } });
    if (coll === "events") {
      // SSE: stock changes (the realtime story for REST)
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const on = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      events.on("stock", on);
      res.write(": connected\n\n"); // lets a client know the listener is registered
      req.on("close", () => {
        events.off("stock", on);
        res.end();
      });
      return;
    }
    // RFC 10008 QUERY: a search with a JSON body, cacheable like a GET
    if (req.method === "QUERY" && coll === "books" && !id) {
      const q = JSON.parse((await readBody(req)) || "{}") as { filter?: BookFilter; limit?: number; after?: string | null };
      const f = q.filter ?? {};
      const p = bookPage(store, f, { first: q.limit ?? 20, after: q.after || null });
      return send(200, listOut(p, "after" in q || "titleContains" in f || "authorId" in f, viewer));
    }
    if (req.method === "GET" && coll === "reviews" && id) {
      const r = store.reviews.get(id);
      return r ? send(200, reviewOut(r)) : send(404, { error: "not_found" });
    }
    if (req.method === "GET" && coll === "books" && !id) {
      const q = url.searchParams;
      const filter: BookFilter = { format: q.get("format"), maxPrice: q.get("maxPrice"), titleContains: q.get("titleContains"), authorId: q.get("authorId") };
      const p = bookPage(store, filter, { first: Number(q.get("limit") ?? 20), after: q.get("after") || null });
      return send(200, listOut(p, q.has("after") || q.has("titleContains") || q.has("authorId"), viewer));
    }
    if (req.method === "GET" && coll === "books" && id) {
      const b = store.books.get(id);
      return b ? send(200, bookOut(b, viewer), { "cache-control": viewer ? "private, max-age=60" : "public, max-age=60" }) : send(404, { error: "not_found" });
    }
    if (req.method === "GET" && coll === "authors" && id && action === "books") {
      if (!store.authors.has(id)) return send(404, { error: "not_found" });
      const p = authorBookPages(store, [id], { first: Number(url.searchParams.get("limit") ?? 10), after: url.searchParams.get("after") || null })[0]!;
      return send(200, listOut(p, true, viewer));
    }
    if (req.method === "GET" && coll === "authors" && id) {
      const a = store.authors.get(id);
      return a ? send(200, { id: a.id, name: a.name, bio: a.bio }) : send(404, { error: "not_found" });
    }
    if (req.method === "GET" && coll === "reviews") {
      const bookId = url.searchParams.get("bookId");
      const first = Number(url.searchParams.get("limit") ?? 10);
      return send(200, { items: [...store.reviews.values()].filter((r) => r.bookId === bookId).sort(byId).slice(0, first) });
    }
    if (req.method === "POST" && coll === "orders" && id && action === "pay") {
      if (!viewer) return send(401, { error: "unauthenticated" });
      const o = store.orders.get(id);
      if (!o || (o.customerId !== viewer.id && viewer.role !== "admin")) return send(404, { error: "not_found" });
      if (o.status !== "PLACED") return send(409, { error: "not_payable", status: o.status });
      o.status = "PAID";
      return send(200, o);
    }
    // PUT: full replacement, with If-Match against the ETag of the current representation (lost-update protection)
    if (req.method === "PUT" && coll === "reviews" && id) {
      if (!viewer) return send(401, { error: "unauthenticated" });
      const r = store.reviews.get(id);
      if (!r) return send(404, { error: "not_found" });
      if (r.reviewerId !== viewer.id && viewer.role !== "admin") return send(403, { error: "permission_denied" });
      const ifMatch = req.headers["if-match"];
      if (typeof ifMatch === "string" && ifMatch !== etagOf(JSON.stringify(reviewOut(r)))) return send(412, { error: "precondition_failed" });
      const body = JSON.parse(await readBody(req)) as { rating?: unknown; body?: unknown };
      if (typeof body.rating !== "number" || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) return send(400, { error: "invalid", field: "rating" });
      if (typeof body.body !== "string" || body.body.length < 1 || body.body.length > 2000) return send(400, { error: "invalid", field: "body" });
      const next = { ...r, rating: body.rating, body: body.body, version: r.version + 1 };
      store.reviews.set(id, next);
      return send(200, reviewOut(next), { etag: etagOf(JSON.stringify(reviewOut(next))) });
    }
    // PATCH: JSON merge patch; absent fields untouched, validation by hand
    if (req.method === "PATCH" && coll === "books" && id) {
      if (viewer?.role !== "admin") return send(viewer ? 403 : 401, { error: viewer ? "permission_denied" : "unauthenticated" });
      const b = store.books.get(id);
      if (!b) return send(404, { error: "not_found" });
      const patch = JSON.parse(await readBody(req)) as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (!["title", "price", "stock"].includes(k)) return send(400, { error: "invalid", field: k });
        if (v === null) return send(400, { error: "invalid", field: k, reason: "cannot be cleared" });
      }
      if ("price" in patch && !(typeof patch["price"] === "string" && /^\d+(\.\d+)?$/.test(patch["price"]))) return send(400, { error: "invalid", field: "price" });
      const next = { ...b, ...(patch as Partial<BookRow>) };
      store.books.set(id, next);
      return send(200, bookOut(next, viewer));
    }
    if (req.method === "DELETE" && coll === "reviews" && id) {
      if (!viewer) return send(401, { error: "unauthenticated" });
      const r = store.reviews.get(id);
      if (!r) return send(404, { error: "not_found" });
      if (r.reviewerId !== viewer.id && viewer.role !== "admin") return send(403, { error: "permission_denied" });
      store.reviews.delete(id);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "POST" && coll === "orders") {
      if (!viewer) return send(401, { error: "unauthenticated" });
      const key = req.headers["idempotency-key"];
      if (typeof key === "string" && idem.has(key)) {
        const prior = idem.get(key)!;
        return send(prior.status, JSON.parse(prior.body), { "idempotent-replayed": "true" });
      }
      const input = JSON.parse(await readBody(req)) as { lines: Array<{ bookId: string; qty: number }> };
      let total = 0;
      for (const l of input.lines) {
        const b = store.books.get(l.bookId);
        if (!b) return send(404, { error: "not_found", bookId: l.bookId });
        if (b.stock < l.qty) return send(409, { error: "out_of_stock", bookId: b.id, available: b.stock });
      }
      const items = input.lines.map((l) => {
        const b = store.books.get(l.bookId)!;
        total += Number(b.price) * l.qty;
        b.stock -= l.qty;
        events.emit("stock", { bookId: b.id, stock: b.stock });
        return { bookId: b.id, qty: l.qty, unitPrice: b.price };
      });
      const order = { id: `o${store.nextId++}`, status: "PLACED", customerId: viewer.id, items, total: total.toFixed(2) };
      store.orders.set(order.id, order as never);
      if (typeof key === "string") idem.set(key, { status: 201, body: JSON.stringify(order) });
      return send(201, order, { location: `/orders/${order.id}` });
    }
    if (req.method === "GET" && coll === "orders" && id) {
      const o = store.orders.get(id);
      if (!o) return send(404, { error: "not_found" });
      if (!viewer) return send(401, { error: "unauthenticated" });
      if (o.customerId !== viewer.id && viewer.role !== "admin") return send(403, { error: "permission_denied" });
      return send(200, o, { "cache-control": "private, max-age=0, no-cache" });
    }
    if (req.method === "POST" && coll === "books" && id && url.searchParams.get("action") === "restock") {
      if (viewer?.role !== "admin") return send(403, { error: "permission_denied" });
      const b = store.books.get(id)!;
      b.stock += Number(url.searchParams.get("qty") ?? 1);
      events.emit("stock", { bookId: b.id, stock: b.stock });
      return send(200, bookOut(b, viewer));
    }
    send(405, { error: "method_not_allowed" });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { name: "REST", base, server, counters, store, close: () => close(server) };
}

// --------------------------------------------------------------- GraphQL
/** The GraphQL stack's schema, exported so tests can run graphql-js tooling on exactly what the server serves. */
export const GRAPHQL_SDL = `
    type Author { id: ID! name: String! bio: String books(first: Int = 10, after: String): Page! }
    type Book { id: ID! title: String! format: String! price: String! stock: Int! author: Author! reviews(first: Int = 10): [Review!]! costPrice: String ownerId: ID! }
    type Review { id: ID! rating: Int! body: String! reviewerId: ID! }
    type OrderItem { qty: Int! unitPrice: String! book: Book! }
    type Order { id: ID! status: String! total: String! items: [OrderItem!]! }
    type Page { items: [Book!]! total: Int! hasMore: Boolean! cursor: String }
    input OrderLine { bookId: ID! qty: Int! }
    type StockChanged { bookId: ID! stock: Int! }
    input BookPatch { title: String price: String stock: Int }
    type Query { books(first: Int = 20, after: String, format: String, maxPrice: String, titleContains: String, authorId: ID): Page! book(id: ID!): Book order(id: ID!): Order review(id: ID!): Review }
    type Mutation {
      placeOrder(lines: [OrderLine!]!): Order!
      payOrder(id: ID!): Order!
      restock(bookId: ID!, qty: Int!): Book!
      editReview(id: ID!, rating: Int!, body: String!): Review!
      updateBook(id: ID!, patch: BookPatch!): Book!
      deleteReview(id: ID!): ID!
    }
    type Subscription { stockChanged(bookId: ID!): StockChanged! }
  `;

export async function startGraphQL(store: Store, opts: { batching?: boolean } = {}): Promise<Stack> {
  const batching = opts.batching ?? true;
  const counters: Counters = { originRequests: 0, loaderCalls: {} };
  const events = new EventEmitter();
  const schema = buildSchema(GRAPHQL_SDL);
  type BookPageQueue = Map<string, { page: { first: number; after: string | null }; waiting: Map<string, Array<(p: unknown) => void>> }>;
  type Ctx = { viewer: ReturnType<typeof viewerOf>; queue: Map<string, Array<(a: unknown) => void>> | null; bookPages: BookPageQueue | null };
  const bookObj = (b: BookRow) => ({
    ...b,
    costPrice: (_a: unknown, ctx: Ctx) => (ctx.viewer && (ctx.viewer.role === "admin" || ctx.viewer.id === b.ownerId) ? b.costPrice : null),
    author: (_a: unknown, ctx: Ctx) =>
      !batching
        ? (counters.loaderCalls["author"] = (counters.loaderCalls["author"] ?? 0) + 1, authorObj(store.authors.get(b.authorId))) // the straightforward resolver
        : new Promise((resolve) => {
        if (!ctx.queue) {
          ctx.queue = new Map();
          queueMicrotask(() => {
            const q = ctx.queue!;
            ctx.queue = null;
            counters.loaderCalls["author"] = (counters.loaderCalls["author"] ?? 0) + 1;
            for (const [id, cbs] of q) for (const cb of cbs) cb(authorObj(store.authors.get(id)));
          });
        }
        (ctx.queue.get(b.authorId) ?? ctx.queue.set(b.authorId, []).get(b.authorId)!).push(resolve);
      }),
    reviews: ({ first }: { first: number }) => {
      counters.loaderCalls["reviews"] = (counters.loaderCalls["reviews"] ?? 0) + 1;
      return [...store.reviews.values()].filter((r) => r.bookId === b.id).sort(byId).slice(0, first);
    },
  });
  const pageObj = (p: Page<BookRow>) => ({ items: p.items.map(bookObj), total: p.total, hasMore: p.hasMore, cursor: p.cursor });
  const authorObj = (a: AuthorRow | undefined) =>
    a && {
      ...a,
      books: ({ first, after }: { first: number; after?: string | null }, ctx: Ctx) => {
        const page = { first, after: after ?? null };
        if (!batching) {
          counters.loaderCalls["authorBooks"] = (counters.loaderCalls["authorBooks"] ?? 0) + 1;
          return pageObj(authorBookPages(store, [a.id], page)[0]!);
        }
        return new Promise((resolve) => {
          if (!ctx.bookPages) {
            ctx.bookPages = new Map();
            queueMicrotask(() => {
              const groups = ctx.bookPages!;
              ctx.bookPages = null;
              for (const g of groups.values()) {
                counters.loaderCalls["authorBooks"] = (counters.loaderCalls["authorBooks"] ?? 0) + 1;
                const ids = [...g.waiting.keys()];
                authorBookPages(store, ids, g.page).forEach((p, i) => {
                  for (const cb of g.waiting.get(ids[i]!)!) cb(pageObj(p));
                });
              }
            });
          }
          // one load per distinct page request, shared by every author asking for it
          const key = JSON.stringify(page);
          const g = ctx.bookPages.get(key) ?? ctx.bookPages.set(key, { page, waiting: new Map() }).get(key)!;
          (g.waiting.get(a.id) ?? g.waiting.set(a.id, []).get(a.id)!).push(resolve);
        });
      },
    };
  const root = {
    books: ({ first, after, ...filter }: { first: number; after?: string } & BookFilter) => pageObj(bookPage(store, filter, { first, after: after ?? null })),
    review: ({ id }: { id: string }) => store.reviews.get(id) ?? null,
    payOrder: ({ id }: { id: string }, ctx: Ctx) => {
      if (!ctx.viewer) throw gqlError("Sign in", "UNAUTHENTICATED");
      const o = store.orders.get(id);
      if (!o || (o.customerId !== ctx.viewer.id && ctx.viewer.role !== "admin")) throw gqlError("Order not found", "NOT_FOUND");
      if (o.status !== "PLACED") throw gqlError(`Order is ${o.status}`, "NOT_PAYABLE", { status: o.status });
      o.status = "PAID";
      return { ...o, items: o.items.map((it) => ({ ...it, book: bookObj(store.books.get(it.bookId)!) })) };
    },
    editReview: ({ id, rating, body }: { id: string; rating: number; body: string }, ctx: Ctx) => {
      if (!ctx.viewer) throw gqlError("Sign in", "UNAUTHENTICATED");
      const r = store.reviews.get(id);
      if (!r) throw gqlError("Review not found", "NOT_FOUND");
      if (r.reviewerId !== ctx.viewer.id && ctx.viewer.role !== "admin") throw gqlError("Not the author", "FORBIDDEN");
      if (rating < 1 || rating > 5) throw gqlError("rating must be 1..5", "BAD_USER_INPUT");
      const next = { ...r, rating, body, version: r.version + 1 };
      store.reviews.set(id, next);
      return next;
    },
    updateBook: ({ id, patch }: { id: string; patch: Record<string, unknown> }, ctx: Ctx) => {
      if (ctx.viewer?.role !== "admin") throw gqlError("Admins only", "FORBIDDEN");
      const b = store.books.get(id);
      if (!b) throw gqlError("Book not found", "NOT_FOUND");
      for (const [k, v] of Object.entries(patch)) if (v === null) throw gqlError(`${k} cannot be cleared`, "BAD_USER_INPUT");
      if ("price" in patch && !/^\d+(\.\d+)?$/.test(String(patch["price"]))) throw gqlError("price must be >= 0", "BAD_USER_INPUT");
      const next = { ...b, ...(patch as Partial<BookRow>) };
      store.books.set(id, next);
      return bookObj(next);
    },
    deleteReview: ({ id }: { id: string }, ctx: Ctx) => {
      if (!ctx.viewer) throw gqlError("Sign in", "UNAUTHENTICATED");
      const r = store.reviews.get(id);
      if (!r) throw gqlError("Review not found", "NOT_FOUND");
      if (r.reviewerId !== ctx.viewer.id && ctx.viewer.role !== "admin") throw gqlError("Not the author", "FORBIDDEN");
      store.reviews.delete(id);
      return id;
    },
    book: ({ id }: { id: string }) => (store.books.get(id) ? bookObj(store.books.get(id)!) : null),
    order: ({ id }: { id: string }, ctx: Ctx) => {
      const o = store.orders.get(id);
      if (!o) return null;
      if (!ctx.viewer) throw new Error("UNAUTHENTICATED");
      if (o.customerId !== ctx.viewer.id && ctx.viewer.role !== "admin") throw new Error("FORBIDDEN");
      return { ...o, items: o.items.map((it) => ({ ...it, book: bookObj(store.books.get(it.bookId)!) })) };
    },
    placeOrder: ({ lines }: { lines: Array<{ bookId: string; qty: number }> }, ctx: Ctx) => {
      if (!ctx.viewer) throw new Error("UNAUTHENTICATED");
      for (const l of lines) {
        const b = store.books.get(l.bookId);
        if (!b) throw new Error("NOT_FOUND");
        if (b.stock < l.qty) {
          const e = new Error(`Only ${b.stock} of ${b.title} left`) as Error & { extensions: unknown };
          e.extensions = { code: "OUT_OF_STOCK", bookId: b.id, available: b.stock };
          throw e;
        }
      }
      let total = 0;
      const items = lines.map((l) => {
        const b = store.books.get(l.bookId)!;
        total += Number(b.price) * l.qty;
        b.stock -= l.qty;
        events.emit("stock", { bookId: b.id, stock: b.stock });
        return { bookId: b.id, qty: l.qty, unitPrice: b.price, book: bookObj(b) };
      });
      const order = { id: `o${store.nextId++}`, status: "PLACED", customerId: ctx.viewer.id, items, total: total.toFixed(2) };
      store.orders.set(order.id, order as never);
      return order;
    },
    restock: ({ bookId, qty }: { bookId: string; qty: number }, ctx: Ctx) => {
      if (ctx.viewer?.role !== "admin") throw new Error("FORBIDDEN");
      const b = store.books.get(bookId)!;
      b.stock += qty;
      events.emit("stock", { bookId: b.id, stock: b.stock });
      return bookObj(b);
    },
    stockChanged: ({ bookId }: { bookId: string }) => {
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      const on = (e: { bookId: string }) => {
        if (e.bookId !== bookId) return;
        queue.push({ stockChanged: e });
        wake?.();
      };
      events.on("stock", on);
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              while (!queue.length) await new Promise<void>((r) => (wake = r));
              return { value: queue.shift(), done: false };
            },
            return: async () => {
              events.off("stock", on);
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
  };
  const server = await listen(async (req, res) => {
    counters.originRequests++;
    const url = new URL(req.url ?? "/", "http://x");
    const viewer = viewerOf(req.headers.authorization);
    const ctx: Ctx = { viewer, queue: null, bookPages: null };
    // GraphQL over HTTP: GET is allowed for queries (cacheable here like a careful team would configure), mutations need POST
    if (url.pathname === "/graphql" && req.method === "GET") {
      const query = url.searchParams.get("query") ?? "";
      const variables = url.searchParams.get("variables");
      const doc = parse(query);
      if (doc.definitions.some((d) => d.kind === "OperationDefinition" && d.operation !== "query")) {
        res.writeHead(405, { allow: "POST", "content-type": "application/graphql-response+json" }).end(JSON.stringify({ errors: [{ message: "Mutations must use POST" }] }));
        return;
      }
      const r = await graphql({ schema, source: query, rootValue: root, contextValue: ctx, variableValues: variables ? JSON.parse(variables) : {} });
      const text = JSON.stringify(r);
      const etag = etagOf(text);
      const cc = viewer ? "private, max-age=60" : "public, max-age=60";
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag, "cache-control": cc }).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/graphql-response+json", etag, "cache-control": cc }).end(text);
      return;
    }
    if (url.pathname === "/graphql" && req.method !== "POST") {
      res.writeHead(405, { allow: "GET, POST", "content-type": "application/json" }).end(JSON.stringify({ errors: [{ message: `${req.method} is not part of GraphQL over HTTP; use GET or POST` }] }));
      return;
    }
    if (url.pathname === "/graphql" && req.method === "POST") {
      const { query, variables } = JSON.parse(await readBody(req)) as { query: string; variables?: Record<string, unknown> };
      const doc = parse(query);
      if (query.trimStart().startsWith("subscription")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        const it = (await subscribe({ schema, document: doc, rootValue: root, contextValue: ctx, variableValues: variables ?? {} })) as AsyncIterableIterator<ExecutionResult>;
        req.on("close", () => void it.return?.());
        res.write(": subscribed\n\n"); // the resolver has registered its listener
        for await (const r of it) res.write(`data: ${JSON.stringify(r)}\n\n`);
        return;
      }
      const r = await graphql({ schema, source: query, rootValue: root, contextValue: ctx, variableValues: variables ?? {} });
      res.writeHead(200, { "content-type": "application/graphql-response+json", "cache-control": "no-store" }).end(JSON.stringify(r));
      return;
    }
    res.writeHead(404).end();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { name: "GraphQL", base, server, counters, store, close: () => close(server) };
}

// ------------------------------------------------------------------- Rayfold
export async function startRayfold(store: Store): Promise<Stack & { bookstore: ReturnType<typeof createBookstore> }> {
  const counters: Counters = { originRequests: 0, loaderCalls: store.calls };
  const bookstore = createBookstore({ store });
  const handler = createHttpHandler(bookstore.server, { viewer: (req) => viewerOf(req.headers.authorization) });
  const mcp = createMcpHandler(bookstore.server, { viewer: (req) => viewerOf(req.headers.authorization) });
  const bindings = createBindingHandler(bookstore.server, { viewer: (req) => viewerOf(req.headers.authorization) });
  const server = await listen(async (req, res) => {
    counters.originRequests++;
    if ((req.url ?? "/").startsWith("/rayfold")) return handler(req, res);
    if (await mcp(req, res)) return;
    if (await bindings(req, res)) return;
    res.writeHead(404).end();
  });
  attachWebSocket(server, bookstore.server, { viewer: (req) => viewerOf(new URL(req.url ?? "/", "http://x").searchParams.get("auth") ?? undefined) });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { name: "Rayfold", base, server, counters, store, bookstore, close: () => close(server) };
}

/** Seed plus the real catalogue: 36 books by 12 authors, 24 reviews. Each stack gets its own copy. */
export function freshStore(): Store {
  return withCatalogue(seed());
}

/** A tiny HTTP cache in front of a stack: honours ETag/If-None-Match and counts origin round trips vs 304s. */
export class CachingClient {
  readonly etags = new Map<string, { etag: string; body: string; headers: Record<string, string> }>();
  hits = 0;
  revalidated = 0;
  misses = 0;
  /** Cache-Control the origin sent for a cached URL. */
  headers(url: string): string {
    return this.etags.get(url)?.headers["cache-control"] ?? "";
  }
  get(url: string, headers: Record<string, string> = {}) {
    return this.send(url, undefined, headers);
  }
  /** POST with a body; cache key is url + body (what a QUERY-aware cache does). */
  post(url: string, body: string, headers: Record<string, string> = {}) {
    return this.send(url, body, headers);
  }
  /** RFC 10008 QUERY: safe, and cacheable with the body as part of the key. */
  query(url: string, body: string, headers: Record<string, string> = {}) {
    return this.send(url, body, headers, "QUERY");
  }
  private async send(url: string, body: string | undefined, headers: Record<string, string>, method = "POST"): Promise<{ status: number; body: unknown; fromCache: boolean; headers: Record<string, string>; wireBytes: number }> {
    const key = body === undefined ? url : `${url}\n${body}`;
    const cached = this.etags.get(key);
    const init: RequestInit = { headers: { ...headers, ...(cached ? { "if-none-match": cached.etag } : {}) } };
    if (body !== undefined) {
      init.method = method;
      init.body = body;
    }
    const res = await fetch(url, init);
    const hdrs: Record<string, string> = {};
    res.headers.forEach((v, k) => (hdrs[k] = v));
    // bytes a proxy would see for this response: status line + headers + body
    const headerBytes = Object.entries(hdrs).reduce((n, [k, v]) => n + k.length + v.length + 4, 17);
    if (res.status === 304 && cached) {
      this.revalidated++;
      return { status: 200, body: JSON.parse(cached.body), fromCache: true, headers: cached.headers, wireBytes: headerBytes };
    }
    const text = await res.text();
    const etag = res.headers.get("etag");
    if (etag && res.status === 200) {
      this.etags.set(key, { etag, body: text, headers: hdrs });
      this.misses++;
    }
    return { status: res.status, body: text ? JSON.parse(text.split("\n")[0]!) : null, fromCache: false, headers: hdrs, wireBytes: headerBytes + Buffer.byteLength(text) };
  }
}

export type Values = { REST: number | null; GraphQL: number | null; Rayfold: number | null };
export type Verdict = "lead" | "tie" | "behind";

export interface Row {
  aspect: string;
  metric: string;
  REST: string;
  GraphQL: string;
  Rayfold: string;
  note?: string;
  /** numeric form of the metric; null = not possible on that stack (always worst) */
  values?: Values;
  unit?: string;
  better?: "lower" | "higher";
  /** computed from values, never typed in */
  verdict?: Verdict;
  /** every HTTP exchange the test made, per stack, as recorded by the Recorder */
  examples?: { REST: Exchange[]; GraphQL: Exchange[]; Rayfold: Exchange[] };
}

/**
 * Rayfold leads when strictly better than both others and ties when equal to the best of them. Within 1% of the best (both
 * measured) is a tie too: a 4-byte gap on 31 KB is noise, not a lead.
 */
export function computeVerdict(values: Values, better: "lower" | "higher"): Verdict {
  const score = (v: number | null) => (v === null ? Number.NEGATIVE_INFINITY : better === "higher" ? v : -v);
  const rayfold = score(values.Rayfold);
  const best = Math.max(score(values.REST), score(values.GraphQL));
  if (Number.isFinite(rayfold) && Number.isFinite(best) && Math.abs(rayfold - best) <= 0.01 * Math.abs(best)) return "tie";
  return rayfold > best ? "lead" : rayfold === best ? "tie" : "behind";
}

export interface Fact {
  metric: string;
  unit?: string;
  better: "lower" | "higher";
  values: Values;
  REST: string;
  GraphQL: string;
  Rayfold: string;
  verdict?: Verdict;
}

export interface Exchange {
  label?: string;
  request: { method: string; target: string; headers: Record<string, string>; body?: string };
  response: { status: number; headers: Record<string, string>; body: string };
}

export interface MethodBlock {
  method: string;
  title: string;
  operation: string;
  exchanges: { REST: Exchange[]; GraphQL: Exchange[]; Rayfold: Exchange[] };
  facts: Fact[];
  note?: string;
  verdict?: Verdict;
}

export class Report {
  readonly rows: Row[] = [];
  readonly methods: MethodBlock[] = [];
  add(row: Row): void {
    if (row.values && row.better) row.verdict = computeVerdict(row.values, row.better);
    this.rows.push(row);
  }
  addMethod(m: MethodBlock): void {
    for (const f of m.facts) f.verdict = computeVerdict(f.values, f.better);
    const vs = m.facts.map((f) => f.verdict);
    m.verdict = vs.includes("behind") ? "behind" : vs.includes("lead") ? "lead" : "tie";
    this.methods.push(m);
  }
  json(): string {
    const order = ["GET", "POST", "PUT", "PATCH", "DELETE", "QUERY"];
    const methods = [...this.methods].sort((a, b) => order.indexOf(a.method) - order.indexOf(b.method));
    return JSON.stringify({ generatedAt: new Date().toISOString(), rows: this.rows, methods }, null, 2) + "\n";
  }
  /** `about` names the dataset and the file that asserts these rows, since two suites share this writer. */
  markdown(about: { title: string; dataset: string; assertedBy: string }): string {
    const lines = [
      `# ${about.title}`,
      "",
      `${about.dataset}, each stack behind real HTTP with good-practice implementations (ETags, DataLoader-style batching, Idempotency-Key convention, SSE subscriptions). Every cell is asserted by \`${about.assertedBy}\`.`,
      "",
      "This table compares the three stacks on one workload. The rest of the end-to-end suite lives beside it: `methods.test.ts` (every HTTP method a binding serves), `security.test.ts` (the attacks of spec 12), `realdata.test.ts` (the Project Gutenberg catalogue), and `fleet.test.ts` (two servers and a real Postgres).",
      "",
      "| Aspect | Metric | REST | GraphQL | Rayfold | Note |",
      "|---|---|---|---|---|---|",
    ];
    for (const r of this.rows) lines.push(`| ${r.aspect} | ${r.metric} | ${r.REST} | ${r.GraphQL} | ${r.Rayfold} | ${r.note ?? ""} |`);
    return lines.join("\n") + "\n";
  }
}

/**
 * Writes a committed report file, only when E2E_WRITE=1 (`npm run e2e` sets it) so a plain test run leaves the tree clean.
 * Through a temp file and a rename, so a suite reading the file in parallel never sees half of it.
 */
export function writeReport(path: string, text: string): void {
  if (process.env["E2E_WRITE"] !== "1") return;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** The graphql-js major actually under test, so a report never names a version the suite did not run. */
export const GRAPHQL_MAJOR = graphqlVersion.split(".")[0];

export const sseFrames = (chunk: string): unknown[] => chunk.split("\n\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));

// ---------------------------------------------------------------- exchange recorder
const SHOW_REQ = ["content-type", "accept", "authorization", "if-match", "if-none-match", "idempotency-key", "rayfold-safe"];
const SHOW_RES = ["content-type", "etag", "cache-control", "location", "allow", "idempotent-replayed"];

export interface Recorded {
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, string>;
  ex: Exchange;
  /** request target + body, response body */
  bytes: { up: number; down: number };
}

/** Perform one real HTTP exchange and keep a readable record of it for the report. */
export async function exchange(base: string, method: string, target: string, opts: { headers?: Record<string, string>; body?: string; label?: string } = {}): Promise<Recorded> {
  const headers = opts.headers ?? {};
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = opts.body;
  const res = await fetch(base + target, init);
  const text = await res.text();
  const all: Record<string, string> = {};
  res.headers.forEach((v, k) => (all[k] = v));
  const pick = (h: Record<string, string>, keys: string[]) => Object.fromEntries(Object.entries(h).filter(([k]) => keys.includes(k.toLowerCase())).map(([k, v]) => [k.toLowerCase(), v]));
  let json: unknown = null;
  try {
    json = text ? (text.includes("\n{") ? text.trim().split("\n").map((l) => JSON.parse(l)) : JSON.parse(text)) : null;
  } catch {
    json = null;
  }
  const ex: Exchange = { request: { method, target, headers: pick(headers, SHOW_REQ) }, response: { status: res.status, headers: pick(all, SHOW_RES), body: text } };
  if (opts.body !== undefined) ex.request.body = opts.body;
  if (opts.label) ex.label = opts.label;
  return { status: res.status, text, json, headers: all, ex, bytes: { up: Buffer.byteLength(target) + Buffer.byteLength(opts.body ?? ""), down: Buffer.byteLength(text) } };
}

// ---------------------------------------------------------------- Apollo-style normalized cache for the GraphQL client
/**
 * What Apollo Client does: every object with __typename + id is stored once and query results hold references,
 * so a mutation that returns an updated entity refreshes every cached view of it. It does not remove deleted
 * entities from lists or learn side effects the mutation did not select.
 */
export class GqlNormalizedCache {
  private readonly entities = new Map<string, Record<string, unknown>>();
  private readonly results = new Map<string, unknown>();
  write(queryKey: string | null, data: unknown): void {
    const norm = this.normalize(data);
    if (queryKey) this.results.set(queryKey, norm);
  }
  read(queryKey: string): unknown {
    return this.denormalize(this.results.get(queryKey));
  }
  private normalize(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => this.normalize(x));
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = this.normalize(x);
    if (typeof o["__typename"] === "string" && o["id"] !== undefined) {
      const key = `${o["__typename"]}:${String(o["id"])}`;
      this.entities.set(key, { ...(this.entities.get(key) ?? {}), ...out });
      return { __ref: key };
    }
    return out;
  }
  private denormalize(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => this.denormalize(x));
    const o = v as Record<string, unknown>;
    if (typeof o["__ref"] === "string") return this.denormalize(this.entities.get(o["__ref"]) ?? null);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = this.denormalize(x);
    return out;
  }
}

function gqlError(message: string, code: string, extra: Record<string, unknown> = {}): Error {
  const e = new Error(message) as Error & { extensions: unknown };
  e.extensions = { code, ...extra };
  return e;
}

// ---------------------------------------------------------------- recorder for every exchange a test makes
export type StackName = "REST" | "GraphQL" | "Rayfold";

/**
 * Wraps global fetch so every request a test sends to one of the stacks is kept, with its response, for the
 * report. Streaming responses are captured up to the point the client closed them. RB bodies are decoded.
 */
export class Recorder {
  private readonly original = globalThis.fetch;
  private origins = new Map<string, StackName>();
  private cur: Record<StackName, Exchange[]> = { REST: [], GraphQL: [], Rayfold: [] };
  private pending: Array<Promise<void>> = [];
  private nextLabel: string | undefined;

  constructor(private readonly decodeRb: (bytes: Uint8Array, frames: boolean) => unknown) {}

  install(): void {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => this.fetch(input, init)) as typeof fetch;
  }
  uninstall(): void {
    globalThis.fetch = this.original;
  }
  /** Map each stack's base URL (any number per stack). */
  track(stacks: Array<[string, StackName]>): void {
    this.origins = new Map(stacks.map(([base, name]) => [new URL(base).origin, name]));
    this.cur = { REST: [], GraphQL: [], Rayfold: [] };
    this.pending = [];
  }
  /** Label the next recorded exchange. */
  label(text: string): void {
    this.nextLabel = text;
  }
  /** Everything recorded since `track`, once all bodies (including closed streams) are captured. */
  async take(): Promise<Record<StackName, Exchange[]>> {
    await bounded(Promise.allSettled(this.pending), "recorded bodies to settle");
    return { REST: [...this.cur.REST], GraphQL: [...this.cur.GraphQL], Rayfold: [...this.cur.Rayfold] };
  }

  private async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const stack = this.origins.get(url.origin);
    const res = await this.original(input, init);
    if (!stack) return res;
    const sent = new Headers(init?.headers);
    const reqHeaders: Record<string, string> = {};
    sent.forEach((v, k) => {
      if (SHOW_REQ.includes(k)) reqHeaders[k] = v;
    });
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (SHOW_RES.includes(k)) resHeaders[k] = v;
    });
    const e: Exchange = { request: { method: init?.method ?? "GET", target: url.pathname + url.search, headers: reqHeaders }, response: { status: res.status, headers: resHeaders, body: "" } };
    if (this.nextLabel) {
      e.label = this.nextLabel;
      this.nextLabel = undefined;
    }
    const body = init?.body;
    if (typeof body === "string") e.request.body = body;
    else if (body instanceof Uint8Array) e.request.body = `RB request, ${body.length} bytes on the wire, shown decoded:\n${JSON.stringify(this.decodeRb(body, false))}`;
    this.cur[stack].push(e);
    this.pending.push(this.capture(res.clone(), e));
    return res;
  }

  private async capture(res: Response, e: Exchange): Promise<void> {
    const ct = res.headers.get("content-type") ?? "";
    if (ct === "application/rayfold") {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const frames = this.decodeRb(bytes, true) as unknown[];
      e.response.body = `RB, ${bytes.length} bytes on the wire, shown decoded:\n${frames.map((f) => JSON.stringify(f)).join("\n")}`;
      return;
    }
    if (!res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
        e.response.body = text;
      }
    } catch {
      e.response.body = text + (text ? "\n" : "") + "(stream closed by the client)";
    }
  }
}

import { bounded } from "./wait.ts";
