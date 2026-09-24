/**
 * Checks every HTTP entry point applies before doing any work (spec 12).
 * - Host: a server reached on a loopback address answers only loopback host names. This defeats DNS rebinding,
 *   where a web page renames its own domain to 127.0.0.1 and reads or drives a local server as if same-origin.
 * - Origin: a state-changing request sent by a browser from another origin is refused unless that origin is allowed.
 *   Together with JSON-only content types this stops cross-site request forgery.
 */
import { RayfoldError } from "./protocol.ts";

/**
 * What these checks read from a Node request and write to a Node response, described here rather than imported, so the
 * file carries no Node types and can be bundled for a runtime that has none.
 */
interface NodeRequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket: { localAddress?: string | undefined; encrypted?: boolean | undefined };
}

/** A header as these checks read it: Node gives a list for a few headers, none of which is read here. */
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
interface NodeResponseLike {
  writeHead(status: number, headers: Record<string, string>): { end(body?: string): void };
}

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

/**
 * The checks themselves, on header values alone, so every transport applies the same ones: the Node server below and
 * the fetch handler both call these. `loopback` says whether the server is reached on a loopback address, which only
 * the transport can know.
 */
export function hostProblemOf(host: string | null | undefined, loopback: boolean, o: OriginOptions = {}): string | null {
  if (!host) return "Missing Host header";
  const name = hostName(host);
  if (o.allowedHosts) return o.allowedHosts.includes(name) || o.allowedHosts.includes(host.toLowerCase()) ? null : `Host ${host} is not allowed`;
  if (loopback && !LOOPBACK_NAMES.has(name)) return `Host ${host} is not allowed on a loopback server`;
  return null;
}

/**
 * Whether the request reached this server over TLS: the transport's own word, or a proxy's `X-Forwarded-Proto` saying
 * `https`. The header is only ever believed in that direction, so a client that forges it can make the Origin rule
 * stricter for itself and never looser.
 */
export function reachedOverTls(transportSecure: boolean, forwardedProto: string | null | undefined): boolean {
  return transportSecure || forwardedProto?.split(",")[0]?.trim().toLowerCase() === "https";
}

/**
 * Same origin means the Origin's host[:port] equals the Host header, and a page served over plain http is never the
 * origin of a server reached over https: a network attacker can write that page. The other direction is let through,
 * because a server behind a TLS-terminating proxy that sends no `X-Forwarded-Proto` sees plain http for its own https
 * pages. `secure` comes from {@link reachedOverTls}.
 */
export function originProblemOf(origin: string | null | undefined, host: string | null | undefined, o: OriginOptions = {}, secure = false): string | null {
  if (origin === undefined || origin === null) return null; // browsers send Origin on every state-changing request; other clients need not
  if (o.allowedOrigins?.includes("*") || o.allowedOrigins?.includes(origin)) return null;
  try {
    const u = new URL(origin);
    if (u.host === (host ?? "").toLowerCase() && !(secure && u.protocol === "http:")) return null; // same origin (Host is checked on its own)
  } catch {
    /* "null" and malformed origins are never allowed */
  }
  return `Origin ${origin} is not allowed`;
}

/** The media type of a `Content-Type` header, lower-cased, without parameters. */
export function mediaTypeOf(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/** null when the Host header is acceptable, otherwise the reason. */
export function hostProblem(req: NodeRequestLike, o: OriginOptions = {}): string | null {
  return hostProblemOf(one(req.headers.host), isLoopbackAddress(req.socket.localAddress), o);
}

/** null when the request is not a cross-origin browser request, or its origin is allowed; otherwise the reason. */
export function originProblem(req: NodeRequestLike, o: OriginOptions = {}): string | null {
  return originProblemOf(one(req.headers.origin), one(req.headers.host), o, reachedOverTls(req.socket.encrypted === true, one(req.headers["x-forwarded-proto"])));
}

/** The media type of the request body, lower-cased, without parameters. */
export function mediaType(req: NodeRequestLike): string {
  return mediaTypeOf(one(req.headers["content-type"]));
}

/** A request body over the transport's limit. Answered 413 Content Too Large, never 429: retrying cannot help. */
export class BodyTooLarge extends RayfoldError {
  constructor(readonly max: number) {
    super("resource_exhausted", `Body exceeds ${max} bytes`);
  }
}

/** The 413 refusal for a body over the limit. */
export function refuseBody(res: NodeResponseLike, e: BodyTooLarge): void {
  refuse(res, 413, "resource_exhausted", e.message, "payload_too_large");
}

/** Where an RFC 9457 `type` points: the documentation site has a page for each problem type. */
export const PROBLEM_TYPE_BASE = "https://eddyboutros.github.io/rayfold/errors/";

/** An RFC 9457 refusal written before any operation ran. */
export function refuse(res: NodeResponseLike, status: number, code: string, detail: string, problemType = code, headers: Record<string, string> = {}): void {
  res
    .writeHead(status, { "Content-Type": "application/problem+json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers })
    .end(JSON.stringify({ type: PROBLEM_TYPE_BASE + problemType, title: problemType.replace(/_/g, " "), status, detail, code }));
}
