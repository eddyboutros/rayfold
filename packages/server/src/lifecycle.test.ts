import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RayfoldContext } from "./context.ts";
import { ok } from "./executor.ts";
import { listen, shutdown } from "./http.ts";
import { MemoryRelay, type Relay } from "./relay.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
import { attachWebSocket } from "./ws.ts";
import { bounded, Signal } from "../../../e2e/wait.ts";

/**
 * What a load balancer and a rolling deploy need from a server: to be told when it can take traffic, and a shutdown
 * that finishes what is running, sends long-lived clients elsewhere, and only then goes away.
 */
const SCHEMA = `
  entity Book { id: ID stock: Int }
  event StockChanged { bookId: ID, stock: Int }
  query book(id: ID): Book?
  command restock(id: ID, qty: Int): Book emits StockChanged
  stream stockUpdates(bookIds: [ID]): StockChanged
`;
const KEY = "0123456789abcdef";
const viewer = { id: "u1" };

const open: Server[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const ws of sockets.splice(0)) if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  await Promise.all(
    open.splice(0).map(
      (h) =>
        new Promise<void>((r) => {
          h.close(() => r());
          h.closeAllConnections();
        }),
    ),
  );
});

interface Built {
  server: RayfoldServer;
  /** Pushed when the restock resolver starts; the test decides when it finishes through `release`. */
  running: Signal<true>;
  release: () => void;
}

function build(opts: { relay?: Relay; hold?: boolean } = {}): Built {
  const books = new Map([["b1", { id: "b1", stock: 3 }]]);
  const running = new Signal<true>();
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  const server = createRayfoldServer({
    schema: SCHEMA,
    ...(opts.relay ? { relay: opts.relay } : {}),
    resolvers: {
      Query: { book: ({ id }: { id: string }) => books.get(id) ?? null },
      Command: {
        restock: async ({ id, qty }: { id: string; qty: number }) => {
          running.push(true);
          if (opts.hold) await held;
          const book = books.get(id);
          if (!book) throw new Error(`no book ${id}`);
          book.stock += qty;
          return ok({ ...book }, { emit: [{ event: "StockChanged", payload: { bookId: book.id, stock: book.stock } }] });
        },
      },
      Stream: {
        stockUpdates: (args: { bookIds: string[] }, ctx: RayfoldContext) => {
          const wanted = new Set(args.bookIds);
          const source = ctx.events.subscribe<{ bookId: string; stock: number }>("StockChanged", ctx.signal);
          return (async function* () {
            for await (const ev of source) if (wanted.has(ev.bookId)) yield ev;
          })();
        },
      },
    },
  });
  return { server, running, release };
}

async function serve(server: RayfoldServer, opts: Parameters<typeof listen>[2] = {}): Promise<{ base: string; http: Server }> {
  const http = await listen(server, 0, { viewer: () => viewer, ...opts });
  open.push(http);
  return { base: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, http };
}

const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as unknown, headers: res.headers };
};
const post = (base: string, body: unknown) => fetch(`${base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: JSON.stringify(body) });
const restock = (base: string, key: string) => post(base, { ops: [{ id: 1, op: "restock", args: { id: "b1", qty: 1 }, key }] });

/** Opens a streaming response and records its frames as they arrive. */
async function stream(base: string, op: Record<string, unknown>): Promise<Signal<unknown>> {
  const res = await post(base, { ops: [{ id: 1, ...op }] });
  const frames = new Signal<unknown>();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) frames.push(JSON.parse(line));
      }
    }
  })();
  return frames;
}

const liveBook = { op: "book", args: { id: "b1" }, shape: "{ id stock }", live: true };
const unavailable = { id: 1, error: { code: "unavailable", message: "The server is shutting down" }, fin: true };

describe("health and readiness", () => {
  it("health answers while the process runs; readiness is true for a server with nothing to wait for", async () => {
    const { base } = await serve(build().server);
    expect(await get(`${base}/rayfold/health`)).toMatchObject({ status: 200, body: { status: "ok" } });
    const ready = await get(`${base}/rayfold/ready`);
    expect(ready).toMatchObject({ status: 200, body: { ready: true, reasons: [] } });
    expect(ready.headers.get("cache-control")).toBe("no-store");
  });

  it("readiness waits for the relay, and says what stopped it", async () => {
    let listening = () => {};
    const slow: Relay = { publish: async () => {}, subscribe: () => new Promise((resolve) => (listening = () => resolve(async () => {}))) };
    const { base } = await serve(build({ relay: slow }).server);
    expect(await get(`${base}/rayfold/ready`)).toMatchObject({ status: 503, body: { ready: false, reasons: ["relay: not listening yet"] } });
    listening();
    await bounded(
      (async () => {
        while ((await get(`${base}/rayfold/ready`)).status !== 200) await new Promise((r) => setImmediate(r));
      })(),
      "readiness turning true once the relay listens",
    );

    const broken: Relay = {
      publish: async () => {},
      subscribe: async () => {
        throw new Error("LISTEN failed");
      },
    };
    const failed = build({ relay: broken }).server;
    await failed.ready().catch(() => undefined);
    const { base: failedBase } = await serve(failed);
    expect(await get(`${failedBase}/rayfold/ready`)).toMatchObject({ status: 503, body: { ready: false, reasons: ["relay: LISTEN failed"] } });
    expect(await get(`${failedBase}/rayfold/health`)).toMatchObject({ status: 200 }); // alive, just not ready
  });

  it("runs the configured checks and names the one that failed; a check that never answers counts as failed", async () => {
    const { base } = await serve(build().server, {
      readiness: {
        db: async () => {
          throw new Error("connection refused");
        },
        cache: async () => "pong",
      },
    });
    expect(await get(`${base}/rayfold/ready`)).toMatchObject({ status: 503, body: { ready: false, reasons: ["db: connection refused"] } });

    const { base: healthy } = await serve(build().server, { readiness: { db: async () => 1, cache: async () => 2 } });
    expect(await get(`${healthy}/rayfold/ready`)).toMatchObject({ status: 200, body: { ready: true, reasons: [] } }); // guard: checks that pass leave it ready

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = new Signal<true>();
    const never = () => {
      started.push(true);
      return new Promise<never>(() => {});
    };
    const { base: stuck } = await serve(build().server, { readiness: { db: never }, readinessTimeoutMs: 2_000 });
    const answer = get(`${stuck}/rayfold/ready`);
    await started.atLeast(1, "the check being asked"); // its timer exists only from here; advancing earlier would miss it
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await answer).toMatchObject({ status: 503, body: { ready: false, reasons: ["db: no answer within 2000 ms"] } });
  });
});

describe("draining", () => {
  it("ends a live query and a stream with a retryable unavailable, lets a running command finish, and resolves once it has", async () => {
    const built = build({ hold: true });
    const { base } = await serve(built.server);
    const live = await stream(base, liveBook);
    const updates = await stream(base, { op: "stockUpdates", args: { bookIds: ["b1"] } });
    await live.atLeast(1, "the live query answering");
    expect(live.items[0]).toMatchObject({ id: 1, data: { id: "b1", stock: 3 } });

    const command = restock(base, KEY);
    await built.running.atLeast(1, "the command running");
    expect(built.server.inflight).toBe(3);

    let drained = false;
    const draining = built.server.drain({ timeoutMs: 5_000 }).then(() => (drained = true));
    await live.atLeast(2, "the live query being ended");
    await updates.atLeast(1, "the stream being ended");
    expect(live.items[1]).toEqual(unavailable);
    expect(updates.items[0]).toEqual(unavailable);
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(drained).toBe(false); // the command is still running: shutting down waits for it
    expect(built.server.inflight).toBe(1);

    built.release();
    const answered = await command;
    expect(answered.status).toBe(200);
    expect(await answered.text()).toContain('"ok":{"$type":"Book","id":"b1","stock":4}');
    await bounded(draining, "drain resolving once the command finished");
    expect(built.server.inflight).toBe(0);

    // from here the balancer is told to look elsewhere, and so is anything that still arrives
    expect(await get(`${base}/rayfold/ready`)).toMatchObject({ status: 503, body: { ready: false, reasons: ["shutting down"] } });
    expect(await get(`${base}/rayfold/health`)).toMatchObject({ status: 200, body: { status: "ok" } });
    const late = await restock(base, KEY + "2");
    expect(late.status).toBe(503);
    expect(late.headers.get("retry-after")).toBe("1");
    expect(await late.json()).toMatchObject({ code: "unavailable", detail: "The server is shutting down" });
  });

  it("gives up waiting for a batch that never finishes after timeoutMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const built = build({ hold: true }); // never released
    const { base } = await serve(built.server);
    void restock(base, KEY);
    await built.running.atLeast(1, "the command running");
    let drained = false;
    const draining = built.server.drain({ timeoutMs: 1_000 }).then(() => (drained = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(drained).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await bounded(draining, "drain giving up at the timeout");
    expect(built.server.inflight).toBe(1); // still running; the process is about to end regardless
  });

  it("closes a WebSocket as a server going away, after the frames that end its live queries", async () => {
    const built = build();
    const http = createServer((_req, res) => res.writeHead(404).end());
    attachWebSocket(http, built.server, { viewer: () => viewer });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    open.push(http);
    const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold/ws`, ["rayfold.0.1"]);
    sockets.push(ws);
    const received = new Signal<unknown>();
    const closed = new Signal<{ code: number; reason: string }>();
    ws.addEventListener("message", (e) => received.push(JSON.parse(String(e.data))));
    ws.addEventListener("close", (e) => closed.push({ code: e.code, reason: e.reason }));
    await bounded(new Promise<void>((r) => ws.addEventListener("open", () => r(), { once: true })), "socket open");
    ws.send(JSON.stringify({ ops: [{ id: 1, ...liveBook }] }));
    await received.atLeast(1, "the live query answering over the socket");

    await built.server.drain();
    await closed.atLeast(1, "the socket closing");
    expect(received.items[1]).toEqual(unavailable);
    expect(closed.items[0]).toEqual({ code: 1001, reason: "server shutting down" });
  });

  it("shutdown() drains, closes the port, and stops hearing the relay", async () => {
    const relay = new MemoryRelay();
    const built = build({ relay: relay.join() });
    await built.server.ready();
    expect(relay.size).toBe(1);
    const { base, http } = await serve(built.server);
    expect((await restock(base, KEY)).status).toBe(200);

    await shutdown(built.server, http);
    expect(relay.size).toBe(0);
    await expect(fetch(`${base}/rayfold/health`)).rejects.toThrow();
  });
});
