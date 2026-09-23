/**
 * The Rayfold endpoint as a `Request` -> `Response` handler (spec 04 §4). Nothing here touches Node, so it runs on
 * Cloudflare Workers, Deno, Bun, Hono, Next.js route handlers, and anywhere else that speaks the web standard; the
 * Node transport in `http.ts` is this handler with an adapter in front, so there is one implementation of the rules
 * rather than two that drift.
 *
 * Live queries and streams work wherever the platform lets a response stay open, which the streaming runtimes do.
 * What serverless takes away is not streaming but duration: when a platform cuts a response at its time limit the op
 * ends there, and the client opens it again (`client.live()` reconnects on a retryable end).
 */
import { annotation, canonicalJson, fieldsOf, fromBase64url, referencesViewer, sha256Hex, type Expr, type RayfoldSchemaIR, type TypeRef } from "@rayfold/schema";
import { RbCodec, RB_CONTENT_TYPE } from "@rayfold/rb";
import { hostProblemOf, mediaTypeOf, originProblemOf, PROBLEM_TYPE_BASE, type OriginOptions } from "./guard.ts";
import { openApiFor } from "./openapi.ts";
import { HTTP_STATUS, RayfoldError, type ErrorCode, type Frame, type RequestEnvelope, type WireError } from "./protocol.ts";
import type { RayfoldServer } from "./server.ts";
import type { UploadOptions } from "./uploads.ts";

export interface FetchOptions extends OriginOptions {
  /** What GET {path}/manifest serves: the schema without policy expressions (default), the full IR, or nothing. */
  manifest?: "redacted" | "full" | "off";
  /** Path prefix, default "/rayfold". */
  path?: string;
  /** Turn the incoming request into a viewer (e.g. parse a Bearer token). */
  viewer?: (request: Request) => unknown | Promise<unknown>;
  /** Max request body in bytes, default 1 MiB. */
  maxBody?: number;
  /** Extra CORS origin to allow (development). */
  cors?: string;
  /**
   * When a whole interval of this many milliseconds passes without a frame, a streaming response gets a keep-alive: an
   * empty line, or a zero-length RB frame (spec 04 section 4), so proxies do not close an idle live query. Default 15 000.
   */
  keepAliveMs?: number;
  /**
   * What `GET {path}/ready` checks besides the server itself, by name: each resolves when its dependency answers and
   * rejects when it does not. A rejection, or no answer within `readinessTimeoutMs`, makes the server not ready.
   */
  readiness?: Record<string, () => Promise<unknown>>;
  /** How long a readiness check may take before it counts as failed. Default 2000. */
  readinessTimeoutMs?: number;
  /**
   * Serves `GET {path}/stats`: who this server is and what it is doing right now, for an operator or a fleet console.
   *
   * Off unless given, so this adds no open surface by default. `authorize` decides who may read it, and it is asked
   * on every request - a bearer token, an allowed address, whatever you already use. Everything here is in the
   * process already ({@link RayfoldServer.inflight}, the live-query count, the usage snapshot); none of it was
   * reachable from outside, which is why an operator could not tell two servers apart or see a fleet at all.
   */
  stats?: { authorize: (request: Request) => boolean | Promise<boolean> };
  /**
   * Whether this server is reached on a loopback address, which makes it answer loopback host names only (spec 12 §2).
   * The Node transport knows from the socket; elsewhere say so yourself. Default false.
   */
  loopback?: boolean;
  /** Serves `POST {path}/uploads` (extension `upload`), where bytes arrive on their own route. Without it, that route is 404. */
  uploads?: UploadOptions;
}

const FRAMES_TYPE = "application/rayfold-frames+json";
const PROBLEM_TYPE = "application/problem+json";
const KEEP_ALIVE_RB = Uint8Array.of(0);
const BODY_TYPES = new Set(["application/rayfold+json", "application/json", RB_CONTENT_TYPE]);

const codecs = new WeakMap<RayfoldServer, RbCodec>();
/** One RB codec per server: its key dictionary comes from the schema. */
export function codecFor(server: RayfoldServer): RbCodec {
  let c = codecs.get(server);
  if (!c) codecs.set(server, (c = new RbCodec(server.ir)));
  return c;
}

/** The IR without policy expressions: clients need names and types, not how access is decided. */
export function publicIR(ir: RayfoldSchemaIR): RayfoldSchemaIR {
  return JSON.parse(JSON.stringify(ir), (_k, v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const o = v as Record<string, unknown>;
    const isPolicy = (o["name"] === "allow" || o["name"] === "deny") && !("type" in o) && !!o["args"] && typeof o["args"] === "object" && !Array.isArray(o["args"]);
    return isPolicy ? { ...o, args: {} } : v;
  }) as RayfoldSchemaIR;
}

/**
 * What one server can say about itself: who it is, and what it is doing right now.
 *
 * Every field is read straight off the server - nothing is accumulated and nothing is measured here, so asking is
 * cheap and answering changes nothing. Counts over time are a caller's job.
 */
export function statsOf(server: RayfoldServer): Record<string, unknown> {
  const readiness = server.readiness();
  return {
    identity: server.identity,
    // the clock `startedAt` was read from: a server given its own `now` would otherwise report the gap between two clocks
    uptimeMs: server.options.now() - server.identity.startedAt,
    rayfold: "0.1",
    schemaHash: server.hash,
    extensions: [...server.mounted],
    inflight: server.inflight,
    draining: server.draining.aborted,
    ready: readiness.ready,
    reasons: readiness.reasons,
    // live queries and streams subscribed to the change bus right now: what a drain is about to end
    live: server.changes.size,
    ...(server.relayFailure === undefined ? {} : { relayFailure: String(server.relayFailure) }),
    ...(server.counters && "snapshot" in server.counters
      ? {
          counters: (server.counters as { snapshot(): unknown }).snapshot(),
          // above zero means the counters above are incomplete, which a reader has to be told rather than left to assume
          countersDropped: (server.counters as { dropped?: number }).dropped ?? 0,
        }
      : {}),
    ...(server.usage && "snapshot" in server.usage ? { usage: (server.usage as { snapshot(): unknown }).snapshot() } : {}),
  };
}

/** The server's own readiness and the configured checks, each given `readinessTimeoutMs` to answer. */
export async function readinessOf(server: RayfoldServer, opts: { readiness?: Record<string, () => Promise<unknown>>; readinessTimeoutMs?: number } = {}): Promise<{ ready: boolean; reasons: string[] }> {
  const own = server.readiness().reasons;
  const limit = opts.readinessTimeoutMs ?? 2_000;
  const checks = await Promise.all(
    Object.entries(opts.readiness ?? {}).map(async ([name, check]): Promise<string | undefined> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${limit} ms`)), limit);
      });
      try {
        await Promise.race([check(), late]);
        return undefined;
      } catch (e) {
        return `${name}: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const reasons = [...own, ...checks.filter((c): c is string => c !== undefined)];
  return { ready: reasons.length === 0, reasons };
}

/** JSON with the content type this endpoint has always sent; `Response.json` leaves the charset off. */
function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
  });
}

/** An RFC 9457 refusal, as a response. */
function problemResponse(status: number, code: string, detail: string, problemType = code, headers: Record<string, string> = {}, wire?: WireError): Response {
  // spec 05 §4: a declared domain error identifies itself by its own type rather than by the protocol code, so its
  // name is the problem `type` and `title` — the same convention `problem()` in bindings.ts follows. This used to
  // put it in a member of its own called `errorType`, which was a second name for one fact.
  const body = {
    type: PROBLEM_TYPE_BASE + (wire?.type ?? problemType),
    title: wire?.type ?? problemType.replace(/_/g, " "),
    status,
    detail,
    code,
    ...(wire?.data !== undefined ? { data: wire.data } : {}),
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": PROBLEM_TYPE, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

/** Cache-Control, Vary and ETag for a safe request (spec 07 §2): min over `@cache` of the ops and types touched. */
export function cacheHeadersFor(server: RayfoldServer, envelope: RequestEnvelope, frames: Frame[], viewer: unknown): Record<string, string> {
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
  // Only types and fields actually present in the response count (spec 07 s1: "touches such a field"). A compact frame
  // leaves out `$type` wherever the schema fixes it, so the walk follows each op's return type, and reads `$type` only
  // where it is still there, as on a union member.
  const seen = new Set<string>();
  const walk = (v: unknown, t: TypeRef | undefined): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, t?.kind === "list" ? t.of : undefined);
      return;
    }
    const o = v as Record<string, unknown>;
    const tn = o["$type"];
    const ref: TypeRef | undefined = typeof tn === "string" ? { kind: "named", name: tn, nullable: false } : t?.kind === "named" ? t : undefined;
    const def = ref ? server.ir.types[ref.name] : undefined;
    if (def && !seen.has(def.name)) {
      seen.add(def.name);
      consider(def.annotations);
    }
    const fields = ref ? (fieldsOf(server.ir, ref) ?? []) : [];
    for (const [k, x] of Object.entries(o)) {
      if (k === "$type") continue;
      const fd = fields.find((field) => field.name === k);
      if (fd && (annotation(fd, "allow") || annotation(fd, "deny"))) consider(fd.annotations);
      walk(x, fd?.type);
    }
  };
  // the static type at a deferred frame's path, such as "items.0.author"
  const typeAt = (root: TypeRef | undefined, path: string): TypeRef | undefined => {
    let t = root;
    for (const seg of path === "" ? [] : path.split(".")) {
      if (!t) return undefined;
      if (/^\d+$/.test(seg)) {
        if (t.kind === "list") t = t.of;
        continue;
      }
      while (t.kind === "list") t = t.of;
      t = (fieldsOf(server.ir, t) ?? []).find((field) => field.name === seg)?.type;
    }
    return t;
  };
  const opNames = new Map<unknown, string>();
  for (const o of Array.isArray(envelope.ops) ? envelope.ops : []) if (o && typeof o === "object") opNames.set(o.id, o.op);
  for (const f of frames) {
    if (!("data" in f)) continue;
    const returns = server.ir.ops[opNames.get(f.id) ?? ""]?.returns;
    walk(f.data, "at" in f ? typeAt(returns, f.at) : returns);
  }
  if (viewer !== null && viewer !== undefined) scope = "private";
  if (!Number.isFinite(maxAge)) maxAge = 0;
  const directives = [scope, `max-age=${Math.floor(maxAge)}`];
  if (swr > 0) directives.push(`stale-while-revalidate=${Math.floor(swr)}`);
  if (maxAge === 0 && swr === 0) directives.push("no-cache");
  const payload = frames.map((f) => {
    if ("meta" in f && f.meta) {
      const { ms: _ms, ...rest } = f.meta;
      return { ...f, meta: rest };
    }
    return f;
  });
  return {
    "Cache-Control": directives.join(", "),
    Vary: "Rayfold-Client, Accept, Authorization",
    ETag: `"sha256-${sha256Hex(canonicalJson(payload))}"`,
  };
}

function parseB64(v: string, name: string): unknown {
  try {
    return JSON.parse(fromBase64url(v));
  } catch {
    throw new RayfoldError("invalid_argument", `Query parameter ${name} is not base64url JSON`);
  }
}

/** Reads the body, refusing anything over `max` before it is buffered whole. */
async function readBody(request: Request, max: number): Promise<Uint8Array> {
  const body = request.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new BodyOverLimit(max);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A request body over the limit, refused 413 before anything runs. Named apart from the Node one, which owns a socket. */
export class BodyOverLimit extends RayfoldError {
  constructor(readonly max: number) {
    super("resource_exhausted", `Body exceeds ${max} bytes`);
  }
}

/** The media type an upload arrives as: not one a browser may send cross-site without a preflight (spec 12 §2.1). */
const UPLOAD_TYPE = "application/octet-stream";

/**
 * `POST {path}/uploads`: the bytes go to the store and the client gets the handle a command will name. Every check the
 * batch endpoint applies to a write applies here too, because this is one: the Origin rule, a content type a foreign
 * page cannot send without asking, a size bound enforced while reading rather than after, and an identified sender
 * unless the server says otherwise.
 */
async function upload(request: Request, opts: FetchOptions, host: string | null): Promise<Response> {
  const { store, maxBytes = 25 * 1024 * 1024, viewerRequired = true } = opts.uploads!;
  const badOrigin = originProblemOf(request.headers.get("origin"), host, opts);
  if (badOrigin) return problemResponse(403, "permission_denied", badOrigin);
  const ct = mediaTypeOf(request.headers.get("content-type"));
  if (ct !== UPLOAD_TYPE) {
    return problemResponse(415, "invalid_argument", `Content-Type ${ct || "(none)"} is not accepted; send ${UPLOAD_TYPE}`, "unsupported_media_type", { "Accept-Post": UPLOAD_TYPE });
  }
  const viewer = opts.viewer ? await opts.viewer(request) : null;
  if (viewerRequired && (viewer === null || viewer === undefined)) {
    return problemResponse(401, "unauthenticated", "An upload needs an identified caller");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    return problemResponse(413, "resource_exhausted", `Upload exceeds ${maxBytes} bytes`, "payload_too_large");
  }
  if (!request.body) return problemResponse(400, "invalid_argument", "An upload needs a body");

  // counted as it passes, so a body that lies about its length is stopped at the bound rather than after it
  let size = 0;
  let over = false;
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.length;
        if (size > maxBytes) {
          over = true;
          controller.error(new RayfoldError("resource_exhausted", `Upload exceeds ${maxBytes} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  try {
    const name = request.headers.get("rayfold-upload-name");
    const type = request.headers.get("rayfold-upload-type");
    const kept = await store.put(counted, { ...(name ? { name } : {}), ...(type ? { type } : {}), viewer });
    return json({ id: kept.id, size: kept.size, ...(kept.name ? { name: kept.name } : {}), ...(kept.type ? { type: kept.type } : {}) }, { status: 201 });
  } catch (e) {
    if (over) return problemResponse(413, "resource_exhausted", `Upload exceeds ${maxBytes} bytes`, "payload_too_large");
    throw e;
  }
}

/**
 * The Rayfold endpoint as a fetch handler. Mount it wherever your runtime takes one:
 * `export default { fetch: createFetchHandler(server) }` on Workers, `Bun.serve({ fetch })`, `app.all("/rayfold/*", ...)`
 * under Hono, or a Next.js route handler.
 */
export function createFetchHandler(server: RayfoldServer, opts: FetchOptions = {}): (request: Request) => Promise<Response> {
  const base = opts.path ?? "/rayfold";
  const maxBody = opts.maxBody ?? 1_048_576;
  if (opts.uploads) server.mounted.add("upload"); // the manifest says which extensions are served beside the endpoint

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const common: Record<string, string> = { "Rayfold-Schema": server.hash, "X-Content-Type-Options": "nosniff" };
    const withCommon = (response: Response): Response => {
      for (const [k, v] of Object.entries(common)) if (!response.headers.has(k)) response.headers.set(k, v);
      return response;
    };

    // Counted here because nothing else can: a refusal below is answered and returned before `execute` is called,
    // so no Instrumentation hook ever sees it. Without this a server cannot say that a fifth of its traffic is
    // being turned away at the door, let alone why.
    const count = (name: string, labels?: Record<string, string>) => server.counters?.add(name, 1, labels);
    count("rayfold.requests", { method: request.method });

    const host = request.headers.get("host") ?? url.host;
    const badHost = hostProblemOf(host, opts.loopback ?? false, opts);
    if (badHost) {
      count("rayfold.refused", { reason: "host" });
      return withCommon(problemResponse(403, "permission_denied", badHost));
    }
    if (opts.cors) {
      common["Access-Control-Allow-Origin"] = opts.cors;
      // the upload route's own two are here as well: a browser on another origin preflights an upload, and a
      // header the preflight does not allow makes the whole request fail before the server ever sees it
      common["Access-Control-Allow-Headers"] = "Content-Type, Authorization, Rayfold-Client, Rayfold-Deadline, Rayfold-Safe, Rayfold-Upload-Name, Rayfold-Upload-Type";
      common["Access-Control-Allow-Methods"] = "GET, POST, QUERY, OPTIONS";
      if (request.method === "OPTIONS") return withCommon(new Response(null, { status: 204 }));
    }
    if (!url.pathname.startsWith(base)) {
      count("rayfold.refused", { reason: "route" });
      return withCommon(problemResponse(404, "not_found", `No route for ${url.pathname}`));
    }

    const sub = url.pathname.slice(base.length);
    try {
      if (sub === "/manifest" && request.method === "GET") {
        if (opts.manifest === "off") throw new RayfoldError("not_found", `No route for ${url.pathname}`);
        return withCommon(json({ ...server.manifest(), schema: opts.manifest === "full" ? server.ir : publicIR(server.ir) }));
      }
      if (sub === "/openapi.json" && request.method === "GET") return withCommon(json(openApiFor(server.ir)));
      if (sub === "/health" && request.method === "GET") {
        return withCommon(json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } }));
      }
      if (sub === "/ready" && request.method === "GET") {
        const status = await readinessOf(server, opts);
        return withCommon(json(status, { status: status.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } }));
      }
      if (sub === "/stats" && request.method === "GET") {
        // A route nobody configured is a route that does not exist, rather than one that refuses: an unconfigured
        // server should look the same from outside as one that never had the feature.
        if (!opts.stats) throw new RayfoldError("not_found", `No route for ${url.pathname}`);
        if (!(await opts.stats.authorize(request))) throw new RayfoldError("permission_denied", "Not allowed to read stats");
        return withCommon(json(statsOf(server), { headers: { "Cache-Control": "no-store" } }));
      }
      if (server.draining.aborted) {
        // the balancer has been told through /ready; a request that still arrives is sent elsewhere
        throw Object.assign(new RayfoldError("unavailable", "The server is shutting down"), { retryAfter: "1" });
      }
      if (sub === "/uploads" && opts.uploads) {
        if (request.method !== "POST") {
          throw Object.assign(new RayfoldError("unimplemented", `Method ${request.method} not allowed on ${base}/uploads`), { headers: { Allow: "POST" } });
        }
        return withCommon(await upload(request, opts, host));
      }

      let envelope: RequestEnvelope;
      let safe = false;
      if (sub === "" || sub === "/") {
        if (request.method === "POST" || request.method === "QUERY") {
          // JSON-only bodies force browsers into a CORS preflight, so a cross-site form or text/plain post cannot run anything.
          const ct = mediaTypeOf(request.headers.get("content-type"));
          if (!BODY_TYPES.has(ct)) {
            count("rayfold.refused", { reason: "media" });
            return withCommon(
              problemResponse(415, "invalid_argument", `Content-Type ${ct || "(none)"} is not accepted; send application/rayfold+json`, "unsupported_media_type", {
                "Accept-Post": [...BODY_TYPES].join(", "),
              }),
            );
          }
          // Safe requests (QUERY, or POST with Rayfold-Safe, which may hold only queries) cannot change data. A foreign page
          // cannot send them without a CORS preflight and cannot read the answer, so only data-changing requests need the
          // Origin check. This keeps reads working behind proxies that rewrite Host.
          const declaredSafe = request.method === "QUERY" || request.headers.get("rayfold-safe") === "true";
          const badOrigin = declaredSafe ? null : originProblemOf(request.headers.get("origin"), host, opts);
          if (badOrigin) {
            count("rayfold.refused", { reason: "origin" });
            return withCommon(problemResponse(403, "permission_denied", badOrigin));
          }
          const body = await readBody(request, maxBody);
          if (ct === RB_CONTENT_TYPE) {
            try {
              envelope = codecFor(server).decode(body) as RequestEnvelope;
            } catch {
              throw new RayfoldError("invalid_argument", "Body is not valid RB");
            }
          } else {
            try {
              envelope = JSON.parse(new TextDecoder().decode(body)) as RequestEnvelope;
            } catch {
              throw new RayfoldError("invalid_argument", "Body is not valid JSON");
            }
          }
          safe = declaredSafe;
        } else {
          count("rayfold.refused", { reason: "method" });
          throw Object.assign(new RayfoldError("unimplemented", `Method ${request.method} not allowed on ${base}`), {
            headers: { Allow: "POST, QUERY", "Accept-Query": "application/rayfold+json" },
          });
        }
      } else if (request.method === "GET") {
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
        throw new RayfoldError("not_found", `No route for ${request.method} ${url.pathname}`);
      }

      // a body that parses but is no envelope (null, a number, ops that are not a list) is the client's error, not a 500
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new RayfoldError("invalid_argument", "Body must be { ops: [...] }");
      if (safe && Array.isArray(envelope.ops) && envelope.ops.some((o) => server.ir.ops[(o as { op?: string } | null)?.op ?? ""]?.kind !== "query")) {
        throw new RayfoldError("invalid_argument", "Safe requests (GET/QUERY) may only contain queries");
      }
      const client = request.headers.get("rayfold-client");
      const deadline = request.headers.get("rayfold-deadline");
      const traceparent = request.headers.get("traceparent");
      const tracestate = request.headers.get("tracestate");
      if (client !== null || deadline !== null || traceparent !== null) {
        envelope.meta = { ...(envelope.meta ?? {}) };
        if (client !== null) envelope.meta.client = client;
        if (deadline !== null && /^\d+$/.test(deadline)) envelope.meta.deadline = Number(deadline);
        if (traceparent !== null) {
          envelope.meta.traceparent = traceparent;
          if (tracestate !== null) envelope.meta.tracestate = tracestate;
        }
      }

      const viewer = opts.viewer ? await opts.viewer(request) : null;
      const accepted = new Set((request.headers.get("accept") ?? "").split(",").map((t) => t.split(";")[0]!.trim().toLowerCase()));
      const wantsRb = accepted.has(RB_CONTENT_TYPE) && !accepted.has(FRAMES_TYPE) && !accepted.has("application/json") && !accepted.has("application/rayfold+json");
      const wantsSingle = !wantsRb && accepted.has("application/json") && Array.isArray(envelope.ops) && envelope.ops.length === 1;

      // A live query or a stream has no complete result to buffer: it would never answer. It streams whatever asked.
      const endless = Array.isArray(envelope.ops) && envelope.ops.some((o) => (o as { live?: unknown } | null)?.live === true || server.ir.ops[(o as { op?: string } | null)?.op ?? ""]?.kind === "stream");
      if ((wantsSingle || safe) && !endless) {
        // Buffer so the status and cache headers come from the complete result.
        const frames: Frame[] = [];
        for await (const f of server.execute(envelope, { viewer, signal: request.signal })) frames.push(f);
        const headers: Record<string, string> = { ...common };
        // spec 07 §3: a batch that is not marked safe is never stored. The streaming branch below says so too, and
        // this one used to return before saying anything at all.
        if (safe) Object.assign(headers, cacheHeadersFor(server, envelope, frames, viewer));
        else headers["Cache-Control"] = "no-store";
        const noneMatch = request.headers.get("if-none-match");
        if (safe && noneMatch && noneMatch === headers["ETag"]) {
          // no body to sniff; the cached response keeps its own headers
          const { "X-Content-Type-Options": _sniff, ...rest } = headers;
          return new Response(null, { status: 304, headers: rest });
        }
        if (wantsSingle && frames.length === 1) {
          const f = frames[0]!;
          const status = "error" in f ? HTTP_STATUS[f.error.code] : 200;
          return new Response(canonicalJson(f), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
        }
        if (wantsRb) return new Response(codecFor(server).encodeFrames(frames) as BodyInit, { headers: { ...headers, "Content-Type": RB_CONTENT_TYPE } });
        return new Response(frames.map((f) => JSON.stringify(f)).join("\n") + "\n", { headers: { ...headers, "Content-Type": FRAMES_TYPE } });
      }

      const codec = wantsRb ? codecFor(server) : null;
      const encoder = new TextEncoder();
      let quiet = true;
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          keepAlive = setInterval(() => {
            if (quiet) {
              try {
                controller.enqueue(codec ? KEEP_ALIVE_RB : encoder.encode("\n"));
              } catch {
                /* the consumer went away; the loop below ends on the same signal */
              }
            }
            quiet = true;
          }, opts.keepAliveMs ?? 15_000);
          void (async () => {
            try {
              for await (const f of server.execute(envelope, { viewer, signal: request.signal })) {
                controller.enqueue(codec ? codec.encodeFrames([f]) : encoder.encode(JSON.stringify(f) + "\n"));
                quiet = false;
              }
              controller.close();
            } catch (e) {
              // the frames are already on their way, so the failure ends the body rather than becoming a status
              controller.error(e);
            } finally {
              clearInterval(keepAlive);
            }
          })();
        },
        cancel() {
          clearInterval(keepAlive);
        },
      });
      return new Response(body, { headers: { ...common, "Content-Type": wantsRb ? RB_CONTENT_TYPE : FRAMES_TYPE, "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
    } catch (e) {
      if (e instanceof BodyOverLimit) return withCommon(problemResponse(413, "resource_exhausted", e.message, "payload_too_large"));
      const code: ErrorCode = e instanceof RayfoldError ? e.code : "internal";
      const detail = e instanceof RayfoldError ? e.message : "Internal error";
      const extra = (e as { headers?: Record<string, string>; retryAfter?: string }) ?? {};
      const headers = { ...(extra.headers ?? {}), ...(extra.retryAfter ? { "Retry-After": extra.retryAfter } : {}) };
      return withCommon(problemResponse(HTTP_STATUS[code], code, detail, code, headers, e instanceof RayfoldError ? e.toWire() : undefined));
    }
  };
}
