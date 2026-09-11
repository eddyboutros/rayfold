/**
 * WebSocket transport (spec 04 §5) with a dependency-free RFC 6455 server side.
 * Text messages carry JSON envelopes/frames and binary messages carry RB (spec 09 §4); a batch is answered in the form
 * it came in. `{ "cancel": id }` stops an op; `{ "id", "item" }` and `{ "id", "fin": true }` feed bidirectional
 * streams (reserved for the `@input` extension).
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { RayfoldServer } from "./server.ts";
import { RayfoldError, type Frame, type RequestEnvelope } from "./protocol.ts";
import { hostProblem, originProblem, type OriginOptions } from "./guard.ts";
import { codecFor } from "./http.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const SUBPROTOCOL = "rayfold.0.1";

export interface WsOptions extends OriginOptions {
  /** Largest frame or assembled message accepted, in bytes. Default 1 MiB. */
  maxMessage?: number;
  path?: string;
  viewer?: (req: IncomingMessage) => unknown | Promise<unknown>;
}

/** Attach the Rayfold WebSocket endpoint to a Node HTTP server. */
export function attachWebSocket(http: Server, server: RayfoldServer, opts: WsOptions = {}): void {
  const path = opts.path ?? "/rayfold/ws";
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Browsers send the page's Origin on the handshake and attach cookies: without this check any site could open a socket as the user.
    const refused = hostProblem(req, opts) ?? originProblem(req, opts);
    if (refused) {
      socket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${refused}`, () => socket.destroy()); // flush the refusal, then close fully
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    const proto = (req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim()).includes(SUBPROTOCOL) ? `Sec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n` : "";
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`);
    void handleConnection(socket, head, req, server, opts);
  });
}

async function handleConnection(socket: Duplex, head: Buffer, req: IncomingMessage, server: RayfoldServer, opts: WsOptions): Promise<void> {
  const viewer = opts.viewer ? await opts.viewer(req) : null;
  const ops = new Map<number, AbortController>();
  // text frames for a JSON batch; for an RB batch, binary messages of one length-prefixed RB frame each
  const send = (obj: unknown, binary = false) =>
    socket.write(binary ? encodeFrame(Buffer.from(codecFor(server).encodeFrames([obj])), 0x2) : encodeFrame(Buffer.from(JSON.stringify(obj), "utf8"), 0x1));
  const close = () => {
    for (const ac of ops.values()) ac.abort(new RayfoldError("canceled", "Canceled"));
    ops.clear();
    socket.end();
  };
  const onMessage = (payload: Buffer, binary: boolean) => {
    let msg: unknown;
    try {
      msg = binary ? codecFor(server).decode(new Uint8Array(payload)) : JSON.parse(payload.toString("utf8"));
    } catch {
      send({ error: { code: "invalid_argument", message: binary ? "Message is not valid RB" : "Message is not valid JSON" }, fin: true }, binary);
      return;
    }
    // null, a number or a list is not a message; reading a member of null would throw out of the socket's data handler
    const m = (msg !== null && typeof msg === "object" ? msg : {}) as Record<string, unknown>;
    if (typeof m["cancel"] === "number") {
      const ac = ops.get(m["cancel"]);
      if (ac) ac.abort(new RayfoldError("canceled", "Canceled"));
      return;
    }
    if (Array.isArray(m["ops"])) {
      const env = m as unknown as RequestEnvelope;
      const ac = new AbortController();
      for (const o of env.ops) {
        if (ops.has(o?.id)) {
          send({ error: { code: "invalid_argument", message: `op id ${o.id} is already in use on this connection` }, fin: true }, binary);
          return;
        }
      }
      for (const o of env.ops) ops.set(o.id, ac);
      void (async () => {
        try {
          for await (const f of server.execute(env, { viewer, signal: ac.signal })) {
            send(f, binary);
            if ("id" in f && "fin" in f && f.fin) ops.delete(f.id);
          }
        } finally {
          for (const o of env.ops) if (ops.get(o.id) === ac) ops.delete(o.id);
        }
      })();
      return;
    }
    send({ error: { code: "invalid_argument", message: "Expected a batch envelope, {cancel}, or a stream item" }, fin: true }, binary);
  };

  let buf = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let assembled = 0;
  let messageBinary = false;
  const maxMessage = opts.maxMessage ?? 1_048_576;
  let refused = false;
  const tooBig = () => {
    refused = true;
    buf = Buffer.alloc(0);
    fragments = [];
    for (const ac of ops.values()) ac.abort(new RayfoldError("canceled", "Canceled"));
    ops.clear();
    // close code 1009 (message too big); flushed before the socket is closed
    socket.end(encodeFrame(Buffer.concat([Buffer.from([0x03, 0xf1]), Buffer.from("message too big")]), 0x8), () => socket.destroy());
  };
  socket.on("data", (chunk: Buffer) => {
    if (refused) return;
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > maxMessage + 14) return tooBig(); // a frame larger than the limit is never buffered to completion
    for (;;) {
      const parsed = decodeFrame(buf);
      if (!parsed) break;
      buf = buf.subarray(parsed.length);
      const { opcode, fin, payload } = parsed;
      if (opcode === 0x8) {
        socket.write(encodeFrame(Buffer.alloc(0), 0x8));
        close();
        return;
      }
      if (opcode === 0x9) {
        socket.write(encodeFrame(payload, 0xa));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) messageBinary = opcode === 0x2; // continuation frames keep the first frame's type
      assembled += payload.length;
      if (assembled > maxMessage) return tooBig();
      fragments.push(payload);
      if (fin) {
        const message = Buffer.concat(fragments);
        fragments = [];
        assembled = 0;
        onMessage(message, messageBinary);
      }
    }
  });
  // Node keeps server sockets half-open: a client that drops without a close frame only sends FIN ("end").
  // Closing on "end" too releases the socket and its live subscriptions instead of leaking them.
  socket.on("end", close);
  socket.on("close", close);
  socket.on("error", close);
}

export function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export function decodeFrame(buf: Buffer): { opcode: number; fin: boolean; payload: Buffer; length: number } | null {
  if (buf.length < 2) return null;
  const b0 = buf[0]!;
  const b1 = buf[1]!;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  const maskKey = masked ? buf.subarray(off, off + 4) : null;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!;
  return { opcode, fin, payload, length: off + len };
}

export type { Frame };
