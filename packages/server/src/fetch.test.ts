import { afterEach, describe, expect, it, vi } from "vitest";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { createFetchHandler } from "./fetch.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
import { Signal, bounded } from "../../../e2e/wait.ts";

/**
 * The endpoint as the runtimes without Node see it: a `Request` in, a `Response` out, no server listening. Everything
 * here runs the handler directly, which is what Workers, Deno, Bun, Hono and a Next.js route handler do with it.
 * `http.test.ts` drives the same handler through a Node socket, so between them the rules are checked once per shape.
 */
const KEY = "0123456789abcdef";
const admin = { id: "u9", role: "admin" };
const bs = createBookstore();
const handler = createFetchHandler(bs.server, { viewer: (r) => (r.headers.get("authorization") === "Bearer admin" ? admin : null) });

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

  it("runs a command for a viewer the handler derived from the request", async () => {
    const res = await post({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY }] }, { authorization: "Bearer admin", accept: "application/json" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: { $type: "Book", id: "b1" } });
  });

  it("serves a single query over GET, with the cache headers a shared cache reads", async () => {
    const res = await get(`/rayfold/book?a=${Buffer.from(JSON.stringify({ id: "b1" })).toString("base64url")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/^public, max-age=\d+/);
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
    await draining.drain({ timeoutMs: 100 });
    const res = await drainingHandler(new Request("http://api.example/rayfold", { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: JSON.stringify({ ops: [{ id: 1, op: "a" }] }) }));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect((await get("/rayfold/health")).status).toBe(200); // guard: a live server still answers
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
    const [, change] = await live.frames.atLeast(2, "the change");
    expect(change).toMatchObject({ id: 1, patch: [{ set: "Book:b1" }] });
    await live.stop();
  });

  it("sends a keep-alive when nothing has happened, so an idle live query is not closed by a proxy", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const quiet = createFetchHandler(bs.server, { keepAliveMs: 1_000, viewer: () => admin });
    const res = await quiet(
      new Request("http://api.example/rayfold", { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }", live: true }] }) }),
    );
    const live = read(res);
    await live.frames.atLeast(1, "the first result");
    await vi.advanceTimersByTimeAsync(2_000);
    const seen = live.frames.items.filter((f) => (f as { keepAlive?: boolean }).keepAlive);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    await live.stop();
  });
});
