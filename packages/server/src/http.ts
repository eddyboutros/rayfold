/**
 * HTTP transport for Node. The rules live in `fetch.ts`, which speaks the web standard and needs no Node; this turns a
 * Node request into a `Request`, hands it there, and writes the `Response` back. One implementation serves both, so a
 * fix to caching, guards or framing reaches every runtime at once.
 *
 * What stays here is what owns a socket: reading a body with the drain-then-drop behaviour a stream gives us, deciding
 * from the socket whether the server is loopback-bound, and the listener itself. Spec: spec/04-frames-and-transport.md §4.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RayfoldServer } from "./server.ts";
import { RayfoldError, type Frame, type RequestEnvelope } from "./protocol.ts";
import { cacheHeadersFor, codecFor, createFetchHandler, publicIR, readinessOf, type FetchOptions } from "./fetch.ts";
import { BodyTooLarge, hostProblem, isLoopbackAddress, refuse, refuseBody, type OriginOptions } from "./guard.ts";

export { codecFor, publicIR };

export interface HttpOptions extends Omit<FetchOptions, "viewer" | "loopback">, OriginOptions {
  /** Turn the incoming request into a viewer (e.g. parse a Bearer token). */
  viewer?: (req: IncomingMessage) => unknown | Promise<unknown>;
}

/** The Node request each `Request` was built from, so a viewer written against Node still gets one. */
const sources = new WeakMap<Request, IncomingMessage>();

export function createHttpHandler(server: RayfoldServer, opts: HttpOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const maxBody = opts.maxBody ?? 1_048_576;
  const { viewer, ...rest } = opts;
  const handle = createFetchHandler(server, {
    ...rest,
    ...(viewer ? { viewer: (request: Request) => viewer(sources.get(request)!) } : {}),
  });

  return async (req, res) => {
    // The socket is the only place that says whether this server is loopback-bound, so the host rule is applied here;
    // the handler applies `allowedHosts` again, which agrees with this one.
    const badHost = hostProblem(req, opts);
    if (badHost) return refuse(res, 403, "permission_denied", badHost);
    // a Host that is no valid authority (a space, a port past 65535) used to reach the URL built from it, which threw
    if (!validAuthority(req.headers.host)) return refuse(res, 400, "invalid_argument", "Host header is not a valid host");

    // An upload is bounded by its own limit, not the envelope's, so its body travels as a stream rather than being
    // read whole here; everything else is read with the drain-then-drop behaviour only a socket can give.
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const uploading = !!opts.uploads && path === `${opts.path ?? "/rayfold"}/uploads`;
    let body: Buffer | undefined;
    if (!uploading && (req.method === "POST" || req.method === "QUERY")) {
      try {
        body = await readBody(req, maxBody);
      } catch (e) {
        if (e instanceof BodyTooLarge) return refuseBody(res, e);
        throw e;
      }
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    }
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const init: RequestInit & { duplex?: "half" } = { method: req.method ?? "GET", headers, signal: ac.signal };
    if (uploading && req.method === "POST") {
      init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
      init.duplex = "half"; // the body is still arriving when the request is made
    } else if (body && body.length) init.body = new Uint8Array(body);
    // A fixed origin: the Host header travels as a header, which is what the handler reads the host from.
    let request: Request;
    try {
      const target = req.url ?? "/";
      request = new Request(target.startsWith("/") ? `http://localhost${target}` : new URL(target, "http://localhost").href, init as RequestInit);
    } catch {
      return refuse(res, 400, "invalid_argument", "Request target is not a valid path");
    }
    sources.set(request, req);

    const response = await handle(request);
    if (res.headersSent) return;
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) {
      res.end();
      return;
    }
    res.flushHeaders(); // a live query may say nothing for a while; its headers should not wait with it
    // piped, so a client that stops reading stops the reads from the body as well; the handler bounds what then waits
    // there. A body that fails (the client stopped reading, the batch threw) ends the socket rather than the response,
    // so the client sees it cut short instead of complete.
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res).catch(() => undefined);
  };
}

/** Whether a Host header is an authority a URL can be built on: a name or address, and a port within range. */
function validAuthority(host: string | undefined): boolean {
  if (host === undefined || /[\s/?#@\\]/.test(host)) return false;
  try {
    new URL(`http://${host}`);
    return true;
  } catch {
    return false;
  }
}

/** Cache-Control/ETag for safe requests (spec 07 §2), applied to a Node response. */
export function applyCacheHeaders(server: RayfoldServer, envelope: RequestEnvelope, frames: Frame[], viewer: unknown, res: ServerResponse): void {
  for (const [name, value] of Object.entries(cacheHeadersFor(server, envelope, frames, viewer))) res.setHeader(name, value);
}

/** The server's own readiness and the configured checks, each given `readinessTimeoutMs` to answer. */
export async function readiness(server: RayfoldServer, opts: HttpOptions = {}): Promise<{ ready: boolean; reasons: string[] }> {
  return readinessOf(server, opts);
}

/** How much of an over-limit body is drained (so the refusal can be read) before the socket is dropped. */
const DRAIN_LIMIT = 1_048_576;

export function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
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
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/** Start a Node HTTP server hosting the Rayfold endpoint. */
export function listen(server: RayfoldServer, port: number, opts: HttpOptions = {}): Promise<Server> {
  const handler = createHttpHandler(server, opts);
  const http = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) refuse(res, 500, "internal", "Internal error");
      else res.end();
    });
  });
  return new Promise((resolve) => http.listen(port, () => resolve(http)));
}

/**
 * Stops a server the way a rolling deploy needs: `drain()` turns readiness off and ends live queries and streams with a
 * retryable error, batches still running get `timeoutMs` to finish, then the connections close and the server stops
 * hearing the relay. Wire it to the signal your platform sends:
 * `process.on("SIGTERM", () => shutdown(server, http).then(() => process.exit(0)))`.
 */
export async function shutdown(server: RayfoldServer, http: Server, opts: { timeoutMs?: number; flushMs?: number } = {}): Promise<void> {
  await server.drain(opts);
  await new Promise<void>((resolve) => {
    let force: ReturnType<typeof setTimeout> | undefined;
    http.close(() => {
      if (force) clearTimeout(force);
      resolve();
    });
    // `drain()` resolves when the operations end, which is not when their last frames have reached the socket: the
    // handler hands frames to a stream and a separate loop writes them. So idle connections go now, the ones still
    // writing are left to finish and close themselves, and only a client that never reads is cut off, after `flushMs`.
    http.closeIdleConnections();
    force = setTimeout(() => http.closeAllConnections(), opts.flushMs ?? 1_000);
    force.unref?.();
  });
  await server.close();
}

export { isLoopbackAddress };
export type { RayfoldError };
