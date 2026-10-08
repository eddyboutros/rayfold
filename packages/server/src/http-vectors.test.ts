import { readFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createBindingHandler } from "./bindings.ts";
import { createFetchHandler } from "./fetch.ts";
import { createHttpHandler } from "./http.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";

/**
 * The published `http/` vectors, run against this runtime's HTTP entry points: the Node handler on a real socket, with
 * the bindings mounted in front of it as an application mounts them, and the fetch handler for every endpoint case it
 * can receive. `HttpVectorsTest.kt` runs the JVM's `RayfoldHttp` and `RayfoldBindings` against the same file.
 */
const PATH = new URL("../../../conformance/vectors/http/exchanges.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

type Matcher = Record<string, unknown>;
interface Case {
  name: string;
  why?: string;
  route: "endpoint" | "binding";
  badRequestTarget?: boolean;
  server?: { allowedOrigins?: string[]; bindings?: boolean };
  request: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  expect: {
    status: number;
    headers?: Record<string, string | null | Matcher>;
    problem?: string;
    json?: Record<string, Matcher>;
    frame?: Record<string, Matcher>;
    emptyBody?: boolean;
    streams?: boolean;
  };
}
const doc = JSON.parse(readFileSync(PATH, "utf8")) as { schema: string; cases: Case[] };

// a member this runner has no assertion for fails the case rather than passing it unchecked
const KNOWN = {
  case: ["name", "why", "route", "badRequestTarget", "server", "request", "expect"],
  server: ["allowedOrigins", "bindings"],
  request: ["method", "path", "headers", "body"],
  expect: ["status", "headers", "problem", "json", "frame", "emptyBody", "streams"],
  matcher: ["equals", "contains", "includes", "excludes", "includesMatch", "hasKey", "lacksKey", "hasKeyDeep"],
  header: ["contains", "listIncludes"],
};
function onlyKnown(what: string, o: object | undefined, known: string[]): void {
  for (const k of Object.keys(o ?? {})) expect(known, `${what}: no runner for "${k}"`).toContain(k);
}

/** The fixed resolvers the file's `about` describes. */
function rayfold(): RayfoldServer {
  const echo = (args: Record<string, unknown>) => ({ id: "h1", got: args });
  return createRayfoldServer({
    schema: doc.schema,
    resolvers: {
      Query: {
        book: (args: { id: string }) => ({ id: args.id, title: "T" }),
        find: (args: Record<string, unknown>) => ({ ...echo(args), n: args["n"] ?? null }),
        hit: (args: Record<string, unknown>) => ({ ...echo(args), n: args["hitId"] }),
        search: echo,
      },
      Command: { tag: echo },
    },
  });
}

interface Answer {
  status: number;
  headers: Headers;
  body: string;
  /** Set when the case asked for the first frame only: the response was still open when it was read. */
  firstLine?: string;
}

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => (s.close(() => r()), s.closeAllConnections()))));
});

/** The Node handler on a real socket, with the bindings in front of it when the case mounts them. */
async function nodeServer(c: Case): Promise<number> {
  const server = rayfold();
  const origins = c.server?.allowedOrigins ? { allowedOrigins: c.server.allowedOrigins } : {};
  const endpoint = createHttpHandler(server, { ...origins, viewer: () => null });
  const bindings = c.server?.bindings ? createBindingHandler(server, { ...origins, viewer: () => null }) : null;
  const http = createServer((req, res) => {
    void (async () => {
      if (bindings && (await bindings(req, res))) return;
      await endpoint(req, res);
    })();
  });
  open.push(http);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return (http.address() as AddressInfo).port;
}

function toHeaders(h: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === "string") out.set(k, v);
    else if (Array.isArray(v)) for (const x of v) out.append(k, x);
  }
  return out;
}

/** node:http rather than fetch, which will not send a Host of the caller's choosing. */
function overSocket(port: number, method: string, path: string, headers: Record<string, string>, body: string | undefined, firstLineOnly: boolean): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (req.destroy(), reject(new Error(`no answer within 5 s to ${method} ${path}`))), 5_000);
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { ...headers, ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
        if (firstLineOnly && text.includes("\n")) {
          clearTimeout(timer);
          const firstLine = text.slice(0, text.indexOf("\n"));
          req.destroy();
          resolve({ status: res.statusCode ?? 0, headers: toHeaders(res.headers), body: text, firstLine });
        }
      });
      res.on("end", () => {
        clearTimeout(timer);
        if (firstLineOnly) reject(new Error(`the response ended before its first frame was read: ${JSON.stringify(text)}`));
        else resolve({ status: res.statusCode ?? 0, headers: toHeaders(res.headers), body: text });
      });
    });
    req.on("error", (e) => (clearTimeout(timer), reject(e)));
    req.end(body);
  });
}

async function overFetch(handler: (r: Request) => Promise<Response>, method: string, path: string, headers: Record<string, string>, body: string | undefined, firstLineOnly: boolean): Promise<Answer> {
  const ac = new AbortController();
  const res = await handler(new Request(`http://api.example${path}`, { method, headers, signal: ac.signal, ...(body !== undefined ? { body } : {}) }));
  if (!firstLineOnly) return { status: res.status, headers: res.headers, body: await res.text() };
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;
  while (!text.includes("\n")) {
    const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no first frame within 5 s")), Math.max(0, deadline - Date.now())))]);
    if (next.done) throw new Error(`the response ended before its first frame was read: ${JSON.stringify(text)}`);
    text += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel();
  ac.abort();
  return { status: res.status, headers: res.headers, body: text, firstLine: text.slice(0, text.indexOf("\n")) };
}

/** Sends the case's request with `{host}` and `{etag}` filled in. */
async function exchange(c: Case, send: (method: string, path: string, headers: Record<string, string>, body: string | undefined, firstLineOnly: boolean) => Promise<Answer>, host: string): Promise<Answer> {
  const body = c.request.body === undefined ? undefined : JSON.stringify(c.request.body);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.request.headers ?? {})) headers[k] = v.replace(/\{host\}/g, host);
  if (!Object.keys(headers).some((k) => k.toLowerCase() === "host")) headers["Host"] = host;
  if (Object.values(headers).some((v) => v.includes("{etag}"))) {
    const plain = Object.fromEntries(Object.entries(headers).filter(([, v]) => !v.includes("{etag}")));
    const first = await send(c.request.method, c.request.path, plain, body, false);
    const etag = first.headers.get("etag");
    expect(etag, `${c.name}: the first answer carries no ETag to send back`).toBeTruthy();
    for (const k of Object.keys(headers)) headers[k] = headers[k]!.replace(/\{etag\}/g, etag!);
  }
  return send(c.request.method, c.request.path, headers, body, c.expect.streams === true);
}

function at(value: unknown, path: string): unknown {
  if (path === "") return value;
  let cur = value;
  for (const seg of path.split(".")) cur = cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined;
  return cur;
}

function hasKeyDeep(v: unknown, key: string): boolean {
  if (v === null || typeof v !== "object") return false;
  if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, key)) return true;
  return Object.values(v).some((x) => hasKeyDeep(x, key));
}

function checkPaths(what: string, value: unknown, checks: Record<string, Matcher>): void {
  for (const [path, m] of Object.entries(checks)) {
    onlyKnown(`${what} ${path}`, m, KNOWN.matcher);
    const v = at(value, path);
    const label = `${what} at "${path}": ${JSON.stringify(v)}`;
    if ("equals" in m) expect(v, label).toEqual(m["equals"]);
    if ("contains" in m) {
      expect(typeof v, label).toBe("string");
      expect(v, label).toContain(m["contains"]);
    }
    if ("includes" in m) expect(v, label).toContainEqual(m["includes"]);
    if ("excludes" in m) {
      expect(Array.isArray(v), label).toBe(true);
      expect(v, label).not.toContainEqual(m["excludes"]);
    }
    if ("includesMatch" in m) {
      expect(Array.isArray(v), label).toBe(true);
      expect(v, label).toContainEqual(expect.objectContaining(m["includesMatch"] as object));
    }
    if ("hasKey" in m) expect(Object.keys((v ?? {}) as object), label).toContain(m["hasKey"]);
    if ("lacksKey" in m) {
      expect(v !== null && typeof v === "object", label).toBe(true);
      expect(Object.keys(v as object), label).not.toContain(m["lacksKey"]);
    }
    if ("hasKeyDeep" in m) expect(hasKeyDeep(v, m["hasKeyDeep"] as string), label).toBe(true);
  }
}

function check(c: Case, a: Answer): void {
  const why = c.why ?? c.name;
  const e = c.expect;
  expect(a.status, `${why}: ${a.body}`).toBe(e.status);
  for (const [name, want] of Object.entries(e.headers ?? {})) {
    const got = a.headers.get(name);
    if (want === null) expect(got, `${why}: ${name} must be absent`).toBeNull();
    else if (typeof want === "string") expect(got, `${why}: ${name}`).toBe(want);
    else {
      onlyKnown(`header ${name}`, want, KNOWN.header);
      expect(got, `${why}: ${name} is missing`).not.toBeNull();
      if ("contains" in want) expect(got, `${why}: ${name}`).toContain(want["contains"]);
      if ("listIncludes" in want) {
        const items = got!.split(",").map((s) => s.trim().toLowerCase());
        expect(items, `${why}: ${name}`).toContain(String(want["listIncludes"]).toLowerCase());
      }
    }
  }
  if (e.problem !== undefined) {
    expect(a.headers.get("content-type"), why).toContain("application/problem+json");
    expect((JSON.parse(a.body) as { code: string }).code, why).toBe(e.problem);
  }
  if (e.emptyBody) expect(a.body, why).toBe("");
  if (e.streams) expect(a.firstLine, `${why}: the first frame was not read while the response was open`).toBeDefined();
  if (e.json) checkPaths(why, JSON.parse(a.body), e.json);
  if (e.frame) {
    const line = a.firstLine ?? a.body.split("\n").find((l) => l.trim() !== "");
    expect(line, `${why}: no frame in ${JSON.stringify(a.body)}`).toBeDefined();
    checkPaths(why, JSON.parse(line!), e.frame);
  }
}

describe("conformance vectors: http", () => {
  for (const c of doc.cases) {
    describe(c.name, () => {
      onlyKnown(c.name, c, KNOWN.case);
      onlyKnown(`${c.name} server`, c.server, KNOWN.server);
      onlyKnown(`${c.name} request`, c.request, KNOWN.request);
      onlyKnown(`${c.name} expect`, c.expect, KNOWN.expect);
      expect(["endpoint", "binding"], `${c.name}: no runner for route ${c.route}`).toContain(c.route);

      it("over the Node handler", async () => {
        const port = await nodeServer(c);
        const host = `127.0.0.1:${port}`;
        check(c, await exchange(c, (m, p, h, b, first) => overSocket(port, m, p, h, b, first), host));
      });

      // the fetch handler serves the endpoint and not the bindings, which are Node's
      if (c.route === "endpoint" && !c.server?.bindings) {
        it("over the fetch handler", async () => {
          const server = rayfold();
          const origins = c.server?.allowedOrigins ? { allowedOrigins: c.server.allowedOrigins } : {};
          const handler = createFetchHandler(server, { ...origins, viewer: () => null });
          check(c, await exchange(c, (m, p, h, b, first) => overFetch(handler, m, p, h, b, first), "api.example"));
        });
      }
    });
  }
});
