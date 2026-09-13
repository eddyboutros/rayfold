import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { attachWebSocket, createHttpHandler, type Frame, type RayfoldServer } from "@rayfold/server";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { Signal } from "../../../e2e/wait.ts";
import { RayfoldClient } from "./client.ts";
import { createLocalTransport, type Transport } from "./transport.ts";
import { createWebSocketTransport } from "./ws-transport.ts";
import { RbCodec } from "@rayfold/rb";

type Bookstore = ReturnType<typeof createBookstore>;
const u1 = { id: "u1", role: "customer" };
const admin = { id: "u9", role: "admin" };
const viewerOf = (auth: string | undefined) => (auth === "Bearer admin" ? admin : auth ? u1 : null);

let bs: Bookstore;
let http: Server;
let wsUrl: string;
beforeEach(async () => {
  bs = createBookstore();
  const handler = createHttpHandler(bs.server, { viewer: (req) => viewerOf(req.headers.authorization) });
  http = createServer((req, res) => void handler(req, res));
  attachWebSocket(http, bs.server, { viewer: (req) => viewerOf(new URL(req.url ?? "/", "http://x").searchParams.get("auth") ?? undefined) });
  await new Promise<void>((r) => http.listen(0, r));
  wsUrl = `ws://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold/ws`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((r) => {
    http.close(() => r());
    http.closeAllConnections();
  });
});

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

describe("live queries through the client", () => {
  it("client.live() delivers the initial data and later server-side changes, then unsubscribes on stop", async () => {
    const subs = changeBusLog(bs.server);
    const local = new RayfoldClient({ transport: createLocalTransport(bs.server, () => u1) });
    const seen = new Signal<number>();
    const stop = local.live<{ stock: number }>("book", { id: "b2" }, { shape: "{ id stock }" }, (d) => seen.push(d.stock));
    await seen.atLeast(1, "initial live data");
    const adminClient = new RayfoldClient({ transport: createLocalTransport(bs.server, () => admin) });
    await adminClient.command("restock", { bookId: "b2", qty: 3 });
    await seen.atLeast(2, "live patch");
    expect(seen.items).toEqual([2, 5]);
    expect(bs.store.calls["Query.book"]).toBe(2); // the server re-ran it; the client never refetched
    stop();
    await subs.until(offs(1), "live op unsubscribed after stop");
    expect(bs.server.changes.size).toBe(0);
  });

  it("a live list is kept correct by a list patch, without the page being resent", async () => {
    const local = createLocalTransport(bs.server, () => u1);
    const wire: Frame[] = [];
    const tap: Transport = {
      send: (env, o) =>
        (async function* () {
          for await (const f of local.send(env, o)) {
            wire.push(f);
            yield f;
          }
        })(),
    };
    const c = new RayfoldClient({ transport: tap });
    const seen = new Signal<Array<{ id: string }>>();
    const stop = c.live<{ items: Array<{ id: string }> }>("books", { page: { first: 10 } }, { shape: "{ items { id title } }" }, (d) => seen.push(d.items));
    await seen.atLeast(1, "the initial list");
    const before = seen.items[0]!.length;
    bs.store.books.set("b9", { id: "b9", title: "New", format: "EBOOK" as const, price: "1.00", stock: 1, authorId: "a1", costPrice: null, ownerId: "u1" });
    bs.server.changes.publish({ keys: new Set(), ops: new Set(["books"]) });
    await seen.atLeast(2, "the list patch");
    stop();
    const patched = wire.find((f) => "patch" in f) as { patch: Array<Record<string, unknown>> };
    expect(patched.patch.some((p) => "list" in p)).toBe(true); // the new row, not the page
    expect(seen.items[1]!.length).toBe(before + 1);
    expect(seen.items[1]!.map((b) => b.id)).toContain("b9");
  });

  it("a schema-aware client's live query travels compact and still receives patches", async () => {
    const local = createLocalTransport(bs.server, () => u1);
    const wire: Frame[] = [];
    const tap: Transport = {
      send: (env, o) =>
        (async function* () {
          for await (const f of local.send(env, o)) {
            wire.push(f);
            yield f;
          }
        })(),
    };
    const c = new RayfoldClient({ transport: tap, schema: bs.server.ir });
    const seen = new Signal<{ $type?: string; stock: number }>();
    const stop = c.live<{ $type?: string; stock: number }>("book", { id: "b2" }, { shape: "{ id stock }" }, (d) => seen.push(d));
    await seen.atLeast(1, "initial compact live data");
    await new RayfoldClient({ transport: createLocalTransport(bs.server, () => admin) }).command("restock", { bookId: "b2", qty: 3 });
    await seen.atLeast(2, "live patch");
    expect(seen.items).toEqual([{ $type: "Book", id: "b2", stock: 2 }, { $type: "Book", id: "b2", stock: 5 }]); // types restored from the schema
    expect(wire.slice(0, 2)).toEqual([{ id: 1, data: { id: "b2", stock: 2 } }, { id: 1, patch: [{ set: "Book:b2", value: { stock: 5 } }] }]);
    stop();
  });
});

describe("WebSocket transport", () => {
  it("runs batches, shares one socket, remaps ids, and cancels exactly the live op that stops", async () => {
    const subs = changeBusLog(bs.server);
    const transport = createWebSocketTransport({ url: `${wsUrl}?auth=Bearer%20u1` });
    const adminTransport = createWebSocketTransport({ url: `${wsUrl}?auth=Bearer%20admin` });
    try {
      const client = new RayfoldClient({ transport });
      const book = await client.query<{ title: string }>("book", { id: "b1" }, { shape: "{ id title }" });
      expect(book.title).toBe("The Dispossessed");

      // two concurrent batches on the same socket
      const [a, b] = await Promise.all([client.query<{ id: string }>("book", { id: "b2" }, { shape: "{ id }" }), client.query<{ id: string }>("book", { id: "b3" }, { shape: "{ id }" })]);
      expect([a.id, b.id]).toEqual(["b2", "b3"]);

      // pipelined refs are remapped along with ids
      const batch = client.batch();
      const placed = batch.command<{ id: string }>("placeOrder", { input: { lines: [{ bookId: "b3", qty: 1 }] } });
      const read = batch.query<{ total: string }>("order", { id: placed.ref("id") }, { shape: "{ id total }" });
      await batch.run();
      expect((await read.promise).total).toBe("8.00");

      // two live ops over the socket
      const b1 = new Signal<number>();
      const b2 = new Signal<number>();
      const stopB1 = client.live<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }" }, (d) => b1.push(d.stock));
      const stopB2 = client.live<{ stock: number }>("book", { id: "b2" }, { shape: "{ id stock }" }, (d) => b2.push(d.stock));
      await b1.atLeast(1, "ws live b1 initial");
      await b2.atLeast(1, "ws live b2 initial");
      expect(bs.server.changes.size).toBe(2);
      const adminClient = new RayfoldClient({ transport: adminTransport });
      await adminClient.command("restock", { bookId: "b1", qty: 1 });
      await b1.atLeast(2, "ws live b1 patch");
      expect(b1.items).toEqual([5, 6]);

      // cancelling one live op leaves the other subscribed and still updating
      stopB1();
      await subs.until(offs(1), "server dropped the cancelled op");
      expect(bs.server.changes.size).toBe(1);
      await adminClient.command("restock", { bookId: "b2", qty: 1 });
      await b2.atLeast(2, "surviving live op still patched");
      expect(b2.items).toEqual([2, 3]);
      expect(b1.items).toEqual([5, 6]);
      stopB2();
      await subs.until(offs(2), "server dropped the second op");
      expect(bs.server.changes.size).toBe(0);
    } finally {
      transport.close();
      adminTransport.close();
    }
  });
});

describe("RB over the WebSocket transport (spec 09 section 4)", () => {
  /** A WebSocket that records whether each message it receives is text or binary. */
  const recording = (kinds: string[]) =>
    class extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (e) => kinds.push(typeof e.data === "string" ? "text" : "binary"));
      }
    };

  it("a binary client sends RB and gets RB frames with the same data and live patches, beside a text client", async () => {
    const binaryKinds: string[] = [];
    const textKinds: string[] = [];
    const binary = createWebSocketTransport({ url: `${wsUrl}?auth=Bearer%20u1`, binary: bs.server.ir, WebSocket: recording(binaryKinds) });
    const text = createWebSocketTransport({ url: `${wsUrl}?auth=Bearer%20u1`, WebSocket: recording(textKinds) });
    try {
      const rbClient = new RayfoldClient({ transport: binary });
      const jsonClient = new RayfoldClient({ transport: text });
      const shape = { shape: "{ id title stock author { name } }" };
      expect(await rbClient.query("book", { id: "b1" }, shape)).toEqual(await jsonClient.query("book", { id: "b1" }, shape));
      const stock = new Signal<number>();
      const stop = rbClient.live<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }" }, (d) => stock.push(d.stock));
      await stock.atLeast(1, "RB live initial");
      await new RayfoldClient({ transport: createLocalTransport(bs.server, () => admin) }).command("restock", { bookId: "b1", qty: 1 });
      await stock.atLeast(2, "RB live patch");
      expect(stock.items).toEqual([5, 6]);
      stop();
      expect(new Set(binaryKinds)).toEqual(new Set(["binary"]));
      expect(new Set(textKinds)).toEqual(new Set(["text"]));
    } finally {
      binary.close();
      text.close();
    }
  });

  it("undecodable RB is answered with an RB error frame, and a text message that is not an object with an error (guard)", async () => {
    const codec = new RbCodec(bs.server.ir);
    const ws = new WebSocket(wsUrl, ["rayfold.0.1"]);
    ws.binaryType = "arraybuffer";
    const received = new Signal<unknown>();
    ws.addEventListener("message", (e) => received.push(typeof e.data === "string" ? JSON.parse(e.data) : codec.decodeFrames(new Uint8Array(e.data as ArrayBuffer))));
    await new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));
    try {
      ws.send(Uint8Array.of(0x0a));
      await received.atLeast(1, "the RB error");
      expect(received.items[0]).toEqual([{ error: { code: "invalid_argument", message: "Message is not valid RB" }, fin: true }]);
      ws.send("null");
      await received.atLeast(2, "the text error");
      expect(received.items[1]).toEqual({ error: { code: "invalid_argument", message: "Expected a batch envelope, {cancel}, or a stream item" }, fin: true });
      ws.send(codec.encode({ ops: [{ id: 1, op: "book", args: { id: "b2" }, shape: "{ id }" }] }));
      await received.atLeast(3, "an RB answer after the errors");
      expect(received.items[2]).toEqual([{ id: 1, data: { $type: "Book", id: "b2" }, meta: { cost: 1 }, fin: true }]);
    } finally {
      ws.close();
    }
  });
});
