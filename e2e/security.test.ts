/**
 * Security end to end (spec 12). Every attack from the security audit is sent to a running Rayfold stack (the batch
 * endpoint, REST-style bindings, MCP and WebSocket) over real sockets. Each test proves the attack is refused and
 * that honest use of the same entry point still works. Results, with the recorded request and response, are written
 * to e2e/security.json, which the report page shows.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { createRayfoldServer, listen, MemoryIdempotencyStore } from "@rayfold/server";
import { RbCodec } from "@rayfold/rb";
import { loadSchema } from "@rayfold/schema";
import { bookstoreSchemaText, createBookstore } from "../examples/bookstore-ts/src/index.ts";
import { MemoryShapeRegistry } from "../packages/server/src/views.ts";
import { freshStore, startRayfold, type Exchange } from "./harness.ts";
import { Signal, bounded } from "./wait.ts";

interface Attack { area: string; attack: string; defence: string; guard: string; runtimes: string[]; result: string; exchange?: Exchange }
const attacks: Attack[] = [];
const BOTH = ["TypeScript", "Kotlin"];
const TS = ["TypeScript"];
const EVIL = "https://evil.example";
const KEY = "attack-key-0000000001";
const JSON_HEADERS = { "content-type": "application/rayfold+json" };
const SHOWN_REQ = ["content-type", "origin", "host", "authorization", "idempotency-key", "accept"];
const SHOWN_RES = ["content-type", "x-content-type-options", "cache-control", "accept-post", "allow"];

/** Records the outcome, then asserts it: the JSON only ever says "refused" for an attack that really was. */
function report(a: Omit<Attack, "result">, refused: boolean): void {
  attacks.push({ ...a, result: refused ? "refused" : "NOT refused" });
  expect(refused, a.attack).toBe(true);
}
afterAll(() => {
  writeFileSync("e2e/security.json", JSON.stringify({ generatedAt: new Date().toISOString(), attacks }, null, 2) + "\n");
});

type Rayfold = Awaited<ReturnType<typeof startRayfold>>;
let rayfold: Rayfold;
const extra: Server[] = [];
beforeEach(async () => {
  rayfold = await startRayfold(freshStore());
});
afterEach(async () => {
  await rayfold.close();
  await Promise.all(extra.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); })));
});

const clip = (s: string) => (s.length > 900 ? `${s.slice(0, 900)}… (${s.length.toLocaleString("en-US")} characters in all)` : s);
const pick = (h: Record<string, string | string[] | undefined>, keys: string[]) =>
  Object.fromEntries(Object.entries(h).filter(([k, v]) => keys.includes(k.toLowerCase()) && typeof v === "string").map(([k, v]) => [k.toLowerCase(), v as string]));

/** A raw HTTP request, so headers a browser sets (Origin, and Host under DNS rebinding) can be sent as a browser would. */
function raw(base: string, method: string, path: string, headers: Record<string, string>, body?: string | Uint8Array): Promise<{ status: number; body: string; headers: IncomingHttpHeaders; ex: Exchange }> {
  const u = new URL(base);
  return bounded(
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers,
            ex: {
              request: { method, target: path, headers: pick({ host: `${u.hostname}:${u.port}`, ...headers }, SHOWN_REQ), ...(body !== undefined ? { body: typeof body === "string" ? clip(body) : `(${body.length} bytes of RB)` } : {}) },
              response: { status: res.statusCode ?? 0, headers: pick(res.headers as Record<string, string>, SHOWN_RES), body: clip(data) },
            },
          }),
        );
      });
      req.on("error", reject);
      req.end(body);
    }),
    `${method} ${path}`,
  );
}
const post = (path: string, headers: Record<string, string>, body: unknown) => raw(rayfold.base, "POST", path, headers, typeof body === "string" ? body : JSON.stringify(body));
const framesOf = (text: string) => text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

/**
 * WebSocket opening handshake over a raw socket (node:http's client does not report a refused upgrade reliably).
 * Resolves with 101 and the open socket, or with the refusal's status and body once the server closes.
 */
function upgrade(headers: Record<string, string> = {}): Promise<{ status: number; socket?: Socket; body: string; ex: Exchange }> {
  const u = new URL(rayfold.base);
  const all: Record<string, string> = { Host: `${u.hostname}:${u.port}`, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers };
  const ex = (status: number, body: string): Exchange => ({ request: { method: "GET", target: "/rayfold/ws", headers: pick(all, [...SHOWN_REQ, "upgrade"]) }, response: { status, headers: {}, body } });
  return bounded(
    new Promise((resolve, reject) => {
      const socket = connect(Number(u.port), u.hostname);
      let buf = Buffer.alloc(0);
      let status = 0;
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const end = buf.indexOf("\r\n\r\n");
        if (status || end < 0) return;
        status = Number(buf.subarray(0, end).toString("latin1").split(" ")[1]);
        if (status === 101) {
          socket.off("data", onData);
          resolve({ status, socket, body: "", ex: ex(101, "") });
        }
      };
      socket.on("data", onData);
      socket.on("close", () => {
        if (status === 101) return;
        const text = buf.toString("utf8");
        const body = text.slice(text.indexOf("\r\n\r\n") + 4);
        resolve({ status, body, ex: ex(status, body) });
      });
      socket.on("error", reject);
      socket.write(`GET /rayfold/ws?auth=Bearer%20u1 HTTP/1.1\r\n${Object.entries(all).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    }),
    "WebSocket handshake",
  );
}

/** One masked client frame (RFC 6455 requires clients to mask; a zero mask keeps the bytes readable). */
function clientFrame(payload: Buffer, announced = payload.length): Buffer {
  const head = announced < 126 ? Buffer.from([0x81, 0x80 | announced]) : announced < 65536 ? Buffer.from([0x81, 0x80 | 126, announced >> 8, announced & 0xff]) : Buffer.concat([Buffer.from([0x81, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(announced)); return b; })()]);
  return Buffer.concat([head, Buffer.alloc(4), payload]);
}

// --------------------------------------------------------------------------------------------- browsers
describe("Requests a web page could make", () => {
  const area = "Requests a web page could make";
  const restock = (qty: number) => ({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty }, key: KEY }] });

  it("a command posted as text/plain, which browsers send across sites without asking, is refused", async () => {
    const before = rayfold.store.books.get("b1")!.stock;
    const attack = await post("/rayfold", { "content-type": "text/plain", origin: EVIL, authorization: "Bearer admin" }, restock(50));
    const refused = attack.status === 415 && rayfold.store.books.get("b1")!.stock === before;
    report({ area, attack: "A web page posts a command as text/plain, the one body type browsers send to other sites without a preflight check.", defence: "Bodies must be application/rayfold+json, application/json or application/rayfold; anything else gets 415 before parsing.", guard: "The same command sent as application/rayfold+json runs.", runtimes: BOTH, exchange: attack.ex }, refused);
    const honest = await post("/rayfold", { ...JSON_HEADERS, authorization: "Bearer admin" }, restock(50));
    expect(framesOf(honest.body)[0]).toMatchObject({ ok: { stock: before + 50 } });
  });

  it("a command from a foreign Origin is refused even with a JSON body", async () => {
    const before = rayfold.store.books.get("b1")!.stock;
    const attack = await post("/rayfold", { ...JSON_HEADERS, origin: EVIL, authorization: "Bearer admin" }, restock(50));
    report({ area, attack: "A page on another site sends a JSON command with the user's credentials.", defence: "Requests that change data and carry an Origin must come from the server's own origin or an allowed one; others get 403.", guard: "The same request from the server's own origin runs.", runtimes: BOTH, exchange: attack.ex }, attack.status === 403 && rayfold.store.books.get("b1")!.stock === before);
    const own = await post("/rayfold", { ...JSON_HEADERS, origin: rayfold.base, authorization: "Bearer admin" }, restock(50));
    expect(framesOf(own.body)[0]).toMatchObject({ ok: { stock: before + 50 } });
  });

  it("a plain HTML form posting to a REST-style route is refused", async () => {
    const placed = framesOf((await post("/rayfold", { ...JSON_HEADERS, authorization: "Bearer u1" }, { ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: KEY }] })).body)[0] as { ok: { id: string } };
    const id = placed.ok.id;
    const attack = await raw(rayfold.base, "POST", `/orders/${id}/pay`, { "content-type": "application/x-www-form-urlencoded", origin: EVIL, authorization: "Bearer u1" }, "");
    report({ area, attack: "An HTML form on another site posts to POST /orders/{id}/pay, a route with no body.", defence: "The Origin check covers the REST-style routes too, and POST routes also require an Idempotency-Key header, which a form cannot set.", guard: "The same POST from an app, with its Idempotency-Key, pays the order.", runtimes: BOTH, exchange: attack.ex }, attack.status === 403 && rayfold.store.orders.get(id)!.status === "PLACED");
    const honest = await raw(rayfold.base, "POST", `/orders/${id}/pay`, { "idempotency-key": `${KEY}-pay`, authorization: "Bearer u1" }, "");
    expect(honest.status).toBe(200);
    expect(rayfold.store.orders.get(id)!.status).toBe("PAID");
  });

  it("DNS rebinding: a page that renames its own domain to 127.0.0.1 cannot read the local server", async () => {
    const port = new URL(rayfold.base).port;
    const attack = await raw(rayfold.base, "GET", "/rayfold/manifest", { host: `evil.example:${port}` });
    report({ area, attack: "A page renames its own domain to 127.0.0.1 (DNS rebinding) to talk to a server on the user's machine as if it were the same site.", defence: "A server reached on a loopback address answers only loopback host names (localhost, 127.0.0.1, [::1]); other Host headers get 403.", guard: "The same request with Host 127.0.0.1 is answered.", runtimes: BOTH, exchange: attack.ex }, attack.status === 403);
    expect((await raw(rayfold.base, "GET", "/rayfold/manifest", { host: `127.0.0.1:${port}` })).status).toBe(200);
  });

  it("MCP: a web page cannot drive the local AI-tool endpoint", async () => {
    const before = rayfold.store.books.get("b1")!.stock;
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "restock", arguments: { bookId: "b1", qty: 5 } } };
    const attack = await post("/mcp", { "content-type": "application/json", origin: EVIL, authorization: "Bearer admin" }, call);
    report({ area, attack: "A web page sends tools/call to the MCP endpoint of a Rayfold server on the user's machine or intranet.", defence: "MCP requests with a foreign Origin get 403, as the MCP specification requires, and loopback servers check the Host header.", guard: "An AI client (no browser Origin) lists and calls tools.", runtimes: BOTH, exchange: attack.ex }, attack.status === 403 && rayfold.store.books.get("b1")!.stock === before);
    const honest = await post("/mcp", { "content-type": "application/json", authorization: "Bearer admin" }, call);
    expect(JSON.parse(honest.body)).toMatchObject({ result: { structuredContent: { result: { stock: before + 5 } } } });
  });

  it("MCP: a text/plain body is refused", async () => {
    const attack = await post("/mcp", { "content-type": "text/plain" }, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    report({ area, attack: "A page sends MCP JSON-RPC as text/plain to avoid the browser's preflight check.", defence: "The MCP endpoint accepts only application/json (415 otherwise).", guard: "tools/list as application/json is answered.", runtimes: BOTH, exchange: attack.ex }, attack.status === 415);
    expect((await post("/mcp", { "content-type": "application/json" }, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
  });

  it("a WebSocket opened by a foreign page is refused at the handshake", async () => {
    const attack = await upgrade({ Origin: EVIL });
    attack.socket?.destroy();
    report({ area, attack: "A page on another site opens a WebSocket to Rayfold; the browser attaches the user's cookies to the handshake.", defence: "The handshake is refused with 403 unless the Origin is the server's own or allowed (and the Host is valid).", guard: "A client without a foreign Origin gets 101 Switching Protocols.", runtimes: BOTH, exchange: attack.ex }, attack.status === 403 && !attack.socket);
    const honest = await upgrade();
    expect(honest.status).toBe(101);
    honest.socket?.destroy();
  });
});

// --------------------------------------------------------------------------------------------- overload
describe("Overload and resource exhaustion", () => {
  const area = "Overload and resource exhaustion";

  it("arguments nested 10,000 levels deep are refused before anything walks them", async () => {
    const deep = '{"ops":[{"id":1,"op":"book","args":{"id":' + '{"x":'.repeat(10_000) + '"b1"' + "}".repeat(10_000) + "}}]}";
    const attack = await post("/rayfold", { ...JSON_HEADERS, accept: "application/json" }, deep);
    report({ area, attack: "A request nests its arguments 10,000 levels deep to exhaust the server's stack.", defence: "Arguments and variables deeper than 64 levels fail the batch with invalid_argument, checked without recursion.", guard: "A normal request is answered.", runtimes: BOTH, exchange: attack.ex }, attack.status === 400 && attack.body.includes("nested deeper than 64 levels") && rayfold.store.calls["Query.book"] === undefined);
    expect((await post("/rayfold", { ...JSON_HEADERS, accept: "application/json" }, { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] })).status).toBe(200);
  });

  it("a shape nested 5,000 levels deep is refused while parsing", async () => {
    const shape = "{ " + "author { books { items { ".repeat(1_700) + "id" + " } } }".repeat(1_700) + " }";
    const attack = await post("/rayfold", { ...JSON_HEADERS, accept: "application/json" }, { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape }] });
    report({ area, attack: "A shape nested 5,000 levels deep, to make the parser recurse until it crashes.", defence: "The shape parser stops at 64 levels of nesting and answers invalid_argument; execution depth is capped separately (8 by default).", guard: "A shape nested a few levels runs.", runtimes: BOTH, exchange: attack.ex }, attack.status === 400 && attack.body.includes("nested deeper than 64 levels"));
    expect((await post("/rayfold", { ...JSON_HEADERS, accept: "application/json" }, { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ author { books { items { id } } } }" }] })).status).toBe(200);
  });

  it("a junk op cannot lower a batch's cost below the budget", async () => {
    const heavy = (id: number) => ({ id, op: "books", args: { page: { first: 200 } }, shape: "{ items { id title author { name } } }" });
    const attack = await post("/rayfold", JSON_HEADERS, { ops: [heavy(1), heavy(2), heavy(3), { id: 4, op: "books", args: { page: { first: -100000 } } }] });
    const f = framesOf(attack.body);
    report({ area, attack: "Three expensive list queries plus a fourth with a page size of -100,000, hoping the negative size cancels out their cost.", defence: "An op with invalid arguments never runs and costs 0; untrusted page sizes count as the largest page; every op costs at least 1.", guard: "One of the expensive queries alone fits the budget and runs.", runtimes: BOTH, exchange: attack.ex }, f.length === 1 && (f[0]!["error"] as { code: string }).code === "resource_exhausted" && rayfold.store.calls["Query.books"] === undefined);
    expect(framesOf((await post("/rayfold", JSON_HEADERS, { ops: [heavy(1)] })).body)[0]).toMatchObject({ data: {} });
  });

  it("a body larger than the limit is refused and never parsed", async () => {
    const attack = await post("/rayfold", JSON_HEADERS, { ops: [{ id: 1, op: "book", args: { id: "b1", pad: "x".repeat(1_500_000) } }] });
    report({ area, attack: "A 1.5 MB request body, to make the server buffer and parse huge input.", defence: "Bodies over the limit (1 MiB by default) get 413 Content Too Large; the rest of the upload is drained up to a bound, then the connection is cut.", guard: "A normal body is answered.", runtimes: BOTH, exchange: attack.ex }, attack.status === 413 && rayfold.store.calls["Query.book"] === undefined);
    expect((await post("/rayfold", JSON_HEADERS, { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] })).status).toBe(200);
  });

  it("a WebSocket frame announcing 2 MiB is cut off before it is buffered", async () => {
    const hs = await upgrade();
    expect(hs.status).toBe(101);
    const socket = hs.socket!;
    const received: Buffer[] = [];
    socket.on("data", (c: Buffer) => received.push(c));
    socket.on("error", () => undefined); // the server closes while we are still sending
    const closed = new Promise<void>((r) => socket.once("close", () => r()));
    socket.write(clientFrame(Buffer.alloc(0), 2 * 1024 * 1024));
    for (let sent = 0; sent < 1_200_000 && !socket.destroyed; sent += 65_536) socket.write(Buffer.alloc(65_536));
    await bounded(closed, "server closed the oversized WebSocket");
    const all = Buffer.concat(received);
    const at = all.indexOf(0x88);
    const code = at >= 0 ? all.readUInt16BE(at + 2) : 0;
    report({ area, attack: "A WebSocket client announces a 2 MiB frame and keeps streaming, to fill the server's memory.", defence: "Frames and assembled messages over 1 MiB close the connection with code 1009 (message too big).", guard: "A normal message on a new socket is answered.", runtimes: BOTH, exchange: { request: { method: "WebSocket frame", target: "/rayfold/ws", headers: {}, body: "text frame announcing 2,097,152 bytes, then 1.2 MB of data" }, response: { status: 101, headers: {}, body: `close frame, code ${code}${code === 1009 ? " (message too big)" : ""}` } } }, code === 1009);
    const ok = await upgrade();
    const answer = new Promise<string>((r) => ok.socket!.once("data", (c: Buffer) => r(c.toString("utf8"))));
    ok.socket!.write(clientFrame(Buffer.from(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] }))));
    expect(await bounded(answer, "WebSocket answer")).toContain('"id":"b1"');
    ok.socket!.destroy();
  });

  it("a flood of distinct shapes cannot grow the shape registry without bound", async () => {
    const registry = new MemoryShapeRegistry(loadSchema(bookstoreSchemaText()).ir, 10);
    const b = createBookstore({ shapes: registry });
    const http = await listen(b.server, 0);
    extra.push(http);
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const fields = ["id", "title", "format", "price", "stock"];
    let last: Exchange | undefined;
    for (let i = 0; i < 30; i++) {
      const shape = `{ ${fields.filter((_, j) => (i >> j) & 1).join(" ") || "id"} alias${i}: title }`;
      last = (await raw(base, "POST", "/rayfold", JSON_HEADERS, JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape }] }))).ex;
    }
    report({ area, attack: "A client sends thousands of distinct inline shapes; each one used to be remembered forever.", defence: "Shapes learned from requests are kept up to a limit (10,000 by default; 10 in this test), least recently used first out; rejected shapes are never kept.", guard: "Shapes registered by the server itself stay, and every request is still answered.", runtimes: BOTH, ...(last ? { exchange: last } : {}) }, registry.size === 10);
  });

  it("a flood of idempotency keys cannot grow the replay store without bound", async () => {
    const store = new MemoryIdempotencyStore(24 * 3_600_000, Date.now, 10);
    const b = createBookstore({ idempotency: store });
    const http = await listen(b.server, 0, { viewer: () => ({ id: "u9", role: "admin" }) });
    extra.push(http);
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const restock = (k: number) => raw(base, "POST", "/rayfold", JSON_HEADERS, JSON.stringify({ ops: [{ id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: `${KEY}-${k}` }] }));
    let last: Exchange | undefined;
    for (let k = 0; k < 30; k++) last = (await restock(k)).ex;
    report({ area, attack: "A client sends thousands of commands with new idempotency keys; the records used to be kept until someone read them again.", defence: "Records expire (24 hours by default), expired ones are swept on every write, and past a size limit (100,000 by default; 10 here) the oldest go first.", guard: "The most recent key still replays its result.", runtimes: BOTH, ...(last ? { exchange: last } : {}) }, store.size === 10);
    expect(framesOf((await restock(29)).body)[0]).toMatchObject({ meta: { replay: true } });
  });

  it("deadlines outside 0 to 600,000 ms are refused", async () => {
    const attack = await post("/rayfold", { ...JSON_HEADERS, accept: "application/json" }, { ops: [{ id: 1, op: "book", args: { id: "b1" } }], meta: { deadline: -1 } });
    report({ area, attack: "A client sends a negative or enormous deadline.", defence: "Deadlines must be whole milliseconds from 0 to 600,000; anything else is invalid_argument.", guard: "A 5,000 ms deadline is honoured.", runtimes: BOTH, exchange: attack.ex }, attack.status === 400 && attack.body.includes("meta.deadline"));
    expect((await post("/rayfold", { ...JSON_HEADERS, accept: "application/json" }, { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }], meta: { deadline: 5000 } })).status).toBe(200);
  });
});

// --------------------------------------------------------------------------------------------- replays
describe("Replays and retries", () => {
  const area = "Replays and retries";

  it("an idempotency key cannot replay another command's result", async () => {
    const as = { ...JSON_HEADERS, authorization: "Bearer u1" };
    const id = (framesOf((await post("/rayfold", as, { ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: `${KEY}-p` }] })).body)[0] as { ok: { id: string } }).ok.id;
    await post("/rayfold", as, { ops: [{ id: 1, op: "payOrder", args: { id }, key: KEY }] });
    const attack = await post("/rayfold", as, { ops: [{ id: 1, op: "cancelOrder", args: { id }, key: KEY }] });
    const f = framesOf(attack.body)[0] as { error?: { code: string } };
    report({ area, attack: "A client reuses the key of a paid order's payOrder call on cancelOrder, so the cancel is answered with the stored payment result and never runs.", defence: "A key is bound to its operation and arguments; reusing it for anything else is already_exists, and the write policy is checked before any replay.", guard: "Retrying payOrder with its own key replays the payment.", runtimes: BOTH, exchange: attack.ex }, f.error?.code === "already_exists" && rayfold.store.calls["Command.cancelOrder"] === undefined);
    expect(framesOf((await post("/rayfold", as, { ops: [{ id: 1, op: "payOrder", args: { id }, key: KEY }] })).body)[0]).toMatchObject({ ok: { status: "PAID" }, meta: { replay: true } });
  });

  it("two retries arriving together place one order", async () => {
    const before = rayfold.store.orders.size;
    const order = { ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: KEY }] };
    const [a, b] = await Promise.all([post("/rayfold", { ...JSON_HEADERS, authorization: "Bearer u1" }, order), post("/rayfold", { ...JSON_HEADERS, authorization: "Bearer u1" }, order)]);
    const fa = framesOf(a.body)[0] as { ok: { id: string }; meta?: { replay?: boolean } };
    const fb = framesOf(b.body)[0] as { ok: { id: string }; meta?: { replay?: boolean } };
    report({ area, attack: "An app on a flaky network sends the same order twice at the same moment; both copies used to run.", defence: "The first request claims the key; the second waits for it to finish and replays its result.", guard: "Both requests get the same order back.", runtimes: BOTH, exchange: b.ex }, rayfold.store.orders.size === before + 1 && fa.ok.id === fb.ok.id);
    expect([fa.meta?.replay ?? false, fb.meta?.replay ?? false].sort()).toEqual([false, true]);
  });

  it("anonymous callers cannot share replayed results", async () => {
    const seen: string[] = [];
    const s = createRayfoldServer({ schema: `entity N { id: ID text: String } command note(text: String): N`, resolvers: { Command: { note: (a: { text: string }) => (seen.push(a.text), { id: `n${seen.length}`, text: a.text }) } } });
    const frames = await s.collect({ ops: [{ id: 1, op: "note", args: { text: "hi" }, key: KEY }] });
    report({ area, attack: "Every anonymous caller shares one replay scope, so one guest could replay another guest's result, or probe which keys exist.", defence: "A command with an idempotency key needs an identified caller (a user, service or guest session); anonymous keyed commands are unauthenticated.", guard: "An identified caller's retry replays its own result.", runtimes: BOTH }, (frames[0] as { error?: { code: string } }).error?.code === "unauthenticated" && seen.length === 0);
    await s.collect({ ops: [{ id: 1, op: "note", args: { text: "hi" }, key: KEY }] }, { viewer: { id: "guest-7" } });
    expect(await s.collect({ ops: [{ id: 1, op: "note", args: { text: "hi" }, key: KEY }] }, { viewer: { id: "guest-7" } })).toMatchObject([{ meta: { replay: true } }]);
  });
});

// --------------------------------------------------------------------------------------------- exposure
describe("Data exposure and trust", () => {
  const area = "Data exposure and trust";

  it("asking for another customer's order reads exactly like asking for one that does not exist", async () => {
    const id = (framesOf((await post("/rayfold", { ...JSON_HEADERS, authorization: "Bearer u1" }, { ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key: KEY }] })).body)[0] as { ok: { id: string } }).ok.id;
    const ask = (oid: string, who: string) => post("/rayfold", { ...JSON_HEADERS, authorization: who }, { ops: [{ id: 1, op: "order", args: { id: oid }, shape: "{ id status }" }] });
    const attack = await ask(id, "Bearer u2");
    const missing = await ask("o-does-not-exist", "Bearer u2");
    report({ area, attack: "A customer asks for other customers' order ids with an explicit shape, to learn which orders exist.", defence: "A denied entity at a nullable position reads as null even with an explicit shape, so forbidden and missing look the same.", guard: "The owner gets the order.", runtimes: BOTH, exchange: attack.ex }, attack.body === missing.body && framesOf(attack.body)[0]!["data"] === null);
    expect(framesOf((await ask(id, "Bearer u1")).body)[0]).toMatchObject({ data: { id, status: "PLACED" } });
  });

  it("the public manifest does not reveal how access is decided", async () => {
    const attack = await raw(rayfold.base, "GET", "/rayfold/manifest", {});
    report({ area, attack: "An anonymous caller downloads the manifest to read every permission rule, such as who may see costPrice.", defence: "The manifest keeps names and types but removes policy expressions; the full schema is opt-in, and the manifest can be switched off.", guard: "Clients still get every type and operation they need.", runtimes: BOTH, exchange: { ...attack.ex, response: { ...attack.ex.response, body: "(schema without policy expressions, " + attack.body.length.toLocaleString("en-US") + " characters)" } } }, attack.status === 200 && !attack.body.includes("$expr"));
    expect(Object.keys(JSON.parse(attack.body).schema.ops)).toContain("placeOrder");
  });

  it("a $ref path cannot reach an object's prototype", async () => {
    const attack = await post("/rayfold", JSON_HEADERS, { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }, { id: 2, op: "book", args: { id: { $ref: "1.constructor" } } }] });
    const f = framesOf(attack.body).find((x) => x["id"] === 2) as { error?: { code: string } };
    report({ area, attack: "A batch points $ref at \"1.constructor\" or \"1.__proto__\" to pull built-in objects into the arguments.", defence: "$ref paths read only the earlier result's own data; anything else resolves to nothing.", guard: "$ref to \"1.id\" passes the book's id along.", runtimes: TS, exchange: attack.ex }, f.error?.code === "invalid_argument" && ({} as Record<string, unknown>)["polluted"] === undefined);
    expect(framesOf((await post("/rayfold", JSON_HEADERS, { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }, { id: 2, op: "book", args: { id: { $ref: "1.id" } }, shape: "{ title }" }] })).body)[1]).toMatchObject({ data: { title: "The Dispossessed" } });
  });

  it("a \"__proto__\" key in a binary request stays plain data", async () => {
    const codec = new RbCodec(rayfold.bookstore.server.ir);
    const env = { ops: [{ id: 1, op: "book", args: JSON.parse('{"__proto__":{"id":"b2"}}') as Record<string, unknown>, shape: "{ id }" }] };
    const attack = await raw(rayfold.base, "POST", "/rayfold", { "content-type": "application/rayfold", accept: "application/rayfold+json" }, codec.encode(env));
    const f = framesOf(attack.body)[0] as { error?: { code: string; message: string } };
    report({ area, attack: "A binary (RB) request carries an argument object whose key is \"__proto__\", so decoding it would swap the object's prototype and smuggle in arguments.", defence: "The decoder stores every key as plain data, so the request fails validation as an unknown argument.", guard: "A normal binary request is answered.", runtimes: TS, exchange: attack.ex }, f.error?.code === "invalid_argument" && f.error.message.includes("__proto__"));
    const honest = await raw(rayfold.base, "POST", "/rayfold", { "content-type": "application/rayfold", accept: "application/rayfold+json" }, codec.encode({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] }));
    expect(framesOf(honest.body)[0]).toMatchObject({ data: { id: "b1" } });
  });

  it("a dry run cannot write through a command that does not support it", async () => {
    let writes = 0;
    const s = createRayfoldServer({ schema: `entity A { id: ID } command careless: A @idempotent(false)`, resolvers: { Command: { careless: () => (writes++, { id: "a" }) } } });
    const frames = await s.collect({ ops: [{ id: 1, op: "careless", simulate: true }] });
    report({ area, attack: "An AI agent asks for a dry run of a command whose code forgets to check ctx.simulate, so the \"dry run\" would really write.", defence: "Only commands that declare @simulate accept dry runs, and only they get a .simulate tool in MCP; others answer failed_precondition.", guard: "Declared commands, such as placeOrder, still offer a dry run that writes nothing.", runtimes: BOTH }, (frames[0] as { error?: { code: string } }).error?.code === "failed_precondition" && writes === 0);
    const sim = await post("/mcp", { "content-type": "application/json", authorization: "Bearer u1" }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "placeOrder.simulate", arguments: { input: { lines: [{ bookId: "b3", qty: 1 }] } } } });
    expect(JSON.parse(sim.body)).toMatchObject({ result: { structuredContent: { result: { status: "PLACED" } } } });
    expect(rayfold.store.orders.size).toBe(0);
  });

  it("a permission rule on large amounts cannot be bypassed by sending the amount as text", async () => {
    const s = createRayfoldServer({ schema: `entity A { id: ID } command pay(amount: Decimal): A @idempotent(false) @deny(write: args.amount > 1000)`, resolvers: { Command: { pay: () => ({ id: "p" }) } } });
    const frames = await s.collect({ ops: [{ id: 1, op: "pay", args: { amount: "5000.00" } }] }, { viewer: { id: "u1" } });
    report({ area, attack: "A rule denies payments over 1000, but Decimal amounts travel as text, and text compared with a number used to count as \"not greater\".", defence: "Numbers and numeric text compare exactly by value (also beyond 2^53), and a rule that cannot be evaluated fails closed.", guard: "An amount of 999.99 is allowed.", runtimes: BOTH }, (frames[0] as { error?: { code: string } }).error?.code === "permission_denied");
    expect(await s.collect({ ops: [{ id: 1, op: "pay", args: { amount: "999.99" } }] }, { viewer: { id: "u1" } })).toMatchObject([{ ok: { id: "p" } }]);
  });

  it("numbers that would lose digits are refused instead of rounded", async () => {
    const attack = await post("/rayfold", { ...JSON_HEADERS, accept: "application/json" }, `{"ops":[{"id":1,"op":"book","args":{"id":9007199254740993}}]}`);
    report({ area, attack: "A client sends the id 9007199254740993 as a JSON number, which JavaScript silently rounds to a different id.", defence: "Integers beyond 2^53 and Decimals written in exponent form are refused; send them as text.", guard: "The same id as text is accepted.", runtimes: TS, exchange: attack.ex }, attack.status === 400 && attack.body.includes("expected ID"));
    expect((await post("/rayfold", { ...JSON_HEADERS, accept: "application/json" }, { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] })).status).toBe(200);
  });

  it("responses tell browsers not to guess their type", async () => {
    const answers = [
      await post("/rayfold", JSON_HEADERS, { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] }),
      await post("/rayfold", { "content-type": "text/plain" }, "{}"),
      await raw(rayfold.base, "GET", "/books/b1", {}),
      await post("/mcp", { "content-type": "application/json" }, { jsonrpc: "2.0", id: 1, method: "ping" }),
    ];
    const hardened = answers.every((a) => a.headers["x-content-type-options"] === "nosniff") && answers[1]!.headers["cache-control"] === "no-store";
    report({ area, attack: "A browser second-guesses a response's type (MIME sniffing) and runs data as a script, or a shared cache keeps an error page.", defence: "Every response carries X-Content-Type-Options: nosniff, and refusals carry Cache-Control: no-store.", guard: "Responses keep their declared content types, and 304 answers stay minimal.", runtimes: BOTH, exchange: answers[1]!.ex }, hardened);
  });
});

// --------------------------------------------------------------------------------------------- vanishing clients
describe("Connections that vanish", () => {
  const area = "Overload and resource exhaustion";

  it("a WebSocket client that disappears without a close frame releases its socket and live subscriptions", async () => {
    const released = new Signal<string>();
    const changes = rayfold.bookstore.server.changes;
    const subscribe = changes.subscribe.bind(changes);
    vi.spyOn(changes, "subscribe").mockImplementation((fn) => {
      const off = subscribe(fn);
      return () => {
        off();
        released.push("off");
      };
    });
    try {
      const hs = await upgrade();
      expect(hs.status).toBe(101);
      const first = new Promise<string>((r) => hs.socket!.once("data", (c: Buffer) => r(c.toString("utf8"))));
      hs.socket!.write(clientFrame(Buffer.from(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true }] }))));
      expect(await bounded(first, "first live frame")).toContain('"stock"');
      const heldWhileOpen = changes.size; // guard: an open connection keeps its live query
      hs.socket!.destroy(); // no close frame: the server only sees the connection end
      await released.atLeast(1, "live subscription released after the client vanished");
      report({ area, attack: "A client opens a WebSocket, starts a live query, then vanishes without a close frame, so the server would keep the socket and the subscription forever.", defence: "The server closes its side as soon as the client's side ends, which cancels that connection's live queries.", guard: "While the connection is open, its live query stays subscribed.", runtimes: BOTH }, heldWhileOpen === 1 && changes.size === 0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
