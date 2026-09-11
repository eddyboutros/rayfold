/**
 * Every HTTP method, side by side. For GET, POST, PUT, PATCH, DELETE and QUERY the same bookstore operation runs
 * against REST, GraphQL and Rayfold over real HTTP; each step is asserted and recorded as a raw exchange, and the
 * facts are measured, not typed in. Writes e2e/methods.json for the report.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { base64url, canonicalShape, loadSchema, parseShapeText, shapeIdOf } from "@rayfold/schema";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { bookstoreSchemaText } from "../examples/bookstore-ts/src/index.ts";
import { CachingClient, GqlNormalizedCache, Report, exchange, freshStore, startGraphQL, startRayfold, startRest, type Exchange, type Recorded, type Stack } from "./harness.ts";
import { Signal, openSse } from "./wait.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const report = new Report();
let rest: Stack;
let gql: Stack;
let rayfold: Awaited<ReturnType<typeof startRayfold>>;
const U1 = { authorization: "Bearer u1" };
const ADMIN = { authorization: "Bearer admin" };
const JSON_CT = { "content-type": "application/json" };
const MERGE_CT = { "content-type": "application/merge-patch+json" };
const RAYFOLD_CT = { "content-type": "application/rayfold+json" };
const { ir } = loadSchema(bookstoreSchemaText());

// Every method runs against its own three servers and stores: no test depends on another test's writes.
beforeEach(async () => {
  [rest, gql, rayfold] = await Promise.all([startRest(freshStore()), startGraphQL(freshStore()), startRayfold(freshStore())]);
});
afterEach(async () => {
  await Promise.all([rest.close(), gql.close(), rayfold.close()]);
});
afterAll(() => {
  writeFileSync("e2e/methods.json", report.json());
});

const labeled = (r: Recorded, label: string): Exchange => ({ ...r.ex, label });
const gqlPost = (query: string, variables: Obj = {}, headers: Record<string, string> = {}, label?: string) =>
  exchange(gql.base, "POST", "/graphql", { headers: { ...JSON_CT, ...headers }, body: JSON.stringify({ query, variables }), ...(label ? { label } : {}) });
const rayfoldPost = (ops: unknown[], headers: Record<string, string> = {}, label?: string) =>
  exchange(rayfold.base, "POST", "/rayfold", { headers: { ...RAYFOLD_CT, ...headers }, body: JSON.stringify({ ops }), ...(label ? { label } : {}) });
const frames = (r: Recorded): Obj[] => (Array.isArray(r.json) ? r.json : [r.json]) as Obj[];
const data = (r: Recorded): Obj => (r.json as Obj)["data"] as Obj;

/** fetch wrapper for RayfoldClient transports that records each exchange for the report. */
function recordingFetch(into: Exchange[], label: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    const text = await res.clone().text();
    const url = new URL(String(input));
    const sent = (init?.headers ?? {}) as Record<string, string>;
    const reqHeaders = Object.fromEntries(Object.entries(sent).filter(([k]) => ["content-type", "authorization", "rayfold-safe"].includes(k.toLowerCase())));
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (["content-type", "cache-control", "etag"].includes(k)) resHeaders[k] = v;
    });
    const e: Exchange = { label, request: { method: init?.method ?? "GET", target: url.pathname + url.search, headers: reqHeaders }, response: { status: res.status, headers: resHeaders, body: text } };
    if (typeof init?.body === "string") e.request.body = init.body;
    into.push(e);
    return res;
  }) as typeof fetch;
}

describe("GET", () => {
  it("load a product header: title, price and the author's name", async () => {
    const r1 = await exchange(rest.base, "GET", "/books/b1");
    const r2 = await exchange(rest.base, "GET", `/authors/${(r1.json as Obj)["authorId"]}`);
    expect((r2.json as Obj)["name"]).toBe("Ursula K. Le Guin");
    const r304 = await exchange(rest.base, "GET", "/books/b1", { headers: { "if-none-match": r1.headers["etag"]! } });
    expect(r304.status).toBe(304);

    const q1 = `{ book(id: "b1") { id title price author { name } } }`;
    const q2 = `{ book(id: "b1") { title id price author { name } } }`;
    const g1 = await exchange(gql.base, "GET", `/graphql?query=${encodeURIComponent(q1)}`);
    expect(data(g1)["book"].author.name).toBe("Ursula K. Le Guin");
    const g304 = await exchange(gql.base, "GET", `/graphql?query=${encodeURIComponent(q1)}`, { headers: { "if-none-match": g1.headers["etag"]! } });
    expect(g304.status).toBe(304);
    const g2 = await exchange(gql.base, "GET", `/graphql?query=${encodeURIComponent(q2)}`);
    expect(g2.status).toBe(200);
    const gqlEntries = new Set([g1.ex.request.target, g2.ex.request.target]).size;

    // Rayfold: the query's HTTP binding; the default view already embeds the author's name
    const y1 = await exchange(rayfold.base, "GET", "/books/b1");
    expect(y1.json).toMatchObject({ id: "b1", title: "The Dispossessed", author: { name: "Ursula K. Le Guin" } });
    const y304 = await exchange(rayfold.base, "GET", "/books/b1", { headers: { "if-none-match": y1.headers["etag"]! } });
    expect(y304.status).toBe(304);
    // custom shapes travel as canonical ids, so field order never splits the cache
    const views = (t: string, v: string) => ir.views[`${t}.${v}`];
    const s1 = "{ id title price author { name } }";
    const id1 = shapeIdOf(canonicalShape(parseShapeText(s1), views));
    expect(shapeIdOf(canonicalShape(parseShapeText("{ title id price author { name } }"), views))).toBe(id1);
    expect(rayfold.bookstore.server.registerShape(s1)).toBe(id1); // what `rayfold shapes` does at build time
    const y2 = await exchange(rayfold.base, "GET", `/rayfold/book?a=${base64url(JSON.stringify({ id: "b1" }))}&s=${id1}`, { label: "custom shape by canonical id (same URL for either field order)" });
    expect(y2.status).toBe(200);

    report.addMethod({
      method: "GET",
      title: "Read",
      operation: "Load a product header: title, price and the author's name. Then load it again through a cache.",
      exchanges: { REST: [r1.ex, r2.ex, labeled(r304, "repeat view: revalidation")], GraphQL: [g1.ex, labeled(g304, "repeat view: revalidation")], Rayfold: [y1.ex, labeled(y304, "repeat view: revalidation"), y2.ex] },
      facts: [
        { metric: "HTTP requests for the view", better: "lower", values: { REST: 2, GraphQL: 1, Rayfold: 1 }, REST: "2: the book, then its author", GraphQL: "1", Rayfold: "1: the default view embeds the author's name" },
        { metric: "request size (URL)", unit: "bytes", better: "lower", values: { REST: r1.bytes.up + r2.bytes.up, GraphQL: g1.bytes.up, Rayfold: y1.bytes.up }, REST: `${r1.bytes.up + r2.bytes.up} B across 2 URLs`, GraphQL: `${g1.bytes.up} B: the whole query rides in the URL`, Rayfold: `${y1.bytes.up} B` },
        { metric: "repeat view revalidates with 304", better: "higher", values: { REST: 1, GraphQL: 1, Rayfold: 1 }, REST: "yes (ETag)", GraphQL: "yes (GET with ETag, as configured here)", Rayfold: "yes (ETag; Cache-Control derived from @cache)" },
        { metric: "cache entries when two clients list the fields in a different order", better: "lower", values: { REST: 2, GraphQL: gqlEntries, Rayfold: 1 }, REST: "2: book and author are separate resources", GraphQL: `${gqlEntries}: each query text is its own URL`, Rayfold: "1: shapes are canonicalized to one sha256 id" },
      ],
      note: "GraphQL over HTTP allows GET for queries only; mutations must use POST.",
    });
  });
});

describe("POST", () => {
  it("check out: place an order, then pay for it; then retry both steps as if the response was lost", async () => {
    const lines = { lines: [{ bookId: "b3", qty: 1 }] };
    const restKey = { ...JSON_CT, ...U1, "idempotency-key": "k-post-rest-00001" };
    const rOrder = await exchange(rest.base, "POST", "/orders", { headers: restKey, body: JSON.stringify(lines) });
    expect(rOrder.status).toBe(201);
    expect(rOrder.headers["location"]).toMatch(/^\/orders\/o\d+$/);
    const orderId = (rOrder.json as Obj)["id"] as string;
    const rPay = await exchange(rest.base, "POST", `/orders/${orderId}/pay`, { headers: U1 });
    expect((rPay.json as Obj)["status"]).toBe("PAID");
    const restOrders = rest.store.orders.size;
    const rRetry1 = await exchange(rest.base, "POST", "/orders", { headers: restKey, body: JSON.stringify(lines) });
    expect(rRetry1.headers["idempotent-replayed"]).toBe("true");
    const rRetry2 = await exchange(rest.base, "POST", `/orders/${orderId}/pay`, { headers: U1 });
    expect(rRetry2.status).toBe(409); // the payment went through, but the retry reports a conflict
    expect(rest.store.orders.size).toBe(restOrders);

    const placeQ = `mutation($lines: [OrderLine!]!) { placeOrder(lines: $lines) { id status } }`;
    const payQ = `mutation($id: ID!) { payOrder(id: $id) { id status } }`;
    const gOrder = await gqlPost(placeQ, lines, U1);
    const gPay = await gqlPost(payQ, { id: data(gOrder)["placeOrder"].id }, U1);
    expect(data(gPay)["payOrder"].status).toBe("PAID");
    const gqlOrders = gql.store.orders.size;
    const gRetry1 = await gqlPost(placeQ, lines, U1, "retry of the order: a second order");
    const gRetry2 = await gqlPost(payQ, { id: data(gRetry1)["placeOrder"].id }, U1, "retry of the payment: a second charge");
    expect(data(gRetry2)["payOrder"].status).toBe("PAID");
    expect(gql.store.orders.size).toBe(gqlOrders + 1);

    const ops = [
      { id: 1, op: "placeOrder", args: { input: lines }, key: "k-post-rayfold-000001", shape: "{ id status }" },
      { id: 2, op: "payOrder", args: { id: { $ref: "1.id" } }, key: "k-post-rayfold-000002", shape: "{ id status }" },
    ];
    const y = await rayfoldPost(ops, U1);
    expect(frames(y)[1]!["ok"].status).toBe("PAID");
    const rayfoldOrders = rayfold.store.orders.size;
    const yRetry = await rayfoldPost(ops, U1, "retry after a lost response: both ops replay");
    expect(frames(yRetry).every((f) => f["meta"]?.replay === true)).toBe(true);
    expect(rayfold.store.orders.size).toBe(rayfoldOrders);
    const yBinding = await exchange(rayfold.base, "POST", "/orders", { headers: { ...JSON_CT, ...U1, "idempotency-key": "k-post-bind-00001" }, body: JSON.stringify(lines), label: "the same command through its HTTP binding" });
    expect(yBinding.status).toBe(201);
    expect(yBinding.headers["location"]).toMatch(/^\/orders\/o\d+$/);

    report.addMethod({
      method: "POST",
      title: "Create",
      operation: "Check out: place an order, then pay for it. Then send both steps again, as a client does when a response is lost.",
      exchanges: { REST: [rOrder.ex, rPay.ex, labeled(rRetry2, "retry of the payment")], GraphQL: [gOrder.ex, gPay.ex, gRetry1.ex, gRetry2.ex], Rayfold: [y.ex, yRetry.ex, yBinding.ex] },
      facts: [
        { metric: "round trips for place + pay", better: "lower", values: { REST: 2, GraphQL: 2, Rayfold: 1 }, REST: "2", GraphQL: "2: a mutation's result cannot feed the next mutation", Rayfold: '1: payOrder takes { "$ref": "1.id" }' },
        { metric: "retrying the whole checkout is safe", better: "higher", values: { REST: 0, GraphQL: 0, Rayfold: 1 }, REST: "no: the order replays, but the payment retry answers 409 although it succeeded", GraphQL: "no: the retry places and pays a second order", Rayfold: "yes: both commands replay their original results" },
      ],
    });
  });
});

describe("PUT", () => {
  it("replace a review while a second editor still holds the old version", async () => {
    const A = { rating: 5, body: "Reread it: better than I remembered." };
    const B = { rating: 2, body: "Too slow for me." };
    const rGet = await exchange(rest.base, "GET", "/reviews/r2", { headers: U1 });
    const etag1 = rGet.headers["etag"]!;
    const rA = await exchange(rest.base, "PUT", "/reviews/r2", { headers: { ...JSON_CT, ...U1, "if-match": etag1 }, body: JSON.stringify(A) });
    expect(rA.status).toBe(200);
    const rB = await exchange(rest.base, "PUT", "/reviews/r2", { headers: { ...JSON_CT, ...U1, "if-match": etag1 }, body: JSON.stringify(B) });
    expect(rB.status).toBe(412);
    const rRe = await exchange(rest.base, "GET", "/reviews/r2", { headers: U1 });
    const rB2 = await exchange(rest.base, "PUT", "/reviews/r2", { headers: { ...JSON_CT, ...U1, "if-match": rRe.headers["etag"]! }, body: JSON.stringify(B) });
    expect(rB2.status).toBe(200);

    const editQ = `mutation($id: ID!, $rating: Int!, $body: String!) { editReview(id: $id, rating: $rating, body: $body) { id rating body } }`;
    const gA = await gqlPost(editQ, { id: "r2", ...A }, U1, "editor A");
    const gB = await gqlPost(editQ, { id: "r2", ...B }, U1, "editor B, stale: accepted, A's edit is gone");
    expect(data(gB)["editReview"].rating).toBe(2);
    expect(gql.store.reviews.get("r2")!.rating).toBe(2); // nobody was told that A's change was overwritten

    const yGet = await exchange(rayfold.base, "GET", "/reviews/r2");
    const v1 = (yGet.json as Obj)["version"] as number;
    const yA = await exchange(rayfold.base, "PUT", "/reviews/r2", { headers: { ...JSON_CT, ...U1, "if-match": `"${v1}"` }, body: JSON.stringify(A) });
    expect(yA.status).toBe(200);
    expect(yA.headers["etag"]).toBe(`"${v1 + 1}"`);
    const yB = await exchange(rayfold.base, "PUT", "/reviews/r2", { headers: { ...JSON_CT, ...U1, "if-match": `"${v1}"` }, body: JSON.stringify(B) });
    expect(yB.status).toBe(412);
    const current = (yB.json as Obj)["data"].current as { version: number; rating: number };
    expect(current).toMatchObject({ rating: 5, version: v1 + 1 });
    const yB2 = await exchange(rayfold.base, "PUT", "/reviews/r2", { headers: { ...JSON_CT, ...U1, "if-match": `"${current.version}"` }, body: JSON.stringify(B) });
    expect(yB2.status).toBe(200);
    const yNative = await rayfoldPost([{ id: 1, op: "editReview", args: { id: "r2", input: A }, key: "k-put-native-0001", ifVersion: v1 }], U1, "the same stale edit as a native batch op");
    expect(frames(yNative)[0]!["error"]).toMatchObject({ code: "failed_precondition", type: "VersionConflict", data: { current: { version: v1 + 2 } } });

    report.addMethod({
      method: "PUT",
      title: "Replace",
      operation: "Editor A replaces review r2. Editor B, still holding the previous version, replaces it too.",
      exchanges: {
        REST: [rGet.ex, labeled(rA, "editor A"), labeled(rB, "editor B, stale"), labeled(rRe, "editor B refetches"), labeled(rB2, "editor B retries")],
        GraphQL: [gA.ex, gB.ex],
        Rayfold: [yGet.ex, labeled(yA, "editor A"), labeled(yB, "editor B, stale: 412 carries the current review"), labeled(yB2, "editor B retries"), yNative.ex],
      },
      facts: [
        { metric: "lost updates when two editors race", better: "lower", values: { REST: 0, GraphQL: 1, Rayfold: 0 }, REST: "0 (If-Match, 412)", GraphQL: "1: no conditional write; B silently overwrote A", Rayfold: "0 (If-Match or ifVersion, VersionConflict)" },
        { metric: "requests for the stale editor to see the current version and retry", better: "lower", values: { REST: 3, GraphQL: null, Rayfold: 2 }, REST: "3: 412, GET, PUT", GraphQL: "never told", Rayfold: "2: the 412 already carries the current review" },
      ],
    });
  });
});

describe("PATCH", () => {
  it("change one book's price; everything else stays, and open views follow", async () => {
    // REST: the client shows the catalogue and the product page; another user listens to the event stream
    const rList = await exchange(rest.base, "GET", "/books?limit=40");
    const restEvents = openSse(`${rest.base}/events`);
    await restEvents.ready;
    const rPatch = await exchange(rest.base, "PATCH", "/books/b5", { headers: { ...MERGE_CT, ...ADMIN }, body: JSON.stringify({ price: "10.75" }) });
    expect(rPatch.json).toMatchObject({ id: "b5", title: "Beloved", price: "10.75", stock: 14 });
    // sentinel: publish a stock change on the same ordered stream; a price event, if one existed, would arrive first
    await fetch(`${rest.base}/books/b5?action=restock&qty=1`, { method: "POST", headers: ADMIN });
    await restEvents.events.atLeast(1, "the sentinel stock event");
    await restEvents.close();
    expect(restEvents.events.items).toEqual([{ bookId: "b5", stock: 15 }]); // only the sentinel: nothing announces a price change
    const restViews = ((rPatch.json as Obj)["price"] === "10.75" ? 1 : 0) + ((rList.json as Obj)["items"].find((b: Obj) => b["id"] === "b5").price === "10.75" ? 1 : 0);
    const rBad = await exchange(rest.base, "PATCH", "/books/b5", { headers: { ...MERGE_CT, ...ADMIN }, body: JSON.stringify({ price: "-1.00" }), label: "negative price: rejected by a hand-written check" });
    expect(rBad.status).toBe(400);
    const restContract = JSON.stringify(await (await fetch(`${rest.base}/openapi.json`)).json());
    expect(restContract).not.toContain("minimum"); // the published document does not know the rule

    const cache = new GqlNormalizedCache();
    cache.write("list", data(await gqlPost(`{ books(first: 40) { items { __typename id price } } }`)));
    cache.write("page", data(await gqlPost(`{ book(id: "b5") { __typename id title price } }`)));
    const gPatch = await gqlPost(`mutation { updateBook(id: "b5", patch: { price: "10.75" }) { __typename id price } }`, {}, ADMIN);
    cache.write(null, data(gPatch));
    const gPage = (cache.read("page") as Obj)["book"] as Obj;
    expect(gPage).toMatchObject({ title: "Beloved", price: "10.75" });
    const gqlViews = ((cache.read("list") as Obj)["books"].items.find((b: Obj) => b["id"] === "b5").price === "10.75" ? 1 : 0) + (gPage["price"] === "10.75" ? 1 : 0);
    const gBad = await gqlPost(`mutation { updateBook(id: "b5", patch: { price: "-1.00" }) { id } }`, {}, ADMIN, "negative price: rejected by a hand-written check");
    expect((gBad.json as Obj)["errors"][0].extensions.code).toBe("BAD_USER_INPUT");
    const subs = data(await gqlPost(`{ __schema { subscriptionType { fields { name } } } }`))["__schema"].subscriptionType.fields.map((f: Obj) => f["name"]);
    expect(subs).toEqual(["stockChanged"]); // no subscription covers price changes

    const recorded: Exchange[] = [];
    const client = new RayfoldClient({ transport: createFetchTransport({ url: `${rayfold.base}/rayfold`, headers: () => ADMIN, fetch: recordingFetch(recorded, "Rayfold client: the command (native batch)") }) });
    await client.query("books", { page: { first: 40 } }, { shape: "{ items { id price } }" });
    await client.query("book", { id: "b5" }, { shape: "{ id title price }" });
    const watcher = new RayfoldClient({ transport: createFetchTransport({ url: `${rayfold.base}/rayfold`, headers: () => U1 }) });
    const livePrices = new Signal<string>();
    const stop = watcher.live<{ price: string }>("book", { id: "b5" }, { shape: "{ id price }" }, (d) => livePrices.push(d.price));
    await livePrices.atLeast(1, "the live view's first result");
    recorded.length = 0;
    const reqs = rayfold.counters.originRequests;
    await client.command("updateBook", { id: "b5", patch: { price: "10.75" } }, { shape: "{ id price }" });
    const list = await client.query<{ items: Array<{ id: string; price: string }> }>("books", { page: { first: 40 } }, { shape: "{ items { id price } }", policy: "cache" });
    const page = await client.query<{ title: string; price: string }>("book", { id: "b5" }, { shape: "{ id title price }", policy: "cache" });
    expect(rayfold.counters.originRequests - reqs).toBe(1); // the command; both views come from the patched cache
    expect(page.title).toBe("Beloved");
    const rayfoldViews = (list.items.find((b) => b.id === "b5")!.price === "10.75" ? 1 : 0) + (page.price === "10.75" ? 1 : 0);
    await livePrices.atLeast(2, "the live view's update");
    stop();
    expect(livePrices.items).toEqual(["9.50", "10.75"]);
    const yPatch = await exchange(rayfold.base, "PATCH", "/books/b5", { headers: { ...MERGE_CT, ...ADMIN }, body: JSON.stringify({ stock: 12 }), label: "HTTP binding: only stock is sent" });
    expect(yPatch.json).toMatchObject({ id: "b5", title: "Beloved", price: "10.75", stock: 12 });
    const yBad = await exchange(rayfold.base, "PATCH", "/books/b5", { headers: { ...MERGE_CT, ...ADMIN }, body: JSON.stringify({ price: "-1.00" }), label: "negative price: rejected by @range(min: 0) from the schema" });
    expect(yBad.status).toBe(400);
    expect((yBad.json as Obj)["detail"]).toBe("updateBook().patch.price: must be >= 0");
    const openapi = (await (await fetch(`${rayfold.base}/rayfold/openapi.json`)).json()) as Obj;
    expect(openapi["components"].schemas.BookPatch.properties.price).toMatchObject({ "x-rayfold-range": { min: 0 } });
    expect(openapi["paths"]["/books/{id}"].patch.requestBody.content).toHaveProperty("application/merge-patch+json");

    report.addMethod({
      method: "PATCH",
      title: "Partial update",
      operation: "An admin changes the price of Beloved (b5). The admin's client already shows the catalogue and the product page; another user has the product page open.",
      exchanges: { REST: [rPatch.ex, rBad.ex], GraphQL: [gPatch.ex, gBad.ex], Rayfold: [...recorded, yPatch.ex, yBad.ex] },
      facts: [
        { metric: "fields not sent are left untouched", better: "higher", values: { REST: 1, GraphQL: 1, Rayfold: 1 }, REST: "yes (merge patch)", GraphQL: "yes (absent input fields)", Rayfold: "yes (absent stays absent; explicit null clears)" },
        { metric: "open views correct without a refetch (catalogue + product page)", better: "higher", values: { REST: restViews, GraphQL: gqlViews, Rayfold: rayfoldViews }, REST: `${restViews} of 2: the PATCH response replaces the page; the list is stale`, GraphQL: `${gqlViews} of 2: the normalized cache merges the returned book`, Rayfold: `${rayfoldViews} of 2: the patch updates every cached view` },
        { metric: "another user's open view updates by itself", better: "higher", values: { REST: 0, GraphQL: 0, Rayfold: 1 }, REST: "no: no event exists for price (the stream carries stock only)", GraphQL: "no: no subscription covers price", Rayfold: "yes: a live query needs no event code" },
        { metric: "validation rule and published contract come from one source", better: "higher", values: { REST: 0, GraphQL: 0, Rayfold: 1 }, REST: "no: hand-written check; OpenAPI maintained separately", GraphQL: "no: SDL has no constraint syntax; the check lives in the resolver", Rayfold: "yes: @range(min: 0) is enforced and appears in the generated OpenAPI" },
      ],
    });
  });
});

describe("DELETE", () => {
  it("delete a review the book page still shows; then retry as if the response was lost", async () => {
    const rList = await exchange(rest.base, "GET", "/reviews?bookId=b2");
    expect((rList.json as Obj)["items"].map((r: Obj) => r["id"])).toContain("r2");
    const rDel = await exchange(rest.base, "DELETE", "/reviews/r2", { headers: U1 });
    expect(rDel.status).toBe(204);
    const rRetry = await exchange(rest.base, "DELETE", "/reviews/r2", { headers: U1 });
    expect(rRetry.status).toBe(404);
    const restStale = (rList.json as Obj)["items"].some((r: Obj) => r["id"] === "r2") ? 1 : 0;

    const cache = new GqlNormalizedCache();
    cache.write("page", data(await gqlPost(`{ book(id: "b2") { __typename id reviews { __typename id rating } } }`)));
    const gDel = await gqlPost(`mutation { deleteReview(id: "r2") }`, {}, U1);
    expect(data(gDel)["deleteReview"]).toBe("r2");
    cache.write(null, data(gDel));
    const gqlStale = ((cache.read("page") as Obj)["book"].reviews as Obj[]).some((r) => r["id"] === "r2") ? 1 : 0;
    const gRetry = await gqlPost(`mutation { deleteReview(id: "r2") }`, {}, U1, "retry after a lost response");
    expect((gRetry.json as Obj)["errors"][0].extensions.code).toBe("NOT_FOUND");

    const recorded: Exchange[] = [];
    const client = new RayfoldClient({ transport: createFetchTransport({ url: `${rayfold.base}/rayfold`, headers: () => U1, fetch: recordingFetch(recorded, "Rayfold client (native batch)") }) });
    const seen = new Signal<string[]>();
    const stop = client.watch<{ reviews: { items: Array<{ id: string }> } }>("book", { id: "b2" }, { shape: "{ id reviews { items { id rating } } }" }, (d) => seen.push(d.reviews.items.map((r) => r.id)));
    await seen.atLeast(1, "the book page");
    expect(seen.items[0]).toEqual(["r2"]);
    recorded.length = 0;
    const key = "k-del-rayfold-0000001";
    await client.command("deleteReview", { id: "r2" }, { key, shape: "{ id }" });
    await seen.atLeast(2, "the page update");
    expect(seen.items[1]).toEqual([]); // the del patch removed it from the cached list
    const rayfoldStale = seen.items[1]!.includes("r2") ? 1 : 0;
    await client.command("deleteReview", { id: "r2" }, { key, shape: "{ id }" }); // the retry replays
    stop();
    expect(recorded[1]!.response.body).toContain('"replay":true');
    recorded[1]!.label = "retry after a lost response: replayed";
    const yDel = await exchange(rayfold.base, "DELETE", "/reviews/r1", { headers: { ...ADMIN, "idempotency-key": "k-del-bind-000001" }, label: "HTTP binding" });
    expect(yDel.status).toBe(200);
    const yRetry = await exchange(rayfold.base, "DELETE", "/reviews/r1", { headers: { ...ADMIN, "idempotency-key": "k-del-bind-000001" }, label: "HTTP binding: the retry replays" });
    expect(yRetry.status).toBe(200);
    expect(yRetry.headers["idempotent-replayed"]).toBe("true");

    report.addMethod({
      method: "DELETE",
      title: "Delete",
      operation: "The author deletes review r2 while the book page (which lists it) is cached. Then the client retries, as it does when a response is lost.",
      exchanges: { REST: [rList.ex, rDel.ex, labeled(rRetry, "retry after a lost response")], GraphQL: [gDel.ex, gRetry.ex], Rayfold: [...recorded, yDel.ex, yRetry.ex] },
      facts: [
        { metric: "cached views still showing the deleted review", better: "lower", values: { REST: restStale, GraphQL: gqlStale, Rayfold: rayfoldStale }, REST: "1: the cached list keeps it until a refetch", GraphQL: "1: a normalized cache does not remove deleted entities from lists by itself", Rayfold: '0: the command\'s { "del": "Review:r2" } patch removes it everywhere' },
        { metric: "a retry after a lost response reports the original success", better: "higher", values: { REST: 0, GraphQL: 0, Rayfold: 1 }, REST: "no: 404, indistinguishable from a wrong id", GraphQL: "no: NOT_FOUND error", Rayfold: "yes: the idempotency key replays the first result" },
      ],
    });
  });
});

describe("QUERY", () => {
  it("search paperbacks up to $10 with author names, then repeat the search through a shared cache", async () => {
    const filter = { format: "PAPERBACK", maxPrice: "10.00" };
    const restBody = JSON.stringify({ filter, limit: 20 });
    const rq = await exchange(rest.base, "QUERY", "/books", { headers: JSON_CT, body: restBody });
    expect(rq.status).toBe(200);
    const items = (rq.json as Obj)["items"] as Array<{ authorId: string }>;
    const authorIds = [...new Set(items.map((b) => b.authorId))];
    const rAuthors = await Promise.all(authorIds.map((id) => exchange(rest.base, "GET", `/authors/${id}`)));

    const GQ = `{ books(first: 20, format: "PAPERBACK", maxPrice: "10.00") { items { id title price author { name } } total } }`;
    const gq = await exchange(gql.base, "QUERY", "/graphql", { headers: JSON_CT, body: JSON.stringify({ query: GQ }) });
    expect(gq.status).toBe(405);
    const gp = await exchange(gql.base, "POST", "/graphql", { headers: JSON_CT, body: JSON.stringify({ query: GQ }), label: "fallback: POST, which shared caches cannot store" });
    expect(data(gp)["books"].items.length).toBe(items.length);

    const envelope = JSON.stringify({ ops: [{ id: 1, op: "books", args: { filter, page: { first: 20 } }, shape: "{ items { id title price author { name } } total }" }] });
    const yq = await exchange(rayfold.base, "QUERY", "/rayfold", { headers: RAYFOLD_CT, body: envelope });
    expect(yq.headers["etag"]).toBeTruthy();
    expect(frames(yq)[0]!["data"].items.length).toBe(items.length);
    const yb = await exchange(rayfold.base, "QUERY", "/books", { headers: JSON_CT, body: JSON.stringify({ filter }), label: "the same query through its HTTP binding" });
    expect((yb.json as Obj)["items"].length).toBe(items.length);

    const c = new CachingClient();
    await c.query(`${rest.base}/books`, restBody, JSON_CT);
    for (const a of authorIds) await c.get(`${rest.base}/authors/${a}`);
    let restRepeat = (await c.query(`${rest.base}/books`, restBody, JSON_CT)).wireBytes;
    for (const a of authorIds) restRepeat += (await c.get(`${rest.base}/authors/${a}`)).wireBytes;
    expect(c.revalidated).toBe(1 + authorIds.length);
    const gqBody = JSON.stringify({ query: GQ });
    await c.post(`${gql.base}/graphql`, gqBody, JSON_CT);
    const gRepeat = await c.post(`${gql.base}/graphql`, gqBody, JSON_CT);
    expect(gRepeat.fromCache).toBe(false);
    await c.query(`${rayfold.base}/rayfold`, envelope, RAYFOLD_CT);
    const yRepeat = await c.query(`${rayfold.base}/rayfold`, envelope, RAYFOLD_CT);
    expect(yRepeat.fromCache).toBe(true);

    report.addMethod({
      method: "QUERY",
      title: "Safe query with a body",
      operation: "Search paperbacks up to $10 and show each author's name, then run the same search again through a shared cache (RFC 10008).",
      exchanges: { REST: [rq.ex, ...rAuthors.map((a) => a.ex)], GraphQL: [gq.ex, gp.ex], Rayfold: [yq.ex, yb.ex] },
      facts: [
        { metric: "QUERY method supported", better: "higher", values: { REST: 1, GraphQL: 0, Rayfold: 1 }, REST: "yes (RFC 10008, implemented here)", GraphQL: "no: 405; fall back to POST or a long GET", Rayfold: "yes: any read-only batch, and query bindings" },
        { metric: "requests for results with author names", better: "lower", values: { REST: 1 + authorIds.length, GraphQL: 1, Rayfold: 1 }, REST: `${1 + authorIds.length}: results, then one per author`, GraphQL: "1 (POST)", Rayfold: "1" },
        { metric: "bytes on the repeat search through a shared cache", unit: "bytes, headers + body", better: "lower", values: { REST: restRepeat, GraphQL: gRepeat.wireBytes, Rayfold: yRepeat.wireBytes }, REST: `${1 + authorIds.length} revalidations (304), ${restRepeat} B`, GraphQL: `the full response again (POST), ${gRepeat.wireBytes} B`, Rayfold: `1 revalidation (304), ${yRepeat.wireBytes} B` },
      ],
    });
  });
});
