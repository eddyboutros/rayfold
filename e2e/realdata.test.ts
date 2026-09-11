/**
 * The comparison on real data. REST, GraphQL and Rayfold each serve the whole Project Gutenberg catalogue (78,086 real books
 * by 26,263 real authors, on top of the seed's 4 books) over real HTTP. Every answer is checked against an oracle built
 * straight from the catalogue file, never through a stack; requests, bytes and loader calls are measured, and the suite
 * writes e2e/realdata.json in the shape of e2e/results.json, with a description of the dataset.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { RbCodec } from "@rayfold/rb";
import { gutenbergData, seed, withGutenberg, type Store } from "../examples/bookstore-ts/src/index.ts";
import { Recorder, Report, exchange, startGraphQL, startRayfold, startRest, type Exchange, type Recorded, type Stack } from "./harness.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const JSON_CT = { "content-type": "application/json" };
const MERGE_CT = { "content-type": "application/merge-patch+json" };
const RAYFOLD_CT = { "content-type": "application/rayfold+json" };
const ADMIN = { authorization: "Bearer admin" };
const PAGE_SHAPE = "{ items { id title } total hasMore cursor }";

// ---------------------------------------------------------------- the oracle, straight from the catalogue file
const G = gutenbergData();
const SEED = seed(); // the fixture withGutenberg() extends: b1-b4 by a1-a3
interface OBook { id: string; title: string; authorId: string }
type OAuthor = { name: string; bio: string | null };
const oBooks: OBook[] = [
  ...[...SEED.books.values()].map((b) => ({ id: b.id, title: b.title, authorId: b.authorId })),
  ...G.books.map(([no, title, author]) => ({ id: `g${no}`, title, authorId: `ga${author}` })),
].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const oAuthors = new Map<string, OAuthor>([
  ...[...SEED.authors.values()].map((a): [string, OAuthor] => [a.id, { name: a.name, bio: a.bio }]),
  ...G.authors.map(([name, bio], i): [string, OAuthor] => [`ga${i}`, { name, bio }]),
]);
const oById = new Map(oBooks.map((b) => [b.id, b]));
const authorOf = (b: OBook) => oAuthors.get(b.authorId)!;
const titled = (needle: string) => oBooks.filter((b) => b.title.toLowerCase().includes(needle));
const byAuthor = (authorId: string) => oBooks.filter((b) => b.authorId === authorId);
const authorIdsNamed = (name: string) => G.authors.flatMap(([n], i) => (n === name ? [`ga${i}`] : []));

const DATASET = {
  source: G.source,
  retrieved: G.retrieved,
  books: G.books.length,
  authors: G.authors.length,
  storeBooks: oBooks.length,
  storeAuthors: oAuthors.size,
  note:
    "Real, from the catalogue: every title, author name and author life dates (served as the author's bio), and the ids: book g<Text#> is Project Gutenberg's own ebook number, author ga<index> its position in the converted file. The catalogue's languages and release dates are in the file but not served by this bookstore. The store's own: price 0.00, format EBOOK, stock 1,000,000 and owner \"gutenberg\" on every catalogue book (the catalogue has no prices or stock; Project Gutenberg ebooks are free), no reviews, and the seed fixture's 4 books by 3 authors (b1-b4, a1-a3), which every stack serves alongside the catalogue.",
  attribution: "Project Gutenberg is a registered trademark of the Project Gutenberg Literary Archive Foundation. Rayfold is not affiliated with or endorsed by Project Gutenberg. See data/README.md.",
};

// ---------------------------------------------------------------- stacks, recorder, report
const report = new Report();
/** RB, Rayfold's binary encoding, built on the schema the Rayfold server serves. */
let rb: RbCodec;
const recorder = new Recorder((bytes, frames) => (frames ? rb.decodeFrames(bytes) : rb.decode(bytes)));
const fresh = (): Store => withGutenberg(seed());
let rest: Stack;
let gql: Stack;
/** the same GraphQL API with the obvious per-parent resolvers (no DataLoader) */
let gqlNaive: Stack;
let rayfold: Awaited<ReturnType<typeof startRayfold>>;
let rowsBefore = 0;

/** A 500-book page is too long to read in a report: bodies over 4 KB are cut there, with their full size. */
const MAX_BODY = 4096;
const cut = (body: string) => (body.length <= MAX_BODY ? body : `${body.slice(0, MAX_BODY)}\n... (${Buffer.byteLength(body)} bytes in full, cut for the report)`);
const shorten = (e: Exchange): Exchange => ({ ...e, request: { ...e.request, ...(e.request.body === undefined ? {} : { body: cut(e.request.body) }) }, response: { ...e.response, body: cut(e.response.body) } });

beforeAll(() => recorder.install());
// Every test gets its own four servers over four copies of the catalogue; only the parsed file is shared.
beforeEach(async () => {
  [rest, gql, gqlNaive, rayfold] = await Promise.all([startRest(fresh()), startGraphQL(fresh()), startGraphQL(fresh(), { batching: false }), startRayfold(fresh())]);
  rb = new RbCodec(rayfold.bookstore.server.ir);
  recorder.track([[rest.base, "REST"], [gql.base, "GraphQL"], [gqlNaive.base, "GraphQL"], [rayfold.base, "Rayfold"]]);
  rowsBefore = report.rows.length;
});
afterEach(async () => {
  const ex = await recorder.take();
  const examples = { REST: ex.REST.map(shorten), GraphQL: ex.GraphQL.map(shorten), Rayfold: ex.Rayfold.map(shorten) };
  for (const row of report.rows.slice(rowsBefore)) row.examples = examples;
  await Promise.all([rest.close(), gql.close(), gqlNaive.close(), rayfold.close()]);
});
afterAll(() => {
  recorder.uninstall();
  writeFileSync("e2e/realdata.json", JSON.stringify({ ...(JSON.parse(report.json()) as Obj), dataset: DATASET }, null, 2) + "\n");
});

// ---------------------------------------------------------------- measured calls
interface Meter { requests: number; bytes: number }
const meter = (): Meter => ({ requests: 0, bytes: 0 });

/** One real HTTP exchange counted into `m`: a request, and its bytes (request target + body + response body). */
async function hit(m: Meter, base: string, method: string, target: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Recorded> {
  const r = await exchange(base, method, target, opts);
  m.requests++;
  m.bytes += r.bytes.up + r.bytes.down;
  return r;
}
async function restGet(m: Meter, target: string): Promise<Obj> {
  const r = await hit(m, rest.base, "GET", target);
  expect(r.status, target).toBe(200);
  return r.json as Obj;
}
async function restQuery(m: Meter, body: unknown): Promise<Obj> {
  const r = await hit(m, rest.base, "QUERY", "/books", { headers: JSON_CT, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
  return r.json as Obj;
}
async function gqlData(m: Meter, s: Stack, query: string, variables: Obj = {}, headers: Record<string, string> = {}): Promise<Obj> {
  const r = await hit(m, s.base, "POST", "/graphql", { headers: { ...JSON_CT, ...headers }, body: JSON.stringify({ query, variables }) });
  const body = r.json as Obj;
  expect(body["errors"]).toBeUndefined();
  return body["data"] as Obj;
}
async function rayfoldFrames(m: Meter, ops: Obj[], headers: Record<string, string> = {}): Promise<{ status: number; frames: Obj[] }> {
  const r = await hit(m, rayfold.base, "POST", "/rayfold", { headers: { ...RAYFOLD_CT, ...headers }, body: JSON.stringify({ ops }) });
  return { status: r.status, frames: r.text.trim().split("\n").map((l) => JSON.parse(l) as Obj) };
}
/** One op's result, with its deferred parts (frames carrying `at`) merged in where they belong. */
function opData(frames: Obj[], id: number): Obj {
  const mine = frames.filter((f) => f["id"] === id);
  expect(mine.filter((f) => "error" in f)).toEqual([]);
  const data = mine.find((f) => "data" in f && !("at" in f))!["data"] as Obj;
  for (const f of mine.filter((x) => "at" in x)) Object.assign(String(f["at"]).split(".").reduce((o: Obj, k) => o[k] as Obj, data), f["data"]);
  return data;
}
/** A batch of read ops in compact JSON; each op's data, in op order. */
async function rayfoldData(m: Meter, ops: Obj[]): Promise<Obj[]> {
  const { status, frames } = await rayfoldFrames(m, ops.map((op) => ({ ...op, compact: true })));
  expect(status).toBe(200);
  return ops.map((op) => opData(frames, op["id"] as number));
}
/** The same read ops sent and answered as RB; each op's data, in op order. Bytes: target + request + response body. */
async function rayfoldRbData(m: Meter, ops: Obj[]): Promise<Obj[]> {
  const body = rb.encode({ ops: ops.map((op) => ({ ...op, compact: true })) });
  const res = await fetch(`${rayfold.base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold", accept: "application/rayfold" }, body: body as BodyInit });
  const bytes = new Uint8Array(await res.arrayBuffer());
  m.requests++;
  m.bytes += "/rayfold".length + body.length + bytes.length;
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/rayfold");
  const frames = rb.decodeFrames(bytes) as Obj[];
  return ops.map((op) => opData(frames, op["id"] as number));
}

interface PageOut { ids: string[]; titles: string[]; total: number; hasMore: boolean; cursor: string | null }
const toPage = (p: Obj): PageOut => ({ ids: p["items"].map((b: Obj) => b["id"]), titles: p["items"].map((b: Obj) => b["title"]), total: p["total"], hasMore: p["hasMore"], cursor: p["cursor"] });
const pages = (n: number, per: number) => Array.from({ length: Math.ceil(n / per) }, (_, i) => Math.min(per, n - i * per));

/** Follows the cursor until the stack says there is no more, or `enough` rows have arrived. */
async function walk(fetchPage: (after: string | null) => Promise<PageOut>, enough = Number.POSITIVE_INFINITY): Promise<PageOut[]> {
  const out: PageOut[] = [];
  let rows = 0;
  let after: string | null = null;
  for (;;) {
    const p = await fetchPage(after);
    out.push(p);
    rows += p.ids.length;
    if (!p.hasMore || rows >= enough) return out;
    if (out.length === 100) throw new Error("a cursor walk did not end within 100 pages");
    after = p.cursor;
  }
}

/**
 * How Rayfold is measured: as its client sends when it has the schema, which is compact frames in the binary encoding
 * (RB). Every row also measures the identical ops as JSON and says so in its note.
 */
const RB_NOTE = (json: number) => `Rayfold is measured as its client sends when it has the schema: compact frames in its binary encoding (RB). The identical ops as JSON took ${json} B, with the identical data`;

/**
 * Rayfold pipelines a cursor walk: one request carries up to `perTrip` pages, each continuing after the previous page's
 * cursor through a `$ref`, so a round trip moves `perTrip` pages. Stops at the first page without more, or at `enough`.
 */
async function rayfoldPipelinedWalk(send: (ops: Obj[]) => Promise<Obj[]>, per: number, perTrip: number, enough: number): Promise<{ pages: PageOut[]; data: Obj[] }> {
  const pages: PageOut[] = [];
  const data: Obj[] = [];
  let rows = 0;
  let after: string | null = null;
  for (let trip = 1; ; trip++) {
    if (trip > 100) throw new Error("a pipelined walk did not end within 100 requests");
    const count = Math.min(perTrip, Math.ceil((enough - rows) / per));
    const ops = Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      op: "books",
      args: { page: i > 0 ? { first: per, after: { $ref: `${i}.cursor` } } : after ? { first: per, after } : { first: per } },
      shape: PAGE_SHAPE,
    }));
    for (const d of await send(ops)) {
      const p = toPage(d);
      pages.push(p);
      data.push(d);
      rows += p.ids.length;
      if (!p.hasMore || rows >= enough) return { pages, data };
    }
    after = pages[pages.length - 1]!.cursor;
  }
}

/** A Rayfold cursor walk, one op per page, keeping each page's data. */
async function rayfoldWalk(send: (ops: Obj[]) => Promise<Obj[]>, opFor: (after: string | null) => Obj, enough?: number): Promise<{ pages: PageOut[]; data: Obj[] }> {
  const data: Obj[] = [];
  const got = await walk(async (after) => {
    const [d] = await send([opFor(after)]);
    data.push(d!);
    return toPage(d!);
  }, enough);
  return { pages: got, data };
}

/** The pages hold exactly `want` in order (ids and titles), `per` a page, each cursor on its page's last row. */
function expectWalk(label: string, got: PageOut[], want: OBook[], per: number, total: number): void {
  expect(got.flatMap((p) => p.ids), label).toEqual(want.map((b) => b.id));
  expect(got.flatMap((p) => p.titles), label).toEqual(want.map((b) => b.title));
  expect(got.map((p) => p.ids.length), label).toEqual(pages(want.length, per));
  expect(got.map((p) => p.cursor), label).toEqual(got.map((p) => p.ids[p.ids.length - 1]));
  expect(got.map((p) => p.total), label).toEqual(got.map(() => total));
  expect(got.map((p) => p.hasMore), label).toEqual(got.map((_, i) => i < got.length - 1 || total > want.length));
}

// ---------------------------------------------------------------- the tasks
describe("1. Title search over 78,090 real titles", () => {
  it("'frankenstein' finds exactly the catalogue's six books and 'love' the catalogue's total, on every stack", async () => {
    const frank = titled("frankenstein");
    const love = titled("love");
    // pinned, so a different catalogue file is noticed instead of silently compared
    expect(frank.map((b) => b.id)).toEqual(["g41445", "g42324", "g62404", "g62405", "g62406", "g84"]);
    expect(love.length).toBe(556);
    const wantFrank: PageOut = { ids: frank.map((b) => b.id), titles: frank.map((b) => b.title), total: 6, hasMore: false, cursor: "g84" };
    const first20 = love.slice(0, 20);
    const wantLove: PageOut = { ids: first20.map((b) => b.id), titles: first20.map((b) => b.title), total: love.length, hasMore: true, cursor: first20[19]!.id };

    const R = meter();
    expect(toPage(await restGet(R, "/books?titleContains=frankenstein&limit=50"))).toEqual(wantFrank);
    expect(toPage(await restQuery(R, { filter: { titleContains: "love" }, limit: 20 }))).toEqual(wantLove);

    const Q = meter();
    const g = await gqlData(Q, gql, `{ f: books(titleContains: "frankenstein", first: 50) ${PAGE_SHAPE} l: books(titleContains: "love", first: 20) ${PAGE_SHAPE} }`);
    expect([toPage(g["f"]), toPage(g["l"])]).toEqual([wantFrank, wantLove]);

    const Y = meter();
    const ops = [
      { id: 1, op: "books", args: { filter: { titleContains: "frankenstein" }, page: { first: 50 } }, shape: PAGE_SHAPE },
      { id: 2, op: "books", args: { filter: { titleContains: "love" }, page: { first: 20 } }, shape: PAGE_SHAPE },
    ];
    const [yf, yl] = await rayfoldData(Y, ops);
    expect([toPage(yf!), toPage(yl!)]).toEqual([wantFrank, wantLove]);
    expect(rayfold.store.calls).toEqual({ "Query.books": 2 });
    expect([rest.counters.originRequests, gql.counters.originRequests, rayfold.counters.originRequests]).toEqual([R.requests, Q.requests, Y.requests]);
    expect([R.requests, Q.requests, Y.requests]).toEqual([2, 1, 1]);
    const B = meter();
    expect(await rayfoldRbData(B, ops)).toEqual([yf, yl]);

    report.add({
      aspect: "Title search on the real catalogue",
      metric: "requests and bytes for two searches",
      values: { REST: R.bytes, GraphQL: Q.bytes, Rayfold: B.bytes },
      unit: "bytes on the wire (request + response)",
      better: "lower",
      REST: `${R.requests} requests (GET with query parameters, then QUERY with a body), ${R.bytes} B`,
      GraphQL: `${Q.requests} request (two aliased fields), ${Q.bytes} B`,
      Rayfold: `${B.requests} request (a batch of two ops), ${B.bytes} B`,
      note: `"frankenstein": the catalogue's ${frank.length} editions (three English, three French volumes), all of them; "love": total ${love.length}, first 20 by id. Ids, titles and totals match the catalogue file on every stack. ${RB_NOTE(Y.bytes)}`,
    });
  });
});

describe("2. An author's whole bibliography, 50 at a time", () => {
  it("Mark Twain (196) and William Shakespeare (330): every stack pages through exactly the catalogue's books", async () => {
    // The catalogue lists Mark Twain under two author records with the same name and dates; ga43 holds his books.
    expect(authorIdsNamed("Mark Twain")).toEqual(["ga43", "ga10926"]);
    expect([byAuthor("ga43").length, byAuthor("ga10926").length]).toEqual([196, 1]);
    expect(authorIdsNamed("William Shakespeare")).toEqual(["ga56"]);
    expect(byAuthor("ga56").length).toBe(330);

    const R = meter();
    const Q = meter();
    const Y = meter();
    const walks: Array<[(after: string | null) => Obj, Obj[]]> = [];
    for (const aid of ["ga43", "ga56"]) {
      const want = byAuthor(aid);
      const r = await walk(async (after) => toPage(await restGet(R, `/authors/${aid}/books?limit=50${after ? `&after=${after}` : ""}`)));
      const g = await walk(async (after) => toPage((await gqlData(Q, gql, `query($a: ID!, $after: String) { books(authorId: $a, first: 50, after: $after) ${PAGE_SHAPE} }`, { a: aid, after }))["books"]));
      const opFor = (after: string | null) => ({ id: 1, op: "books", args: { filter: { authorId: aid }, page: after ? { first: 50, after } : { first: 50 } }, shape: PAGE_SHAPE });
      const y = await rayfoldWalk((ops) => rayfoldData(Y, ops), opFor);
      walks.push([opFor, y.data]);
      expectWalk(`REST ${aid}`, r, want, 50, want.length);
      expectWalk(`GraphQL ${aid}`, g, want, 50, want.length);
      expectWalk(`Rayfold ${aid}`, y.pages, want, 50, want.length);
    }
    const trips = Math.ceil(196 / 50) + Math.ceil(330 / 50);
    expect([R.requests, Q.requests, Y.requests]).toEqual([trips, trips, trips]);
    expect(rayfold.store.calls).toEqual({ "Query.books": trips });
    const B = meter();
    for (const [opFor, data] of walks) expect((await rayfoldWalk((ops) => rayfoldRbData(B, ops), opFor)).data).toEqual(data);
    expect(B.requests).toBe(trips);

    // Cross-check, outside the measurement: the same bibliographies through REST's list filters.
    const x = meter();
    recorder.label("cross-check, not measured: Mark Twain through GET /books?authorId=");
    expect(toPage(await restGet(x, "/books?authorId=ga43&limit=200")).ids).toEqual(byAuthor("ga43").map((b) => b.id));
    recorder.label("cross-check, not measured: William Shakespeare through QUERY /books");
    expect(toPage(await restQuery(x, { filter: { authorId: "ga56" }, limit: 400 }))).toMatchObject({ ids: byAuthor("ga56").map((b) => b.id), total: 330, hasMore: false });

    report.add({
      aspect: "Author bibliography, 50 per page (Mark Twain 196, William Shakespeare 330)",
      metric: "round trips and bytes to page through both",
      values: { REST: R.bytes, GraphQL: Q.bytes, Rayfold: B.bytes },
      unit: "bytes on the wire (request + response)",
      better: "lower",
      REST: `${R.requests} round trips, ${R.bytes} B (whole book resources)`,
      GraphQL: `${Q.requests} round trips, ${Q.bytes} B`,
      Rayfold: `${B.requests} round trips, ${B.bytes} B`,
      note: `Every stack follows its cursor, so round trips are equal and bytes decide. The catalogue lists Mark Twain twice (ga43 with 196 books, ga10926 with 1). ${RB_NOTE(Y.bytes)}`,
    });
  });
});

describe("3. A list of 200 real books with author names (N+1)", () => {
  it("REST fetches each distinct author, GraphQL's obvious resolver loads per book, DataLoader and Rayfold load once", async () => {
    const want = oBooks.slice(0, 200);
    const wantRows = want.map((b) => [b.id, authorOf(b).name]);
    const distinct = [...new Set(want.map((b) => b.authorId))];

    const R = meter();
    const list = await restGet(R, "/books?limit=200");
    const authorIds = [...new Set<string>(list["items"].map((b: Obj) => b["authorId"]))];
    expect(authorIds).toEqual(distinct);
    const names = new Map((await Promise.all(authorIds.map((id) => restGet(R, `/authors/${id}`)))).map((a) => [a["id"], a["name"]]));
    expect(list["items"].map((b: Obj) => [b["id"], names.get(b["authorId"])])).toEqual(wantRows);
    expect(R.requests).toBe(1 + distinct.length);

    const GQ = "{ books(first: 200) { items { id author { name } } } }";
    const Q = meter();
    const N = meter();
    for (const [s, m] of [[gql, Q], [gqlNaive, N]] as const) {
      expect((await gqlData(m, s, GQ))["books"].items.map((b: Obj) => [b["id"], b["author"].name])).toEqual(wantRows);
    }
    expect(gql.counters.loaderCalls["author"]).toBe(1);
    const naive = gqlNaive.counters.loaderCalls["author"]!;
    expect(naive).toBe(200);

    const Y = meter();
    const [y] = await rayfoldData(Y, [{ id: 1, op: "books", args: { page: { first: 200 } }, shape: "{ items { id author { name } } }" }]);
    expect(y!["items"].map((b: Obj) => [b["id"], b["author"].name])).toEqual(wantRows);
    expect(rayfold.store.calls).toEqual({ "Query.books": 1, "Book.author": 1 });

    report.add({
      aspect: "List of 200 real books with author names",
      metric: "author lookups at the backend",
      values: { REST: distinct.length, GraphQL: naive, Rayfold: rayfold.store.calls["Book.author"]! },
      unit: "author lookups with straightforward code",
      better: "lower",
      REST: `${distinct.length}: one request per distinct author after the list (${R.requests} requests, ${R.bytes} B)`,
      GraphQL: `${naive} with the obvious resolver; ${gql.counters.loaderCalls["author"]} with a hand-written DataLoader (both measured; 1 request, ${Q.bytes} B)`,
      Rayfold: `${rayfold.store.calls["Book.author"]}: a batch loader is the only resolver shape (1 request, ${Y.bytes} B)`,
      note: `The first 200 books by id (the seed's 4, then g1, g10, g100, ...) have ${distinct.length} distinct authors, every name checked against the catalogue. GraphQL and Rayfold select id and author name; with the title as well, Rayfold's static cost for a 200-row page crosses its default budget (see the cost row)`,
    });
  });

  it("a page of books per author (Author.books) loads once per level with DataLoader and Rayfold, once per author without", async () => {
    const want = oBooks.slice(4, 7);
    expect(want.map((b) => b.id)).toEqual(["g1", "g10", "g100"]);
    expect(new Set(want.map((b) => b.authorId)).size).toBe(3); // three authors, so there is something to batch
    const expected = want.map((b) => ({ id: b.id, author: { id: b.authorId, books: { items: byAuthor(b.authorId).slice(0, 2).map((x) => ({ id: x.id })), total: byAuthor(b.authorId).length } } }));
    const m = meter();
    const GQ = '{ books(first: 3, after: "b4") { items { id author { id books(first: 2) { items { id } total } } } } }';
    expect((await gqlData(m, gql, GQ))["books"].items).toEqual(expected);
    expect((await gqlData(m, gqlNaive, GQ))["books"].items).toEqual(expected);
    expect([gql.counters.loaderCalls["authorBooks"], gqlNaive.counters.loaderCalls["authorBooks"]]).toEqual([1, 3]);
    const [y] = await rayfoldData(m, [{ id: 1, op: "books", args: { page: { first: 3, after: "b4" } }, shape: "{ items { id author { id books(page: { first: 2 }) { items { id } total } } } }" }]);
    expect(y!["items"]).toEqual(expected);
    expect(rayfold.store.calls).toEqual({ "Query.books": 1, "Book.author": 1, "Author.books": 1 });
  });
});

describe("4. Product page: Pride and Prejudice (g1342)", () => {
  it("the book, Jane Austen with her life dates and five more of her books: the same facts on every stack", async () => {
    const book = oById.get("g1342")!;
    const author = authorOf(book);
    expect([book.title, book.authorId, author.name, author.bio]).toEqual(["Pride and Prejudice", "ga59", "Jane Austen", "Lived 1775-1817."]);
    const hers = byAuthor(book.authorId);
    const want = { title: book.title, author: author.name, bio: author.bio, more: hers.filter((b) => b.id !== book.id).slice(0, 5).map((b) => [b.id, b.title]), total: hers.length };
    // what the page shows: the first six of her books by id, without this one, cut to five
    const screen = (b: Obj, a: Obj, books: Obj) => ({ title: b["title"], author: a["name"], bio: a["bio"], more: books["items"].filter((x: Obj) => x["id"] !== book.id).slice(0, 5).map((x: Obj) => [x["id"], x["title"]]), total: books["total"] });

    const R = meter();
    const rb = await restGet(R, "/books/g1342");
    const [ra, rbooks] = await Promise.all([restGet(R, `/authors/${rb["authorId"]}`), restGet(R, `/authors/${rb["authorId"]}/books?limit=6`)]);
    expect(screen(rb, ra, rbooks)).toEqual(want);

    const Q = meter();
    const g = (await gqlData(Q, gql, '{ book(id: "g1342") { id title author { id name bio books(first: 6) { items { id title } total } } } }'))["book"];
    expect(screen(g, g.author, g.author.books)).toEqual(want);
    expect(gql.counters.loaderCalls).toEqual({ author: 1, authorBooks: 1 });

    const Y = meter();
    const ops = [{ id: 1, op: "book", args: { id: "g1342" }, shape: "{ id title author { id name bio books(page: { first: 6 }) { items { id title } total } } }" }];
    const [y] = await rayfoldData(Y, ops);
    expect(screen(y!, y!["author"], y!["author"].books)).toEqual(want);
    expect(rayfold.store.calls).toEqual({ "Query.book": 1, "Book.author": 1, "Author.books": 1 });
    expect([R.requests, Q.requests, Y.requests]).toEqual([3, 1, 1]);
    expect([rest.counters.originRequests, gql.counters.originRequests, rayfold.counters.originRequests]).toEqual([3, 1, 1]);
    const B = meter();
    expect(await rayfoldRbData(B, ops)).toEqual([y]);

    report.add({
      aspect: "Product page: Pride and Prejudice, Jane Austen and five more of her books",
      metric: "requests and bytes for the page",
      values: { REST: R.bytes, GraphQL: Q.bytes, Rayfold: B.bytes },
      unit: "bytes on the wire (request + response)",
      better: "lower",
      REST: `${R.requests} requests in 2 waves (book, then author and her books), ${R.bytes} B`,
      GraphQL: `${Q.requests} request, ${Q.bytes} B (DataLoader: 1 author load, 1 books load)`,
      Rayfold: `${B.requests} request, ${B.bytes} B (the lazy bio in a later frame of the same response)`,
      note: `g1342 by Jane Austen (${author.bio}), ${hers.length} of her books in the catalogue; the five shown are her first by id after this one is left out. ${RB_NOTE(Y.bytes)}`,
    });
  });
});

describe("5. Deep pagination: the first 5,000 books by id, 500 asked per page", () => {
  it("no duplicate and no gap on any stack; Rayfold pipelines four 200-row pages per request; one sort of the ids serves the whole walk", async () => {
    const want = oBooks.slice(0, 5000);
    const R = meter();
    const Q = meter();
    const Y = meter();
    const r = await walk(async (after) => toPage(await restGet(R, `/books?limit=500&after=${after ?? ""}`)), want.length);
    const g = await walk(async (after) => toPage((await gqlData(Q, gql, `query($after: String) { books(first: 500, after: $after) ${PAGE_SHAPE} }`, { after }))["books"]), want.length);
    // Rayfold serves at most 200 rows a page. A 200-row page of this shape costs 206 (5 + 200 rows + the items list;
    // the scalars come with the rows), so four fit the default budget of 1,000 and go in one request, chained by cursor.
    const y = await rayfoldPipelinedWalk((ops) => rayfoldData(Y, ops), 200, 4, want.length);
    expectWalk("REST", r, want, 500, oBooks.length);
    expectWalk("GraphQL", g, want, 500, oBooks.length);
    expectWalk("Rayfold", y.pages, want, 200, oBooks.length);
    expect([R.requests, Q.requests, Y.requests]).toEqual([10, 10, 7]);
    expect(rayfold.store.calls).toEqual({ "Query.books": 25 });
    const B = meter();
    expect((await rayfoldPipelinedWalk((ops) => rayfoldRbData(B, ops), 200, 4, want.length)).data).toEqual(y.data);
    expect(B.requests).toBe(7);
    expect([rest.store.books.sorts, gql.store.books.sorts, rayfold.store.books.sorts]).toEqual([1, 1, 1]);
    // guard: five 200-row pages (5 x 206 = 1,030) are over the default budget, so four a request is the most that fits
    const five = await rayfoldFrames(meter(), Array.from({ length: 5 }, (_, i) => ({ id: i + 1, op: "books", args: { page: { first: 200 } }, shape: PAGE_SHAPE })));
    expect(five.frames).toEqual([{ error: { code: "resource_exhausted", message: "Batch cost 1030 exceeds budget 1000", data: { cost: 1030, budget: 1000 } }, fin: true }]);

    // An unknown cursor must not restart the walk at the first book; a known one continues right after its row.
    const x = meter();
    const next = oBooks[5000]!;
    const cases: Array<[string, PageOut]> = [
      ["g1000a", { ids: [], titles: [], total: oBooks.length, hasMore: false, cursor: null }],
      [want[4999]!.id, { ids: [next.id], titles: [next.title], total: oBooks.length, hasMore: true, cursor: next.id }],
    ];
    for (const [after, expected] of cases) {
      expect(toPage(await restGet(x, `/books?limit=1&after=${after}`)), after).toEqual(expected);
      expect(toPage((await gqlData(x, gql, `query($after: String) { books(first: 1, after: $after) ${PAGE_SHAPE} }`, { after }))["books"]), after).toEqual(expected);
      expect(toPage((await rayfoldData(x, [{ id: 1, op: "books", args: { page: { first: 1, after } }, shape: PAGE_SHAPE }]))[0]!), after).toEqual(expected);
    }
    const [off] = await rayfoldData(x, [{ id: 1, op: "books", args: { page: { first: 2, offset: 4999 } }, shape: PAGE_SHAPE }]);
    expect(toPage(off!)).toEqual({ ids: [want[4999]!.id, next.id], titles: [want[4999]!.title, next.title], total: oBooks.length, hasMore: true, cursor: next.id });
    // REST answers a request that uses only the original parameters with the original body
    recorder.label("original parameters only: the original { items, total } body");
    expect(Object.keys(await restGet(x, "/books?limit=1"))).toEqual(["items", "total"]);
    recorder.label("after= opts into the cursor fields");
    expect(Object.keys(await restGet(x, "/books?limit=1&after="))).toEqual(["items", "total", "hasMore", "cursor"]);
    expect([rest.store.books.sorts, gql.store.books.sorts, rayfold.store.books.sorts]).toEqual([1, 1, 1]);

    report.add({
      aspect: "Deep pagination: the first 5,000 of 78,090 books by id, 500 asked per page",
      metric: "round trips",
      values: { REST: R.requests, GraphQL: Q.requests, Rayfold: Y.requests },
      unit: "round trips",
      better: "lower",
      REST: `${R.requests} pages of 500, one request each, ${R.bytes} B (whole book resources)`,
      GraphQL: `${Q.requests} pages of 500, one request each, ${Q.bytes} B`,
      Rayfold: `${Y.requests} requests carrying 25 pages of 200: four pages a request, each page continuing after the previous page's cursor ($ref), ${B.bytes} B`,
      note: `Rayfold serves at most 200 rows a page and bounds each request by its cost budget; four 200-row pages (4 x 206 = 824 of the default 1,000) fit in one request because a later op can read an earlier op's cursor. REST and GraphQL here have no page cap and serve the 500 asked for, but a request cannot use a cursor it has not received yet, so each page is a round trip. All three return the catalogue's first 5,000 ids in order, with no duplicate and no gap. ${RB_NOTE(Y.bytes)}`,
    });
  });
});

describe("6. Spot checks on real rows", () => {
  it("every 3,900th catalogue book: title and author name match the catalogue file on every stack", async () => {
    const picks = G.books.filter((_, i) => i % 3900 === 0).map(([no, title, author]) => ({ id: `g${no}`, title, author: G.authors[author]![0] }));
    expect(picks.length).toBe(21);

    const R = meter();
    const books = await Promise.all(picks.map((p) => restGet(R, `/books/${p.id}`)));
    const authorIds = [...new Set(books.map((b) => b["authorId"] as string))];
    const names = new Map((await Promise.all(authorIds.map((id) => restGet(R, `/authors/${id}`)))).map((a) => [a["id"], a["name"]]));
    expect(books.map((b) => ({ id: b["id"], title: b["title"], author: names.get(b["authorId"]) }))).toEqual(picks);

    const Q = meter();
    const g = await gqlData(Q, gql, `{ ${picks.map((p, i) => `b${i}: book(id: "${p.id}") { id title author { name } }`).join(" ")} }`);
    expect(picks.map((_, i) => ({ id: g[`b${i}`].id, title: g[`b${i}`].title, author: g[`b${i}`].author.name }))).toEqual(picks);

    const Y = meter();
    const ops = picks.map((p, i) => ({ id: i + 1, op: "book", args: { id: p.id }, shape: "{ id title author { name } }" }));
    const y = await rayfoldData(Y, ops);
    expect(y.map((d) => ({ id: d["id"], title: d["title"], author: d["author"].name }))).toEqual(picks);
    const B = meter();
    expect(await rayfoldRbData(B, ops)).toEqual(y);
    expect([R.requests, Q.requests, B.requests]).toEqual([21 + authorIds.length, 1, 1]);

    report.add({
      aspect: "Spot checks: 21 real books with their authors",
      metric: "requests and bytes to fetch them",
      values: { REST: R.bytes, GraphQL: Q.bytes, Rayfold: B.bytes },
      unit: "bytes on the wire (request + response)",
      better: "lower",
      REST: `${R.requests} requests: each book, then each of its ${authorIds.length} distinct authors, ${R.bytes} B`,
      GraphQL: `${Q.requests} request (21 aliased fields), ${Q.bytes} B`,
      Rayfold: `${B.requests} request (a batch of 21 ops), ${B.bytes} B`,
      note: `Every 3,900th book of the catalogue, from ${picks[0]!.id} ("${picks[0]!.title}", ${picks[0]!.author}) to ${picks[20]!.id}; titles and authors identical to the file on all three. GraphQL and Rayfold both need one request, so bytes decide, as in the rows above. ${RB_NOTE(Y.bytes)}`,
    });
  });
});

describe("7. Cost limit on real data", () => {
  const LIST = { op: "books", args: { page: { first: 200 } }, shape: "{ items { id author { name } } }" };

  it("Rayfold refuses three 200-book lists with author names before any resolver touches the store", async () => {
    const Y = meter();
    const three = await rayfoldFrames(Y, [1, 2, 3].map((id) => ({ id, ...LIST })));
    expect(three.status).toBe(200); // the refusal travels as the batch's only frame
    // one list: 5 + 200 rows + the items list + 200 author loads = 406; the scalars (id, name) come with their rows
    expect(three.frames).toEqual([{ error: { code: "resource_exhausted", message: "Batch cost 1218 exceeds budget 1000", data: { cost: 1218, budget: 1000 } }, fin: true }]);
    const untouched = Object.keys(rayfold.store.calls).length === 0;
    expect(untouched).toBe(true);
    // guard: one list with the titles as well costs the same 406, fits the default budget, and is served in full
    recorder.label("one list, with the titles as well: within the default budget");
    const [withTitle] = await rayfoldData(Y, [{ id: 1, ...LIST, shape: "{ items { id title author { name } } }" }]);
    expect(withTitle!["items"].map((b: Obj) => [b["id"], b["title"], b["author"].name])).toEqual(oBooks.slice(0, 200).map((b) => [b.id, b.title, authorOf(b).name]));

    // The same load on REST and GraphQL is served in full.
    const R = meter();
    const lists = await Promise.all([1, 2, 3].map(() => restGet(R, "/books?limit=200")));
    const Q = meter();
    const g = await gqlData(Q, gql, `{ ${["a", "b", "c"].map((k) => `${k}: books(first: 200) { items { id author { name } } }`).join(" ")} }`);
    const served = [lists.map((l) => l["items"].length), ["a", "b", "c"].map((k) => g[k].items.length)];
    expect(served).toEqual([[200, 200, 200], [200, 200, 200]]);
    const rejected = (rows: number[]) => (rows.every((n) => n === 0) ? 1 : 0);

    report.add({
      aspect: "Over-budget batch on real data (3 x 200 books with author names)",
      metric: "rejected before execution?",
      values: { REST: rejected(served[0]!), GraphQL: rejected(served[1]!), Rayfold: three.frames[0]!["error"] && untouched ? 1 : 0 },
      unit: "rejected before execution (1 = yes)",
      better: "higher",
      REST: `no: 3 requests served ${served[0]!.reduce((a, b) => a + b)} rows`,
      GraphQL: `no: one query served ${served[1]!.reduce((a, b) => a + b)} rows (no cost analysis unless a plugin is added)`,
      Rayfold: `yes: static cost ${three.frames[0]!["error"].data.cost} vs budget ${three.frames[0]!["error"].data.budget}, refused in the batch's only frame before any resolver ran`,
      note: `One such list costs ${three.frames[0]!["error"].data.cost / 3} and is accepted, with the titles too: scalar fields come with the row already loaded, so the budget counts rows and loads, not columns. Three in one batch are refused; REST and GraphQL serve any number`,
    });
  });

  it("and accepts one: 200 real books whose author names match the catalogue", async () => {
    const Y = meter();
    const [y] = await rayfoldData(Y, [{ id: 1, ...LIST }]);
    expect(y!["items"].map((b: Obj) => [b["id"], b["author"].name])).toEqual(oBooks.slice(0, 200).map((b) => [b.id, authorOf(b).name]));
    expect(rayfold.store.calls).toEqual({ "Query.books": 1, "Book.author": 1 });
  });
});

describe("8. Sorted id order: built once per set of ids, rows always current", () => {
  it("a renamed book shows at once without a re-sort; adding or removing an id re-sorts exactly once, on every stack", async () => {
    const m = meter();
    const RENAMED = "The Declaration of Independence (renamed by this test)";
    const added = { id: "c1", title: "A row another writer added", format: "EBOOK" as const, price: "0.00", stock: 1, authorId: "a1", costPrice: null, ownerId: "u1" };
    const rows = (p: Obj): Array<[string, string]> => p["items"].map((b: Obj) => [b["id"], b["title"]]);
    const stacks: Array<{ s: Stack; reads: Array<() => Promise<Array<[string, string]>>>; rename: () => Promise<unknown> }> = [
      {
        s: rest,
        reads: [async () => rows(await restGet(m, "/books?limit=6")), async () => rows(await restQuery(m, { limit: 6 }))],
        rename: async () => (await hit(m, rest.base, "PATCH", "/books/g1", { headers: { ...MERGE_CT, ...ADMIN }, body: JSON.stringify({ title: RENAMED }) })).json,
      },
      {
        s: gql,
        reads: [async () => rows((await gqlData(m, gql, "{ books(first: 6) { items { id title } } }"))["books"])],
        rename: async () => (await gqlData(m, gql, 'mutation($t: String!) { updateBook(id: "g1", patch: { title: $t }) { id title } }', { t: RENAMED }, ADMIN))["updateBook"],
      },
      {
        s: rayfold,
        reads: [async () => rows((await rayfoldData(m, [{ id: 1, op: "books", args: { page: { first: 6 } }, shape: "{ items { id title } }" }]))[0]!)],
        rename: async () => (await rayfoldFrames(m, [{ id: 1, op: "updateBook", args: { id: "g1", patch: { title: RENAMED } }, key: "realdata-rename-g1-000001", shape: "{ id title }" }], ADMIN)).frames[0]!["ok"],
      },
    ];
    const first6 = oBooks.slice(0, 6).map((b): [string, string] => [b.id, b.title]); // b1-b4, g1, g10
    const renamed = first6.map(([id, t]): [string, string] => [id, id === "g1" ? RENAMED : t]);
    for (const { s, reads, rename } of stacks) {
      const expectReads = async (want: Array<[string, string]>, sorts: number) => {
        for (const read of reads) {
          expect(await read(), s.name).toEqual(want);
          expect(s.store.books.sorts, s.name).toBe(sorts);
        }
      };
      await expectReads(first6, 1);
      await expectReads(first6, 1); // reading again must not sort again
      expect(await rename()).toMatchObject({ id: "g1", title: RENAMED });
      await expectReads(renamed, 1); // the replaced row, served from the same order
      s.store.books.set(added.id, added);
      await expectReads([...renamed.slice(0, 4), [added.id, added.title], renamed[4]!], 2);
      s.store.books.delete(added.id);
      await expectReads(renamed, 3);
    }
  });
});
