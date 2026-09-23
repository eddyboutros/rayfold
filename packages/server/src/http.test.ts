import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { base64url } from "@rayfold/schema";
import { RbCodec } from "@rayfold/rb";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { listen, publicIR, type HttpOptions } from "./http.ts";
import { createMcpHandler } from "./mcp.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
import { Signal, bounded } from "../../../e2e/wait.ts";

type Bookstore = ReturnType<typeof createBookstore>;
const viewerOf: NonNullable<HttpOptions["viewer"]> = (req) => {
  const auth = req.headers.authorization;
  if (auth === "Bearer admin") return { id: "u9", role: "admin" };
  if (auth?.startsWith("Bearer ")) return { id: auth.slice(7), role: "customer" };
  return null;
};

let bs: Bookstore;
let base: string;
const open: Server[] = [];
async function serve(server: RayfoldServer, opts: HttpOptions = { viewer: viewerOf }): Promise<string> {
  const http = await listen(server, 0, opts);
  open.push(http);
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}
beforeEach(async () => {
  bs = createBookstore();
  base = await serve(bs.server);
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => new Promise<void>((r) => {
    h.close(() => r());
    h.closeAllConnections();
  })));
});

const KEY = "0123456789abcdef";
const restock = { id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY };
const post = (body: unknown, headers: Record<string, string> = {}, method = "POST", url = `${base}/rayfold`) =>
  fetch(url, { method, headers: { "content-type": "application/rayfold+json", ...headers }, body: JSON.stringify(body) });

async function frames(res: Response): Promise<unknown[]> {
  expect(res.headers.get("content-type")).toBe("application/rayfold-frames+json");
  const text = await res.text();
  return text.trim().split("\n").map((l) => JSON.parse(l));
}

describe("POST /rayfold", () => {
  it("streams NDJSON frames with the schema hash header", async () => {
    const res = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title }" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("rayfold-schema")).toBe(bs.server.hash);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await frames(res)).toEqual([{ id: 1, data: { $type: "Book", id: "b1", title: "The Dispossessed" }, meta: { cost: 1 }, fin: true }]);
  });

  it("Accept: application/json collapses a single-frame batch and derives the status", async () => {
    const okRes = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] }, { accept: "application/json" });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ data: { $type: "Book", id: "b1" }, fin: true, id: 1, meta: { cost: 1 } });
    const denied = await post({ ops: [{ id: 1, op: "myOrders" }] }, { accept: "application/json" });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("authenticates via the viewer hook and runs commands as that viewer", async () => {
    const res = await post({ ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: KEY }] }, { authorization: "Bearer u1" });
    expect(await frames(res)).toMatchObject([{ id: 1, ok: { id: "o1", status: "PLACED" }, fin: true }]);
    expect(bs.store.orders.get("o1")).toMatchObject({ customerId: "u1" });
  });

  it("rejects malformed bodies with RFC 9457 problem details and runs nothing", async () => {
    const res = await fetch(`${base}/rayfold`, { method: "POST", body: "{nope", headers: { "content-type": "application/rayfold+json" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toEqual({ type: "https://eddyboutros.github.io/rayfold/errors/invalid_argument", title: "invalid argument", status: 400, detail: "Body is not valid JSON", code: "invalid_argument" });
    expect(bs.store.calls).toEqual({});
  });

  it("accepts and answers RB (application/rayfold) with the same frames as JSON; broken RB is a 400", async () => {
    const codec = new RbCodec(bs.server.ir);
    const env = { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title author { name } }" }] };
    const rb = await fetch(`${base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold", accept: "application/rayfold" }, body: codec.encode(env) as BodyInit });
    expect(rb.headers.get("content-type")).toBe("application/rayfold");
    const rbFrames = codec.decodeFrames(new Uint8Array(await rb.arrayBuffer()));
    expect(rbFrames).toEqual(await frames(await post(env)));
    const bad = await fetch(`${base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold" }, body: new Uint8Array([0xff, 0x01, 0x02]) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_argument", detail: "Body is not valid RB" });
  });

  it("other methods on /rayfold are refused with Allow and Accept-Query; unknown routes are 404", async () => {
    const put = await fetch(`${base}/rayfold`, { method: "PUT", body: "{}" });
    expect(put.status).toBe(501);
    expect(put.headers.get("allow")).toBe("POST, QUERY");
    expect(put.headers.get("accept-query")).toBe("application/rayfold+json");
    const missing = await fetch(`${base}/elsewhere`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "not_found" });
  });

  it("a body over maxBody is refused before anything runs; a body under it passes (guard)", async () => {
    const small = await serve(bs.server, { viewer: viewerOf, maxBody: 120 });
    const tooBig = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: `{ id ${"title ".repeat(40)}}` }] }, {}, "POST", `${small}/rayfold`);
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({ type: "https://eddyboutros.github.io/rayfold/errors/payload_too_large", title: "payload too large", status: 413, detail: "Body exceeds 120 bytes", code: "resource_exhausted" });
    expect(bs.store.calls).toEqual({});
    const fits = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] }, {}, "POST", `${small}/rayfold`);
    expect(fits.status).toBe(200);
    expect(bs.store.calls["Query.book"]).toBe(1);
  });
});

describe("safe requests: GET, QUERY and Rayfold-Safe POST", () => {
  it("GET /rayfold/{op} is cacheable: ETag, Cache-Control from @cache, 304 on a matching If-None-Match only", async () => {
    const url = `${base}/rayfold/book?a=${base64url(JSON.stringify({ id: "b1" }))}`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^"sha256-[0-9a-f]{64}"$/);
    expect(await frames(res)).toMatchObject([{ id: 1, data: { id: "b1" } }]);
    const again = await fetch(url, { headers: { "if-none-match": etag! } });
    expect(again.status).toBe(304);
    const other = await fetch(url, { headers: { "if-none-match": '"sha256-stale"' } });
    expect(other.status).toBe(200);
  });

  it("private data and authenticated viewers make responses private", async () => {
    await post({ ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: KEY }] }, { authorization: "Bearer u1" });
    const res = await fetch(`${base}/rayfold/order?a=${base64url(JSON.stringify({ id: "o1" }))}`, { headers: { authorization: "Bearer u1" } });
    expect(await frames(res)).toMatchObject([{ data: { id: "o1" } }]);
    expect(res.headers.get("cache-control")).toBe("private, max-age=0, no-cache");
    const pub = await fetch(`${base}/rayfold/book?a=${base64url(JSON.stringify({ id: "b1" }))}`, { headers: { authorization: "Bearer u1" } });
    expect(pub.headers.get("cache-control")).toBe("private, max-age=60");
    const anon = await fetch(`${base}/rayfold/book?a=${base64url(JSON.stringify({ id: "b1" }))}`);
    expect(anon.headers.get("cache-control")).toBe("public, max-age=60"); // guard: the same read without a viewer stays public
  });

  it("the QUERY method runs queries with cache headers", async () => {
    const res = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title }" }] }, {}, "QUERY");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("etag")).toMatch(/^"sha256-/);
    expect(await frames(res)).toEqual([{ id: 1, data: { $type: "Book", id: "b1", title: "The Dispossessed" }, meta: { cost: 1 }, fin: true }]);
  });

  it("QUERY and Rayfold-Safe POST refuse commands without running them; plain POST runs the same command (guard)", async () => {
    for (const [method, extra] of [["QUERY", {}], ["POST", { "rayfold-safe": "true" }]] as const) {
      const res = await post({ ops: [restock] }, { authorization: "Bearer admin", ...extra }, method);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "invalid_argument", detail: "Safe requests (GET/QUERY) may only contain queries" });
    }
    expect(bs.store.calls["Command.restock"]).toBeUndefined();
    expect(bs.store.books.get("b1")!.stock).toBe(5);
    const plain = await post({ ops: [restock] }, { authorization: "Bearer admin" });
    expect(await frames(plain)).toMatchObject([{ id: 1, ok: { id: "b1", stock: 6 } }]);
    expect(bs.store.calls["Command.restock"]).toBe(1);
  });

  it("a Rayfold-Safe POST that only holds queries succeeds and gets cache headers (guard)", async () => {
    const res = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] }, { "rayfold-safe": "true" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await frames(res)).toEqual([{ id: 1, data: { $type: "Book", id: "b1" }, meta: { cost: 1 }, fin: true }]);
  });

  it("a compact read gets the cache headers of the types in its result, found from the schema rather than $type", async () => {
    const shape = "{ id title author { id name } }";
    const full = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape }] }, {}, "QUERY");
    const compact = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape, compact: true }] }, {}, "QUERY");
    expect(JSON.stringify(await frames(compact))).not.toContain("$type");
    expect(compact.headers.get("cache-control")).toBe("public, max-age=60");
    expect(compact.headers.get("cache-control")).toBe(full.headers.get("cache-control"));

    const page = await post({ ops: [{ id: 1, op: "books", args: { page: { first: 2 } }, shape: "{ items { id title } }", compact: true }] }, {}, "QUERY");
    expect(page.headers.get("cache-control")).toBe("public, max-age=60");

    // guard: a result whose types declare no @cache is still not cacheable, so the walk is not a blanket max-age
    const review = await post({ ops: [{ id: 1, op: "review", args: { id: "r1" }, shape: "{ id rating }", compact: true }] }, {}, "QUERY");
    expect(review.headers.get("cache-control")).toBe("public, max-age=0, no-cache");
  });
});

describe("headers into the batch", () => {
  const probe = (metas: unknown[]) =>
    createRayfoldServer({
      schema: `entity A { id: ID } query a: A query hang: A`,
      resolvers: {
        Query: {
          a: (_args, ctx) => {
            metas.push({ ...ctx.meta });
            return { id: "a" };
          },
          hang: (_args, ctx) => new Promise((_r, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason))),
        },
      },
    });

  it("Rayfold-Client and a numeric Rayfold-Deadline reach ctx.meta; a non-numeric deadline is ignored", async () => {
    const metas: unknown[] = [];
    const url = `${await serve(probe(metas))}/rayfold`;
    const one = { ops: [{ id: 1, op: "a" }] };
    await (await post(one, { "rayfold-client": "test/1", "rayfold-deadline": "5000" }, "POST", url)).text();
    await (await post(one, { "rayfold-client": "test/1", "rayfold-deadline": "soon" }, "POST", url)).text();
    await (await post(one, {}, "POST", url)).text();
    expect(metas).toEqual([{ client: "test/1", deadline: 5000 }, { client: "test/1" }, {}]);
  });

  it("Rayfold-Deadline is enforced: an op still running when it passes ends with deadline_exceeded", async () => {
    // only the deadline's timer is faked: sockets and fetch keep their real timers
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const started = new Signal<true>();
      const hanging = createRayfoldServer({
        schema: `entity A { id: ID } query hang: A`,
        resolvers: {
          Query: {
            hang: (_args, ctx) =>
              new Promise((_r, reject) => {
                ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
                started.push(true);
              }),
          },
        },
      });
      const url = `${await serve(hanging)}/rayfold`;
      const res = await post({ ops: [{ id: 1, op: "hang" }] }, { "rayfold-deadline": "1000" }, "POST", url);
      await started.atLeast(1, "the hanging op running under its deadline");
      const body = frames(res);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await body).toEqual([{ id: 1, error: { code: "deadline_exceeded", message: "Batch deadline exceeded" }, fin: true }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("discovery", () => {
  it("GET /rayfold/manifest exposes the schema and limits, but not how access is decided", async () => {
    const res = await fetch(`${base}/rayfold/manifest`);
    const m = await res.json();
    expect(m).toMatchObject({ rayfold: "0.1", schemaHash: bs.server.hash, limits: { budget: 1000, maxOps: 50, maxDepth: 8, maxFields: 500, trustedShapes: false }, extensions: ["live", "rb", "http"] });
    expect(m.schema).toEqual(JSON.parse(JSON.stringify(publicIR(bs.server.ir))));
    const costPrice = m.schema.types.Book.fields.find((f: { name: string }) => f.name === "costPrice");
    expect(costPrice.annotations).toContainEqual(expect.objectContaining({ name: "allow", args: {} })); // guarded, but the rule stays private
    expect(JSON.stringify(m.schema)).not.toContain("$expr");
    expect(Object.keys(m.schema.types)).toEqual(Object.keys(bs.server.ir.types)); // everything else is still there
  });

  it("the manifest option can serve the full IR, or no manifest at all", async () => {
    const full = await (await fetch(`${await serve(bs.server, { viewer: viewerOf, manifest: "full" })}/rayfold/manifest`)).json();
    expect(JSON.stringify(full.schema)).toContain("$expr");
    const off = await fetch(`${await serve(bs.server, { viewer: viewerOf, manifest: "off" })}/rayfold/manifest`);
    expect(off.status).toBe(404);
  });

  it("the manifest lists mcp once an MCP endpoint is mounted beside the server, and not before", async () => {
    const extensions = async () => ((await (await fetch(`${base}/rayfold/manifest`)).json()) as { extensions: string[] }).extensions;
    expect(await extensions()).toEqual(["live", "rb", "http"]);
    createMcpHandler(bs.server);
    expect(await extensions()).toEqual(["live", "rb", "http", "mcp"]);
    // guard: another server over the same schema serves no MCP endpoint, so its manifest does not claim one
    const other = createBookstore();
    expect(other.server.manifest().extensions).toEqual(["live", "rb", "http"]);
  });
});

describe("the Origin rule covers data-changing requests only", () => {
  /** node:http, because a browser-style Origin header is what this test is about. */
  const rawPost = (url: string, headers: Record<string, string>, body: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(url);
      const req = httpRequest({ host: u.hostname, port: u.port, method: "POST", path: u.pathname, headers }, (r) => {
        let d = "";
        r.setEncoding("utf8");
        r.on("data", (c: string) => (d += c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, body: d }));
      });
      req.on("error", reject);
      req.end(body);
    });
  const book = JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] });
  const other = "https://other.example";

  it("a safe read from another origin is answered: it cannot change data, and that page could not read the answer", async () => {
    const r = await rawPost(`${base}/rayfold`, { "content-type": "application/rayfold+json", "rayfold-safe": "true", origin: other }, book);
    expect(r.status).toBe(200);
    expect(r.body).toContain('"id":"b1"');
  });

  it("guard: the same read without Rayfold-Safe is refused, and a Rayfold-Safe batch that carries a command never runs", async () => {
    const plain = await rawPost(`${base}/rayfold`, { "content-type": "application/rayfold+json", origin: other }, book);
    expect(plain.status).toBe(403);
    expect(JSON.parse(plain.body)).toMatchObject({ code: "permission_denied", detail: `Origin ${other} is not allowed` });
    const smuggled = await rawPost(`${base}/rayfold`, { "content-type": "application/rayfold+json", "rayfold-safe": "true", origin: other, authorization: "Bearer admin" }, JSON.stringify({ ops: [restock] }));
    expect(smuggled.status).toBe(400);
    expect(JSON.parse(smuggled.body)).toMatchObject({ detail: "Safe requests (GET/QUERY) may only contain queries" });
    expect(bs.store.calls["Command.restock"]).toBeUndefined();
    expect(bs.store.books.get("b1")!.stock).toBe(5);
  });

  it("a command from an origin in allowedOrigins runs; the same command from another origin is refused and runs nothing", async () => {
    const url = `${await serve(bs.server, { viewer: viewerOf, allowedOrigins: ["http://app.example"] })}/rayfold`;
    const body = JSON.stringify({ ops: [{ ...restock, shape: "{ id stock }" }] });
    const allowed = await rawPost(url, { "content-type": "application/rayfold+json", origin: "http://app.example", authorization: "Bearer admin" }, body);
    expect(allowed.status).toBe(200);
    expect(allowed.body.trim().split("\n").map((l) => JSON.parse(l))).toEqual([
      { id: 1, ok: { $type: "Book", id: "b1", stock: 6 }, patch: [{ set: "Book:b1", value: { $type: "Book", id: "b1", stock: 6 } }], meta: { cost: 1 }, fin: true },
    ]);
    expect(bs.store.books.get("b1")!.stock).toBe(6);
    expect(bs.store.calls["Command.restock"]).toBe(1);
    const refused = await rawPost(url, { "content-type": "application/rayfold+json", origin: other, authorization: "Bearer admin" }, body);
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toEqual({ type: "https://eddyboutros.github.io/rayfold/errors/permission_denied", title: "permission denied", status: 403, detail: `Origin ${other} is not allowed`, code: "permission_denied" });
    expect(bs.store.books.get("b1")!.stock).toBe(6);
    expect(bs.store.calls["Command.restock"]).toBe(1);
  });
});

describe("keep-alives on a streaming response (spec 04 section 4)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const liveBook = { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true }] };
  const admin = { id: "u9", role: "admin" };
  const openLive = async (accept: string) => {
    // only the interval is faked: sockets and fetch keep their real timers
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const url = await serve(bs.server, { viewer: viewerOf, keepAliveMs: 1000 });
    const ac = new AbortController();
    const res = await fetch(`${url}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json", accept }, body: JSON.stringify(liveBook), signal: ac.signal });
    return { res, reader: res.body!.getReader(), stop: () => ac.abort() };
  };

  it("an idle live query gets an empty line after keepAliveMs of silence, and none while frames flow", async () => {
    const { res, reader, stop } = await openLive("application/rayfold-frames+json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = new TextDecoder();
    let buf = "";
    const lines: string[] = [];
    const line = async (): Promise<string> => {
      while (!lines.length) {
        buf += text.decode((await bounded(reader.read(), "a chunk of the live response")).value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        lines.push(...parts);
      }
      return lines.shift()!;
    };
    expect(JSON.parse(await line())).toEqual({ id: 1, data: { $type: "Book", id: "b1", stock: 5 }, meta: { cost: 1 } });
    // the first interval saw the data frame, so only the second, silent one writes a keep-alive
    await vi.advanceTimersByTimeAsync(2000);
    expect(await line()).toBe("");
    await bs.server.collect({ ops: [restock] }, { viewer: admin });
    expect(JSON.parse(await line())).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 6 } }] });
    // guard: the interval right after a frame writes nothing; only the next silent one does
    await vi.advanceTimersByTimeAsync(1000);
    await bs.server.collect({ ops: [{ ...restock, key: KEY + "2" }] }, { viewer: admin });
    expect(JSON.parse(await line())).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 7 } }] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await line()).toBe("");
    stop();
  });

  it("over RB the keep-alive is a zero-length frame, which the decoder skips", async () => {
    const { res, reader, stop } = await openLive(RB_TYPE);
    expect(res.headers.get("content-type")).toBe(RB_TYPE);
    const d = new RbCodec(bs.server.ir).decoder();
    const chunk = async () => (await bounded(reader.read(), "a chunk of the live response")).value!;
    expect(d.feed(await chunk())).toEqual([{ id: 1, data: { $type: "Book", id: "b1", stock: 5 }, meta: { cost: 1 } }]);
    await vi.advanceTimersByTimeAsync(2000);
    const keepAlive = await chunk();
    expect([...keepAlive]).toEqual([0]);
    expect(d.feed(keepAlive)).toEqual([]);
    expect(d.pendingBytes).toBe(0);
    stop();
  });
});

const RB_TYPE = "application/rayfold";

describe("bodies that parse but are not envelopes (found by fuzzing)", () => {
  it("null, a number or a list is a 400 problem; ops that are not a list are refused as invalid, never a 500", async () => {
    const heads = [{}, { "rayfold-safe": "true" }, { accept: "application/json" }];
    for (const body of [null, 7, []]) {
      for (const headers of heads) {
        const res = await post(body, headers);
        expect(res.status, `${JSON.stringify(body)} ${JSON.stringify(headers)}`).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe("invalid_argument");
      }
    }
    const seen: unknown[] = [];
    for (const body of [{ ops: 5 }, { ops: [null] }, { ops: [1, "x"] }]) {
      for (const headers of heads) {
        const res = await post(body, headers);
        seen.push([JSON.stringify(body), JSON.stringify(headers), res.status, res.headers.get("content-type"), await res.text()]);
      }
    }
    const refusal = (message: string) => ({ error: { code: "invalid_argument", message }, fin: true });
    // a batch error frame in a stream (200); the frame as a single JSON document when one op was asked for as JSON
    // (400); a problem document when a safe request's ops cannot all be checked to be queries (400)
    const streamed = (message: string) => [200, "application/rayfold-frames+json", `${JSON.stringify(refusal(message))}\n`];
    const single = (message: string) => [400, "application/json; charset=utf-8", JSON.stringify(refusal(message))];
    const unsafe = [400, "application/problem+json", JSON.stringify({ type: "https://eddyboutros.github.io/rayfold/errors/invalid_argument", title: "invalid argument", status: 400, detail: "Safe requests (GET/QUERY) may only contain queries", code: "invalid_argument" })];
    const [plain, safe, json] = heads.map((h) => JSON.stringify(h));
    expect(seen).toEqual([
      ['{"ops":5}', plain, ...streamed("Body must be { ops: [...] }")],
      ['{"ops":5}', safe, ...streamed("Body must be { ops: [...] }")],
      ['{"ops":5}', json, ...streamed("Body must be { ops: [...] }")],
      ['{"ops":[null]}', plain, ...streamed("ops[0]: expected an object")],
      ['{"ops":[null]}', safe, ...unsafe],
      ['{"ops":[null]}', json, ...single("ops[0]: expected an object")],
      ['{"ops":[1,"x"]}', plain, ...streamed("ops[0]: expected an object")],
      ['{"ops":[1,"x"]}', safe, ...unsafe],
      ['{"ops":[1,"x"]}', json, ...streamed("ops[0]: expected an object")], // two ops: not a single-frame answer
    ]);
    // guard: a real envelope on the same route still runs
    expect((await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] }, { "rayfold-safe": "true" })).status).toBe(200);
  });
});
