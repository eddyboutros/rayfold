/**
 * Checks every HTTP entry point applies before doing any work (spec 12).
 * - Host: a server reached on a loopback address answers only loopback host names. This defeats DNS rebinding,
 *   where a web page renames its own domain to 127.0.0.1 and reads or drives a local server as if same-origin.
 * - Origin: a state-changing request sent by a browser from another origin is refused unless that origin is allowed.
 *   Together with JSON-only content types this stops cross-site request forgery.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { RayfoldError } from "./protocol.ts";

export interface OriginOptions {
  /** Browser origins allowed besides the server's own, such as "https://app.example.com". "*" allows any. */
  allowedOrigins?: readonly string[];
  /** Host names this server answers to. Default: any, but a loopback-bound server answers loopback names only. */
  allowedHosts?: readonly string[];
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackAddress(a: string | undefined): boolean {
  return !!a && (a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127."));
}

function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  const i = h.lastIndexOf(":");
  return i >= 0 ? h.slice(0, i) : h;
}

/** null when the Host header is acceptable, otherwise the reason. */
export function hostProblem(req: IncomingMessage, o: OriginOptions = {}): string | null {
  const host = req.headers.host;
  if (!host) return "Missing Host header";
  const name = hostName(host);
  if (o.allowedHosts) return o.allowedHosts.includes(name) || o.allowedHosts.includes(host.toLowerCase()) ? null : `Host ${host} is not allowed`;
  if (isLoopbackAddress(req.socket.localAddress) && !LOOPBACK_NAMES.has(name)) return `Host ${host} is not allowed on a loopback server`;
  return null;
}

/** null when the request is not a cross-origin browser request, or its origin is allowed; otherwise the reason. */
export function originProblem(req: IncomingMessage, o: OriginOptions = {}): string | null {
  const origin = req.headers.origin;
  if (origin === undefined) return null; // browsers send Origin on every state-changing request; other clients need not
  if (o.allowedOrigins?.includes("*") || o.allowedOrigins?.includes(origin)) return null;
  try {
    if (new URL(origin).host === (req.headers.host ?? "").toLowerCase()) return null; // same origin (Host is checked on its own)
  } catch {
    /* "null" and malformed origins are never allowed */
  }
  return `Origin ${origin} is not allowed`;
}

/** The media type of the request body, lower-cased, without parameters. */
export function mediaType(req: IncomingMessage): string {
  return (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
}

/** A request body over the transport's limit. Answered 413 Content Too Large, never 429: retrying cannot help. */
export class BodyTooLarge extends RayfoldError {
  constructor(readonly max: number) {
    super("resource_exhausted", `Body exceeds ${max} bytes`);
  }
}

/** The 413 refusal for a body over the limit. */
export function refuseBody(res: ServerResponse, e: BodyTooLarge): void {
  refuse(res, 413, "resource_exhausted", e.message, "payload_too_large");
}

/** Where an RFC 9457 `type` points: the documentation site has a page for each problem type. */
export const PROBLEM_TYPE_BASE = "https://eddyboutros.github.io/rayfold/errors/";

/** An RFC 9457 refusal written before any operation ran. */
export function refuse(res: ServerResponse, status: number, code: string, detail: string, problemType = code, headers: Record<string, string> = {}): void {
  res
    .writeHead(status, { "Content-Type": "application/problem+json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers })
    .end(JSON.stringify({ type: PROBLEM_TYPE_BASE + problemType, title: problemType.replace(/_/g, " "), status, detail, code }));
}
