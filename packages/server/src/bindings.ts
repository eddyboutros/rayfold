/**
 * HTTP bindings (extension `http`, spec 04 section 8): expose queries and commands on REST-shaped routes with
 * their natural methods, backed by the same contract (validation, policies, typed errors, idempotency, patches).
 *
 *   query   book(id: ID): Book?            @http(method: GET,    path: "/books/{id}")
 *   command editReview(id: ID, input: ...) @http(method: PUT,    path: "/reviews/{id}", body: input)
 *   command updateBook(id: ID, patch: ...) @http(method: PATCH,  path: "/books/{id}",   body: patch)
 *   command deleteReview(id: ID)           @http(method: DELETE, path: "/reviews/{id}")
 *   command placeOrder(input: ...)         @http(method: POST,   path: "/orders", body: input, location: "/orders/{id}")
 *   query   books(filter: ..., page: ...)  @http(method: QUERY,  path: "/books", body: "*")
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { annotation, type OpDef, type RayfoldSchemaIR } from "@rayfold/schema";
import { COMMAND_METHODS, IDEMPOTENT_METHODS, QUERY_METHODS, bindingsOf, type Binding } from "./routes.ts";
import type { RayfoldServer } from "./server.ts";
import { HTTP_STATUS, RayfoldError, type Frame, type RequestEnvelope, type RequestOp, type WireError } from "./protocol.ts";
// from fetch.ts, not http.ts: openapi.ts reads `bindingsOf` from here, and going through the Node transport for it
// would pull node:http into every runtime that imports the endpoint
import { cacheHeadersFor } from "./fetch.ts";
import { BodyTooLarge, PROBLEM_TYPE_BASE, hostProblem, mediaType, originProblem, refuse, refuseBody, type OriginOptions } from "./guard.ts";

// where the route model lived before the OpenAPI document needed it without a transport
export { COMMAND_METHODS, QUERY_METHODS, bindingsOf, type Binding };

export interface BindingOptions extends OriginOptions {
  /** Mount prefix, default "" (routes are served exactly as declared). */
  prefix?: string;
  viewer?: (req: IncomingMessage) => unknown | Promise<unknown>;
  maxBody?: number;
}

/** Returns a handler that answers bound routes and returns false for anything else. */
export function createBindingHandler(server: RayfoldServer, opts: BindingOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const bindings = bindingsOf(server.ir);
  const prefix = opts.prefix ?? "";
  const maxBody = opts.maxBody ?? 1_048_576;

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(prefix)) return false;
    const path = url.pathname.slice(prefix.length) || "/";
    const matches = bindings.map((b) => ({ b, m: b.regex.exec(path) })).filter((x) => x.m);
    if (!matches.length) return false;
    res.setHeader("X-Content-Type-Options", "nosniff");
    const safeMethod = req.method === "GET" || req.method === "HEAD" || req.method === "QUERY"; // queries only: they cannot change data
    const refused = hostProblem(req, opts) ?? (safeMethod ? null : originProblem(req, opts));
    if (refused) {
      refuse(res, 403, "permission_denied", refused);
      return true;
    }
    const hit = matches.find((x) => x.b.method === req.method);
    if (!hit) {
      res.setHeader("Allow", matches.map((x) => x.b.method).join(", "));
      problem(res, 405, { code: "unimplemented", message: `${req.method} is not bound on ${path}` });
      return true;
    }
    const { b, m } = hit as { b: Binding; m: RegExpExecArray };
    try {
      const args: Record<string, unknown> = {};
      b.params.forEach((name, i) => (args[name] = fromText(b.op, name, decodePathSegment(m[i + 1]!, name))));
      const shapeParam = url.searchParams.get("shape");
      if (b.method === "GET") {
        for (const [k, v] of url.searchParams) if (k !== "shape" && !(k in args)) args[k] = fromText(b.op, k, v);
      }
      if (b.body) {
        const raw = await readBody(req, maxBody);
        if (raw.length) {
          const ct = mediaType(req);
          const accepted = b.method === "PATCH" ? ["application/merge-patch+json", "application/json"] : ["application/json"];
          if (!accepted.includes(ct)) {
            refuse(res, 415, "invalid_argument", `Content-Type ${ct || "(none)"} is not accepted; send ${accepted[0]}`, "unsupported_media_type");
            return true;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new RayfoldError("invalid_argument", "Body is not valid JSON");
          }
          if (b.body === "*") {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RayfoldError("invalid_argument", "Body must be a JSON object");
            // own properties, as JSON.parse made them: Object.assign would turn a "__proto__" key into the prototype of args
            for (const [k, v] of Object.entries(parsed)) Object.defineProperty(args, k, { value: v, enumerable: true, writable: true, configurable: true });
          } else args[b.body] = parsed;
        }
      }
      const op: RequestOp = { id: 1, op: b.op.name, args };
      if (shapeParam) op.shape = shapeParam;
      const key = header(req, "idempotency-key");
      if (key) op.key = key;
      const ifMatch = header(req, "if-match");
      if (ifMatch) {
        const v = ifMatch.replace(/^W\//, "").replace(/^"|"$/g, "");
        op.ifVersion = /^\d+$/.test(v) ? Number(v) : v;
      }
      if (b.op.kind === "command" && b.method === "POST" && !key) {
        const idem = annotation(b.op, "idempotent");
        if (!(idem && idem.args["value"] === false)) {
          throw new RayfoldError("invalid_argument", `POST ${b.path} requires an Idempotency-Key header (16-128 characters)`);
        }
      }
      const envelope: RequestEnvelope = { ops: [op] };
      const viewer = opts.viewer ? await opts.viewer(req) : null;
      const frames: Frame[] = [];
      for await (const f of server.execute(envelope, { viewer, keyOptional: IDEMPOTENT_METHODS.has(b.method) })) frames.push(f);
      const folded = fold(frames);
      if ("error" in folded) {
        const e = folded.error;
        const status = e.type === "VersionConflict" ? 412 : HTTP_STATUS[e.code];
        problem(res, status, e);
        return true;
      }
      const result = folded.result;
      if (b.op.kind === "query") {
        for (const [name, value] of Object.entries(cacheHeadersFor(server, envelope, frames, viewer))) res.setHeader(name, value);
        if (header(req, "if-none-match") && header(req, "if-none-match") === res.getHeader("ETag")) {
          res.removeHeader("X-Content-Type-Options"); // no body to sniff; the cached response keeps its headers
          res.writeHead(304).end();
          return true;
        }
        json(res, 200, result);
        return true;
      }
      res.setHeader("Cache-Control", "no-store");
      const version = versionOf(server.ir, b.op, result);
      if (version !== undefined) res.setHeader("ETag", `"${version}"`);
      if (folded.replay) res.setHeader("Idempotent-Replayed", "true");
      if (b.method === "POST" && b.location && result && typeof result === "object") {
        res.setHeader("Location", prefix + b.location.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, f: string) => encodeURIComponent(String((result as Record<string, unknown>)[f] ?? ""))));
        json(res, 201, result);
        return true;
      }
      json(res, 200, result);
      return true;
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        refuseBody(res, e);
        return true;
      }
      const w = e instanceof RayfoldError ? e.toWire() : { code: "internal" as const, message: "Internal error" };
      problem(res, HTTP_STATUS[w.code], w);
      return true;
    }
  };
}

function decodePathSegment(raw: string, name: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new RayfoldError("invalid_argument", `Path parameter ${name} is not valid percent-encoding`);
  }
}

/** Path and query-string values are text; coerce them by the argument's declared type. */
export function fromText(op: OpDef, name: string, text: string): unknown {
  const def = op.args.find((a) => a.name === name);
  if (!def || def.type.kind !== "named") return text;
  switch (def.type.name) {
    case "Int":
    case "Float":
      return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
    case "Boolean":
      return text === "true" ? true : text === "false" ? false : text;
    case "ID":
    case "String":
    case "Decimal":
    case "Date":
    case "Instant":
      return text;
    default:
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
  }
}

/** The @version field of the result entity, if the op returns one. */
function versionOf(ir: RayfoldSchemaIR, op: OpDef, result: unknown): unknown {
  if (!result || typeof result !== "object" || op.returns.kind !== "named") return undefined;
  const def = ir.types[op.returns.name];
  if (!def || def.kind !== "entity") return undefined;
  const vf = def.fields.find((f) => annotation(f, "version"));
  return vf ? (result as Record<string, unknown>)[vf.name] : undefined;
}

function fold(frames: Frame[]): { result: unknown; replay: boolean } | { error: WireError } {
  let result: unknown = null;
  let replay = false;
  for (const f of frames) {
    if ("error" in f) return { error: f.error };
    if ("ok" in f) {
      result = f.ok;
      replay = !!(f.meta as { replay?: boolean } | undefined)?.replay;
    } else if ("data" in f && !("at" in f)) result = f.data;
    else if ("at" in f && result && typeof result === "object") {
      let target: unknown = result;
      if (f.at !== "") for (const p of f.at.split(".")) target = target && typeof target === "object" ? (target as Record<string, unknown>)[p] : undefined;
      if (target && typeof target === "object") Object.assign(target as object, f.data as object);
    }
  }
  return { result, replay };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
}

/** How much of an over-limit body is drained (so the refusal can be read) before the socket is dropped. */
const DRAIN_LIMIT = 1_048_576;

function readBody(req: IncomingMessage, max: number): Promise<string> {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

/** RFC 9457 problem; typed Rayfold errors keep their `type` and `data` so REST clients can branch on them. */
function problem(res: ServerResponse, status: number, e: WireError): void {
  const body: Record<string, unknown> = {
    type: PROBLEM_TYPE_BASE + (e.type ?? e.code),
    title: e.type ?? e.code.replace(/_/g, " "),
    status,
    detail: e.message,
    code: e.code,
  };
  if (e.path !== undefined) body["path"] = e.path;
  if (e.data !== undefined) body["data"] = e.data;
  res.writeHead(status, { "Content-Type": "application/problem+json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}
