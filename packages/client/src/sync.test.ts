import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestEnvelope } from "@rayfold/server";
import { Signal, bounded } from "../../../e2e/wait.ts";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { RayfoldCache } from "./cache.ts";
import { RayfoldClient, RayfoldClientError, type ClientOptions } from "./client.ts";
import { localStorageQueue, memoryQueue, type QueueEvent } from "./offline.ts";
import { createLocalTransport, type Transport } from "./transport.ts";

type Bookstore = ReturnType<typeof createBookstore>;
const admin = { id: "u9", role: "admin" };
const customer = { id: "u1", role: "customer" };
let bs: Bookstore;
let keyN = 0;
beforeEach(() => {
  bs = createBookstore();
  keyN = 0;
});
afterEach(() => vi.unstubAllGlobals());

/** A network that is up, down (nothing reaches the server), lossy (the server runs the batch but the answer is lost), or held at a gate. */
function network(inner: Transport) {
  const net = { mode: "up" as "up" | "down" | "lossy", sent: [] as RequestEnvelope[], gate: null as Promise<void> | null };
  const transport: Transport = {
    send(env, opts) {
      return (async function* () {
        if (net.gate) await net.gate;
        if (net.mode === "down") throw new TypeError("fetch failed");
        net.sent.push(env);
        if (net.mode === "lossy") {
          for await (const _f of inner.send(env, opts)) {
            // the server answered, and the answer never arrives
          }
          throw new TypeError("fetch failed");
        }
        yield* inner.send(env, opts);
      })();
    },
  };
  return { net, transport };
}

const clientOn = (transport: Transport, extra: Partial<ClientOptions> = {}) =>
  new RayfoldClient({ transport, keyGen: () => `sync-key-${String(++keyN).padStart(8, "0")}`, ...extra });
const stockOf = (c: RayfoldClient, id = "b1") => c.cache.get(`Book:${id}`)?.["stock"];

describe("predictions in the cache", () => {
  it("stack, and removing one leaves the server's value under whatever prediction is left", () => {
    const cache = new RayfoldCache();
    cache.applyPatch([{ set: "Book:b1", value: { stock: 5, title: "T" } }, { set: "Book:b2", value: { stock: 1 } }]);
    cache.addLayer("a", [{ set: "Book:b1", value: { stock: 6 } }]);
    cache.addLayer("b", [{ set: "Book:b1", value: { stock: 8 } }]);
    expect(cache.get("Book:b1")).toMatchObject({ stock: 8, title: "T" });
    cache.removeLayer("b");
    expect(cache.get("Book:b1")?.["stock"]).toBe(6);
    cache.applyPatch([{ set: "Book:b1", value: { stock: 7 } }]); // the server moves underneath the prediction
    expect(cache.get("Book:b1")?.["stock"]).toBe(6);
    cache.removeLayer("a");
    expect(cache.get("Book:b1")).toMatchObject({ stock: 7, title: "T" });
    expect(cache.predictions).toEqual([]);
    // guard: an entity no prediction covers takes server writes directly
    cache.applyPatch([{ set: "Book:b2", value: { stock: 2 } }]);
    expect(cache.get("Book:b2")?.["stock"]).toBe(2);
  });
});

describe("optimistic commands (sub-profile sync, spec 08 section 5)", () => {
  it("show the prediction at once, then the server's own value when it answers", async () => {
    const { net, transport } = network(createLocalTransport(bs.server, () => admin));
    const c = clientOn(transport);
    const seen = new Signal<number>();
    const stop = c.watch<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }" }, (d) => seen.push(d.stock));
    await seen.atLeast(1, "the first value");
    let release!: () => void;
    net.gate = new Promise<void>((r) => (release = r));
    // the prediction is one short on purpose: the server's answer has to win
    const done = c.command("restock", { bookId: "b1", qty: 2 }, { shape: "{ id stock }", optimistic: (cache) => [{ set: "Book:b1", value: { stock: (cache.get("Book:b1")?.["stock"] as number) + 1 } }] });
    await seen.atLeast(2, "the prediction");
    expect(seen.items.slice(0, 2)).toEqual([5, 6]);
    expect(bs.store.books.get("b1")!.stock).toBe(5); // nothing has reached the server yet
    net.gate = null;
    release();
    await expect(done).resolves.toMatchObject({ stock: 7 });
    await seen.until((xs) => xs.at(-1) === 7, "the server's value");
    expect(stockOf(c)).toBe(7);
    expect(c.cache.predictions).toEqual([]);
    stop();
  });

  it("roll back when the command fails, and the failure still reaches the caller", async () => {
    const c = clientOn(createLocalTransport(bs.server, () => customer));
    await c.query("book", { id: "b1" }, { shape: "{ id stock }" });
    const failed = c.command("placeOrder", { input: { lines: [{ bookId: "b1", qty: 99 }] } }, { optimistic: [{ set: "Book:b1", value: { stock: -94 } }] });
    expect(stockOf(c)).toBe(-94);
    await expect(failed).rejects.toSatisfy((e: unknown) => e instanceof RayfoldClientError && e.is("OutOfStock"));
    expect(stockOf(c)).toBe(5);
    expect(c.cache.predictions).toEqual([]);
  });
});

describe("the offline queue (sub-profile sync, spec 08 section 5)", () => {
  it("keeps commands made while the server is unreachable, shows their predictions, and sends them in order with their keys", async () => {
    const { net, transport } = network(createLocalTransport(bs.server, () => admin));
    const events = new Signal<QueueEvent>();
    const c = clientOn(transport, { offline: { storage: memoryQueue() } });
    c.onQueue((e) => events.push(e));
    net.mode = "down";
    const first = c.command("restock", { bookId: "b1", qty: 1 }, { shape: "{ id stock }", optimistic: [{ set: "Book:b1", value: { stock: 6 } }] });
    await events.atLeast(1, "the first command queued");
    net.mode = "up";
    // the network is back, but a command made now still waits behind the first
    const second = c.command("restock", { bookId: "b1", qty: 2 }, { shape: "{ id stock }" });
    await events.atLeast(2, "the second command queued");
    expect(c.queued.map((q) => q.key)).toEqual(["sync-key-00000001", "sync-key-00000002"]);
    expect(stockOf(c)).toBe(6);
    expect(net.sent).toEqual([]);
    expect(bs.store.books.get("b1")!.stock).toBe(5);

    expect(await c.drain()).toBe(0);
    await expect(first).resolves.toMatchObject({ stock: 6 });
    await expect(second).resolves.toMatchObject({ stock: 8 });
    expect(net.sent.map((e) => e.ops[0]!.key)).toEqual(["sync-key-00000001", "sync-key-00000002"]);
    expect(bs.store.books.get("b1")!.stock).toBe(8);
    expect(stockOf(c)).toBe(8);
    expect(events.items.map((e) => e.type)).toEqual(["queued", "queued", "sent", "sent"]);
  });

  it("a drain while the server is still unreachable sends nothing and keeps every command", async () => {
    const { net, transport } = network(createLocalTransport(bs.server, () => admin));
    const events = new Signal<QueueEvent>();
    const c = clientOn(transport, { offline: {} });
    c.onQueue((e) => events.push(e));
    net.mode = "down";
    void c.command("restock", { bookId: "b1", qty: 1 });
    void c.command("restock", { bookId: "b2", qty: 1 });
    await events.atLeast(2, "both queued");
    // made back to back, both attempts failed; the queue holds them in the order they were made
    expect(c.queued.map((q) => q.args["bookId"])).toEqual(["b1", "b2"]);
    expect(await c.drain()).toBe(2);
    expect(bs.store.calls["Command.restock"]).toBeUndefined();
  });

  it("a command the server ran before its answer was lost is replayed on the retry, not run twice", async () => {
    const { net, transport } = network(createLocalTransport(bs.server, () => admin));
    const events = new Signal<QueueEvent>();
    const c = clientOn(transport, { offline: {} });
    c.onQueue((e) => events.push(e));
    net.mode = "lossy";
    const restocked = c.command("restock", { bookId: "b1", qty: 1 }, { shape: "{ id stock }" });
    await events.atLeast(1, "queued after the lost answer");
    expect(bs.store.calls["Command.restock"]).toBe(1); // it did run on the server
    net.mode = "up";
    expect(await c.drain()).toBe(0);
    await expect(restocked).resolves.toMatchObject({ stock: 6 });
    expect(bs.store.calls["Command.restock"]).toBe(1); // the retry carried the same key and was answered from the record
    expect(bs.store.books.get("b1")!.stock).toBe(6);
  });

  it("a queued command the server refuses is rolled back and rejected, and the next one still goes out", async () => {
    const { net, transport } = network(createLocalTransport(bs.server, () => customer));
    const events = new Signal<QueueEvent>();
    const c = clientOn(transport, { offline: {} });
    c.onQueue((e) => events.push(e));
    net.mode = "down";
    const tooMany = c.command("placeOrder", { input: { lines: [{ bookId: "b1", qty: 99 }] } }, { optimistic: [{ set: "Book:b1", value: { stock: -94 } }] });
    const one = c.command("placeOrder", { input: { lines: [{ bookId: "b1", qty: 1 }] } }, { shape: "{ id status }" });
    await events.atLeast(2, "both queued");
    net.mode = "up";
    expect(await c.drain()).toBe(0);
    await expect(tooMany).rejects.toSatisfy((e: unknown) => e instanceof RayfoldClientError && e.is("OutOfStock"));
    await expect(one).resolves.toMatchObject({ status: "PLACED" });
    expect(c.cache.predictions).toEqual([]);
    expect(events.items.map((e) => e.type)).toEqual(["queued", "queued", "failed", "sent"]);
    expect(bs.store.books.get("b1")!.stock).toBe(4);
  });

  it("the queue survives a reload: a new client with the same storage shows the prediction again and sends the command", async () => {
    const { net, transport } = network(createLocalTransport(bs.server, () => admin));
    const saved = new Map<string, string>();
    const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
    const events = new Signal<QueueEvent>();
    const before = clientOn(transport, { offline: { storage: localStorageQueue("orders", storage) } });
    before.onQueue((e) => events.push(e));
    net.mode = "down";
    void before.command("restock", { bookId: "b1", qty: 1 }, { shape: "{ id stock }", optimistic: [{ set: "Book:b1", value: { stock: 6 } }] });
    await events.atLeast(1, "queued");
    expect(JSON.parse(saved.get("orders")!)).toMatchObject([{ key: "sync-key-00000001", op: "restock", optimistic: [{ set: "Book:b1" }] }]);

    const after = clientOn(transport, { offline: { storage: localStorageQueue("orders", storage) } });
    expect(await after.drain()).toBe(1); // still offline, and the restored command waits
    expect(stockOf(after)).toBe(6);
    net.mode = "up";
    expect(await after.drain()).toBe(0);
    expect(net.sent.map((e) => e.ops[0]!.key)).toEqual(["sync-key-00000001"]);
    expect(bs.store.books.get("b1")!.stock).toBe(6);
    expect(saved.has("orders")).toBe(false);
  });

  it("the browser coming back online sends the waiting commands; guard: drainOnReconnect false listens for nothing", async () => {
    // Node has no window: a stand-in with a browser's addEventListener
    const window = new EventTarget();
    const listening: string[] = [];
    vi.stubGlobal("addEventListener", (type: string, fn: () => void) => {
      listening.push(type);
      window.addEventListener(type, fn);
    });
    const { net, transport } = network(createLocalTransport(bs.server, () => admin));
    const manual = clientOn(transport, { offline: { drainOnReconnect: false } });
    const c = clientOn(transport, { offline: {} });
    expect(listening).toEqual(["online"]);
    const events = new Signal<QueueEvent>();
    const manualEvents = new Signal<QueueEvent>();
    c.onQueue((e) => events.push(e));
    manual.onQueue((e) => manualEvents.push(e));
    net.mode = "down";
    const restocked = c.command("restock", { bookId: "b1", qty: 1 }, { shape: "{ id stock }" });
    const held = manual.command("restock", { bookId: "b2", qty: 1 }, { shape: "{ id stock }" });
    await events.atLeast(1, "queued while offline");
    await manualEvents.atLeast(1, "the manual client's command queued while offline");
    net.mode = "up";
    window.dispatchEvent(new Event("online"));
    expect(await bounded(restocked, "sent on the online event")).toEqual({ $type: "Book", id: "b1", stock: 6 });
    expect(events.items.map((e) => e.type)).toEqual(["queued", "sent"]);
    expect(manual.queued.map((q) => q.args["bookId"])).toEqual(["b2"]);
    // the manual client sends only when told to
    expect(await manual.drain()).toBe(0);
    expect(await held).toEqual({ $type: "Book", id: "b2", stock: 3 });
    expect(net.sent.map((e) => e.ops[0]!.args?.["bookId"])).toEqual(["b1", "b2"]);
  });

  it("guard: without `offline`, a failed network rejects as before, rolls the prediction back, and queues nothing", async () => {
    const { net, transport } = network(createLocalTransport(bs.server, () => admin));
    const c = clientOn(transport);
    net.mode = "down";
    await expect(c.command("restock", { bookId: "b1", qty: 1 }, { optimistic: [{ set: "Book:b1", value: { stock: 6 } }] })).rejects.toThrow("fetch failed");
    expect(c.queued).toEqual([]);
    expect(c.cache.get("Book:b1")).toBeUndefined();
    expect(await c.drain()).toBe(0);
  });
});
