import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { attachWebSocket, createHttpHandler, type Frame, type RayfoldServer } from "@rayfold/server";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { Signal, bounded } from "../../../e2e/wait.ts";
import { RayfoldClient, RayfoldClientError } from "./client.ts";
import { createLocalTransport, type Transport } from "./transport.ts";
import { createWebSocketTransport } from "./ws-transport.ts";
import { RbCodec } from "@rayfold/rb";
import { schemaHash } from "@rayfold/schema";

type Bookstore = ReturnType<typeof createBookstore>;
const u1 = { id: "u1", role: "customer" };
const admin = { id: "u9", role: "admin" };
const viewerOf = (auth: string | undefined) => (auth === "Bearer admin" ? admin : auth ? u1 : null);

let bs: Bookstore;
let http: Server;
let wsUrl: string;
let conns: Set<Socket>;
beforeEach(async () => {
  bs = createBookstore();
  const handler = createHttpHandler(bs.server, { viewer: (req) => viewerOf(req.headers.authorization) });
  http = createServer((req, res) => void handler(req, res));
  conns = new Set();
  http.on("connection", (s) => {
    conns.add(s);
    s.on("close", () => conns.delete(s));
  });
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
    bs.store.books.set("b9", { id: "b9", title: "New", format: "EBOOK" as const, price: "1.00", stock: 1, authorId: "a1", costPrice: null, ownerId: "u1" });
    bs.server.changes.publish({ keys: new Set(), ops: new Set(["books"]) });
    await seen.atLeast(2, "the list patch");
    stop();
    // the new row, not the page
    expect(wire.filter((f) => "patch" in f)).toEqual([{ id: 1, patch: [{ list: "items", ins: [{ at: 4, value: { $type: "Book", id: "b9", title: "New" } }] }] }]);
    expect(seen.items.map((items) => items.map((b) => b.id))).toEqual([
      ["b1", "b2", "b3", "b4"],
      ["b1", "b2", "b3", "b4", "b9"],
    ]);
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

describe("WebSocket transport connections", () => {
  const ons = (n: number) => (xs: Array<"on" | "off">) => xs.filter((x) => x === "on").length >= n;

  it("a dropped socket fails the live op as unavailable, and live() reopens it on a new socket from connectUrl", async () => {
    const subs = changeBusLog(bs.server);
    const urls: string[] = [];
    // `url` is never dialled: connectUrl builds every socket's address
    const transport = createWebSocketTransport({ url: "ws://127.0.0.1:1/unused", connectUrl: () => (urls.push(`${wsUrl}?auth=Bearer%20u1`), urls.at(-1)!) });
    try {
      const client = new RayfoldClient({ transport });
      const seen = new Signal<{ stock: number; initial: boolean }>();
      const errors = new Signal<{ code: string; message: string; retrying: boolean }>();
      const stop = client.live<{ stock: number }>(
        "book",
        { id: "b1" },
        { shape: "{ id stock }" },
        (d, m) => seen.push({ stock: d.stock, initial: m.initial }),
        (e, m) => errors.push({ code: (e as RayfoldClientError).code, message: (e as Error).message, retrying: m.retrying }),
      );
      await seen.atLeast(1, "live data on the first socket");
      await subs.until(ons(1), "server subscribed the live op");
      for (const s of conns) s.destroy();
      await errors.atLeast(1, "the dropped socket reported");
      await seen.atLeast(2, "live data on the reopened socket");
      await subs.until(ons(2), "server subscribed the reopened op");
      await new RayfoldClient({ transport: createLocalTransport(bs.server, () => admin) }).command("restock", { bookId: "b1", qty: 1 });
      await seen.atLeast(3, "patch on the reopened socket");
      expect(errors.items).toEqual([{ code: "unavailable", message: "Connection closed", retrying: true }]);
      expect(seen.items).toEqual([
        { stock: 5, initial: true },
        { stock: 5, initial: false },
        { stock: 6, initial: false },
      ]);
      expect(urls).toEqual([`${wsUrl}?auth=Bearer%20u1`, `${wsUrl}?auth=Bearer%20u1`]);
      stop();
    } finally {
      transport.close();
    }
  });

  it("a socket that cannot connect fails the batch as unavailable", async () => {
    const gone = createServer();
    await new Promise<void>((r) => gone.listen(0, r));
    const port = (gone.address() as AddressInfo).port;
    await new Promise<void>((r) => gone.close(() => r()));
    const transport = createWebSocketTransport({ url: `ws://127.0.0.1:${port}/rayfold/ws` });
    const err = await bounded(new RayfoldClient({ transport }).query("book", { id: "b1" }).catch((e: unknown) => e), "the refused connect");
    expect(err).toBeInstanceOf(RayfoldClientError);
    expect({ code: (err as RayfoldClientError).code, message: (err as Error).message }).toEqual({ code: "unavailable", message: "WebSocket connection failed" });
  });

  it("a refused connection fails only that request: the next one connects again and is answered", async () => {
    const gone = createServer();
    await new Promise<void>((r) => gone.listen(0, r));
    const port = (gone.address() as AddressInfo).port;
    await new Promise<void>((r) => gone.close(() => r()));
    // the first address refuses, as a server mid-deploy does; the next is the real one
    const dialled: string[] = [];
    const transport = createWebSocketTransport({ url: "ws://127.0.0.1:1/unused", connectUrl: () => (dialled.push(dialled.length ? wsUrl : `ws://127.0.0.1:${port}/rayfold/ws`), dialled.at(-1)!) });
    const client = new RayfoldClient({ transport });
    const first = await bounded(client.query("book", { id: "b1" }).catch((e: unknown) => e), "the refused connect");
    expect((first as RayfoldClientError).code).toBe("unavailable");
    // a failed attempt used to be kept, and every later request got the same rejection without dialling again
    expect(await bounded(client.query<{ id: string }>("book", { id: "b1" }, { shape: "{ id }" }), "the second request")).toMatchObject({ id: "b1" });
    expect(dialled.length).toBe(2);
    transport.close();
  });

  it("leaving a live op's frames early cancels exactly that op on the server", async () => {
    const subs = changeBusLog(bs.server);
    const transport = createWebSocketTransport({ url: `${wsUrl}?auth=Bearer%20u1` });
    const live = (id: string) => transport.send({ rayfold: "0.1", ops: [{ id: 1, op: "book", args: { id }, shape: "{ id stock }", live: true }] })[Symbol.asyncIterator]();
    try {
      const left = live("b1");
      const kept = live("b2");
      expect(await left.next()).toEqual({ value: { id: 1, data: { $type: "Book", id: "b1", stock: 5 }, meta: { cost: 1 } }, done: false });
      expect(await kept.next()).toEqual({ value: { id: 1, data: { $type: "Book", id: "b2", stock: 2 }, meta: { cost: 1 } }, done: false });
      await subs.until(ons(2), "server subscribed both ops");
      await left.return!();
      await subs.until(offs(1), "server dropped the op that was left");
      expect(bs.server.changes.size).toBe(1);
      // guard: the op still being read stays subscribed and still gets its patch
      await new RayfoldClient({ transport: createLocalTransport(bs.server, () => admin) }).command("restock", { bookId: "b2", qty: 1 });
      expect(await bounded(kept.next(), "patch for the op still read")).toEqual({ value: { id: 1, patch: [{ set: "Book:b2", value: { stock: 3 } }] }, done: false });
      expect(subs.items).toEqual(["on", "on", "off"]);
    } finally {
      transport.close();
    }
  });
});

describe("a refused batch on a shared socket", () => {
  it("is rejected and closed, and a live query on the same socket keeps going untouched", async () => {
    const transport = createWebSocketTransport({ url: `${wsUrl}?auth=Bearer%20u1` });
    try {
      const client = new RayfoldClient({ transport });
      const stock = new Signal<number>();
      const errors: unknown[] = [];
      const stop = client.live<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }" }, (d) => stock.push(d.stock), (e) => errors.push(e));
      await stock.atLeast(1, "live initial");
      const refused = await bounded(client.query("noSuchOp").catch((e: unknown) => e), "the refused batch settled");
      expect(refused).toBeInstanceOf(RayfoldClientError);
      expect((refused as RayfoldClientError).code).toBe("invalid_argument");
      // guard: the socket and the live query on it are still good
      expect(await client.query<{ id: string }>("book", { id: "b2" }, { shape: "{ id }" })).toEqual({ $type: "Book", id: "b2" });
      await new RayfoldClient({ transport: createLocalTransport(bs.server, () => admin) }).command("restock", { bookId: "b1", qty: 1 });
      await stock.atLeast(2, "live patch after the refusal");
      expect(stock.items).toEqual([5, 6]);
      expect(errors).toEqual([]);
      stop();
    } finally {
      transport.close();
    }
  });

  it("a batch that ended leaves no listener on the caller's signal; guard: aborting a running batch still cancels it", async () => {
    const subs = changeBusLog(bs.server);
    const transport = createWebSocketTransport({ url: `${wsUrl}?auth=Bearer%20u1` });
    try {
      const client = new RayfoldClient({ transport });
      const ac = new AbortController();
      for (const id of ["b1", "b2", "b3"]) {
        const b = client.batch();
        b.query("book", { id }, { shape: "{ id }" });
        await b.run({ signal: ac.signal });
      }
      expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);

      const b = client.batch();
      const live = b.query("book", { id: "b1" }, { shape: "{ id }", live: true });
      const run = b.run({ signal: ac.signal });
      await subs.until((xs) => xs.includes("on"), "live op subscribed");
      ac.abort();
      await subs.until(offs(1), "the aborted live op unsubscribed on the server");
      await expect(bounded(live.promise, "the aborted op settled")).rejects.toMatchObject({ code: "canceled" });
      await bounded(run, "the aborted batch ended");
    } finally {
      transport.close();
    }
  });

  /** A socket whose server is the test: it records what the client sends and answers with whatever frames it is given. */
  class ScriptedSocket extends EventTarget {
    static readonly OPEN = 1;
    static last: ScriptedSocket | undefined;
    readonly sent = new Signal<{ ops?: Array<{ id: number; op: string }>; cancel?: number }>();
    readyState = 0;
    binaryType = "blob";
    constructor() {
      super();
      ScriptedSocket.last = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(text: string): void {
      this.sent.push(JSON.parse(text));
    }
    answer(f: unknown): void {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(f) }));
    }
    close(): void {}
  }
  const scripted = () => createWebSocketTransport({ url: "ws://scripted", WebSocket: ScriptedSocket as unknown as typeof WebSocket });
  const outcome = (p: Promise<unknown>) => p.then((v) => ({ ok: v }), (e: RayfoldClientError) => ({ error: e.code }));

  it("a refusal without an op id waits while two batches could own it, and goes to the one left once the other answers", async () => {
    const client = new RayfoldClient({ transport: scripted() });
    const good = outcome(client.query("book", { id: "b1" }));
    const bad = outcome(client.query("noSuchOp"));
    const settled: string[] = [];
    void good.then(() => settled.push("good"));
    void bad.then(() => settled.push("bad"));
    const socket = ScriptedSocket.last!;
    await socket.sent.atLeast(2, "both envelopes sent");
    expect(socket.sent.items.map((m) => m.ops![0]!.id)).toEqual([1, 2]);
    socket.answer({ error: { code: "invalid_argument", message: "Unknown op noSuchOp" }, fin: true });
    await Promise.resolve();
    expect(settled).toEqual([]); // either batch could be the refused one: neither is failed on a guess
    socket.answer({ id: 1, data: { $type: "Book", id: "b1" }, fin: true });
    expect(await bounded(good, "the good batch")).toEqual({ ok: { $type: "Book", id: "b1" } });
    expect(await bounded(bad, "the refused batch")).toEqual({ error: "invalid_argument" });
  });

  it("two refusals among two unanswered batches are one each; guard: a batch answered before them is not failed", async () => {
    const client = new RayfoldClient({ transport: scripted() });
    const b = client.batch();
    const live = b.query("book", { id: "b1" }, { live: true });
    const run = b.run();
    const socket = ScriptedSocket.last!;
    await socket.sent.atLeast(1, "the live envelope sent");
    socket.answer({ id: 1, data: { $type: "Book", id: "b1" } });
    const bad1 = outcome(client.query("noSuchOp"));
    const bad2 = outcome(client.query("otherBadOp"));
    await socket.sent.atLeast(3, "both refused envelopes sent");
    socket.answer({ error: { code: "invalid_argument", message: "Unknown op noSuchOp" }, fin: true });
    socket.answer({ error: { code: "invalid_argument", message: "Unknown op otherBadOp" }, fin: true });
    expect(await bounded(bad1, "first refused")).toEqual({ error: "invalid_argument" });
    expect(await bounded(bad2, "second refused")).toEqual({ error: "invalid_argument" });
    socket.answer({ id: 1, patch: [{ set: "Book:b1", value: { stock: 3 } }] });
    socket.answer({ id: 1, fin: true });
    await bounded(run, "the live batch ended with its own fin");
    expect(await live.promise).toEqual({ $type: "Book", id: "b1" });
    expect(client.cache.get("Book:b1")).toEqual({ $type: "Book", id: "b1", stock: 3 });
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

  it("a client whose RB dictionary comes from another schema fails its batch as unavailable, then speaks JSON (guard: the first test stays on RB)", async () => {
    const older = structuredClone(bs.server.ir);
    const book = older.types["Book"] as { fields: Array<{ name: string }> };
    book.fields.push({ ...book.fields[1]!, name: "aaa" }); // a field the server does not have renumbers every key after it
    const kinds: string[] = [];
    const urls: string[] = [];
    const Recording = recording(kinds);
    const transport = createWebSocketTransport({
      url: `${wsUrl}?auth=Bearer%20u1`,
      binary: older,
      WebSocket: class extends Recording {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          urls.push(String(url));
        }
      },
    });
    try {
      const client = new RayfoldClient({ transport });
      const shape = { shape: "{ id title }" };
      await expect(client.query("book", { id: "b1" }, shape)).rejects.toMatchObject({ code: "unavailable" });
      expect(await client.query("book", { id: "b1" }, shape)).toEqual({ $type: "Book", id: "b1", title: "The Dispossessed" });
      expect(kinds).toEqual(["text"]);
      expect(urls.map((u) => new URL(u).searchParams.get("schema"))).toEqual([schemaHash(older), null]);
    } finally {
      transport.close();
    }
  });

  it("the server closes a socket that names another schema with 4409 and its own hash (guard: its own hash is served)", async () => {
    const closed = (schema: string) =>
      bounded(new Promise<{ code: number; reason: string; answered: unknown }>((resolve) => {
        let answered: unknown = null;
        const ws = new WebSocket(`${wsUrl}?schema=${encodeURIComponent(schema)}`, ["rayfold.0.1"]);
        ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason, answered }), { once: true });
        ws.addEventListener("open", () => ws.send(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }] })), { once: true });
        ws.addEventListener("message", (e) => {
          answered = JSON.parse(String(e.data));
          ws.close(1000);
        }, { once: true });
      }), "the socket to close");
    expect(await closed("sha256:stale")).toEqual({ code: 4409, reason: bs.server.hash, answered: null });
    expect((await closed(bs.server.hash)).answered).toEqual({ id: 1, data: { $type: "Book", id: "b1" }, meta: { cost: 1 }, fin: true });
  });

  it("undecodable RB is answered with an RB error frame, and a text message that is not an object with an error (guard)", async () => {
    const codec = new RbCodec(bs.server.ir);
    const ws = new WebSocket(wsUrl, ["rayfold.0.1"]);
    ws.binaryType = "arraybuffer";
    const received = new Signal<unknown>();
    ws.addEventListener("message", (e) => received.push(typeof e.data === "string" ? JSON.parse(e.data) : codec.decodeFrames(new Uint8Array(e.data as ArrayBuffer))));
    await new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true }));
    try {
      ws.send(new Uint8Array([0x0a]));
      await received.atLeast(1, "the RB error");
      expect(received.items[0]).toEqual([{ error: { code: "invalid_argument", message: "Message is not valid RB" }, fin: true }]);
      ws.send("null");
      await received.atLeast(2, "the text error");
      expect(received.items[1]).toEqual({ error: { code: "invalid_argument", message: "Expected a batch envelope or {cancel}" }, fin: true });
      ws.send(new Uint8Array(codec.encode({ ops: [{ id: 1, op: "book", args: { id: "b2" }, shape: "{ id }" }] })));
      await received.atLeast(3, "an RB answer after the errors");
      expect(received.items[2]).toEqual([{ id: 1, data: { $type: "Book", id: "b2" }, meta: { cost: 1 }, fin: true }]);
    } finally {
      ws.close();
    }
  });
});
