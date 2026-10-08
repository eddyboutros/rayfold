import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as connectTcp, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { schemaHash } from "@rayfold/schema";
import { Signal, bounded } from "../../../e2e/wait.ts";
import { publicIR } from "./fetch.ts";
import { RayfoldError } from "./protocol.ts";
import { createRayfoldServer } from "./server.ts";
import { attachWebSocket, decodeFrame, encodeFrame } from "./ws.ts";

/**
 * The published `websocket/` vectors, run against this runtime's WebSocket transport over a real socket. The client is
 * a raw RFC 6455 one, so it can send bytes no WebSocket API would (a text message that is not UTF-8) and read the
 * handshake's status and the close frame's code and reason. `WebSocketVectorsTest.kt` checks the JVM against the same
 * file. Every wait is bounded, so a frame that never comes fails the case instead of hanging it.
 */
const PATH = new URL("../../../conformance/vectors/websocket/sessions.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
type Json = unknown;
type Step = Record<string, Json>;
interface Case {
  name: string;
  why?: string;
  viewer?: Json;
  hook?: "unauthenticated" | "throws";
  connect?: { schema: string };
  steps: Step[];
}
const doc = JSON.parse(readFileSync(PATH, "utf8")) as {
  schema: string;
  data: Array<{ id: string; stock: number }>;
  budget: number;
  clock: number;
  viewer: Json;
  cases: Case[];
};

const CASE_KEYS = new Set(["name", "why", "viewer", "hook", "connect", "steps"]);
const STEP_KEYS: Record<string, string[]> = { send: [], sendHex: [], command: [], clock: [], expect: [], close: ["reason"], ran: [], handshake: [] };

const open: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(open.splice(0).map((h) => new Promise<void>((r) => {
    h.close(() => r());
    h.closeAllConnections();
  })));
});

/** A server over the vector's schema and rows, with a clock the steps set and a count of each resolver's runs. */
function serverFor() {
  const rows = new Map(doc.data.map((r) => [r.id, { ...r }]));
  const ran: Record<string, number> = {};
  const count = (op: string) => (ran[op] = (ran[op] ?? 0) + 1);
  const clock = { now: doc.clock };
  const server = createRayfoldServer({
    schema: doc.schema,
    budget: doc.budget,
    now: () => clock.now,
    resolvers: {
      Query: {
        book: (args: { id: string }) => (count("book"), rows.get(args.id) ?? null),
        pricey: (args: { id: string }) => (count("pricey"), rows.get(args.id) ?? null),
      },
      Command: {
        restock: (args: { id: string; qty: number }) => {
          count("restock");
          const row = rows.get(args.id);
          if (!row) throw new RayfoldError("not_found", "No such book");
          row.stock += args.qty;
          return { ...row };
        },
      },
    },
  });
  return { server, ran, clock };
}

/** A raw client: the handshake's status, then every server frame in order (close frames as `{ close, reason }`). */
async function rawConnect(host: string, query: string) {
  const [h, port] = host.split(":");
  const socket = connectTcp(Number(port), h!);
  sockets.push(socket);
  await bounded(new Promise<void>((r, j) => socket.once("connect", r).once("error", j)), "tcp connect");
  const frames = new Signal<{ text?: string; close?: number; reason?: string }>();
  const status = new Signal<number>();
  let buf = Buffer.alloc(0);
  let upgraded = false;
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      status.push(Number(buf.subarray(0, end).toString("latin1").split(" ")[1]));
      upgraded = true;
      buf = buf.subarray(end + 4);
    }
    for (;;) {
      const f = decodeFrame(buf);
      if (!f) break;
      buf = buf.subarray(f.length);
      if (f.opcode === 0x8) frames.push({ close: f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005, reason: f.payload.subarray(2).toString("utf8") });
      else if (f.opcode === 0x1) frames.push({ text: f.payload.toString("utf8") });
    }
  });
  socket.write(
    `GET /rayfold/ws${query} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: rayfold.0.1\r\n\r\n`,
  );
  // clients mask what they send (RFC 6455 section 5.1); encodeFrame writes server frames, so the mask is added here
  const sendText = (payload: Buffer) => {
    const plain = encodeFrame(payload, 0x1);
    const head = plain.subarray(0, plain.length - payload.length);
    const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
    socket.write(Buffer.concat([Buffer.from([head[0]!, head[1]! | 0x80]), head.subarray(2), mask, masked]));
  };
  return { status, frames, sendText };
}

/** Exactly the expected members; `error` by code; "*" accepts anything present. */
function matches(want: Record<string, Json>, got: Record<string, Json>): boolean {
  if (Object.keys(want).sort().join() !== Object.keys(got).sort().join()) return false;
  return Object.entries(want).every(([k, v]) => {
    if (v === "*") return true;
    if (k === "error") return (got[k] as { code?: unknown })?.code === (v as { code: unknown }).code && Object.keys(v as object).every((m) => m === "code");
    return JSON.stringify(sortKeys(v)) === JSON.stringify(sortKeys(got[k]));
  });
}
function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}
const byOp = (fs: Array<Record<string, Json>>) => {
  const out = new Map<string, Array<Record<string, Json>>>();
  for (const f of fs) {
    const k = "id" in f ? String(f["id"]) : "batch";
    out.set(k, [...(out.get(k) ?? []), f]);
  }
  return out;
};

describe("conformance vectors: websocket", () => {
  for (const c of doc.cases) {
    it(c.name, async () => {
      const why = c.why ?? c.name;
      for (const k of Object.keys(c)) expect(CASE_KEYS.has(k), `${c.name}: no runner for case member "${k}"`).toBe(true);
      const { server, ran, clock } = serverFor();
      const viewer = c.viewer ?? doc.viewer;
      const http = createServer((_req, res) => res.writeHead(404).end());
      attachWebSocket(http, server, {
        viewer: () => {
          if (c.hook === "unauthenticated") throw new RayfoldError("unauthenticated", "Token expired");
          if (c.hook === "throws") throw new Error("key server down");
          expect(c.hook, `${c.name}: no runner for hook ${String(c.hook)}`).toBeUndefined();
          return viewer;
        },
      });
      await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
      open.push(http);
      const host = `127.0.0.1:${(http.address() as AddressInfo).port}`;

      const hashes: Record<string, string> = { $server: server.hash, $public: schemaHash(publicIR(server.ir)) };
      expect(hashes["$public"], "the vector needs a schema whose public form hashes differently").not.toBe(hashes["$server"]);
      const named = c.connect?.schema;
      if (c.connect) for (const k of Object.keys(c.connect)) expect(k, `${c.name}: no runner for connect.${k}`).toBe("schema");
      const query = named === undefined ? "" : `?schema=${encodeURIComponent(hashes[named] ?? named)}`;
      const client = await rawConnect(host, query);
      let read = 0;
      const next = async (n: number, label: string) => {
        const items = await client.frames.until((xs) => xs.length >= read + n, `${c.name}: ${label}`);
        const got = items.slice(read, read + n);
        read += n;
        return got;
      };

      const handshake = c.steps.find((s) => "handshake" in s);
      const status = (await client.status.atLeast(1, `${c.name}: the handshake's answer`))[0];
      expect(status, `${why}: handshake`).toBe(handshake ? handshake["handshake"] : 101);

      for (const step of c.steps) {
        const [action, ...rest] = Object.keys(step);
        expect(action !== undefined && action in STEP_KEYS, `${c.name}: no runner for step ${JSON.stringify(step)}`).toBe(true);
        for (const m of rest) expect(STEP_KEYS[action!]!.includes(m), `${c.name}: no runner for "${m}" on a ${action} step`).toBe(true);
        switch (action) {
          case "handshake":
            break; // checked above, before any other step
          case "send":
            client.sendText(Buffer.from(JSON.stringify(step["send"]), "utf8"));
            break;
          case "sendHex":
            client.sendText(Buffer.from(step["sendHex"] as string, "hex"));
            break;
          case "clock":
            clock.now = step["clock"] as number;
            break;
          case "command": {
            const op = step["command"] as { op: string; args: Json };
            const frames = await server.collect({ ops: [{ id: 1, op: op.op, args: op.args as Record<string, unknown>, key: `vector-${read}-${op.op}` }] }, { viewer });
            expect(frames.some((f) => "error" in f), `${c.name}: the command failed: ${JSON.stringify(frames)}`).toBe(false);
            break;
          }
          case "expect": {
            const want = step["expect"] as Array<Record<string, Json>>;
            const got = (await next(want.length, `${want.length} frame(s)`)).map((f) => {
              expect(f.text, `${why}: expected a frame, the server closed with ${f.close} ${f.reason}`).toBeDefined();
              return JSON.parse(f.text!) as Record<string, Json>;
            });
            const w = byOp(want);
            const g = byOp(got);
            expect([...g.keys()].sort(), `${why}: ${JSON.stringify(got)}`).toEqual([...w.keys()].sort());
            for (const [id, frames] of w) frames.forEach((f, i) => expect(matches(f, g.get(id)![i]!), `${why}: op ${id} frame ${i}: wanted ${JSON.stringify(f)}, got ${JSON.stringify(g.get(id)![i])}`).toBe(true));
            break;
          }
          case "close": {
            const [f] = await next(1, "the close frame");
            expect(f, `${why}: wanted a close, got ${JSON.stringify(f)}`).toMatchObject({ close: step["close"] });
            if ("reason" in step) expect(f!.reason, why).toBe(hashes[step["reason"] as string] ?? step["reason"]);
            break;
          }
          case "ran": {
            for (const [op, n] of Object.entries(step["ran"] as Record<string, number>)) expect(ran[op] ?? 0, `${why}: ${op} ran`).toBe(n);
            break;
          }
        }
      }
    });
  }
  it("covers the file", () => expect(doc.cases.length).toBeGreaterThan(10));
});
