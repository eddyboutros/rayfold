/**
 * The end-to-end comparison. Every scenario runs against REST, GraphQL and Rayfold over real HTTP,
 * asserts correctness per stack, records the measurable difference, and the suite writes e2e/report.md.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { base64url, diffSchemas, loadSchema } from "@rayfold/schema";
import { RbCodec } from "@rayfold/rb";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { bookstoreSchemaText } from "../examples/bookstore-ts/src/index.ts";
import { BreakingChangeType, buildSchema, findBreakingChanges } from "graphql";
import { CachingClient, GRAPHQL_MAJOR, GRAPHQL_SDL, GqlNormalizedCache, Recorder, Report, exchange, freshStore, startGraphQL, startRayfold, startRest, writeReport, type Stack } from "./harness.ts";
import { Signal, openSse } from "./wait.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const JSON_CT = { "content-type": "application/json" };

const report = new Report();
let rest: Stack;
let gql: Stack;
/** the same GraphQL API with the obvious per-parent author resolver (no DataLoader) */
let gqlNaive: Stack;
const rbCodec = new RbCodec(loadSchema(bookstoreSchemaText()).ir);
let rayfold: Awaited<ReturnType<typeof startRayfold>>;
const U1 = { authorization: "Bearer u1" };
const ADMIN = { authorization: "Bearer admin" };

/** Records every exchange each test makes; the report shows them under the test's row. */
const recorder = new Recorder((bytes, asFrames) => (asFrames ? rbCodec.decodeFrames(bytes) : rbCodec.decode(bytes)));
let rowsBefore = 0;

beforeAll(() => recorder.install());
// Every test gets its own four servers and stores: no test depends on another test's writes.
beforeEach(async () => {
  [rest, gql, gqlNaive, rayfold] = await Promise.all([startRest(freshStore()), startGraphQL(freshStore()), startGraphQL(freshStore(), { batching: false }), startRayfold(freshStore())]);
  recorder.track([[rest.base, "REST"], [gql.base, "GraphQL"], [gqlNaive.base, "GraphQL"], [rayfold.base, "Rayfold"]]);
  rowsBefore = report.rows.length;
});
afterEach(async () => {
  const examples = await recorder.take();
  for (const row of report.rows.slice(rowsBefore)) row.examples = examples;
  await Promise.all([rest.close(), gql.close(), gqlNaive.close(), rayfold.close()]);
});
afterAll(() => {
  recorder.uninstall();
  writeReport(
    "e2e/report.md",
    report.markdown({
      title: "End-to-end comparison: REST vs GraphQL vs Rayfold",
      dataset: "Same bookstore, same data, same flows",
      assertedBy: "e2e/comparison.test.ts",
    }),
  );
  writeReport("e2e/results.json", report.json());
});

const jsonPost = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const gqlCall = async (query: string, variables: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
  const res = await jsonPost(`${gql.base}/graphql`, { query, variables }, headers);
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> | null; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> } };
};
const rayfoldCall = async (ops: unknown[], headers: Record<string, string> = {}) => {
  const res = await fetch(`${rayfold.base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json", ...headers }, body: JSON.stringify({ ops }) });
  const text = await res.text();
  return { status: res.status, frames: text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>), bytes: Buffer.byteLength(text) };
};
const reset = () => {
  for (const s of [rest, gql, rayfold]) {
    s.counters.originRequests = 0;
    for (const k of Object.keys(s.counters.loaderCalls)) delete s.counters.loaderCalls[k];
  }
};

describe("1. Product page: book + author + reviews", () => {
  it("same facts everywhere; GraphQL and Rayfold in one round trip, Rayfold with the fewest bytes", async () => {
    reset();
    const e1 = await exchange(rest.base, "GET", "/books/b1");
    const b = e1.json as { authorId: string };
    const [e2, e3] = await Promise.all([exchange(rest.base, "GET", `/authors/${b.authorId}`), exchange(rest.base, "GET", "/reviews?bookId=b1&limit=3")]);
    expect((e2.json as { name: string }).name).toBe("Ursula K. Le Guin");
    expect((e3.json as { items: unknown[] }).items).toHaveLength(2);
    const restReqs = rest.counters.originRequests;
    const restBytes = [e1, e2, e3].reduce((n, e) => n + e.bytes.up + e.bytes.down, 0);

    const gBody = JSON.stringify({ query: `{ book(id: "b1") { id title format price stock author { id name } reviews(first: 3) { id rating } } }` });
    const g = await exchange(gql.base, "POST", "/graphql", { headers: { "content-type": "application/json" }, body: gBody });
    expect((g.json as { data: { book: { author: { name: string } } } }).data.book.author.name).toBe("Ursula K. Le Guin");
    const gBytes = g.bytes.up + g.bytes.down;

    // Rayfold: the server-defined view Book.card names exactly these fields; RB is Rayfold's standard binary wire
    const ops = [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ ...Book.card }", compact: true }];
    const rbBody = rbCodec.encode({ ops });
    const res = await fetch(`${rayfold.base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold", accept: "application/rayfold" }, body: rbBody as BodyInit });
    const rbResp = new Uint8Array(await res.arrayBuffer());
    const frames = rbCodec.decodeFrames(rbResp) as Array<{ data: { author: { name: string }; reviews: { items: unknown[] } } }>;
    expect(frames[0]!.data.author.name).toBe("Ursula K. Le Guin");
    expect(frames[0]!.data.reviews.items).toHaveLength(2);
    const rbUp = "/rayfold".length + rbBody.length;
    const rayfoldBytes = rbUp + rbResp.length;

    expect(restReqs).toBe(3);
    expect(gql.counters.originRequests).toBe(1);
    expect(rayfold.counters.originRequests).toBe(1);
    expect(rayfoldBytes).toBeLessThan(gBytes);

    // The same request again as JSON, so the report can say how much of the difference is the binary format. It goes to
    // a server the recorder does not track: the page itself takes one request, and the report counts the recorded ones.
    const measureAsJson = async () => {
      const side = await startRayfold(freshStore());
      try {
        const text = await (await fetch(`${side.base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: JSON.stringify({ ops }) })).text();
        return { frames: text.trim().split("\n").map((l) => JSON.parse(l) as unknown), bytes: Buffer.byteLength(text) };
      } finally {
        await side.close();
      }
    };
    const asJson = await measureAsJson();
    expect(asJson.frames).toEqual(frames);
    const jsonUp = "/rayfold".length + Buffer.byteLength(JSON.stringify({ ops }));
    const jsonBytes = jsonUp + asJson.bytes;
    report.add({ aspect: "Product page (book + author + 3 reviews)", values: { REST: restBytes, GraphQL: gBytes, Rayfold: rayfoldBytes }, unit: "bytes on the wire (request + response)", better: "lower", metric: "requests and bytes for the page", REST: `3 requests in 2 waves, ${restBytes} B`, GraphQL: `1 request, ${gBytes} B as JSON`, Rayfold: `1 request, ${rayfoldBytes} B in binary, ${jsonBytes} B as JSON`, note: `The same data on all three; each count is the URL path plus the request and the response. GraphQL sends ${g.bytes.up} B and gets ${g.bytes.down} B back, as JSON. Rayfold in its binary format sends ${rbUp} B and gets ${rbResp.length} B back; as JSON it would be ${jsonUp} B and ${asJson.bytes} B, ${jsonBytes <= gBytes ? "no more than" : "a little more than"} GraphQL. Most of the saving is the binary format; the request is also shorter because it names a view the server defines (Book.card) instead of listing every field.` });
  });
});

describe("2. List of 20 books with author names (N+1)", () => {
  it("REST pays a request per author, GraphQL's obvious resolver loads per book, Rayfold batches by construction", async () => {
    reset();
    const list = await (await fetch(`${rest.base}/books?limit=20`)).json();
    const authorIds = [...new Set((list.items as Array<{ authorId: string }>).map((x) => x.authorId))];
    await Promise.all(authorIds.map((id) => fetch(`${rest.base}/authors/${id}`)));
    expect(rest.counters.originRequests).toBe(1 + authorIds.length);

    const q = `{ books(first: 20) { items { id title author { name } } } }`;
    await gqlCall(q);
    expect(gql.counters.loaderCalls["author"]).toBe(1); // with the hand-written DataLoader
    for (const k of Object.keys(gqlNaive.counters.loaderCalls)) delete gqlNaive.counters.loaderCalls[k];
    expect((await jsonPost(`${gqlNaive.base}/graphql`, { query: q })).status).toBe(200);
    const naive = gqlNaive.counters.loaderCalls["author"]!;
    expect(naive).toBe(20);

    await rayfoldCall([{ id: 1, op: "books", args: { page: { first: 20 } }, shape: "{ items { id title author { name } } }" }]);
    expect(rayfold.counters.loaderCalls["Book.author"]).toBe(1);
    report.add({ aspect: "List of 20 books with author names", values: { REST: authorIds.length, GraphQL: naive, Rayfold: 1 }, unit: "author lookups with straightforward code", better: "lower", metric: "author lookups at the backend", REST: `${authorIds.length} extra requests from the client (N+1 at the edge)`, GraphQL: `${naive} with the obvious resolver; 1 only with a hand-written DataLoader (both measured)`, Rayfold: "1: a batch loader is the only resolver shape", note: "`rayfold explain` shows one loader call per level" });
  });
});

describe("3. Over-fetching and payload shaping", () => {
  it("REST returns whole resources; GraphQL and Rayfold return the selected fields; RB shrinks further", async () => {
    const restBytes = Buffer.byteLength(await (await fetch(`${rest.base}/books?limit=20`)).text());
    const g = await jsonPost(`${gql.base}/graphql`, { query: `{ books(first: 20) { items { id title } } }` });
    const gqlBytes = Buffer.byteLength(await g.text());
    const y = await rayfoldCall([{ id: 1, op: "books", args: { page: { first: 20 } }, shape: "{ items { id title } }", compact: true }]);
    const rb = await fetch(`${rayfold.base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json", accept: "application/rayfold" }, body: JSON.stringify({ ops: [{ id: 1, op: "books", args: { page: { first: 20 } }, shape: "{ items { id title } }" }] }) });
    const rbBytes = (await rb.arrayBuffer()).byteLength;
    expect(gqlBytes).toBeLessThan(restBytes);
    expect(y.bytes).toBeLessThan(restBytes);
    expect(rbBytes).toBeLessThan(gqlBytes);
    expect(y.bytes).toBeLessThanOrEqual(gqlBytes + 16); // compact JSON is at parity with GraphQL's JSON
    report.add({ aspect: "Payload for 20 books, only id + title wanted", values: { REST: restBytes, GraphQL: gqlBytes, Rayfold: rbBytes }, unit: "bytes (Rayfold = RB)", better: "lower", metric: "bytes on the wire", REST: `${restBytes} (full resources)`, GraphQL: `${gqlBytes}`, Rayfold: `${y.bytes} compact JSON / ${rbBytes} RB`, note: "compact mode drops $type where the schema fixes it; RB halves it again" });
  });
});

describe("4. Create then read (pipelining) and retry safety (idempotency)", () => {
  it("place an order, then pay for it: the second command needs the first one's id", async () => {
    reset();
    const o = await (await jsonPost(`${rest.base}/orders`, { lines: [{ bookId: "b3", qty: 1 }] }, { ...U1, "idempotency-key": "k-rest-pay-00001" })).json();
    const paid = await (await jsonPost(`${rest.base}/orders/${o.id}/pay`, {}, U1)).json();
    expect(paid.status).toBe("PAID");
    expect(rest.counters.originRequests).toBe(2);

    const m = await gqlCall(`mutation { placeOrder(lines: [{ bookId: "b3", qty: 1 }]) { id status } }`, {}, U1);
    const id = (m.body.data!["placeOrder"] as { id: string }).id;
    const p = await gqlCall(`mutation($id: ID!) { payOrder(id: $id) { status } }`, { id }, U1);
    expect((p.body.data!["payOrder"] as { status: string }).status).toBe("PAID");
    expect(gql.counters.originRequests).toBe(2);

    const y = await rayfoldCall([
      { id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: "e2e-place-pay-0001", shape: "{ id }" },
      { id: 2, op: "payOrder", args: { id: { $ref: "1.id" } }, key: "e2e-place-pay-0002", shape: "{ id status }" },
    ], U1);
    expect(rayfold.counters.originRequests).toBe(1);
    expect(y.frames[1]!["ok"]).toMatchObject({ status: "PAID" });
    report.add({ aspect: "Place an order, then pay for it", values: { REST: 2, GraphQL: 2, Rayfold: 1 }, unit: "round trips", better: "lower", metric: "round trips for two dependent commands", REST: "2", GraphQL: "2 (a mutation's result cannot feed a second mutation in the same document)", Rayfold: "1 ($ref pipelining)", note: "reading back the created order is 1 request on GraphQL too, via the mutation's selection set; dependent commands are where pipelining matters" });
  });

  it("a retried create is safe only where idempotency is enforced, not merely available", async () => {
    // REST: Idempotency-Key convention works IF the client sends it; a client that forgets double-orders.
    const before = rest.store.orders.size;
    await jsonPost(`${rest.base}/orders`, { lines: [{ bookId: "b3", qty: 1 }] }, { ...U1, "idempotency-key": "k-rest-1" });
    recorder.label("retry with the same Idempotency-Key: replayed");
    await jsonPost(`${rest.base}/orders`, { lines: [{ bookId: "b3", qty: 1 }] }, { ...U1, "idempotency-key": "k-rest-1" });
    recorder.label("a client that forgets the header");
    expect(rest.store.orders.size).toBe(before + 1);
    await jsonPost(`${rest.base}/orders`, { lines: [{ bookId: "b3", qty: 1 }] }, U1);
    recorder.label("its retry: a second order");
    await jsonPost(`${rest.base}/orders`, { lines: [{ bookId: "b3", qty: 1 }] }, U1);
    expect(rest.store.orders.size).toBe(before + 3); // forgot the header: two orders

    // GraphQL: no idempotency concept; a retried mutation is a second order.
    const gBefore = gql.store.orders.size;
    await gqlCall(`mutation { placeOrder(lines: [{ bookId: "b3", qty: 1 }]) { id } }`, {}, U1);
    await gqlCall(`mutation { placeOrder(lines: [{ bookId: "b3", qty: 1 }]) { id } }`, {}, U1);
    expect(gql.store.orders.size).toBe(gBefore + 2);

    // Rayfold: the key is mandatory; a retry replays; a forgotten key is rejected before execution.
    const yBefore = rayfold.store.orders.size;
    await rayfoldCall([{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: "e2e-retry-000000001" }], U1);
    const again = await rayfoldCall([{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: "e2e-retry-000000001" }], U1);
    expect((again.frames[0]!["meta"] as { replay?: boolean }).replay).toBe(true);
    const noKey = await rayfoldCall([{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } } }], U1);
    expect(noKey.frames[0]!["error"]).toMatchObject({ code: "invalid_argument" });
    expect(rayfold.store.orders.size).toBe(yBefore + 1);
    report.add({ aspect: "Retrying a create", values: { REST: 1, GraphQL: 1, Rayfold: 0 }, unit: "duplicate orders (client forgot the key)", better: "lower", metric: "duplicate orders after a retry", REST: "0 with Idempotency-Key, 1 without (optional convention)", GraphQL: "1 (no idempotency concept)", Rayfold: "0 (key mandatory, replay returned, missing key rejected)" });
  });
});

describe("5. Errors: typed, structured, machine-actionable", () => {
  it("out of stock: REST status + ad-hoc body, GraphQL errors[] beside null data, Rayfold declared typed error", async () => {
    const r = await jsonPost(`${rest.base}/orders`, { lines: [{ bookId: "b4", qty: 1 }] }, U1);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: "out_of_stock", available: 0 });

    const g = await gqlCall(`mutation { placeOrder(lines: [{ bookId: "b4", qty: 1 }]) { id } }`, {}, U1);
    expect(g.status).toBe(200);
    expect(g.body.data).toBeNull();
    expect(g.body.errors![0]!.extensions).toMatchObject({ code: "OUT_OF_STOCK", available: 0 });

    const y = await rayfoldCall([{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b4", qty: 1 }] } }, key: "e2e-oos-0000000001" }], U1);
    expect(y.frames[0]!["error"]).toEqual({ code: "domain", type: "OutOfStock", message: "Only 0 of A Wizard of Earthsea left", data: { bookId: "b4", available: 0 } });
    // and the contract says so: the schema declares what placeOrder can throw
    const { ir } = loadSchema(bookstoreSchemaText());
    expect(ir.ops["placeOrder"]!.throws).toEqual(["OutOfStock", "PaymentDeclined"]);
    report.add({ aspect: "Domain error (out of stock)", values: { REST: 0, GraphQL: 0, Rayfold: 1 }, unit: "declared in the contract (1 = yes)", better: "higher", metric: "how a client learns the error type", REST: "HTTP 409 + body shape by convention, undocumented", GraphQL: "HTTP 200, errors[].extensions.code by convention, data: null", Rayfold: "declared `throws OutOfStock { bookId, available }`, typed payload, generated client union" });
  });

  it("bad input: Rayfold rejects wrong types AND out-of-range values from the contract; GraphQL only types; REST neither", async () => {
    // wrong type
    const y1 = await rayfoldCall([{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: "two" }] } }, key: "e2e-bad-00000000001" }], U1);
    expect(y1.frames[0]!["error"]).toMatchObject({ code: "invalid_argument", message: "placeOrder().input.lines.0.qty: expected Int" });
    const g1 = await gqlCall(`mutation { placeOrder(lines: [{ bookId: "b1", qty: "two" }]) { id } }`, {}, U1);
    expect(g1.body.errors![0]!.message).toContain("Int");
    const r1 = await jsonPost(`${rest.base}/orders`, { lines: [{ bookId: "b1", qty: "two" }] }, U1);
    expect(r1.status).toBe(201); // accepted silently: "two" coerced to NaN by the handler
    // out of range: qty 0 is a valid Int everywhere, but the Rayfold contract says @range(min: 1)
    const before = { rest: rest.store.orders.size, gql: gql.store.orders.size, rayfold: rayfold.store.orders.size };
    const y2 = await rayfoldCall([{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 0 }] } }, key: "e2e-bad-00000000002" }], U1);
    expect(y2.frames[0]!["error"]).toMatchObject({ code: "invalid_argument", message: "placeOrder().input.lines.0.qty: must be >= 1" });
    const g2 = await gqlCall(`mutation { placeOrder(lines: [{ bookId: "b1", qty: 0 }]) { id } }`, {}, U1);
    expect(g2.body.errors).toBeUndefined();
    const r2 = await jsonPost(`${rest.base}/orders`, { lines: [{ bookId: "b1", qty: 0 }] }, U1);
    expect(r2.status).toBe(201);
    expect(rest.store.orders.size).toBe(before.rest + 1);
    expect(gql.store.orders.size).toBe(before.gql + 1);
    expect(rayfold.store.orders.size).toBe(before.rayfold);
    report.add({ aspect: "Invalid input (qty: \"two\", then qty: 0)", values: { REST: 0, GraphQL: 1, Rayfold: 2 }, unit: "of 2 bad requests rejected before side effects", better: "higher", metric: "rejected before side effects?", REST: "neither (orders created with NaN and 0 quantity)", GraphQL: "type error only; qty 0 creates an order", Rayfold: "both: type system plus @range(min: 1) declared in the schema", note: "constraints live in the contract, so generated clients, agents and docs see them too" });
  });
});

describe("6. Authorization", () => {
  it("field-level rules: Rayfold enforces them from the schema; REST and GraphQL rely on code in every handler", async () => {
    const restAnon = await (await fetch(`${rest.base}/books/b1`)).json();
    const restOwner = await (await fetch(`${rest.base}/books/b1`, { headers: U1 })).json();
    expect(restAnon.costPrice).toBeUndefined();
    expect(restOwner.costPrice).toBe("6.10");

    const gAnon = await gqlCall(`{ book(id: "b1") { costPrice } }`);
    const gOwner = await gqlCall(`{ book(id: "b1") { costPrice } }`, {}, U1);
    expect((gAnon.body.data!["book"] as { costPrice: null }).costPrice).toBeNull(); // silently null: indistinguishable from "no cost price"
    expect((gOwner.body.data!["book"] as { costPrice: string }).costPrice).toBe("6.10");

    const yAnon = await rayfoldCall([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id costPrice }" }]);
    const yOther = await rayfoldCall([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id costPrice }" }], { authorization: "Bearer u2" });
    const yOwner = await rayfoldCall([{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id costPrice }" }], U1);
    const yDefault = await rayfoldCall([{ id: 1, op: "book", args: { id: "b1" } }]);
    expect(yAnon.frames[0]!["error"]).toMatchObject({ code: "unauthenticated", path: "costPrice" });
    expect(yOther.frames[0]!["error"]).toMatchObject({ code: "permission_denied", path: "costPrice" });
    expect(yOwner.frames[0]!["data"]).toMatchObject({ costPrice: "6.10" });
    expect(yDefault.frames[0]!["data"]).not.toHaveProperty("costPrice");
    report.add({ aspect: "Field-level authorization (costPrice)", values: { REST: 0, GraphQL: 0, Rayfold: 1 }, unit: "rule in the contract, explicit denial (1 = yes)", better: "higher", metric: "where the rule lives / what a denied caller sees", REST: "in each handler; field omitted", GraphQL: "in each resolver; null (ambiguous)", Rayfold: "in the schema (`@allow`); explicit unauthenticated/permission_denied with path, default view omits it", note: "Rayfold's `rayfold check` warns when a policy is added or removed" });
  });
});

describe("7. HTTP caching", () => {
  it("a whole product page is one cacheable request on Rayfold; REST revalidates per resource; GraphQL cannot use shared caches", async () => {
    const c = new CachingClient();
    // REST: three resources, three cache entries, three revalidations on the repeat view
    const restUrls = [`${rest.base}/books/b1`, `${rest.base}/authors/a1`, `${rest.base}/reviews?bookId=b1&limit=3`];
    for (const u of restUrls) await c.get(u);
    let restRepeat = 0;
    for (const u of restUrls) restRepeat += (await c.get(u)).wireBytes;
    expect(c.revalidated).toBe(3);
    // GraphQL: one POST, never cacheable by a shared cache
    const gqlBody = JSON.stringify({ query: `{ book(id: "b1") { id title author { name } reviews(first: 3) { id rating } } }` });
    await c.post(`${gql.base}/graphql`, gqlBody, { "content-type": "application/json" });
    const gRepeat = await c.post(`${gql.base}/graphql`, gqlBody, { "content-type": "application/json" });
    expect(gRepeat.fromCache).toBe(false);
    expect(gRepeat.headers["cache-control"]).toBe("no-store");
    // Rayfold: the same page is one safe batch (QUERY semantics via Rayfold-Safe), one ETag, one 304
    const rayfoldBody = JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title author { name } reviews(page: { first: 3 }) { items { id rating } } }" }] });
    await c.post(`${rayfold.base}/rayfold`, rayfoldBody, { "content-type": "application/rayfold+json", "rayfold-safe": "true" });
    const yRepeat = await c.post(`${rayfold.base}/rayfold`, rayfoldBody, { "content-type": "application/rayfold+json", "rayfold-safe": "true" });
    expect(yRepeat.fromCache).toBe(true);
    expect(yRepeat.headers["cache-control"]).toBe("public, max-age=60");
    expect(yRepeat.wireBytes).toBeLessThan(restRepeat);
    expect(yRepeat.wireBytes).toBeLessThan(gRepeat.wireBytes);
    // and private data can never be cached publicly on Rayfold even if the developer forgets: derived scope
    const priv = await fetch(`${rayfold.base}/rayfold/order?a=${base64url(JSON.stringify({ id: "o1" }))}`, { headers: U1 });
    expect(priv.headers.get("cache-control")).toBe("private, max-age=0, no-cache");
    report.add({ aspect: "Shared HTTP caching of a whole product page", values: { REST: restRepeat, GraphQL: gRepeat.wireBytes, Rayfold: yRepeat.wireBytes }, unit: "bytes on the repeat view (headers + body)", better: "lower", metric: "repeat view through a shared cache", REST: `3 revalidations (3 x 304), ${restRepeat} B`, GraphQL: `1 uncacheable POST, ${gRepeat.wireBytes} B`, Rayfold: `1 safe batch, 1 x 304, ${yRepeat.wireBytes} B`, note: "Rayfold derives Cache-Control from @cache and policies; viewer-guarded data is private automatically" });
  });
});

describe("8. Cache coherence after a write", () => {
  it("only Rayfold updates an earlier list view whose data the command changed as a side effect", async () => {
    // REST: the client holds a stale copy until it refetches.
    const restList = await (await fetch(`${rest.base}/books?limit=5`)).json();
    const restStockBefore = (restList.items as Array<{ id: string; stock: number }>).find((b) => b.id === "b1")!.stock;
    await jsonPost(`${rest.base}/orders`, { lines: [{ bookId: "b1", qty: 1 }] }, { ...U1, "idempotency-key": "k-rest-coh" });
    expect((restList.items as Array<{ id: string; stock: number }>).find((b) => b.id === "b1")!.stock).toBe(restStockBefore); // stale

    // GraphQL with an Apollo-style normalized cache: the mutation selects the order it creates, as clients usually do;
    // the book's stock is a side effect it did not select, so the cached list keeps the old value.
    const gcache = new GqlNormalizedCache();
    const listQ = `{ books(first: 5) { items { __typename id stock } } }`;
    gcache.write("list", (await gqlCall(listQ)).body.data);
    const before = (gcache.read("list") as { books: { items: Array<{ id: string; stock: number }> } }).books.items.find((b) => b.id === "b1")!.stock;
    gcache.write(null, (await gqlCall(`mutation { placeOrder(lines: [{ bookId: "b1", qty: 1 }]) { __typename id status total } }`, {}, U1)).body.data);
    expect((gcache.read("list") as { books: { items: Array<{ id: string; stock: number }> } }).books.items.find((b) => b.id === "b1")!.stock).toBe(before); // stale

    const client = new RayfoldClient({ transport: createFetchTransport({ url: `${rayfold.base}/rayfold`, headers: () => U1 }) });
    const seen = new Signal<number>();
    const stop = client.watch<{ items: Array<{ id: string; stock: number }> }>("books", { page: { first: 5 } }, { shape: "{ items { id stock } }" }, (d) => seen.push(d.items[0]!.stock));
    await seen.atLeast(1, "the watched list's first result");
    const reqs = rayfold.counters.originRequests;
    await client.command("placeOrder", { input: { lines: [{ bookId: "b1", qty: 1 }] } }, { shape: "{ id status total }" });
    stop();
    expect(seen.items).toEqual([5, 4]); // b1 starts with 5 copies; the patch arrived with the command's own response
    expect(rayfold.counters.originRequests - reqs).toBe(1); // the command itself, no refetch
    report.add({ aspect: "List view after placing an order", values: { REST: 1, GraphQL: 1, Rayfold: 0 }, unit: "extra requests to be correct", better: "lower", metric: "requests to make the earlier view correct", REST: "1 refetch (or a stale UI)", GraphQL: "1 refetch: a normalized cache only learns what the mutation selected, and stock was a side effect", Rayfold: "0: the server sends the stock change as a patch even though the command selected only the order" });
  });
});

describe("9. Realtime", () => {
  it("stock updates: REST SSE and GraphQL subscriptions need a separate channel; a Rayfold query is its own subscription", async () => {
    // REST: an SSE endpoint the team built for stock events
    const restSse = openSse(`${rest.base}/events`);
    await restSse.ready;
    await jsonPost(`${rest.base}/books/b2?action=restock&qty=1`, {}, ADMIN);
    await restSse.events.atLeast(1, "the REST stock event");
    await restSse.close();
    expect(restSse.events.items).toEqual([{ bookId: "b2", stock: 3 }]);

    // GraphQL: a subscription the team built for stock events
    const gSse = openSse(`${gql.base}/graphql`, { method: "POST", headers: JSON_CT, body: JSON.stringify({ query: `subscription { stockChanged(bookId: "b2") { bookId stock } }` }) });
    await gSse.ready;
    await gqlCall(`mutation { restock(bookId: "b2", qty: 1) { stock } }`, {}, ADMIN);
    await gSse.events.atLeast(1, "the GraphQL subscription event");
    await gSse.close();
    expect(gSse.events.items).toEqual([{ data: { stockChanged: { bookId: "b2", stock: 3 } } }]);

    // Rayfold: the existing query with live: true, streamed over HTTP; the client cache is patched
    const client = new RayfoldClient({ transport: createFetchTransport({ url: `${rayfold.base}/rayfold`, headers: () => U1 }) });
    const seen = new Signal<number>();
    const stop = client.live<{ stock: number }>("book", { id: "b2" }, { shape: "{ id stock }" }, (d) => seen.push(d.stock));
    await seen.atLeast(1, "the live query's first result");
    const adminClient = new RayfoldClient({ transport: createFetchTransport({ url: `${rayfold.base}/rayfold`, headers: () => ADMIN }) });
    await adminClient.command("restock", { bookId: "b2", qty: 1 });
    await seen.atLeast(2, "the live query's patch");
    stop();
    expect(seen.items).toEqual([2, 3]);
    expect(client.cache.get("Book:b2")).toMatchObject({ stock: 3 });
    report.add({ aspect: "Realtime stock updates", values: { REST: 3, GraphQL: 4, Rayfold: 1 }, unit: "pieces the developer writes", better: "lower", metric: "what the developer writes", REST: "an SSE endpoint + event fan-out + client merge code", GraphQL: "a Subscription type + resolver + async iterator + client merge code", Rayfold: "`live: true` on the existing query; server diffs, client cache patched", note: "Rayfold: the subscription reuses shape, policies and cache" });
  });
});

describe("10. Evolution and safety tooling", () => {
  it("removing a field: three removals judged by each stack's own tooling; only Rayfold decides all three right", async () => {
    // The three cases: a removal nobody announced, one announced with a sunset still ahead, one whose sunset has passed.
    // Right answers: block, block, allow.
    const now = new Date("2026-09-10");
    const rayfoldText = bookstoreSchemaText();
    const rayfoldWithout = rayfoldText.replace("  body: String\n", "");
    const rayfoldBefore = (sunset?: string) => (sunset ? rayfoldText.replace("  body: String\n", `  body: String @deprecated(sunset: "${sunset}")\n`) : rayfoldText);
    const rayfoldCheck = (before: string) => diffSchemas(loadSchema(before).ir, loadSchema(rayfoldWithout).ir, { now }).filter((c) => c.at === "Review.body");
    const rayfold3 = [rayfoldCheck(rayfoldBefore()), rayfoldCheck(rayfoldBefore("2027-01-01")), rayfoldCheck(rayfoldBefore("2026-01-01"))];
    expect(rayfold3.map((cs) => cs.map((c) => `${c.level}:${c.code}`))).toEqual([["breaking:field-removed"], ["breaking:field-removed"], ["compatible:field-removed-after-sunset"]]);

    // GraphQL: graphql-js ships findBreakingChanges; @deprecated carries a reason but no date.
    const gqlWithout = GRAPHQL_SDL.replace("rating: Int! body: String! reviewerId", "rating: Int! reviewerId");
    const gqlBefore = (reason?: string) => (reason ? GRAPHQL_SDL.replace("body: String! reviewerId", `body: String! @deprecated(reason: "${reason}") reviewerId`) : GRAPHQL_SDL);
    const gqlCheck = (before: string) => findBreakingChanges(buildSchema(before), buildSchema(gqlWithout)).filter((c) => c.type === BreakingChangeType.FIELD_REMOVED && /\bReview\.body\b/.test(c.description));
    const gql3 = [gqlCheck(gqlBefore()), gqlCheck(gqlBefore("sunset 2027-01-01")), gqlCheck(gqlBefore("sunset 2026-01-01"))];
    expect(gql3.map((cs) => cs.length)).toEqual([1, 1, 1]);
    recorder.label("what a client or a tool can learn about Review.body");
    const intro = await gqlCall(`{ __type(name: "Review") { fields(includeDeprecated: true) { name isDeprecated deprecationReason } } }`);
    expect(intro.body.data?.["__type"]).toMatchObject({ fields: expect.arrayContaining([{ name: "body", isDeprecated: false, deprecationReason: null }]) });

    // REST: the published contract is the only thing a tool could diff.
    recorder.label("the published contract a diff tool would compare");
    const restContract = JSON.stringify(await (await fetch(`${rest.base}/openapi.json`)).json());
    const restSeesField = restContract.includes("body");
    expect(restSeesField).toBe(false);

    const right = (blocks: boolean[]) => Number(blocks[0]) + Number(blocks[1]) + Number(!blocks[2]);
    const values = {
      REST: right([restSeesField, restSeesField, restSeesField]),
      GraphQL: right(gql3.map((cs) => cs.length > 0)),
      Rayfold: right(rayfold3.map((cs) => cs.some((c) => c.level === "breaking"))),
    };
    const rayfoldOut = rayfold3.map((cs) => cs.map((c) => `${c.level}:${c.code}`).join(", "));
    report.add({
      aspect: "Removing a field",
      values,
      unit: "removals decided right, of 3 (unannounced, before sunset, after sunset)",
      better: "higher",
      metric: "what the tooling decides",
      REST: "no field-level contract to diff: every removal ships, announced or not",
      GraphQL: "graphql-js findBreakingChanges flags every removal; @deprecated has no date, so a finished deprecation is flagged too",
      Rayfold: "`rayfold check` blocks unannounced and early removals and allows them after @deprecated(sunset:)",
      note: `Removing Review.body. rayfold check: ${rayfoldOut.join(" / ")}. graphql-js: "${gql3[0]![0]!.description}" in all three cases.`,
    });
  });

  it("query cost and depth are bounded by Rayfold before execution", async () => {
    reset();
    const nested = (first: number) => `{ items { id author { books(page: { first: ${first} }) { items { id author { books(page: { first: ${first} }) { items { id } } } } } } } }`;
    const y = await rayfoldCall([{ id: 1, op: "books", args: { page: { first: 200 } }, shape: nested(200) }]);
    expect(y.frames).toEqual([{ error: { code: "resource_exhausted", message: "Batch cost 8160806 exceeds budget 1000", data: { cost: 8160806, budget: 1000 } }, fin: true }]);
    expect(rayfold.store.calls).toEqual({}); // no loader ran
    // guard: the same nesting with pages of two fits the budget and runs
    const author = (books: string[], nextLevel?: Obj) => ({ $type: "Author", books: { items: books.map((id) => ({ $type: "Book", id, ...(nextLevel ? { author: nextLevel } : {}) })) } });
    const fits = await rayfoldCall([{ id: 1, op: "books", args: { page: { first: 2 } }, shape: nested(2) }]);
    expect(fits.frames).toEqual([{ id: 1, data: { items: [{ $type: "Book", id: "b1", author: author(["b1", "b26"], author(["b1", "b26"])) }, { $type: "Book", id: "b10", author: author(["b10", "b34"], author(["b10", "b34"])) }] }, meta: { cost: 38 }, fin: true }]);
    // the second level meets the same two authors, whose books this batch already loaded
    expect(rayfold.store.calls).toEqual({ "Query.books": 1, "Book.author": 2, "Author.books": 1 });

    reset();
    const levels = (n: number) => "{ items { id " + "author { books(page: { first: 1 }) { items { id ".repeat(n) + "} } } ".repeat(n) + "} }";
    const deep = await rayfoldCall([{ id: 1, op: "books", args: { page: { first: 1 } }, shape: levels(3) }]);
    expect(deep.frames).toEqual([{ id: 1, error: { code: "resource_exhausted", message: "Shape depth 11 exceeds 8" }, fin: true }]);
    expect(rayfold.store.calls).toEqual({});
    // guard: two levels are depth 8, the limit itself
    const atLimit = await rayfoldCall([{ id: 1, op: "books", args: { page: { first: 1 } }, shape: levels(2) }]);
    expect(atLimit.frames).toEqual([{ id: 1, data: { items: [{ $type: "Book", id: "b1", author: author(["b1"], author(["b1"])) }] }, meta: { cost: 15 }, fin: true }]);
    expect(rayfold.store.calls).toEqual({ "Query.books": 1, "Book.author": 1, "Author.books": 1 });

    const g = await gqlCall(`{ books(first: 200) { items { id author { name } } } }`);
    expect(g.status).toBe(200);
    expect((g.body.data!["books"] as { items: unknown[] }).items).toHaveLength(36);
    expect(gql.counters.loaderCalls).toEqual({ author: 1 }); // it ran; nothing weighed it first
    report.add({ aspect: "Abusive query (200 x 200 x 200 nested)", values: { REST: 0, GraphQL: 0, Rayfold: 1 }, unit: "rejected before execution (1 = yes)", better: "higher", metric: "rejected before execution?", REST: "n/a (no query language)", GraphQL: "no, unless a cost plugin is added", Rayfold: "yes: static cost vs budget, from @cost and page sizes" });
  });
});

describe("11. Agent access", () => {
  it("Rayfold is an MCP server out of the box; REST needs an OpenAPI adapter; GraphQL needs introspection-to-tools glue", async () => {
    const openapi = await (await fetch(`${rest.base}/openapi.json`)).json();
    expect(Object.keys(openapi.paths)).toContain("/orders");
    const intro = await gqlCall(`{ __schema { mutationType { fields { name } } } }`);
    expect((intro.body.data!["__schema"] as { mutationType: { fields: Array<{ name: string }> } }).mutationType.fields.map((f) => f.name)).toContain("placeOrder");
    const tools = await (await jsonPost(`${rayfold.base}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
    const names = tools.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("placeOrder");
    expect(names).toContain("placeOrder.simulate");
    const sim = await (await jsonPost(`${rayfold.base}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "placeOrder.simulate", arguments: { input: { lines: [{ bookId: "b3", qty: 1 }] } } } }, U1)).json();
    expect(sim.result.structuredContent.result.status).toBe("PLACED");
    report.add({ aspect: "Exposing the API to an AI agent", values: { REST: 2, GraphQL: 2, Rayfold: 0 }, unit: "extra components to build", better: "lower", metric: "extra work for tools with typed input/output", REST: "hand-written OpenAPI + adapter; no dry-run", GraphQL: "introspection + custom glue; no dry-run", Rayfold: "none: /mcp lists tools with JSON Schema, `.simulate` dry-runs, typed errors" });
  });
});

describe("12. Incremental delivery and streaming", () => {
  it("a slow field (the author's bio on the Beloved page): Rayfold sends the rest first and the bio later in the same response", async () => {
    const BIO = "Nobel laureate in Literature, 1993.";
    recorder.label("the book, with the author only as an id");
    const restBook = (await (await fetch(`${rest.base}/books/b5`)).json()) as Record<string, unknown>;
    expect(restBook).toMatchObject({ title: "Beloved", authorId: "a4" });
    expect(restBook).not.toHaveProperty("author"); // so the name and the slow bio need a second request
    recorder.label("a second request for the author and the slow bio");
    const restAuthor = await (await fetch(`${rest.base}/authors/${String(restBook["authorId"])}`)).json();
    expect(restAuthor).toEqual({ id: "a4", name: "Toni Morrison", bio: BIO });

    recorder.label("one query: the whole body waits for the bio");
    const gRes = await jsonPost(`${gql.base}/graphql`, { query: `{ book(id: "b5") { title author { name bio } } }` });
    const gParts = (gRes.headers.get("content-type") ?? "").startsWith("multipart/mixed") ? 2 : 1;
    expect((await gRes.json()).data.book).toEqual({ title: "Beloved", author: { name: "Toni Morrison", bio: BIO } });

    recorder.label("one request: the page first, the lazy bio in a later frame");
    const y = await rayfoldCall([{ id: 1, op: "book", args: { id: "b5" }, shape: "{ title author { name bio } }" }]);
    expect(y.frames[0]).toMatchObject({ id: 1, data: { $type: "Book", title: "Beloved", author: { $type: "Author", name: "Toni Morrison" } } });
    expect((y.frames[0]!["data"] as { author: object }).author).not.toHaveProperty("bio");
    expect(y.frames.slice(1)).toEqual([{ id: 1, at: "author", data: { bio: BIO } }, { id: 1, fin: true }]);

    // 1 when the fast part and the slow field travel in separate parts of one response
    const laterInSameResponse = (requests: number, parts: number) => (requests === 1 && parts > 1 ? 1 : 0);
    report.add({
      aspect: "Deferring a slow field",
      values: { REST: laterInSameResponse(2, 1), GraphQL: laterInSameResponse(1, gParts), Rayfold: laterInSameResponse(1, y.frames.filter((f) => "data" in f).length) },
      unit: "slow field sent later in the same response (1 = yes)",
      better: "higher",
      metric: "mechanism",
      REST: "the book carries only authorId; the bio takes a second request to /authors/a4",
      GraphQL: `one JSON body: the whole page waits for the bio (@defer is not in graphql-js ${GRAPHQL_MAJOR})`,
      Rayfold: "`@lazy` bio arrives in a later frame at path `author`, same request",
    });
  });
});
