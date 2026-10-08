/**
 * The comparison harness itself. A Rayfold lead only means something against REST and GraphQL stacks that hold the
 * guards a careful team writes, and the report's exchanges and byte counts only mean something if the harness records
 * and counts them right. Each refusal here sits beside the honest request that still works.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RbCodec } from "@rayfold/rb";
import { loadSchema } from "@rayfold/schema";
import { bookstoreSchemaText } from "../examples/bookstore-ts/src/index.ts";
import { CachingClient, Recorder, Report, exchange, freshStore, startGraphQL, startRayfold, startRest, writeReport, type Stack } from "./harness.ts";
import { bounded, openSse } from "./wait.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const JSON_CT = { "content-type": "application/json" };
const U1 = { authorization: "Bearer u1" };
const U2 = { authorization: "Bearer u2" };
const ADMIN = { authorization: "Bearer admin" };

describe("the REST stack's hand-written guards", () => {
  let rest: Stack;
  beforeEach(async () => {
    rest = await startRest(freshStore());
  });
  afterEach(() => rest.close());
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await fetch(rest.base + path, { method, headers: { ...JSON_CT, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Obj) : null };
  };

  it("costPrice only for the book's owner and admins", async () => {
    expect((await call("GET", "/books/b1", U2)).body!["costPrice"]).toBeUndefined();
    expect((await call("GET", "/books/b1", U1)).body!["costPrice"]).toBe("6.10");
    expect((await call("GET", "/books/b1", ADMIN)).body!["costPrice"]).toBe("6.10");
  });

  it("an order is paid once, by its customer; another customer is told it does not exist", async () => {
    const placed = await call("POST", "/orders", U1, { lines: [{ bookId: "b3", qty: 1 }] });
    const id = placed.body!["id"] as string;
    expect(await call("POST", `/orders/${id}/pay`, U2)).toEqual({ status: 404, body: { error: "not_found" } });
    expect(rest.store.orders.get(id)!.status).toBe("PLACED");
    expect((await call("POST", `/orders/${id}/pay`, U1)).body!["status"]).toBe("PAID");
    expect(await call("POST", `/orders/${id}/pay`, U1)).toEqual({ status: 409, body: { error: "not_payable", status: "PAID" } });
  });

  it("a review is edited within 1..5 and deleted only by its author", async () => {
    expect(await call("PUT", "/reviews/r2", U1, { rating: 0, body: "x" })).toEqual({ status: 400, body: { error: "invalid", field: "rating" } });
    expect(await call("PUT", "/reviews/r2", U1, { rating: 6, body: "x" })).toEqual({ status: 400, body: { error: "invalid", field: "rating" } });
    expect(await call("PUT", "/reviews/r2", U1, { rating: 1, body: "x" })).toMatchObject({ status: 200, body: { id: "r2", rating: 1, body: "x" } });
    expect(await call("DELETE", "/reviews/r2", U2)).toEqual({ status: 403, body: { error: "permission_denied" } });
    expect(rest.store.reviews.has("r2")).toBe(true);
    expect((await call("DELETE", "/reviews/r2", U1)).status).toBe(204);
    expect(rest.store.reviews.has("r2")).toBe(false);
  });

  it("a book patch names known fields and clears none", async () => {
    expect(await call("PATCH", "/books/b5", ADMIN, { colour: "red" })).toEqual({ status: 400, body: { error: "invalid", field: "colour" } });
    expect(await call("PATCH", "/books/b5", ADMIN, { title: null })).toEqual({ status: 400, body: { error: "invalid", field: "title", reason: "cannot be cleared" } });
    expect(rest.store.books.get("b5")).toMatchObject({ title: "Beloved", stock: 14 });
    expect((await call("PATCH", "/books/b5", ADMIN, { stock: 3 })).body).toMatchObject({ id: "b5", title: "Beloved", stock: 3 });
  });

  it("an order and a restock both announce the new stock on the event stream", async () => {
    const sse = openSse(`${rest.base}/events`);
    try {
      await sse.ready;
      await call("POST", "/orders", U1, { lines: [{ bookId: "b1", qty: 2 }] });
      await call("POST", "/books/b1?action=restock&qty=1", ADMIN);
      await sse.events.atLeast(2, "both stock events");
    } finally {
      await sse.close();
    }
    expect(sse.events.items).toEqual([{ bookId: "b1", stock: 3 }, { bookId: "b1", stock: 4 }]);
  });

  it("closing the stack does not wait on an event stream a client left open", async () => {
    const sse = openSse(`${rest.base}/events`);
    await sse.ready;
    await bounded(rest.close(), "the stack closing with a stream open");
    await bounded(sse.close(), "the stream ending");
    rest = await startRest(freshStore()); // afterEach closes one
  });
});

describe("the GraphQL stack's hand-written guards", () => {
  let gql: Stack;
  beforeEach(async () => {
    gql = await startGraphQL(freshStore());
  });
  afterEach(() => gql.close());
  const post = async (query: string, headers: Record<string, string> = {}) => (await (await fetch(`${gql.base}/graphql`, { method: "POST", headers: { ...JSON_CT, ...headers }, body: JSON.stringify({ query }) })).json()) as Obj;
  const codes = (r: Obj) => (r["errors"] as Obj[] | undefined)?.map((e) => e["extensions"]?.code as string) ?? [];

  it("costPrice is null for anyone but the owner and admins", async () => {
    const q = `{ book(id: "b1") { costPrice } }`;
    expect((await post(q, U2))["data"]).toEqual({ book: { costPrice: null } });
    expect((await post(q, U1))["data"]).toEqual({ book: { costPrice: "6.10" } });
    expect((await post(q, ADMIN))["data"]).toEqual({ book: { costPrice: "6.10" } });
  });

  it("GET serves queries, privately when signed in, and refuses mutations", async () => {
    const get = (q: string, headers: Record<string, string> = {}) => fetch(`${gql.base}/graphql?query=${encodeURIComponent(q)}`, { headers });
    const mutation = await get(`mutation { restock(bookId: "b1", qty: 1) { stock } }`, ADMIN);
    expect([mutation.status, mutation.headers.get("allow"), await mutation.json()]).toEqual([405, "POST", { errors: [{ message: "Mutations must use POST" }] }]);
    expect(gql.store.books.get("b1")!.stock).toBe(5);
    const signedIn = await get(`{ book(id: "b1") { id } }`, U1);
    expect([signedIn.status, signedIn.headers.get("cache-control")]).toEqual([200, "private, max-age=60"]);
    const anonymous = await get(`{ book(id: "b1") { id } }`);
    expect([anonymous.status, anonymous.headers.get("cache-control")]).toEqual([200, "public, max-age=60"]);
  });

  it("orders, reviews and books keep the same rules as REST", async () => {
    const id = ((await post(`mutation { placeOrder(lines: [{ bookId: "b3", qty: 1 }]) { id } }`, U1))["data"] as Obj)["placeOrder"].id as string;
    expect(codes(await post(`mutation { payOrder(id: "${id}") { status } }`, U2))).toEqual(["NOT_FOUND"]);
    expect((await post(`mutation { payOrder(id: "${id}") { status } }`, U1))["data"]).toEqual({ payOrder: { status: "PAID" } });
    expect(codes(await post(`mutation { payOrder(id: "${id}") { status } }`, U1))).toEqual(["NOT_PAYABLE"]);

    const edit = (rating: number) => post(`mutation { editReview(id: "r2", rating: ${rating}, body: "x") { rating } }`, U1);
    expect(codes(await edit(0))).toEqual(["BAD_USER_INPUT"]);
    expect(codes(await edit(6))).toEqual(["BAD_USER_INPUT"]);
    expect((await edit(1))["data"]).toEqual({ editReview: { rating: 1 } });
    expect(codes(await post(`mutation { deleteReview(id: "r2") }`, U2))).toEqual(["FORBIDDEN"]);
    expect((await post(`mutation { deleteReview(id: "r2") }`, U1))["data"]).toEqual({ deleteReview: "r2" });

    expect(codes(await post(`mutation { updateBook(id: "b5", patch: { title: null }) { id } }`, ADMIN))).toEqual(["BAD_USER_INPUT"]);
    expect(gql.store.books.get("b5")!.title).toBe("Beloved");
    expect((await post(`mutation { updateBook(id: "b5", patch: { stock: 3 }) { stock } }`, ADMIN))["data"]).toEqual({ updateBook: { stock: 3 } });
  });

  it("a subscription hears only the book it named", async () => {
    const sse = openSse(`${gql.base}/graphql`, { method: "POST", headers: JSON_CT, body: JSON.stringify({ query: `subscription { stockChanged(bookId: "b2") { bookId stock } }` }) });
    try {
      await sse.ready;
      await post(`mutation { restock(bookId: "b1", qty: 1) { stock } }`, ADMIN);
      await post(`mutation { restock(bookId: "b2", qty: 1) { stock } }`, ADMIN);
      await sse.events.atLeast(1, "the b2 event");
    } finally {
      await sse.close();
    }
    expect(sse.events.items).toEqual([{ data: { stockChanged: { bookId: "b2", stock: 3 } } }]);
  });
});

describe("what the harness measures", () => {
  let rest: Stack;
  beforeEach(async () => {
    rest = await startRest(freshStore());
  });
  afterEach(() => rest.close());

  it("exchange counts the target and the body going up, the body coming down, and keeps its label", async () => {
    const body = JSON.stringify({ filter: { format: "EBOOK" }, limit: 1 });
    const r = await exchange(rest.base, "QUERY", "/books", { headers: JSON_CT, body, label: "one ebook" });
    expect(r.status).toBe(200);
    expect(r.bytes).toEqual({ up: "/books".length + body.length, down: r.text.length });
    expect(r.ex).toEqual({ label: "one ebook", request: { method: "QUERY", target: "/books", headers: JSON_CT, body }, response: { status: 200, headers: { "content-type": "application/json", etag: r.headers["etag"], "cache-control": "public, max-age=60" }, body: r.text } });
  });

  it("the caching client keys a body-carrying request by its body, and a revalidation costs the status line and headers only", async () => {
    const c = new CachingClient();
    const ebooks = JSON.stringify({ filter: { format: "EBOOK" }, limit: 1 });
    const hardcovers = JSON.stringify({ filter: { format: "HARDCOVER" }, limit: 1 });
    const first = await c.query(`${rest.base}/books`, ebooks, JSON_CT);
    await c.query(`${rest.base}/books`, hardcovers, JSON_CT);
    const again = await c.query(`${rest.base}/books`, ebooks, JSON_CT);
    expect([first.fromCache, again.fromCache, again.body, c.misses, c.revalidated]).toEqual([false, true, first.body, 2, 1]);
    // 17 stands for the status line; each header is its name, its value, ": " and CRLF
    const headerBytes = (h: Record<string, string>) => Object.entries(h).reduce((n, [k, v]) => n + k.length + v.length + 4, 17);
    expect(first.wireBytes).toBe(headerBytes(first.headers) + Buffer.byteLength(JSON.stringify(first.body)));
    const notModified = await fetch(`${rest.base}/books`, { method: "QUERY", headers: { ...JSON_CT, "if-none-match": first.headers["etag"]! }, body: ebooks });
    const sent: Record<string, string> = {};
    notModified.headers.forEach((v, k) => (sent[k] = v));
    expect([notModified.status, again.wireBytes]).toEqual([304, headerBytes(sent)]);
  });
});

describe("the recorder behind every report's exchanges", () => {
  const codec = new RbCodec(loadSchema(bookstoreSchemaText()).ir);
  const recorder = new Recorder((bytes, asFrames) => (asFrames ? codec.decodeFrames(bytes) : codec.decode(bytes)));
  let rest: Stack;
  let rayfold: Stack;
  let other: Stack;
  beforeEach(async () => {
    [rest, rayfold, other] = await Promise.all([startRest(freshStore()), startRayfold(freshStore()), startRest(freshStore())]);
    recorder.install();
  });
  afterEach(async () => {
    recorder.uninstall();
    await Promise.all([rest.close(), rayfold.close(), other.close()]);
  });

  it("keeps each tracked exchange under its stack, labels only the next one, decodes RB both ways, and starts over on track", async () => {
    recorder.track([[rest.base, "REST"]]);
    await fetch(`${rest.base}/books/b1`);
    recorder.track([[rest.base, "REST"], [rayfold.base, "Rayfold"]]);
    recorder.label("the book");
    const book = await (await fetch(`${rest.base}/books/b1`, { headers: U1 })).text();
    await fetch(`${rest.base}/authors/a1`); // its body is never read here, so take() has to wait for the recorder's copy
    const author = await (await fetch(`${other.base}/authors/a1`)).text(); // the same author, from a stack not tracked
    const up = codec.encode({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] });
    const down = new Uint8Array(await (await fetch(`${rayfold.base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold", accept: "application/rayfold" }, body: up as BodyInit })).arrayBuffer());
    const taken = await recorder.take();

    expect(taken.GraphQL).toEqual([]);
    expect(taken.REST.map((e) => [e.label, e.request.target, e.request.headers, e.response.body])).toEqual([
      ["the book", "/books/b1", U1, book],
      [undefined, "/authors/a1", {}, author],
    ]);
    expect(taken.Rayfold).toEqual([
      {
        request: { method: "POST", target: "/rayfold", headers: { "content-type": "application/rayfold", accept: "application/rayfold" }, body: `RB request, ${up.length} bytes on the wire, shown decoded:\n${JSON.stringify(codec.decode(up))}` },
        response: { status: 200, headers: { "content-type": "application/rayfold", "cache-control": "no-store" }, body: `RB, ${down.length} bytes on the wire, shown decoded:\n${(codec.decodeFrames(down) as unknown[]).map((f) => JSON.stringify(f)).join("\n")}` },
      },
    ]);
  });

  it("a stream the client closed is kept up to that point and marked closed, and take() waits for it to end", async () => {
    recorder.track([[rest.base, "REST"]]);
    const ac = new AbortController();
    const res = await fetch(`${rest.base}/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const chunk = async () => new TextDecoder().decode((await reader.read()).value);
    expect(await chunk()).toBe(": connected\n\n");
    // what take() hands back at the moment it settles: it must not settle while the stream is still open
    const taking = recorder.take().then((t) => t.REST[0]!.response.body);
    await fetch(`${rest.base}/books/b2?action=restock&qty=1`, { method: "POST", headers: ADMIN });
    expect(await chunk()).toBe('data: {"bookId":"b2","stock":3}\n\n');
    // the recorder reads a copy of the same stream; one turn of the event loop lets it take the chunk too
    await new Promise<void>((r) => setImmediate(r));
    ac.abort();
    expect(await taking).toBe(': connected\n\ndata: {"bookId":"b2","stock":3}\n\n\n(stream closed by the client)');
  });
});

describe("the report writer", () => {
  let dir: string;
  let was: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rayfold-report-"));
    was = process.env["E2E_WRITE"];
  });
  afterEach(() => {
    if (was === undefined) delete process.env["E2E_WRITE"];
    else process.env["E2E_WRITE"] = was;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes only when E2E_WRITE=1, whole, with no temp file left; guard: a plain run leaves the tree alone", () => {
    const file = join(dir, "report.json");
    delete process.env["E2E_WRITE"];
    writeReport(file, "plain run");
    expect(existsSync(file)).toBe(false);
    process.env["E2E_WRITE"] = "1";
    writeReport(file, "e2e run");
    expect(readFileSync(file, "utf8")).toBe("e2e run");
    expect(readdirSync(dir)).toEqual(["report.json"]);
  });

  it("lists methods in the order GET, POST, PUT, PATCH, DELETE, QUERY whatever order the suites added them", () => {
    const report = new Report();
    for (const method of ["QUERY", "DELETE", "GET", "PATCH", "POST", "PUT"]) report.addMethod({ method, title: method, operation: "", exchanges: { REST: [], GraphQL: [], Rayfold: [] }, facts: [] });
    expect((JSON.parse(report.json()) as { methods: Array<{ method: string }> }).methods.map((m) => m.method)).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE", "QUERY"]);
  });
});
