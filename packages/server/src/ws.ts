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
import { HTTP_STATUS, RayfoldError, type Frame, type RequestEnvelope, type WireError } from "./protocol.ts";
import { hostProblem, originProblem, type OriginOptions } from "./guard.ts";
import { codecFor } from "./http.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const SUBPROTOCOL = "rayfold.0.1";
/** Close code for a client whose RB dictionary was built from another schema (spec 04 section 5). */
export const SCHEMA_MISMATCH = 4409;

export interface WsOptions extends OriginOptions {
  /** Largest frame or assembled message accepted, in bytes. Default 1 MiB. */
  maxMessage?: number;
  /**
   * Most bytes of frames that may wait for a client that is not reading. Past this its ops are stopped and the socket
   * is dropped, rather than a live query buffering without bound. Default 8 MiB.
   */
  maxBuffered?: number;
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
    // the viewer is settled before the socket is accepted, so a hook that refuses (a bad token) is answered as HTTP
    // answers it, rather than rejecting with nothing to catch it: an unhandled rejection ends the process
    void (async () => {
      let viewer: unknown = null;
      try {
        if (opts.viewer) viewer = await opts.viewer(req);
      } catch (e) {
        const status = e instanceof RayfoldError ? HTTP_STATUS[e.code] : 500;
        const detail = e instanceof RayfoldError ? e.message : "Internal error";
        socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Type: text/plain\r\nX-Content-Type-Options: nosniff\r\n\r\n${detail}`, () => socket.destroy());
        return;
      }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`);
      // RB keys are numbered from the schema, so a client holding another one would read every answer under the wrong
      // names, without an error. The close follows the upgrade because a browser cannot read a refused handshake.
      const schema = url.searchParams.get("schema");
      if (schema !== null && schema !== server.hash) {
        const code = Buffer.from([SCHEMA_MISMATCH >> 8, SCHEMA_MISMATCH & 0xff]);
        socket.end(encodeFrame(Buffer.concat([code, Buffer.from(server.hash, "utf8")]), 0x8), () => socket.destroy());
        return;
      }
      handleConnection(socket, head, viewer, server, opts);
    })();
  });
}

function handleConnection(socket: Duplex, head: Buffer, viewer: unknown, server: RayfoldServer, opts: WsOptions): void {
  // one controller per open op, so `{ "cancel": id }` stops that op and leaves the rest of its batch running
  const ops = new Map<number, AbortController>();
  const maxBuffered = opts.maxBuffered ?? 8 * 1024 * 1024;
  const abortAll = (reason: RayfoldError) => {
    for (const ac of ops.values()) ac.abort(reason);
  };
  const stopAll = (reason: RayfoldError) => {
    abortAll(reason);
    ops.clear();
  };
  // text frames for a JSON batch; for an RB batch, binary messages of one length-prefixed RB frame each
  const send = (obj: unknown, binary = false) => {
    if (socket.writableEnded || socket.destroyed) return;
    socket.write(binary ? encodeFrame(Buffer.from(codecFor(server).encodeFrames([obj])), 0x2) : encodeFrame(Buffer.from(JSON.stringify(obj), "utf8"), 0x1));
    // what the socket could not pass on waits here; a client that stops reading would otherwise grow it without bound
    if (socket.writableLength > maxBuffered) {
      stopAll(new RayfoldError("resource_exhausted", "The client stopped reading"));
      socket.destroy();
    }
  };
  // A socket ends on the server's side in two ways: the server drains (1001, and the runtime has ended its live
  // queries and streams with `unavailable`), or the viewer's capability expires (1008, its ops ended `unauthenticated`).
  // Either way it closes once those ops' last frames are out, so the client learns why.
  let ending: { code: number; reason: string } | undefined;
  const endWhenIdle = () => {
    if (!ending || ops.size) return;
    server.draining.removeEventListener("abort", goingAway);
    clearTimeout(expiry);
    socket.end(encodeFrame(Buffer.concat([Buffer.from([ending.code >> 8, ending.code & 0xff]), Buffer.from(ending.reason)]), 0x8), () => socket.destroy());
  };
  const goingAway = () => {
    ending ??= { code: 1001, reason: "server shutting down" };
    endWhenIdle();
  };
  // spec 06 §6: a capability is refused once its exp has passed, and the socket was opened with it, so it ends there
  // rather than serving on, live queries included.
  const exp = capabilityExp(viewer);
  const expired = () => exp !== undefined && exp <= server.options.now();
  const revoke = () => {
    if (!ending) ending = { code: 1008, reason: "capability expired" };
    // the ops stay tracked until their last frames are out, and the socket closes after them
    abortAll(new RayfoldError("unauthenticated", "Capability has expired"));
    endWhenIdle();
  };
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const watchExpiry = () => {
    if (exp === undefined) return;
    if (expired()) return revoke();
    // a timer's longest delay is about 24 days; a later expiry is looked at again then
    expiry = setTimeout(watchExpiry, Math.min(exp - server.options.now(), 2_147_483_647));
  };
  const close = () => {
    server.draining.removeEventListener("abort", goingAway);
    clearTimeout(expiry);
    stopAll(new RayfoldError("canceled", "Canceled"));
    socket.end();
  };
  if (server.draining.aborted) goingAway();
  else server.draining.addEventListener("abort", goingAway, { once: true });
  watchExpiry();
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
      // an op that is not an object with a positive integer id is not tracked here; execute refuses the envelope for it
      const idOf = (o: unknown) => (o !== null && typeof o === "object" ? (o as { id?: unknown }).id : undefined);
      const ids = [...new Set((env.ops as unknown[]).map(idOf).filter((id): id is number => Number.isInteger(id) && (id as number) > 0))];
      // A refusal of the whole batch has no op id, and a client routes frames by id: it could not tell which of its
      // batches was refused, and that batch's ops would wait for a fin for ever. So it goes to each op id the batch
      // named (spec 04 §5); a batch that named none gets it as it is.
      const refuseAll = (error: WireError) => {
        if (!ids.length) return send({ error, fin: true }, binary);
        for (const id of ids) send({ id, error, fin: true }, binary);
      };
      const taken = ids.find((id) => ops.has(id));
      if (taken !== undefined) {
        // not sent per id: the id belongs to an op still running, which would read the refusal as its own end
        send({ error: { code: "invalid_argument", message: `op id ${taken} is already in use on this connection` }, fin: true }, binary);
        return;
      }
      if (expired()) {
        refuseAll({ code: "unauthenticated", message: "Capability has expired" });
        revoke();
        return;
      }
      const signals = new Map<number, AbortSignal>();
      const mine = new Map<number, AbortController>();
      for (const id of ids) {
        const ac = new AbortController();
        ops.set(id, ac);
        mine.set(id, ac);
        signals.set(id, ac.signal);
      }
      void (async () => {
        try {
          for await (const f of server.execute(env, { viewer, opSignals: signals })) {
            if (!("id" in f) && "error" in f) {
              refuseAll(f.error);
              continue;
            }
            send(f, binary);
            if ("id" in f && "fin" in f && f.fin) ops.delete(f.id);
          }
        } catch {
          // execute answers its own failures as frames; anything that still escapes must not escape the socket's handler
          refuseAll({ code: "internal", message: "Internal error" });
        } finally {
          for (const [id, ac] of mine) if (ops.get(id) === ac) ops.delete(id);
          if (server.draining.aborted) goingAway();
          else endWhenIdle();
        }
      })();
      return;
    }
    send({ error: { code: "invalid_argument", message: "Expected a batch envelope or {cancel}" }, fin: true }, binary);
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

/** When the viewer's capability expires (epoch milliseconds, spec 06 section 6), if it holds one. */
function capabilityExp(viewer: unknown): number | undefined {
  const caps = viewer !== null && typeof viewer === "object" ? (viewer as { caps?: unknown }).caps : undefined;
  const exp = caps !== null && typeof caps === "object" ? (caps as { exp?: unknown }).exp : undefined;
  return typeof exp === "number" ? exp : undefined;
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
