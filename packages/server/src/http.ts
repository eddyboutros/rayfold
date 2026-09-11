/** HTTP transport for Node. Spec: spec/04-frames-and-transport.md §4. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { canonicalJson, fromBase64url, sha256Hex, annotation, type RayfoldSchemaIR } from "@rayfold/schema";
import type { RayfoldServer } from "./server.ts";
import { HTTP_STATUS, RayfoldError, type ErrorCode, type Frame, type RequestEnvelope, type WireError } from "./protocol.ts";
import { referencesViewer, type Expr } from "@rayfold/schema";
import { RbCodec, RB_CONTENT_TYPE } from "@rayfold/rb";
import { openApiFor } from "./openapi.ts";
import { BodyTooLarge, hostProblem, mediaType, originProblem, refuse, refuseBody, type OriginOptions } from "./guard.ts";

export interface HttpOptions extends OriginOptions {
  /** What GET {path}/manifest serves: the schema without policy expressions (default), the full IR, or nothing. */
  manifest?: "redacted" | "full" | "off";
  /** Path prefix, default "/rayfold". */
  path?: string;
  /** Turn the incoming request into a viewer (e.g. parse a Bearer token). */
  viewer?: (req: IncomingMessage) => unknown | Promise<unknown>;
  /** Max request body in bytes, default 1 MiB. */
  maxBody?: number;
  /** Extra CORS origin to allow (development). */
  cors?: string;
  /**
   * When a whole interval of this many milliseconds passes without a frame, a streaming response gets a keep-alive: an
   * empty line, or a zero-length RB frame (spec 04 section 4), so proxies do not close an idle live query. Default 15 000.
   */
  keepAliveMs?: number;
}

const FRAMES_TYPE = "application/rayfold-frames+json";
const codecs = new WeakMap<RayfoldServer, RbCodec>();
/** One RB codec per server: its key dictionary comes from the schema. */
export function codecFor(server: RayfoldServer): RbCodec {
  let c = codecs.get(server);
  if (!c) codecs.set(server, (c = new RbCodec(server.ir)));
  return c;
}
const PROBLEM_TYPE = "application/problem+json";
const KEEP_ALIVE_RB = Uint8Array.of(0);
const BODY_TYPES = new Set(["application/rayfold+json", "application/json", RB_CONTENT_TYPE]);

/** The IR without policy expressions: clients need names and types, not how access is decided. */
export function publicIR(ir: RayfoldSchemaIR): RayfoldSchemaIR {
  return JSON.parse(JSON.stringify(ir), (_k, v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const o = v as Record<string, unknown>;
    const isPolicy = (o["name"] === "allow" || o["name"] === "deny") && !("type" in o) && !!o["args"] && typeof o["args"] === "object" && !Array.isArray(o["args"]);
    return isPolicy ? { ...o, args: {} } : v;
  }) as RayfoldSchemaIR;
}

export function createHttpHandler(server: RayfoldServer, opts: HttpOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const base = opts.path ?? "/rayfold";
  const maxBody = opts.maxBody ?? 1_048_576;

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Rayfold-Schema", server.hash);
    res.setHeader("X-Content-Type-Options", "nosniff");
    const badHost = hostProblem(req, opts);
    if (badHost) return refuse(res, 403, "permission_denied", badHost);
    if (opts.cors) {
      res.setHeader("Access-Control-Allow-Origin", opts.cors);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Rayfold-Client, Rayfold-Deadline, Rayfold-Safe");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, QUERY, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
    }
    if (!url.pathname.startsWith(base)) {
      problem(res, "not_found", `No route for ${url.pathname}`);
      return;
    }
    const sub = url.pathname.slice(base.length);
    try {
      if (sub === "/manifest" && req.method === "GET") {
        if (opts.manifest === "off") throw new RayfoldError("not_found", `No route for ${url.pathname}`);
        json(res, 200, { ...server.manifest(), schema: opts.manifest === "full" ? server.ir : publicIR(server.ir) });
        return;
      }
      if (sub === "/openapi.json" && req.method === "GET") {
        json(res, 200, openApiFor(server.ir));
        return;
      }
      let envelope: RequestEnvelope;
      let safe = false;
      if (sub === "" || sub === "/") {
        if (req.method === "POST" || req.method === "QUERY") {
          // JSON-only bodies force browsers into a CORS preflight, so a cross-site form or text/plain post cannot run anything.
          const ct = mediaType(req);
          if (!BODY_TYPES.has(ct)) return refuse(res, 415, "invalid_argument", `Content-Type ${ct || "(none)"} is not accepted; send application/rayfold+json`, "unsupported_media_type", { "Accept-Post": [...BODY_TYPES].join(", ") });
          // Safe requests (QUERY, or POST with Rayfold-Safe, which may hold only queries) cannot change data. A foreign page
          // cannot send them without a CORS preflight and cannot read the answer, so only data-changing requests need the
          // Origin check. This keeps reads working behind proxies that rewrite Host.
          const declaredSafe = req.method === "QUERY" || req.headers["rayfold-safe"] === "true";
          const badOrigin = declaredSafe ? null : originProblem(req, opts);
          if (badOrigin) return refuse(res, 403, "permission_denied", badOrigin);
          const body = await readBody(req, maxBody);
          if (ct === RB_CONTENT_TYPE) {
            try {
              envelope = codecFor(server).decode(new Uint8Array(body)) as RequestEnvelope;
            } catch {
              throw new RayfoldError("invalid_argument", "Body is not valid RB");
            }
          } else {
            try {
              envelope = JSON.parse(body.toString("utf8")) as RequestEnvelope;
            } catch {
              throw new RayfoldError("invalid_argument", "Body is not valid JSON");
            }
          }
          safe = req.method === "QUERY" || req.headers["rayfold-safe"] === "true";
        } else {
          res.setHeader("Allow", "POST, QUERY");
          res.setHeader("Accept-Query", "application/rayfold+json");
          throw new RayfoldError("unimplemented", `Method ${req.method} not allowed on ${base}`);
        }
      } else if (req.method === "GET") {
        // GET /rayfold/{op}?a=<b64url json>&s=<shape id>&v=<b64url json>
        const op = sub.slice(1);
        const a = url.searchParams.get("a");
        const s = url.searchParams.get("s");
        const v = url.searchParams.get("v");
        const one: RequestEnvelope["ops"][number] = { id: 1, op };
        if (a) one.args = parseB64(a, "a") as Record<string, unknown>;
        if (s) one.shape = s;
        if (v) one.vars = parseB64(v, "v") as Record<string, never>;
        envelope = { ops: [one] };
        safe = true;
      } else {
        throw new RayfoldError("not_found", `No route for ${req.method} ${url.pathname}`);
      }

      // a body that parses but is no envelope (null, a number, ops that are not a list) is the client's error, not a 500
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new RayfoldError("invalid_argument", "Body must be { ops: [...] }");
      if (safe && Array.isArray(envelope.ops) && envelope.ops.some((o) => server.ir.ops[(o as { op?: string } | null)?.op ?? ""]?.kind !== "query")) {
        throw new RayfoldError("invalid_argument", "Safe requests (GET/QUERY) may only contain queries");
      }
      const client = req.headers["rayfold-client"];
      const deadline = req.headers["rayfold-deadline"];
      const traceparent = req.headers["traceparent"];
      const tracestate = req.headers["tracestate"];
      if (typeof client === "string" || typeof deadline === "string" || typeof traceparent === "string") {
        envelope.meta = { ...(envelope.meta ?? {}) };
        if (typeof client === "string") envelope.meta.client = client;
        if (typeof deadline === "string" && /^\d+$/.test(deadline)) envelope.meta.deadline = Number(deadline);
        if (typeof traceparent === "string") {
          envelope.meta.traceparent = traceparent;
          if (typeof tracestate === "string") envelope.meta.tracestate = tracestate;
        }
      }

      const viewer = opts.viewer ? await opts.viewer(req) : null;
      const ac = new AbortController();
      req.on("close", () => ac.abort());

      const accepted = new Set((req.headers["accept"] ?? "").split(",").map((t) => t.split(";")[0]!.trim().toLowerCase()));
      const wantsRb = accepted.has(RB_CONTENT_TYPE) && !accepted.has(FRAMES_TYPE) && !accepted.has("application/json") && !accepted.has("application/rayfold+json");
      const wantsSingle = !wantsRb && accepted.has("application/json") && Array.isArray(envelope.ops) && envelope.ops.length === 1;
      if (wantsSingle || safe) {
        // Buffer so we can set status / cache headers from the complete result.
        const frames: Frame[] = [];
        for await (const f of server.execute(envelope, { viewer, signal: ac.signal })) frames.push(f);
        if (safe) applyCacheHeaders(server, envelope, frames, viewer, res);
        if (wantsSingle && frames.length === 1) {
          const f = frames[0]!;
          const status = "error" in f ? HTTP_STATUS[f.error.code] : 200;
          const body = canonicalJson(f);
          if (safe && req.headers["if-none-match"] && req.headers["if-none-match"] === res.getHeader("ETag")) {
            res.removeHeader("X-Content-Type-Options"); // no body to sniff; the cached response keeps its headers
          res.writeHead(304).end();
            return;
          }
          res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(body);
          return;
        }
        if (safe && req.headers["if-none-match"] && req.headers["if-none-match"] === res.getHeader("ETag")) {
          res.removeHeader("X-Content-Type-Options"); // no body to sniff; the cached response keeps its headers
          res.writeHead(304).end();
          return;
        }
        if (wantsRb) {
          res.writeHead(200, { "Content-Type": RB_CONTENT_TYPE }).end(Buffer.from(codecFor(server).encodeFrames(frames)));
          return;
        }
        const body = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
        res.writeHead(200, { "Content-Type": FRAMES_TYPE }).end(body);
        return;
      }

      res.writeHead(200, { "Content-Type": wantsRb ? RB_CONTENT_TYPE : FRAMES_TYPE, "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      const codec = wantsRb ? codecFor(server) : null;
      let quiet = true;
      const keepAlive = setInterval(() => {
        if (quiet) res.write(codec ? KEEP_ALIVE_RB : "\n");
        quiet = true;
      }, opts.keepAliveMs ?? 15_000);
      try {
        for await (const f of server.execute(envelope, { viewer, signal: ac.signal })) {
          res.write(codec ? Buffer.from(codec.encodeFrames([f])) : JSON.stringify(f) + "\n");
          quiet = false;
        }
      } finally {
        clearInterval(keepAlive);
      }
      res.end();
    } catch (e) {
      if (e instanceof BodyTooLarge && !res.headersSent) return refuseBody(res, e);
      if (res.headersSent) {
        res.end();
        return;
      }
      const code: ErrorCode = e instanceof RayfoldError ? e.code : "internal";
      problem(res, code, e instanceof RayfoldError ? e.message : "Internal error", e instanceof RayfoldError ? e.toWire() : undefined);
    }
  };
}

/** Cache-Control/ETag for safe requests (spec 07 §2): min over @cache of ops and entity types touched. */
export function applyCacheHeaders(server: RayfoldServer, envelope: RequestEnvelope, frames: Frame[], viewer: unknown, res: ServerResponse): void {
  let maxAge = Number.POSITIVE_INFINITY;
  let swr = 0;
  let scope: "public" | "private" = "public";
  const consider = (annotations: { name: string; args: Record<string, unknown> }[]) => {
    const c = annotations.find((a) => a.name === "cache");
    if (c) {
      const ma = c.args["maxAge"];
      if (ma && typeof ma === "object" && "$duration" in ma) maxAge = Math.min(maxAge, (ma as { $duration: number }).$duration / 1000);
      const sw = c.args["swr"];
      if (sw && typeof sw === "object" && "$duration" in sw) swr = Math.max(swr, (sw as { $duration: number }).$duration / 1000);
      const sc = c.args["scope"];
      if (sc && typeof sc === "object" && "$ident" in sc && (sc as { $ident: string }).$ident === "private") scope = "private";
    }
    for (const a of annotations) {
      if ((a.name === "allow" || a.name === "deny") && Object.values(a.args).some((v) => v && typeof v === "object" && "$expr" in v && referencesViewer((v as { $expr: Expr }).$expr))) scope = "private";
    }
  };
  for (const o of Array.isArray(envelope.ops) ? envelope.ops : []) {
    const op = o && typeof o === "object" ? server.ir.ops[o.op] : undefined;
    if (op) consider(op.annotations);
  }
  // Only types and fields actually present in the response count (spec 07 s1: "touches such a field").
  const seen = new Set<string>();
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    const tn = o["$type"];
    if (typeof tn === "string") {
      const def = server.ir.types[tn];
      if (def && !seen.has(tn)) {
        seen.add(tn);
        consider(def.annotations);
      }
      if (def && "fields" in def) {
        for (const fd of def.fields) {
          if (fd.name in o && (annotation(fd, "allow") || annotation(fd, "deny"))) consider(fd.annotations);
        }
      }
    }
    Object.values(o).forEach(walk);
  };
  for (const f of frames) walk("data" in f ? f.data : undefined);
  if (viewer !== null && viewer !== undefined) scope = "private";
  if (!Number.isFinite(maxAge)) maxAge = 0;
  const directives = [scope, `max-age=${Math.floor(maxAge)}`];
  if (swr > 0) directives.push(`stale-while-revalidate=${Math.floor(swr)}`);
  if (maxAge === 0 && swr === 0) directives.push("no-cache");
  res.setHeader("Cache-Control", directives.join(", "));
  res.setHeader("Vary", "Rayfold-Client, Accept, Authorization");
  const payload = frames.map((f) => {
    if ("meta" in f && f.meta) {
      const { ms: _ms, ...rest } = f.meta;
      return { ...f, meta: rest };
    }
    return f;
  });
  res.setHeader("ETag", `"sha256-${sha256Hex(canonicalJson(payload))}"`);
}

function parseB64(v: string, name: string): unknown {
  try {
    return JSON.parse(fromBase64url(v));
  } catch {
    throw new RayfoldError("invalid_argument", `Query parameter ${name} is not base64url JSON`);
  }
}

/** How much of an over-limit body is drained (so the refusal can be read) before the socket is dropped. */
const DRAIN_LIMIT = 1_048_576;

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (over) {
        // A client that keeps streaming long after the refusal is cut off rather than read forever.
        if (size > max + DRAIN_LIMIT) req.destroy();
        return;
      }
      if (size > max) {
        // Stop buffering but keep draining: destroying the socket here would lose the refusal on its way out.
        over = true;
        chunks.length = 0;
        reject(new BodyTooLarge(max));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

function problem(res: ServerResponse, code: ErrorCode, detail: string, wire?: WireError): void {
  const status = HTTP_STATUS[code];
  const body = {
    type: `https://rayfold.dev/errors/${code}`,
    title: code.replace(/_/g, " "),
    status,
    detail,
    code,
    ...(wire?.data !== undefined ? { data: wire.data } : {}),
  };
  res.writeHead(status, { "Content-Type": PROBLEM_TYPE, "Cache-Control": "no-store" }).end(JSON.stringify(body));
}

/** Start a Node HTTP server hosting the Rayfold endpoint. */
export function listen(server: RayfoldServer, port: number, opts: HttpOptions = {}): Promise<Server> {
  const handler = createHttpHandler(server, opts);
  const http = createServer((req, res) => void handler(req, res));
  return new Promise((resolve) => http.listen(port, () => resolve(http)));
}
