/** WebSocket transport: one socket, many concurrent batches, per-op cancel. Spec 04 §5. */
import type { Frame, RequestEnvelope } from "@rayfold/server/protocol";
import { RbCodec } from "@rayfold/rb";
import type { RayfoldSchemaIR } from "@rayfold/schema";
import type { Transport } from "./transport.ts";

export interface WsTransportOptions {
  url: string;
  /** Subprotocols; default ["rayfold.0.1"]. */
  protocols?: string[];
  /** WebSocket constructor (defaults to the global one). */
  WebSocket?: typeof WebSocket;
  /** Called to build a fresh socket URL (e.g. to append a token) before each connect. */
  connectUrl?: () => string | Promise<string>;
  /** Rayfold Binary: pass the schema IR (from /rayfold/manifest) to send and receive RB messages instead of JSON text. */
  binary?: RayfoldSchemaIR;
}

interface Pending {
  ids: Set<number>;
  push: (f: Frame) => void;
  close: () => void;
}

export function createWebSocketTransport(o: WsTransportOptions): Transport & { close(): void } {
  const WS = o.WebSocket ?? globalThis.WebSocket;
  let socket: WebSocket | null = null;
  let opening: Promise<WebSocket> | null = null;
  let nextId = 1;
  const pending = new Set<Pending>();
  const codec = o.binary ? new RbCodec(o.binary) : null;
  const encode = (v: unknown): string | Uint8Array<ArrayBuffer> => (codec ? (codec.encode(v) as Uint8Array<ArrayBuffer>) : JSON.stringify(v));

  const route = (f: Frame): void => {
    if (!("id" in f)) {
      for (const p of pending) p.push(f);
      return;
    }
    for (const p of pending) {
      if (p.ids.has(f.id)) {
        p.push(f);
        if ("fin" in f && f.fin) {
          p.ids.delete(f.id);
          if (!p.ids.size) p.close();
        }
      }
    }
  };

  const connect = async (): Promise<WebSocket> => {
    if (socket && socket.readyState === WS.OPEN) return socket;
    if (opening) return opening;
    // A failed attempt is forgotten, so the next request tries again: kept, it answered every later request with the
    // same rejection and the transport was dead for the life of the client after one refused connection.
    const attempt: Promise<WebSocket> = (async () => {
      const url = o.connectUrl ? await o.connectUrl() : o.url;
      const ws = new WS(url, o.protocols ?? ["rayfold.0.1"]);
      if (codec) ws.binaryType = "arraybuffer";
      await new Promise<void>((res, rej) => {
        ws.addEventListener("open", () => res(), { once: true });
        ws.addEventListener("error", () => rej(new Error("WebSocket connection failed")), { once: true });
      });
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") return route(JSON.parse(ev.data) as Frame);
        // a binary message holds length-prefixed RB frames
        if (codec) for (const f of codec.decodeFrames(new Uint8Array(ev.data as ArrayBuffer))) route(f as Frame);
      });
      ws.addEventListener("close", () => {
        if (socket === ws) socket = null; // a replacement may already be open; it is not this one's to forget
        for (const p of pending) {
          for (const id of p.ids) p.push({ id, error: { code: "unavailable", message: "Connection closed" }, fin: true });
          p.close();
        }
        pending.clear();
      });
      socket = ws;
      return ws;
    })().finally(() => {
      if (opening === attempt) opening = null;
    });
    opening = attempt;
    return attempt;
  };

  return {
    send(envelope: RequestEnvelope, opts = {}) {
      const queue: Frame[] = [];
      let waiting: ((r: IteratorResult<Frame>) => void) | null = null;
      let closed = false;
      const p: Pending = {
        ids: new Set(),
        push: (f) => {
          if (waiting) {
            const w = waiting;
            waiting = null;
            w({ value: f, done: false });
          } else queue.push(f);
        },
        close: () => {
          closed = true;
          pending.delete(p);
          if (waiting) {
            const w = waiting;
            waiting = null;
            w({ value: undefined as never, done: true });
          }
        },
      };
      // Remap ids so several batches can share the socket.
      const map = new Map<number, number>();
      const remapped: RequestEnvelope = { ...envelope, ops: envelope.ops.map((op) => {
        const id = nextId++;
        map.set(id, op.id);
        p.ids.add(id);
        return { ...op, args: remapRefs(op.args, envelope.ops, map) as Record<string, unknown>, id };
      }) };
      const backMap = new Map([...map.entries()].map(([k, v]) => [k, v]));
      pending.add(p);
      const start = connect().then((ws) => ws.send(encode(remapped))).catch((e: Error) => {
        p.push({ error: { code: "unavailable", message: e.message }, fin: true });
        p.close();
      });
      opts.signal?.addEventListener("abort", () => {
        void start.then(() => {
          for (const id of p.ids) socket?.send(encode({ cancel: id }));
        });
      }, { once: true });
      return {
        [Symbol.asyncIterator](): AsyncIterator<Frame> {
          return {
            next: (): Promise<IteratorResult<Frame>> => {
              const deliver = (f: Frame): IteratorResult<Frame> => ({ value: "id" in f ? { ...f, id: backMap.get(f.id) ?? f.id } as Frame : f, done: false });
              if (queue.length) return Promise.resolve(deliver(queue.shift()!));
              if (closed) return Promise.resolve({ value: undefined as never, done: true });
              return new Promise((res) => (waiting = (r) => res(r.done ? r : deliver(r.value))));
            },
            return: (): Promise<IteratorResult<Frame>> => {
              for (const id of p.ids) socket?.send(encode({ cancel: id }));
              p.close();
              return Promise.resolve({ value: undefined as never, done: true });
            },
          };
        },
      };
    },
    close() {
      socket?.close();
    },
  };
}

/** Rewrite `{ $ref: "<oldId>.path" }` to the remapped id. */
function remapRefs(v: unknown, ops: RequestEnvelope["ops"], map: Map<number, number>): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => remapRefs(x, ops, map));
  const o = v as Record<string, unknown>;
  if (typeof o["$ref"] === "string" && Object.keys(o).length === 1) {
    const [idText, ...path] = o["$ref"].split(".");
    const oldId = Number(idText);
    const newId = [...map.entries()].find(([, old]) => old === oldId)?.[0];
    return { $ref: `${newId ?? oldId}.${path.join(".")}` };
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = remapRefs(x, ops, map);
  return out;
}
