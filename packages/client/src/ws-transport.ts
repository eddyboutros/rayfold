/** WebSocket transport: one socket, many concurrent batches, per-op cancel. Spec 04 §5. */
import type { Frame, RequestEnvelope } from "@rayfold/server/protocol";
import { RbCodec } from "@rayfold/rb";
import { schemaHash, type RayfoldSchemaIR } from "@rayfold/schema";
import type { SchemaWithHash, Transport } from "./transport.ts";

export interface WsTransportOptions {
  url: string;
  /** Subprotocols; default ["rayfold.0.1"]. */
  protocols?: string[];
  /** WebSocket constructor (defaults to the global one). */
  WebSocket?: typeof WebSocket;
  /** Called to build a fresh socket URL (e.g. to append a token) before each connect. */
  connectUrl?: () => string | Promise<string>;
  /**
   * Rayfold Binary: send and read RB messages instead of JSON text. Pass the manifest from GET /rayfold/manifest, or the
   * server's full schema IR. The socket names the schema's hash when it connects, and a server holding another schema
   * closes it (spec 04 section 5): the batches on it fail as `unavailable`, and later ones go as JSON.
   */
  binary?: RayfoldSchemaIR | SchemaWithHash;
}

interface Pending {
  ids: Set<number>;
  push: (f: Frame) => void;
  close: () => void;
  /** its envelope is on the socket, so the server may be answering it */
  sent: boolean;
  /** a frame carrying one of its op ids arrived, so the server took the envelope */
  answered: boolean;
}

/** A frame without an op id, and the batches it may be the answer to: those sent and not answered when it came. */
interface Orphan {
  frame: Frame;
  among: Set<Pending>;
}

/** The close code of a server holding another schema than the client's RB dictionary (spec 04 section 5). */
const SCHEMA_MISMATCH = 4409;

export function createWebSocketTransport(o: WsTransportOptions): Transport & { close(): void } {
  const WS = o.WebSocket ?? globalThis.WebSocket;
  let socket: WebSocket | null = null;
  let opening: Promise<WebSocket> | null = null;
  let nextId = 1;
  const pending = new Set<Pending>();
  const orphans: Orphan[] = [];
  const rb = o.binary
    ? "schemaHash" in o.binary
      ? { codec: new RbCodec(o.binary.schema), hash: o.binary.schemaHash }
      : { codec: new RbCodec(o.binary), hash: schemaHash(o.binary) }
    : null;
  // dropped for good once a server says it holds another schema: its keys would decode under the wrong names
  let codec = rb?.codec ?? null;
  const encode = (v: unknown): string | Uint8Array<ArrayBuffer> => (codec ? (codec.encode(v) as Uint8Array<ArrayBuffer>) : JSON.stringify(v));

  /**
   * A server refusing a whole envelope used to answer with one frame without an op id, the batch's only answer, and
   * nothing in it says whose it is (spec 04 section 5). Handed to every batch on the socket, it failed batches that
   * had nothing to do with it and left the refused one open for ever. It goes to a batch once no other can be its
   * owner: an answered batch is not, and n such frames among n unanswered batches are one each. The batch that gets
   * it is closed, as the server has nothing more to send it.
   */
  const attribute = (): void => {
    for (;;) {
      for (const o of orphans) for (const p of o.among) if (!pending.has(p) || p.answered) o.among.delete(p);
      for (let i = orphans.length - 1; i >= 0; i--) if (!orphans[i]!.among.size) orphans.splice(i, 1);
      const within = (s: Set<Pending>) => (x: Orphan) => [...x.among].every((p) => s.has(p));
      const owned = orphans.find((o) => orphans.filter(within(o.among)).length >= o.among.size);
      if (!owned) return;
      for (const p of [...owned.among]) {
        const [o] = orphans.splice(orphans.findIndex(within(owned.among)), 1);
        p.push(o!.frame);
        p.ids.clear();
        p.close();
      }
    }
  };

  const route = (f: Frame): void => {
    if (!("id" in f)) {
      orphans.push({ frame: f, among: new Set([...pending].filter((p) => p.sent && !p.answered)) });
      attribute();
      return;
    }
    for (const p of pending) {
      if (p.ids.has(f.id)) {
        p.answered = true;
        p.push(f);
        if ("fin" in f && f.fin) {
          p.ids.delete(f.id);
          if (!p.ids.size) p.close();
        }
      }
    }
    if (orphans.length) attribute();
  };

  const connect = async (): Promise<WebSocket> => {
    if (socket && socket.readyState === WS.OPEN) return socket;
    if (opening) return opening;
    // A failed attempt is forgotten, so the next request tries again: kept, it answered every later request with the
    // same rejection and the transport was dead for the life of the client after one refused connection.
    const attempt: Promise<WebSocket> = (async () => {
      const base = o.connectUrl ? await o.connectUrl() : o.url;
      const url = codec && rb ? `${base}${base.includes("?") ? "&" : "?"}schema=${encodeURIComponent(rb.hash)}` : base;
      const ws = new WS(url, o.protocols ?? ["rayfold.0.1"]);
      // read as bytes either way: a socket opened for RB may still receive them after the codec is dropped
      if (rb) ws.binaryType = "arraybuffer";
      await new Promise<void>((res, rej) => {
        ws.addEventListener("open", () => res(), { once: true });
        ws.addEventListener("error", () => rej(new Error("WebSocket connection failed")), { once: true });
      });
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data === "string") return route(JSON.parse(ev.data) as Frame);
        // a binary message holds length-prefixed RB frames
        if (codec) for (const f of codec.decodeFrames(new Uint8Array(ev.data as ArrayBuffer))) route(f as Frame);
      });
      ws.addEventListener("close", (ev) => {
        if (ev.code === SCHEMA_MISMATCH) codec = null;
        if (socket === ws) socket = null; // a replacement may already be open; it is not this one's to forget
        for (const p of pending) {
          for (const id of p.ids) p.push({ id, error: { code: "unavailable", message: "Connection closed" }, fin: true });
          p.close();
        }
        pending.clear();
        orphans.length = 0;
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
      const onAbort = () => {
        void start.then(() => {
          for (const id of p.ids) socket?.send(encode({ cancel: id }));
        });
      };
      const p: Pending = {
        sent: false,
        answered: false,
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
          opts.signal?.removeEventListener("abort", onAbort);
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
      const start = connect()
        .then((ws) => {
          p.sent = true;
          ws.send(encode(remapped));
        })
        .catch((e: Error) => {
          p.push({ error: { code: "unavailable", message: e.message }, fin: true });
          p.close();
        });
      opts.signal?.addEventListener("abort", onAbort, { once: true });
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
              if (orphans.length) attribute(); // one batch fewer may leave another the only owner
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
