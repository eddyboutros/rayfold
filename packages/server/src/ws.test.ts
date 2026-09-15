import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { Signal, bounded } from "../../../e2e/wait.ts";
import { attachWebSocket, type WsOptions } from "./ws.ts";
import type { RayfoldServer } from "./server.ts";

type Bookstore = ReturnType<typeof createBookstore>;
const admin = { id: "u9", role: "admin" };
const KEY = "0123456789abcdef";
const restock = { id: 1, op: "restock", args: { bookId: "b1", qty: 1 }, key: KEY };
const liveBook = { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true }] };
const readBook = (id: number, bookId: string) => ({ ops: [{ id, op: "book", args: { id: bookId }, shape: "{ id }" }] });
const bookFrame = (id: number, bookId: string) => ({ id, data: { $type: "Book", id: bookId }, meta: { cost: 1 }, fin: true });

let bs: Bookstore;
const open: Server[] = [];
const sockets: WebSocket[] = [];
async function serve(server: RayfoldServer, opts: WsOptions = {}): Promise<string> {
  const http = createServer((_req, res) => res.writeHead(404).end());
  attachWebSocket(http, server, opts);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  open.push(http);
  return `127.0.0.1:${(http.address() as AddressInfo).port}`;
}
beforeEach(() => {
  bs = createBookstore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const ws of sockets.splice(0)) if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  await Promise.all(open.splice(0).map((h) => new Promise<void>((r) => {
    h.close(() => r());
    h.closeAllConnections();
  })));
});

/** An open WebSocket whose text messages land in `received`, and whose close code and reason land in `closed`. */
async function connect(host: string): Promise<{ ws: WebSocket; received: Signal<unknown>; closed: Signal<{ code: number; reason: string }> }> {
  const ws = new WebSocket(`ws://${host}/rayfold/ws`, ["rayfold.0.1"]);
  sockets.push(ws);
  const received = new Signal<unknown>();
  const closed = new Signal<{ code: number; reason: string }>();
  ws.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
  ws.addEventListener("close", (e) => closed.push({ code: e.code, reason: e.reason }));
  await bounded(new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true })), "socket open");
  return { ws, received, closed };
}

/** Records live subscriptions being added to and removed from the server's change bus. */
function changeBusLog(server: RayfoldServer): Signal<"on" | "off"> {
  const log = new Signal<"on" | "off">();
  const subscribe = server.changes.subscribe.bind(server.changes);
  vi.spyOn(server.changes, "subscribe").mockImplementation((fn) => {
    const off = subscribe(fn);
    log.push("on");
    return () => {
      off();
      log.push("off");
    };
  });
  return log;
}
const offs = (n: number) => (xs: Array<"on" | "off">) => xs.filter((x) => x === "off").length >= n;

describe("the handshake applies the Origin rule", () => {
  /** node:http, because the global WebSocket cannot carry a browser-style Origin header. */
  const upgrade = (host: string, origin: string) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: Number(host.split(":")[1]),
        path: "/rayfold/ws",
        headers: { host, origin, upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" },
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: "" });
      });
      req.on("response", (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });

  it("an allowed origin is switched to the protocol; a foreign one is refused before the socket opens", async () => {
    const host = await serve(bs.server, { allowedOrigins: ["http://app.example"] });
    const allowed = await upgrade(host, "http://app.example");
    expect(allowed.status).toBe(101);
    // the RFC 6455 accept value for the sample key above
    expect(allowed.headers["sec-websocket-accept"]).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    const refused = await upgrade(host, "https://other.example");
    expect(refused.status).toBe(403);
    expect(refused.headers["content-type"]).toBe("text/plain");
    expect(refused.body).toBe("Origin https://other.example is not allowed");
  });
});

describe("messages over maxMessage", () => {
  it("a text frame over the limit closes that socket with 1009, and a fresh connection under the limit is served", async () => {
    const host = await serve(bs.server, { maxMessage: 128 });
    const big = await connect(host);
    big.ws.send(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: `{ id ${"title ".repeat(20)}}` }] }));
    await big.closed.atLeast(1, "the close frame for the oversized message");
    expect(big.closed.items).toEqual([{ code: 1009, reason: "message too big" }]);
    expect(big.received.items).toEqual([]);
    const small = await connect(host);
    small.ws.send(JSON.stringify(readBook(1, "b2")));
    await small.received.atLeast(1, "an answer on the next connection");
    expect(small.received.items).toEqual([bookFrame(1, "b2")]);
    expect(small.closed.items).toEqual([]);
  });
});

describe("op lifecycle on one connection", () => {
  it("a socket closed without cancelling releases its live subscription, and a later socket's live op is still patched", async () => {
    const subs = changeBusLog(bs.server);
    const host = await serve(bs.server);
    const first = await connect(host);
    first.ws.send(JSON.stringify(liveBook));
    await first.received.atLeast(1, "initial live data on the first socket");
    expect(first.received.items).toEqual([{ id: 1, data: { $type: "Book", id: "b1", stock: 5 }, meta: { cost: 1 } }]);
    expect(bs.server.changes.size).toBe(1);
    first.ws.close();
    await subs.until(offs(1), "the dropped socket's subscription released");
    expect(bs.server.changes.size).toBe(0);

    const second = await connect(host);
    second.ws.send(JSON.stringify(liveBook));
    await second.received.atLeast(1, "initial live data on the second socket");
    expect(bs.server.changes.size).toBe(1);
    await bs.server.collect({ ops: [restock] }, { viewer: admin });
    await second.received.atLeast(2, "the patch on the second socket");
    expect(second.received.items[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 6 } }] });
  });

  it("cancel stops exactly the live op named and releases its subscription", async () => {
    const subs = changeBusLog(bs.server);
    const host = await serve(bs.server);
    const { ws, received } = await connect(host);
    ws.send(JSON.stringify(liveBook));
    ws.send(JSON.stringify({ ops: [{ id: 2, op: "book", args: { id: "b2" }, shape: "{ id stock }", live: true }] }));
    await received.atLeast(2, "both live ops' initial data");
    expect(bs.server.changes.size).toBe(2);
    ws.send(JSON.stringify({ cancel: 1 }));
    await subs.until(offs(1), "op 1 unsubscribed");
    expect(bs.server.changes.size).toBe(1);
    await bs.server.collect({ ops: [restock] }, { viewer: admin });
    await bs.server.collect({ ops: [{ ...restock, args: { bookId: "b2", qty: 1 }, key: "1123456789abcdef" }] }, { viewer: admin });
    await received.until((xs) => xs.some((f) => (f as { id: number; patch?: unknown }).id === 2 && "patch" in (f as object)), "the surviving op's patch");
    expect(received.items.filter((f) => "patch" in (f as object))).toEqual([{ id: 2, patch: [{ set: "Book:b2", value: { stock: 3 } }] }]);
    expect(received.items.filter((f) => (f as { id: number }).id === 1)).toEqual([
      { id: 1, data: { $type: "Book", id: "b1", stock: 5 }, meta: { cost: 1 } },
      { id: 1, error: { code: "canceled", message: "Canceled" }, fin: true },
    ]);
  });

  it("an op id in use on the connection is refused until that op ends; a cancel of an unknown id is ignored", async () => {
    const subs = changeBusLog(bs.server);
    const host = await serve(bs.server);
    const { ws, received, closed } = await connect(host);
    ws.send(JSON.stringify(liveBook));
    await received.atLeast(1, "initial live data");
    ws.send(JSON.stringify(readBook(1, "b2")));
    await received.atLeast(2, "the refusal of the reused id");
    expect(received.items[1]).toEqual({ error: { code: "invalid_argument", message: "op id 1 is already in use on this connection" }, fin: true });
    expect(bs.store.calls["Query.book"]).toBe(1);
    // guard: another id runs at once, and the id is free again once the live op is cancelled
    ws.send(JSON.stringify(readBook(2, "b2")));
    await received.atLeast(3, "a batch under a free id");
    expect(received.items[2]).toEqual(bookFrame(2, "b2"));
    ws.send(JSON.stringify({ cancel: 1 }));
    // the server frees the id as it sends this frame, so the reuse below cannot race it
    await received.atLeast(4, "op 1's canceled frame");
    expect(received.items[3]).toEqual({ id: 1, error: { code: "canceled", message: "Canceled" }, fin: true });
    await subs.until(offs(1), "op 1 unsubscribed");
    ws.send(JSON.stringify(readBook(1, "b3")));
    await received.atLeast(5, "the id reused after cancel");
    expect(received.items[4]).toEqual(bookFrame(1, "b3"));

    ws.send(JSON.stringify({ cancel: 99 }));
    ws.send(JSON.stringify(readBook(3, "b1")));
    await received.atLeast(6, "an answer after the unknown cancel");
    expect(received.items.slice(5)).toEqual([bookFrame(3, "b1")]);
    expect(closed.items).toEqual([]);
  });
});
