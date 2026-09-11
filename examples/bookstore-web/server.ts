/**
 * Rayfold web demo: the bookstore holding the real Project Gutenberg catalogue, the Rayfold client running in a real browser,
 * a second site for cross-site attack checks, and a reverse proxy that rewrites Host the way nginx proxy_pass does.
 *
 *   npm run demo
 *   demo        http://localhost:4610   the app; Rayfold at /rayfold, REST-style routes, MCP at /mcp, WebSocket at /rayfold/ws
 *   other site  http://localhost:4611   attack.html tries cross-site requests against the demo, with the user's cookie
 *   proxy       http://localhost:4612   forwards everything to the demo and rewrites Host to 127.0.0.1:4610
 *
 * Environment: RAYFOLD_ALLOWED_ORIGINS (comma-separated origins allowed to write, e.g. http://localhost:4612 for the proxy),
 * RAYFOLD_DEMO_LIMIT (load only the first N books), RAYFOLD_DEMO_HOST (bind address, default 127.0.0.1),
 * RAYFOLD_KEEPALIVE_MS (keep-alive interval of streaming responses), RAYFOLD_ATTACK_REPORT (where the attack page's
 * results go; default e2e/browser-attacks.json).
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { attachWebSocket, createBindingHandler, createHttpHandler, createMcpHandler } from "@rayfold/server";
import { createBookstore, seed, withGutenberg } from "../bookstore-ts/src/index.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPORT = process.env["RAYFOLD_ATTACK_REPORT"] ?? fileURLToPath(new URL("../../e2e/browser-attacks.json", import.meta.url));
const DEMO = Number(process.env["RAYFOLD_DEMO_PORT"] ?? 4610);
const OTHER = Number(process.env["RAYFOLD_OTHER_PORT"] ?? 4611);
const PROXY = Number(process.env["RAYFOLD_PROXY_PORT"] ?? 4612);
const HOST = process.env["RAYFOLD_DEMO_HOST"] ?? "127.0.0.1";
const allowedOrigins = (process.env["RAYFOLD_ALLOWED_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const limit = process.env["RAYFOLD_DEMO_LIMIT"] ? Number(process.env["RAYFOLD_DEMO_LIMIT"]) : undefined;

const loadStarted = Date.now();
const store = withGutenberg(seed(), limit === undefined ? {} : { limit });
const bs = createBookstore({ store });
console.log(`loaded ${store.books.size.toLocaleString("en-US")} books by ${store.authors.size.toLocaleString("en-US")} authors in ${Date.now() - loadStarted} ms`);

// Sign-in: a cookie names the viewer, the way most web apps work. SameSite=Lax cookies are still sent to another
// port on the same host, which is exactly what makes the cross-site checks below meaningful.
const sessions = new Map<string, { id: string; role: "customer" | "admin" }>();
const viewerOf = (req: IncomingMessage) => {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  return (sid !== undefined && sessions.get(sid)) || null;
};
const opts = { viewer: viewerOf, allowedOrigins };
// RAYFOLD_KEEPALIVE_MS: how often an idle streaming response gets a keep-alive (the proxy check uses a short one)
const keepAlive = process.env["RAYFOLD_KEEPALIVE_MS"] ? { keepAliveMs: Number(process.env["RAYFOLD_KEEPALIVE_MS"]) } : {};
const rayfold = createHttpHandler(bs.server, { ...opts, ...keepAlive });
const bindings = createBindingHandler(bs.server, opts);
const mcp = createMcpHandler(bs.server, opts);

// The real @rayfold/client, bundled for the browser.
const bundle = await build({
  entryPoints: [HERE + "app.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});
const appJs = bundle.outputFiles[0]!.text;
const indexHtml = readFileSync(HERE + "index.html", "utf8");
const attackHtml = readFileSync(HERE + "attack.html", "utf8").replaceAll("{{DEMO}}", `http://localhost:${DEMO}`);

function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", ...headers }).end(body);
}
function readText(req: IncomingMessage, max = 65_536): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const demo = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", indexHtml, { "cache-control": "no-store" });
    if (req.method === "GET" && url.pathname === "/app.js") return send(res, 200, "text/javascript; charset=utf-8", appJs, { "cache-control": "no-store" });
    if (req.method === "POST" && url.pathname === "/login") {
      const name = String((JSON.parse((await readText(req)) || "{}") as { name?: unknown }).name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
      if (!name) return send(res, 400, "application/json", JSON.stringify({ error: "name required" }));
      const sid = randomBytes(18).toString("base64url");
      const viewer = { id: name, role: name === "admin" ? ("admin" as const) : ("customer" as const) };
      sessions.set(sid, viewer);
      return send(res, 200, "application/json", JSON.stringify(viewer), { "set-cookie": `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (req.method === "GET" && url.pathname === "/me") return send(res, 200, "application/json", JSON.stringify(viewerOf(req)), { "cache-control": "no-store" });
    if (req.method === "GET" && url.pathname === "/__state") {
      // Test hook for the browser run: what the store holds right now. Another site cannot read it (no CORS).
      const book = url.searchParams.get("book") ?? "g84";
      const state = { orders: [...store.orders.values()].map((o) => ({ id: o.id, status: o.status, customerId: o.customerId })), stock: store.books.get(book)?.stock ?? null, reviews: store.reviews.size };
      return send(res, 200, "application/json", JSON.stringify(state), { "cache-control": "no-store" });
    }
    if (url.pathname === "/rayfold" || url.pathname.startsWith("/rayfold/")) return rayfold(req, res);
    if (await mcp(req, res)) return;
    if (await bindings(req, res)) return;
    send(res, 404, "text/plain", "not found");
  })().catch(() => {
    if (!res.headersSent) send(res, 500, "text/plain", "internal error");
  });
});
attachWebSocket(demo, bs.server, opts);

// The other site: a page on another origin (another port on the same host, so the browser still sends the cookie).
const other = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", attackHtml, { "cache-control": "no-store" });
    if (req.method === "GET" && url.pathname === "/sink") return send(res, 200, "text/html; charset=utf-8", "<p>form target</p>");
    if (req.method === "POST" && url.pathname === "/report") {
      const attacks = JSON.parse(await readText(req, 262_144)) as unknown;
      writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), userAgent: req.headers["user-agent"] ?? "", attacks }, null, 2) + "\n");
      return send(res, 204, "text/plain", "");
    }
    send(res, 404, "text/plain", "not found");
  })().catch(() => {
    if (!res.headersSent) send(res, 500, "text/plain", "internal error");
  });
});

// The proxy: like nginx's default proxy_pass, it sends the upstream's own Host, so the browser's Origin
// (http://localhost:4612) no longer matches the Host the demo sees. RAYFOLD_ALLOWED_ORIGINS must list the public origin.
const upstreamHost = `127.0.0.1:${DEMO}`;
const proxy = createServer((req, res) => {
  const up = httpRequest({ host: "127.0.0.1", port: DEMO, method: req.method, path: req.url, headers: { ...req.headers, host: upstreamHost, "x-forwarded-host": req.headers.host ?? "", "x-forwarded-proto": "http" } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502).end();
  });
  req.pipe(up);
});
proxy.on("upgrade", (req, socket, head) => {
  const up = connect(DEMO, "127.0.0.1", () => {
    const headers = Object.entries({ ...req.headers, host: upstreamHost }).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    up.write([`${req.method} ${req.url} HTTP/1.1`, ...headers, "", ""].join("\r\n"));
    if (head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

demo.listen(DEMO, HOST, () => console.log(`demo       http://localhost:${DEMO}${allowedOrigins.length ? `   (also allows ${allowedOrigins.join(", ")})` : ""}`));
other.listen(OTHER, HOST, () => console.log(`other site http://localhost:${OTHER}`));
proxy.listen(PROXY, HOST, () => console.log(`proxy      http://localhost:${PROXY}  -> Host ${upstreamHost}`));
