import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { createFetchHandler } from "./fetch.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
import { MemoryCounters } from "./counters.ts";
import { RayfoldError } from "./protocol.ts";
import { Signal, bounded } from "../../../e2e/wait.ts";

/**
 * The endpoint as the runtimes without Node see it: a `Request` in, a `Response` out, no server listening. Everything
 * here runs the handler directly, which is what Workers, Deno, Bun, Hono and a Next.js route handler do with it.
 * `http.test.ts` drives the same handler through a Node socket, so between them the rules are checked once per shape.
 */
const KEY = "0123456789abcdef";
const admin = { id: "u9", role: "admin" };
let bs: ReturnType<typeof createBookstore>;
let handler: ReturnType<typeof createFetchHandler>;
beforeEach(() => {
  bs = createBookstore();
  handler = createFetchHandler(bs.server, { viewer: (r) => (r.headers.get("authorization") === "Bearer admin" ? admin : null) });
});

const post = (body: unknown, headers: Record<string, string> = {}, method = "POST", path = "/rayfold") =>
  handler(new Request(`http://api.example/${path.replace(/^\//, "")}`, { method, headers: { "content-type": "application/rayfold+json", ...headers }, body: JSON.stringify(body) }));
const get = (path: string, headers: Record<string, string> = {}) => handler(new Request(`http://api.example${path}`, { headers }));
const frames = async (res: Response): Promise<unknown[]> => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

afterEach(() => vi.useRealTimers());

describe("the fetch handler answers a batch", () => {
  it("streams frames, with the schema hash on the response", async () => {
    const res = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title }" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("rayfold-schema")).toBe(bs.server.hash);
    expect(res.headers.get("content-type")).toBe("application/rayfold-frames+json");
    expect(await frames(res)).toEqual([{ id: 1, data: { $type: "Book", id: "b1", title: "The Dispossessed" }, meta: { cost: 1 }, fin: true }]);
  });

  it("collapses a single-frame batch for a client asking for JSON, and takes the status from the frame", async () => {
    const ok = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] }, { accept: "application/json" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await ok.json()).toMatchObject({ id: 1, data: { id: "b1" } });

    const denied = await post({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY }] }, { accept: "application/json" });
    expect(denied.status).toBe(401); // no viewer: commands need one
    expect(await denied.json()).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("an unsafe batch is never stored, whichever body it answers with", async () => {
    // spec 07 §3. The single-frame branch returned before any cache header was set, so the one response a shared
    // cache is most likely to keep was the one that never said not to.
    const single = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] }, { accept: "application/json" });
    expect(single.headers.get("cache-control")).toBe("no-store");
    const streamed = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] });
    expect(streamed.headers.get("cache-control")).toBe("no-store");
    // guard: a batch the caller marked safe still gets its shared-cache headers instead
    const safe = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] }, { accept: "application/json", "rayfold-safe": "true" });
    expect(safe.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("runs a command for a viewer the handler derived from the request", async () => {
    const res = await post({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY }] }, { authorization: "Bearer admin", accept: "application/json" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: { $type: "Book", id: "b1" } });
  });

  it("serves a single query over GET, with the cache headers a shared cache reads", async () => {
    const res = await get(`/rayfold/book?a=${Buffer.from(JSON.stringify({ id: "b1" })).toString("base64url")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("etag")).toMatch(/^"sha256-[0-9a-f]{64}"$/);
    expect(res.headers.get("vary")).toBe("Rayfold-Client, Accept, Authorization");

    // and answers 304 when the client already has that version
    const again = await get(`/rayfold/book?a=${Buffer.from(JSON.stringify({ id: "b1" })).toString("base64url")}`, { "if-none-match": res.headers.get("etag")! });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("refuses what the transport must refuse before anything runs", async () => {
    const wrongType = await post({ ops: [] }, { "content-type": "text/plain" });
    expect(wrongType.status).toBe(415);
    expect(await wrongType.json()).toMatchObject({ code: "invalid_argument", type: expect.stringContaining("unsupported_media_type") });

    const crossSite = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" } }] }, { origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ code: "permission_denied" });

    const notJson = await handler(new Request("http://api.example/rayfold", { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: "{" }));
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ detail: "Body is not valid JSON" });

    const unknown = await get("/nowhere");
    expect(unknown.status).toBe(404);

    const commandOverGet = await get("/rayfold/restock");
    expect(commandOverGet.status).toBe(400);
    expect(await commandOverGet.json()).toMatchObject({ detail: "Safe requests (GET/QUERY) may only contain queries" });
  });

  it("refuses a body over the limit without reading it whole", async () => {
    const small = createFetchHandler(bs.server, { maxBody: 64 });
    const res = await small(
      new Request("http://api.example/rayfold", { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "x".repeat(200) } }] }) }),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "resource_exhausted", detail: "Body exceeds 64 bytes" });
  });

  it("serves the manifest, health and readiness", async () => {
    expect(await (await get("/rayfold/manifest")).json()).toMatchObject({ rayfold: "0.1", schemaHash: bs.server.hash });
    const health = await get("/rayfold/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await (await get("/rayfold/ready")).json()).toEqual({ ready: true, reasons: [] });
    expect((await get("/rayfold/manifest")).headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("a server that is shutting down sends the caller elsewhere", async () => {
    const draining = createRayfoldServer({ schema: `entity A { id: ID } query a: A`, resolvers: { Query: { a: () => ({ id: "a" }) } } });
    const drainingHandler = createFetchHandler(draining);
    const ask = () => drainingHandler(new Request("http://api.example/rayfold", { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: JSON.stringify({ ops: [{ id: 1, op: "a" }] }) }));
    // guard: the same server answers the same batch until it is told to drain, so the refusal below is the drain's
    expect(await frames(await ask())).toEqual([{ id: 1, data: { $type: "A", id: "a" }, meta: { cost: 1 }, fin: true }]);
    await draining.drain({ timeoutMs: 100 });
    const res = await ask();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await res.json()).toEqual({ type: "https://eddyboutros.github.io/rayfold/errors/unavailable", title: "unavailable", status: 503, detail: "The server is shutting down", code: "unavailable" });
    // guard: draining turns batches away, not the process: health on the same server still answers
    const health = await drainingHandler(new Request("http://api.example/rayfold/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });
});

describe("a response that stays open", () => {
  /** Reads a streaming response, recording each frame as it arrives. */
  function read(res: Response): { frames: Signal<unknown>; stop: () => Promise<void> } {
    const out = new Signal<unknown>();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const done = (async () => {
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buffer += decoder.decode(value, { stream: true });
          let at: number;
          while ((at = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            out.push(line === "" ? { keepAlive: true } : JSON.parse(line));
          }
        }
      } catch {
        /* cancelled by the test */
      }
    })();
    return {
      frames: out,
      stop: async () => {
        await reader.cancel().catch(() => undefined);
        await bounded(done, "the stream ending");
      },
    };
  }

  it("pushes a live query's changes as they happen", async () => {
    const res = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true }] });
    expect(res.headers.get("content-type")).toBe("application/rayfold-frames+json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const live = read(res);
    await live.frames.atLeast(1, "the first result");

    await post({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 3 }, key: KEY + "b" }] }, { authorization: "Bearer admin" });
    await live.frames.atLeast(2, "the change");
    expect(live.frames.items).toEqual([
      { id: 1, data: { $type: "Book", id: "b1", stock: 5 }, meta: { cost: 1 } },
      { id: 1, patch: [{ set: "Book:b1", value: { stock: 8 } }] },
    ]);
    await live.stop();
  });

  it("sends a keep-alive when nothing has happened, so an idle live query is not closed by a proxy", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const quiet = createFetchHandler(bs.server, { keepAliveMs: 1_000, viewer: () => admin });
    const res = await quiet(
      new Request("http://api.example/rayfold", { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true }] }) }),
    );
    const live = read(res);
    const restock = (key: string) => bs.server.collect({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key }] }, { viewer: admin });
    await live.frames.atLeast(1, "the first result");
    // the first interval saw the data frame, so only the second, silent one writes a keep-alive
    await vi.advanceTimersByTimeAsync(2_000);
    await live.frames.atLeast(2, "the keep-alive");
    await restock(KEY + "k1");
    await live.frames.atLeast(3, "the first change");
    // guard: the interval right after a frame writes nothing, so the next thing on the wire is the second change
    await vi.advanceTimersByTimeAsync(1_000);
    await restock(KEY + "k2");
    await live.frames.atLeast(4, "the second change");
    await vi.advanceTimersByTimeAsync(2_000);
    await live.frames.atLeast(5, "the keep-alive after the changes stopped");
    expect(live.frames.items).toEqual([
      { id: 1, data: { $type: "Book", id: "b1", stock: 5 }, meta: { cost: 1 } },
      { keepAlive: true },
      { id: 1, patch: [{ set: "Book:b1", value: { stock: 6 } }] },
      { id: 1, patch: [{ set: "Book:b1", value: { stock: 7 } }] },
      { keepAlive: true },
    ]);
    await live.stop();
  });
});

describe("identity and GET /rayfold/stats", () => {
  let t = 0;
  const server = (identity?: Record<string, unknown>) =>
    createRayfoldServer({
      schema: `entity A { id: ID } query a: A`,
      resolvers: { Query: { a: () => ({ id: "a" }) } },
      now: () => t,
      ...(identity ? { identity } : {}),
    });

  const statsHandler = (stats?: { authorize: (r: Request) => boolean | Promise<boolean> }) =>
    createFetchHandler(server({ name: "bookshop", version: "1.4.0", labels: { region: "eu-west" } }), stats ? { stats } : {});

  const get = (h: ReturnType<typeof createFetchHandler>, headers: Record<string, string> = {}) =>
    h(new Request("http://api.example/rayfold/stats", { headers }));

  it("says who the server is and what it is doing", async () => {
    t = 1_000;
    const s = server({ name: "bookshop", version: "1.4.0", labels: { region: "eu-west" } });
    t = 3_500; // the server's own clock, not the wall's, says how long it has been up
    const res = await get(createFetchHandler(s, { stats: { authorize: () => true } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { identity: { instance: string } };
    // an instance id and a start time are always there, whether or not one was supplied
    expect(body.identity.instance).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body).toEqual({
      identity: { name: "bookshop", version: "1.4.0", labels: { region: "eu-west" }, instance: body.identity.instance, startedAt: 1_000 },
      uptimeMs: 2_500,
      rayfold: "0.1",
      schemaHash: s.hash,
      extensions: [],
      inflight: 0,
      draining: false,
      ready: true,
      reasons: [],
      live: 0,
    });
  });

  it("does not exist unless it was configured, rather than refusing", async () => {
    // an unconfigured server must look from outside like one that never had the route at all
    expect((await get(statsHandler())).status).toBe(404);
  });

  it("refuses a caller its authorize function turned down", async () => {
    const h = statsHandler({ authorize: (r) => r.headers.get("authorization") === "Bearer ops" });
    expect((await get(h)).status).toBe(403);
    // guard: the same route answers the caller it allows, so the refusal is the function's doing and not a blanket one
    expect((await get(h, { authorization: "Bearer ops" })).status).toBe(200);
  });

  it("gives two servers different instance ids, and keeps one a server was given", async () => {
    expect(server().identity.instance).not.toBe(server().identity.instance);
    expect(server({ instance: "web-3" }).identity.instance).toBe("web-3");
  });
});

describe("counters", () => {
  const counted = () => {
    const counters = new MemoryCounters();
    const server = createRayfoldServer({
      schema: `entity A { id: ID  n: Int } error OutOfStock { id: ID } query a: A command bump(id: ID): A command refuse(id: ID): A throws OutOfStock`,
      resolvers: {
        Query: { a: () => ({ id: "a", n: 1 }) },
        Command: {
          bump: () => ({ id: "a", n: 2 }),
          refuse: ({ id }: { id: string }) => {
            throw RayfoldError.domain("OutOfStock", { id });
          },
        },
      },
      counters,
    });
    return { counters, server, handler: createFetchHandler(server, { allowedOrigins: ["https://app.example"] }) };
  };
  const find = (c: MemoryCounters, name: string, labels: Record<string, string>) =>
    c.snapshot().find((e) => e.name === name && Object.entries(labels).every(([k, v]) => e.labels[k] === v))?.count ?? 0;

  it("counts a refusal nothing else can see", async () => {
    // a 415 is answered and returned before execute() is called, so no Instrumentation hook ever sees it
    const { counters, handler } = counted();
    await handler(new Request("http://api.example/rayfold", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }));
    expect(find(counters, "rayfold.refused", { reason: "media" })).toBe(1);

    await handler(
      new Request("http://api.example/rayfold", {
        method: "POST",
        headers: { "content-type": "application/rayfold+json", origin: "https://evil.example" },
        body: JSON.stringify({ ops: [{ id: 1, op: "a" }] }),
      }),
    );
    expect(find(counters, "rayfold.refused", { reason: "origin" })).toBe(1);
    expect(find(counters, "rayfold.refused", { reason: "route" })).toBe(0); // guard: reasons are not interchangeable
    // every request is counted as it arrives, refused or not; neither of these reached an op
    expect(counters.snapshot()).toEqual([
      { name: "rayfold.refused", labels: { reason: "media" }, count: 1 },
      { name: "rayfold.refused", labels: { reason: "origin" }, count: 1 },
      { name: "rayfold.requests", labels: { method: "POST" }, count: 2 },
    ]);
  });

  it("counts an op by kind and how it ended, without any instrumentation configured", async () => {
    const { counters, server } = counted();
    await server.collect({ ops: [{ id: 1, op: "a", shape: "{ id }" }] }, {});
    await server.collect({ ops: [{ id: 1, op: "a", shape: "{ nope }" }] }, {}); // refused while planning: an op that never ran
    await server.collect({ ops: [{ id: 1, op: "nope" }] }, {}); // refused with the envelope, before there is an op to count
    expect(counters.snapshot()).toEqual([
      { name: "rayfold.errors", labels: { op: "a", code: "invalid_argument", type: "" }, count: 1 },
      { name: "rayfold.ops", labels: { kind: "query", outcome: "invalid_argument" }, count: 1 },
      { name: "rayfold.ops", labels: { kind: "query", outcome: "ok" }, count: 1 },
    ]);
  });

  it("names the declared error, which a wire code alone cannot", async () => {
    // every declared error is `domain` on the wire, so counting the code would put a schema's whole error vocabulary
    // in one bucket and an operator could never see which one is firing
    const { counters, server } = counted();
    await server.collect({ ops: [{ id: 1, op: "refuse", args: { id: "a" }, key: KEY }] }, { viewer: { id: "u1" } });
    await server.collect({ ops: [{ id: 1, op: "a", shape: "{ nope }" }] }, {});
    expect(find(counters, "rayfold.errors", { op: "refuse", code: "domain", type: "OutOfStock" })).toBe(1);
    expect(find(counters, "rayfold.errors", { op: "a", code: "invalid_argument", type: "" })).toBe(1);

    // guard: an op that succeeded is not in there at all
    await server.collect({ ops: [{ id: 1, op: "a", shape: "{ id }" }] }, {});
    expect(find(counters, "rayfold.errors", { op: "a", code: "ok" })).toBe(0);
    expect(counters.snapshot().filter((e) => e.name === "rayfold.errors")).toHaveLength(2);
  });

  it("counts what the idempotency claim decided", async () => {
    const { counters, server } = counted();
    const key = "0123456789abcdef";
    // an idempotency key needs an identified caller: records are scoped per viewer, so anonymous callers would
    // otherwise share one scope (spec 12 §4.4)
    const viewer = { id: "u1" };
    await server.collect({ ops: [{ id: 1, op: "bump", args: { id: "a" }, key }] }, { viewer });
    expect(find(counters, "rayfold.idempotency", { claim: "owned" })).toBe(1);
    await server.collect({ ops: [{ id: 1, op: "bump", args: { id: "a" }, key }] }, { viewer });
    // the retry replayed rather than running again, and the counter says so
    expect(find(counters, "rayfold.idempotency", { claim: "done" })).toBe(1);
  });

  it("a full sink says so instead of going quiet", () => {
    // MemoryUsage stops recording when it is full, which leaves a graph that keeps drawing and stops being true.
    // Counters must not repeat that: past the bound, known series keep counting and the drops are reported.
    const c = new MemoryCounters(2);
    c.add("a", 1, { x: "1" });
    c.add("b", 1, { x: "1" });
    c.add("c", 1, { x: "1" });
    expect(c.size).toBe(2);
    expect(c.dropped).toBe(1);
    c.add("a", 5, { x: "1" });
    expect(find(c, "a", { x: "1" })).toBe(6); // a series it already knows still counts
  });

  it("labels in any order are one series", () => {
    const c = new MemoryCounters();
    c.add("x", 1, { a: "1", b: "2" });
    c.add("x", 1, { b: "2", a: "1" });
    expect(c.snapshot()).toHaveLength(1);
    expect(c.snapshot()[0]!.count).toBe(2);
  });

  it("a server given no sink counts nothing and does not fail", async () => {
    const server = createRayfoldServer({ schema: `entity A { id: ID } query a: A`, resolvers: { Query: { a: () => ({ id: "a" }) } } });
    expect(server.counters).toBeUndefined();
    expect((await server.collect({ ops: [{ id: 1, op: "a", shape: "{ id }" }] }, {}))[0]).toMatchObject({ id: 1 });
  });
});

/** A stream of `size`-character items: endless unless `count` is given, waiting for `ack(n)` after item n when given. */
function chunkServer(size: number, opts: { count?: number; ack?: (n: number) => Promise<void> } = {}) {
  const yielded = new Signal<number>();
  const ended = new Signal<true>();
  const server = createRayfoldServer({
    schema: `event Chunk { n: Int body: String } stream chunks: Chunk`,
    resolvers: {
      Stream: {
        chunks: async function* (_args: unknown, ctx: { signal: AbortSignal }) {
          try {
            for (let n = 0; (opts.count === undefined || n < opts.count) && !ctx.signal.aborted; n++) {
              yielded.push(n);
              yield { n, body: "x".repeat(size) };
              await opts.ack?.(n);
            }
          } finally {
            ended.push(true);
          }
        },
      },
    } as never,
    maxStreamItems: 100_000,
  });
  return { server, yielded, ended };
}
const chunkBatch = { ops: [{ id: 1, op: "chunks", shape: "{ n body }" }] };
const chunkFrame = (n: number, size: number) => ({ id: 1, item: { n, body: "x".repeat(size) } });

describe("a client that stops reading a streaming response", () => {
  const ask = (handle: ReturnType<typeof createFetchHandler>) =>
    handle(new Request("http://api.example/rayfold", { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: JSON.stringify(chunkBatch) }));

  it("stops the batch once maxBuffered bytes wait for it, and the body ends in an error after the frames that fit", async () => {
    const size = 16 * 1024;
    const { server, yielded, ended } = chunkServer(size);
    const res = await ask(createFetchHandler(server, { maxBuffered: 64 * 1024 }));
    // nothing reads the body: the endless resolver is stopped rather than buffered for ever
    await ended.atLeast(1, "the resolver told to stop");
    // frames join the queue while it is under the bound: the first frame to arrive at a full queue is the last one kept
    const frameBytes = JSON.stringify(chunkFrame(0, size)).length + 1;
    const kept = Math.ceil((64 * 1024) / frameBytes) + 1;
    expect(yielded.items.length).toBeLessThan(kept + 3); // the resolver may be an item or two ahead when it is told
    const reader = res.body!.getReader();
    const text: string[] = [];
    const decoder = new TextDecoder();
    const failure = await (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return null;
          text.push(decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        return e;
      }
    })();
    expect(failure).toBeInstanceOf(RayfoldError);
    expect(failure).toMatchObject({ code: "resource_exhausted", message: "The client stopped reading the response" });
    // an errored body drops what it still held, so a late reader sees a prefix of the frames that fit, then the error
    const seen = text.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(seen.length).toBeLessThanOrEqual(kept);
    expect(seen).toEqual(Array.from({ length: seen.length }, (_, n) => chunkFrame(n, size)));
  });

  it("guard: a client that keeps reading gets every frame of a stream far larger than maxBuffered", async () => {
    const size = 16 * 1024;
    const read = new Signal<number>();
    const { server } = chunkServer(size, { count: 40, ack: (n) => read.until((xs) => xs.includes(n), `item ${n} read`).then(() => undefined) });
    const res = await ask(createFetchHandler(server, { maxBuffered: 64 * 1024 }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const got: unknown[] = [];
    let buffer = "";
    for (;;) {
      const { value, done } = await bounded(reader.read(), "the next chunk");
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const f = JSON.parse(buffer.slice(0, at)) as { item?: { n: number } };
        buffer = buffer.slice(at + 1);
        got.push(f);
        if (f.item) read.push(f.item.n);
      }
    }
    expect(got).toEqual([...Array.from({ length: 40 }, (_, n) => chunkFrame(n, size)), { id: 1, fin: true }]);
  });

  it("cancelling the body ends the batch: a live query is unsubscribed though the request itself was never aborted", async () => {
    const subscribed = new Signal<"on" | "off">();
    const subscribe = bs.server.changes.subscribe.bind(bs.server.changes);
    vi.spyOn(bs.server.changes, "subscribe").mockImplementation((fn) => {
      const off = subscribe(fn);
      subscribed.push("on");
      return () => {
        off();
        subscribed.push("off");
      };
    });
    const res = await post({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true }] });
    const reader = res.body!.getReader();
    await bounded(reader.read(), "the first result");
    // guard: while the body is being read, the live query stays subscribed
    expect(bs.server.changes.size).toBe(1);
    await reader.cancel();
    await subscribed.until((xs) => xs.includes("off"), "the live query unsubscribed");
    expect(bs.server.changes.size).toBe(0);
    expect(subscribed.items).toEqual(["on", "off"]);
  });
});

describe("CORS for the configured origins (spec 04 §4b)", () => {
  const cors = () => createFetchHandler(bs.server, { allowedOrigins: ["https://app.example"], viewer: () => admin });
  const preflight = (h: ReturnType<typeof createFetchHandler>, origin: string) =>
    h(new Request("http://api.example/rayfold", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } }));
  const bookUrl = `http://api.example/rayfold/book?a=${Buffer.from(JSON.stringify({ id: "b1" })).toString("base64url")}`;

  it("answers a preflight from an allowed origin with 204 and the headers that let it through, from allowedOrigins alone", async () => {
    const res = await preflight(cors(), "https://app.example");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, QUERY, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, Authorization, Rayfold-Client, Rayfold-Deadline, Rayfold-Safe, Rayfold-Upload-Name, Rayfold-Upload-Type");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(await res.text()).toBe("");
  });

  it("guard: a preflight from another origin gets no Access-Control-Allow-* headers, so the browser stops there", async () => {
    const res = await preflight(cors(), "https://evil.example");
    expect(res.status).toBe(204);
    expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  it("the answer to an allowed origin is readable by it, and a cacheable one varies by origin", async () => {
    const h = cors();
    const write = await h(
      new Request("http://api.example/rayfold", {
        method: "POST",
        headers: { origin: "https://app.example", "content-type": "application/rayfold+json" },
        body: JSON.stringify({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY }] }),
      }),
    );
    expect(write.status).toBe(200);
    expect(write.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const read = await h(new Request(bookUrl, { headers: { origin: "https://app.example" } }));
    expect(read.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(read.headers.get("vary")).toBe("Rayfold-Client, Accept, Authorization, Origin");
    // guard: a read from an origin not listed is still answered, but not made readable to that origin
    const foreign = await h(new Request(bookUrl, { headers: { origin: "https://evil.example" } }));
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    expect(foreign.headers.get("vary")).toBe("Rayfold-Client, Accept, Authorization");
  });
});

describe("stale-while-revalidate over several @cache declarations (spec 07 §2)", () => {
  const server = (querySwr: string) =>
    createRayfoldServer({
      schema: `entity Note @cache(maxAge: 60s, swr: 300s) { id: ID } query note: Note @cache(maxAge: 30s${querySwr})`,
      resolvers: { Query: { note: () => ({ id: "n1" }) } } as never,
    });
  const cacheControl = async (s: RayfoldServer) => (await createFetchHandler(s)(new Request("http://api.example/rayfold/note"))).headers.get("cache-control");

  it("takes the smallest swr, as it takes the smallest maxAge", async () => {
    expect(await cacheControl(server(", swr: 10s"))).toBe("public, max-age=30, stale-while-revalidate=10");
  });

  it("guard: a declaration without swr does not count, so the one that has it decides", async () => {
    expect(await cacheControl(server(""))).toBe("public, max-age=30, stale-while-revalidate=300");
  });
});
