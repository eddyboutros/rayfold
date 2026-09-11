/**
 * Benchmark: the same bookstore flows over REST, GraphQL (graphql-js) and Rayfold (JSON, RB).
 * Measures round trips per flow, bytes on the wire (request + response bodies) and latency over loopback.
 * Run: npm run bench   -> writes bench/results/latest.md
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildSchema, graphql } from "graphql";
import { createHttpHandler } from "@rayfold/server";
import { RbCodec } from "@rayfold/rb";
import { createBookstore, seed, withCatalogue, type Store } from "../examples/bookstore-ts/src/index.ts";

const ITER = Number(process.env["BENCH_ITER"] ?? 300);

// ---------------------------------------------------------------- shared data
// a real catalogue: 36 books by 12 authors
const store: Store = withCatalogue(seed());
for (let i = 0; i < 0; i++) {
  store.books.set(`b${i}`, { id: `b${i}`, title: `Book ${i}`, format: i % 2 ? "PAPERBACK" : "EBOOK", price: (5 + (i % 7)).toFixed(2), stock: 10, authorId: `a${(i % 3) + 1}`, costPrice: "1.00", ownerId: "u1" });
  store.reviews.set(`r${i}`, { id: `r${i}`, rating: (i % 5) + 1, body: `Review ${i} lorem ipsum dolor sit amet`, bookId: `b${(i % 4) + 1}`, reviewerId: `u${(i % 3) + 1}`, version: 1 });
}
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
const bookView = (b: NonNullable<ReturnType<Store["books"]["get"]>>) => ({ id: b.id, title: b.title, format: b.format, price: b.price, stock: b.stock, authorId: b.authorId });

// ---------------------------------------------------------------- REST
function restHandler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const m = url.pathname.match(/^\/(books|authors|reviews|orders)(?:\/([^/]+))?$/);
  if (!m) return json(404, { error: "not found" });
  const [, coll, id] = m;
  if (req.method === "GET" && coll === "books" && !id) {
    const first = Number(url.searchParams.get("limit") ?? 20);
    const items = [...store.books.values()].sort(byId).slice(0, first).map(bookView);
    return json(200, { items, total: store.books.size });
  }
  if (req.method === "GET" && coll === "books" && id) {
    const b = store.books.get(id);
    return b ? json(200, bookView(b)) : json(404, { error: "not found" });
  }
  if (req.method === "GET" && coll === "authors" && id) {
    const a = store.authors.get(id);
    return a ? json(200, { id: a.id, name: a.name, bio: a.bio }) : json(404, { error: "not found" });
  }
  if (req.method === "GET" && coll === "reviews") {
    const bookId = url.searchParams.get("bookId");
    const first = Number(url.searchParams.get("limit") ?? 10);
    const items = [...store.reviews.values()].filter((r) => r.bookId === bookId).sort(byId).slice(0, first);
    return json(200, { items });
  }
  if (req.method === "POST" && coll === "orders") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const input = JSON.parse(body) as { lines: Array<{ bookId: string; qty: number }> };
      let total = 0;
      const items = input.lines.map((l) => {
        const b = store.books.get(l.bookId)!;
        total += Number(b.price) * l.qty;
        b.stock -= l.qty;
        return { bookId: b.id, qty: l.qty, unitPrice: b.price };
      });
      const order = { id: `o${store.nextId++}`, status: "PLACED", customerId: "u1", items, total: total.toFixed(2) };
      store.orders.set(order.id, order as never);
      json(201, order);
    });
    return;
  }
  if (req.method === "GET" && coll === "orders" && id) {
    const o = store.orders.get(id);
    return o ? json(200, o) : json(404, { error: "not found" });
  }
  json(405, { error: "method" });
}

// ---------------------------------------------------------------- GraphQL
const gqlSchema = buildSchema(`
  type Author { id: ID! name: String! bio: String books: [Book!]! }
  type Book { id: ID! title: String! format: String! price: String! stock: Int! author: Author! reviews(first: Int = 10): [Review!]! }
  type Review { id: ID! rating: Int! body: String! reviewerId: ID! }
  type OrderItem { qty: Int! unitPrice: String! book: Book! }
  type Order { id: ID! status: String! total: String! items: [OrderItem!]! }
  type Page { items: [Book!]! total: Int! }
  input OrderLine { bookId: ID! qty: Int! }
  type Query { books(first: Int = 20): Page! book(id: ID!): Book order(id: ID!): Order }
  type Mutation { placeOrder(lines: [OrderLine!]!): Order! }
`);
// Resolvers with DataLoader-style batching for author (what a careful GraphQL team writes).
type Ctx = { authorLoads: number; loaderQueue: Map<string, Array<(a: unknown) => void>> | null };
const gqlRoot = {
  books: ({ first }: { first: number }) => ({ items: [...store.books.values()].sort(byId).slice(0, first).map(gqlBook), total: store.books.size }),
  book: ({ id }: { id: string }) => {
    const b = store.books.get(id);
    return b ? gqlBook(b) : null;
  },
  order: ({ id }: { id: string }) => {
    const o = store.orders.get(id);
    return o ? { ...o, items: o.items.map((it) => ({ ...it, book: gqlBook(store.books.get(it.bookId)!) })) } : null;
  },
  placeOrder: ({ lines }: { lines: Array<{ bookId: string; qty: number }> }) => {
    let total = 0;
    const items = lines.map((l) => {
      const b = store.books.get(l.bookId)!;
      total += Number(b.price) * l.qty;
      b.stock -= l.qty;
      return { bookId: b.id, qty: l.qty, unitPrice: b.price, book: gqlBook(b) };
    });
    const order = { id: `o${store.nextId++}`, status: "PLACED", customerId: "u1", items, total: total.toFixed(2) };
    store.orders.set(order.id, order as never);
    return order;
  },
};
function gqlBook(b: NonNullable<ReturnType<Store["books"]["get"]>>) {
  return {
    ...bookView(b),
    author: (_a: unknown, ctx: Ctx) =>
      new Promise((resolve) => {
        // batch authors resolved in the same tick (DataLoader pattern)
        if (!ctx.loaderQueue) {
          ctx.loaderQueue = new Map();
          queueMicrotask(() => {
            const q = ctx.loaderQueue!;
            ctx.loaderQueue = null;
            ctx.authorLoads++;
            for (const [id, cbs] of q) for (const cb of cbs) cb(store.authors.get(id));
          });
        }
        (ctx.loaderQueue.get(b.authorId) ?? ctx.loaderQueue.set(b.authorId, []).get(b.authorId)!).push(resolve);
      }),
    reviews: ({ first }: { first: number }) => [...store.reviews.values()].filter((r) => r.bookId === b.id).sort(byId).slice(0, first),
  };
}
function gqlHandler(req: IncomingMessage, res: ServerResponse): void {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { query, variables } = JSON.parse(body) as { query: string; variables?: Record<string, unknown> };
    void graphql({ schema: gqlSchema, source: query, rootValue: gqlRoot, variableValues: variables ?? {}, contextValue: { authorLoads: 0, loaderQueue: null } }).then((r) =>
      res.writeHead(200, { "content-type": "application/graphql-response+json" }).end(JSON.stringify(r)),
    );
  });
}

// ---------------------------------------------------------------- Rayfold
const bookstore = createBookstore({ store });
const rayfoldHandler = createHttpHandler(bookstore.server, { viewer: () => ({ id: "u1", role: "customer" }) });
const codec = new RbCodec(bookstore.server.ir);

// ---------------------------------------------------------------- harness
interface Sample { bytesIn: number; bytesOut: number; roundTrips: number; ms: number }
async function call(url: string, init: RequestInit & { rb?: boolean }): Promise<{ bytesIn: number; bytesOut: number; body: unknown }> {
  const bytesOut = typeof init.body === "string" ? Buffer.byteLength(init.body) : init.body instanceof Uint8Array ? init.body.length : 0;
  const res = await fetch(url, init as RequestInit);
  const buf = new Uint8Array(await res.arrayBuffer());
  const ct = res.headers.get("content-type") ?? "";
  const text = () => new TextDecoder().decode(buf);
  const body = init.rb ? codec.decodeFrames(buf) : ct.startsWith("application/rayfold-frames+json") ? text().trim().split("\n").map((l) => JSON.parse(l)) : ct.includes("json") ? JSON.parse(text()) : null;
  return { bytesIn: buf.length, bytesOut, body };
}

type Flow = (base: { rest: string; gql: string; rayfold: string }) => Promise<Sample>;

const RAYFOLD_HEADERS = { "content-type": "application/rayfold+json", accept: "application/rayfold-frames+json" };
// Rayfold is measured as its client sends when it has the schema: compact frames, which leave out the `$type` and
// `meta` that a schema-aware client does not need (the GraphQL queries here do not ask for __typename either).
const compact = (ops: Array<Record<string, unknown>>) => ops.map((op) => ({ ...op, compact: true }));
const rayfoldBatch = (ops: Array<Record<string, unknown>>) => JSON.stringify({ ops: compact(ops) });
const rayfoldBatchRb = (ops: Array<Record<string, unknown>>) => codec.encode({ ops: compact(ops) });
const RB_HEADERS = { "content-type": "application/rayfold", accept: "application/rayfold" };

/** Flow A: product page = book + author + 3 reviews. */
const flows: Record<string, Record<string, Flow>> = {
  "A. product page (book + author + 3 reviews)": {
    REST: async ({ rest }) => {
      const t0 = performance.now();
      const b = await call(`${rest}/books/b1`, {});
      const [a, r] = await Promise.all([call(`${rest}/authors/${(b.body as { authorId: string }).authorId}`, {}), call(`${rest}/reviews?bookId=b1&limit=3`, {})]);
      return { roundTrips: 2, bytesIn: b.bytesIn + a.bytesIn + r.bytesIn, bytesOut: 0, ms: performance.now() - t0 };
    },
    GraphQL: async ({ gql }) => {
      const t0 = performance.now();
      const body = JSON.stringify({ query: `query($id: ID!) { book(id: $id) { id title format price stock author { id name } reviews(first: 3) { id rating body } } }`, variables: { id: "b1" } });
      const r = await call(gql, { method: "POST", headers: { "content-type": "application/json" }, body });
      return { roundTrips: 1, bytesIn: r.bytesIn, bytesOut: r.bytesOut, ms: performance.now() - t0 };
    },
    "Rayfold (JSON)": async ({ rayfold }) => {
      const t0 = performance.now();
      const body = rayfoldBatch([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title format price stock author { id name } reviews(page: { first: 3 }) { items { id rating body } } }" }]);
      const r = await call(rayfold, { method: "POST", headers: RAYFOLD_HEADERS, body });
      return { roundTrips: 1, bytesIn: r.bytesIn, bytesOut: r.bytesOut, ms: performance.now() - t0 };
    },
    "Rayfold (RB)": async ({ rayfold }) => {
      const t0 = performance.now();
      const body = rayfoldBatchRb([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title format price stock author { id name } reviews(page: { first: 3 }) { items { id rating body } } }" }]);
      const r = await call(rayfold, { method: "POST", headers: RB_HEADERS, body: body as never, rb: true });
      return { roundTrips: 1, bytesIn: r.bytesIn, bytesOut: r.bytesOut, ms: performance.now() - t0 };
    },
  },
  "B. catalogue list (20 books with author names)": {
    REST: async ({ rest }) => {
      const t0 = performance.now();
      const list = await call(`${rest}/books?limit=20`, {});
      const ids = [...new Set((list.body as { items: Array<{ authorId: string }> }).items.map((b) => b.authorId))];
      const authors = await Promise.all(ids.map((id) => call(`${rest}/authors/${id}`, {})));
      return { roundTrips: 2, bytesIn: list.bytesIn + authors.reduce((n, a) => n + a.bytesIn, 0), bytesOut: 0, ms: performance.now() - t0 };
    },
    GraphQL: async ({ gql }) => {
      const t0 = performance.now();
      const body = JSON.stringify({ query: `{ books(first: 20) { items { id title price stock author { name } } total } }` });
      const r = await call(gql, { method: "POST", headers: { "content-type": "application/json" }, body });
      return { roundTrips: 1, bytesIn: r.bytesIn, bytesOut: r.bytesOut, ms: performance.now() - t0 };
    },
    "Rayfold (JSON)": async ({ rayfold }) => {
      const t0 = performance.now();
      const body = rayfoldBatch([{ id: 1, op: "books", args: { page: { first: 20 } }, shape: "{ items { id title price stock author { name } } total }" }]);
      const r = await call(rayfold, { method: "POST", headers: RAYFOLD_HEADERS, body });
      return { roundTrips: 1, bytesIn: r.bytesIn, bytesOut: r.bytesOut, ms: performance.now() - t0 };
    },
    "Rayfold (RB)": async ({ rayfold }) => {
      const t0 = performance.now();
      const body = rayfoldBatchRb([{ id: 1, op: "books", args: { page: { first: 20 } }, shape: "{ items { id title price stock author { name } } total }" }]);
      const r = await call(rayfold, { method: "POST", headers: RB_HEADERS, body: body as never, rb: true });
      return { roundTrips: 1, bytesIn: r.bytesIn, bytesOut: r.bytesOut, ms: performance.now() - t0 };
    },
  },
  "C. place order then read it back with book stock": {
    REST: async ({ rest }) => {
      const t0 = performance.now();
      const o = await call(`${rest}/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines: [{ bookId: "b3", qty: 1 }] }) });
      const read = await call(`${rest}/orders/${(o.body as { id: string }).id}`, {});
      const book = await call(`${rest}/books/b3`, {});
      return { roundTrips: 3, bytesIn: o.bytesIn + read.bytesIn + book.bytesIn, bytesOut: o.bytesOut, ms: performance.now() - t0 };
    },
    GraphQL: async ({ gql }) => {
      const t0 = performance.now();
      const m = await call(gql, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: `mutation { placeOrder(lines: [{ bookId: "b3", qty: 1 }]) { id } }` }) });
      const id = (m.body as { data: { placeOrder: { id: string } } }).data.placeOrder.id;
      const q = await call(gql, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: `query($id: ID!) { order(id: $id) { id status total items { qty book { id stock } } } }`, variables: { id } }) });
      return { roundTrips: 2, bytesIn: m.bytesIn + q.bytesIn, bytesOut: m.bytesOut + q.bytesOut, ms: performance.now() - t0 };
    },
    "Rayfold (JSON)": async ({ rayfold }) => {
      const t0 = performance.now();
      const body = rayfoldBatch([
        { id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: `bench-${Math.random().toString(36).slice(2).padEnd(14, "0")}`, shape: "{ id }" },
        { id: 2, op: "order", args: { id: { $ref: "1.id" } }, shape: "{ id status total items { qty book { id stock } } }" },
      ]);
      const r = await call(rayfold, { method: "POST", headers: RAYFOLD_HEADERS, body });
      return { roundTrips: 1, bytesIn: r.bytesIn, bytesOut: r.bytesOut, ms: performance.now() - t0 };
    },
    "Rayfold (RB)": async ({ rayfold }) => {
      const t0 = performance.now();
      const body = rayfoldBatchRb([
        { id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: `bench-${Math.random().toString(36).slice(2).padEnd(14, "0")}`, shape: "{ id }" },
        { id: 2, op: "order", args: { id: { $ref: "1.id" } }, shape: "{ id status total items { qty book { id stock } } }" },
      ]);
      const r = await call(rayfold, { method: "POST", headers: RB_HEADERS, body: body as never, rb: true });
      return { roundTrips: 1, bytesIn: r.bytesIn, bytesOut: r.bytesOut, ms: performance.now() - t0 };
    },
  },
};

function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown): Promise<Server> {
  const s = createServer((req, res) => void handler(req, res));
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;

async function main(): Promise<void> {
  const [rest, gql, rayfold] = await Promise.all([listen(restHandler), listen(gqlHandler), listen(rayfoldHandler)]);
  const base = {
    rest: `http://127.0.0.1:${(rest.address() as AddressInfo).port}`,
    gql: `http://127.0.0.1:${(gql.address() as AddressInfo).port}/graphql`,
    rayfold: `http://127.0.0.1:${(rayfold.address() as AddressInfo).port}/rayfold`,
  };
  const jsonOut: Array<{ flow: string; impl: string; roundTrips: number; bytesDown: number; bytesUp: number; p50: number; p99: number }> = [];
  const lines: string[] = ["# Bench results", "", `Node ${process.version}, loopback HTTP/1.1, ${ITER} iterations per cell, interleaved, in-memory data (40 books). Latency includes client fetch overhead.`, ""];
  for (const [flowName, impls] of Object.entries(flows)) {
    lines.push(`## ${flowName}`, "", "| Implementation | round trips | bytes down | bytes up | p50 ms | p99 ms |", "|---|---:|---:|---:|---:|---:|");
    const entries = Object.entries(impls);
    for (const [, fn] of entries) for (let i = 0; i < 20; i++) await fn(base); // warm-up
    store.books.get("b3")!.stock = 100_000;
    // Each iteration runs every implementation once, starting with a different one each time, so drift in machine
    // load, JIT state or garbage collection lands on all of them alike instead of on whichever ran last.
    const perImpl = entries.map((): Sample[] => []);
    for (let i = 0; i < ITER; i++) {
      for (let k = 0; k < entries.length; k++) {
        const j = (i + k) % entries.length;
        perImpl[j]!.push(await entries[j]![1](base));
      }
    }
    for (const [j, [impl]] of entries.entries()) {
      const samples = perImpl[j]!;
      const ms = samples.map((s) => s.ms);
      const last = samples[samples.length - 1]!;
      lines.push(`| ${impl} | ${last.roundTrips} | ${last.bytesIn} | ${last.bytesOut} | ${pct(ms, 0.5).toFixed(2)} | ${pct(ms, 0.99).toFixed(2)} |`);
      jsonOut.push({ flow: flowName, impl, roundTrips: last.roundTrips, bytesDown: last.bytesIn, bytesUp: last.bytesOut, p50: Number(pct(ms, 0.5).toFixed(3)), p99: Number(pct(ms, 0.99).toFixed(3)) });
      console.log(`${flowName} / ${impl}: rt=${last.roundTrips} down=${last.bytesIn}B up=${last.bytesOut}B p50=${pct(ms, 0.5).toFixed(2)}ms p99=${pct(ms, 0.99).toFixed(2)}ms`);
    }
    lines.push("");
  }
  lines.push("Notes:", "- REST bytes exclude request bodies for GETs; round trips count dependent waves (parallel requests in one wave count once).",
    "- GraphQL uses graphql-js with a DataLoader-style author batcher; bytes are the JSON response.",
    "- Rayfold asks for compact frames, as its client does when it has the schema: no `$type` or `meta` (GraphQL's queries here ask for no __typename).",
    "- Rayfold (RB) is the binary wire with the schema key dictionary; frames are identical to the JSON run.",
    "- Each iteration runs every implementation once, rotating which goes first, so machine drift affects all alike.", "");
  mkdirSync("bench/results", { recursive: true });
  writeFileSync("bench/results/latest.md", lines.join("\n"));
  writeFileSync("bench/results/latest.json", JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, iterations: ITER, rows: jsonOut }, null, 2) + "\n");
  console.log("wrote bench/results/latest.md and latest.json");
  rest.close();
  gql.close();
  rayfold.close();
}
void main();
