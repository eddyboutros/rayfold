/**
 * The web demo's server as the real process `npm run demo` starts, on free ports: sign-in and its cookie, the routes
 * beside the endpoint, the test hook, and the proxy that rewrites Host. e2e/browser/demo.spec.ts drives the same server
 * from real browsers; this covers what a browser run does not look at.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
let proc: ChildProcess;
let demo = "";
let proxy = "";
let other = "";
const scratch = mkdtempSync(join(tmpdir(), "bookstore-web-"));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

beforeAll(async () => {
  const [d, o, p] = [await freePort(), await freePort(), await freePort()];
  demo = `http://127.0.0.1:${d}`;
  other = `http://127.0.0.1:${o}`;
  proxy = `http://127.0.0.1:${p}`;
  proc = spawn(process.execPath, ["--import", "tsx", "examples/bookstore-web/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      RAYFOLD_DEMO_PORT: String(d),
      RAYFOLD_OTHER_PORT: String(o),
      RAYFOLD_PROXY_PORT: String(p),
      RAYFOLD_DEMO_LIMIT: "100",
      RAYFOLD_ALLOWED_ORIGINS: `http://localhost:${p}`,
      RAYFOLD_ATTACK_REPORT: join(scratch, "attacks.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  // the three servers each say so when they listen; a bounded wait, so a server that never starts fails here
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the demo did not start within 20 s: ${out}`)), 20_000);
    const seen = () => {
      if (/demo\s+http/.test(out) && /other site/.test(out) && /proxy\s+http/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout!.on("data", (b: Buffer) => ((out += b.toString()), seen()));
    proc.stderr!.on("data", (b: Buffer) => (out += b.toString()));
    proc.once("exit", (code) => (clearTimeout(timer), reject(new Error(`the demo exited with ${code}: ${out}`))));
  });
}, 30_000);

afterAll(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill();
    await exited;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const login = (name: unknown, base = demo) => fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
const cookieOf = (res: Response) => /^sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[0] ?? "";

describe("the web demo's server", () => {
  it("signs in with a session cookie the page's scripts cannot read, and /me answers who it names", async () => {
    const res = await login("Reader One!");
    expect(res.status).toBe(200);
    // the name is lower-cased and kept to letters, digits, - and _
    expect(await res.json()).toEqual({ id: "readerone", role: "customer" });
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^sid=[A-Za-z0-9_-]{24}; Path=\/; HttpOnly; SameSite=Lax$/);
    const me = await fetch(`${demo}/me`, { headers: { cookie: cookieOf(res) } });
    expect([me.headers.get("cache-control"), await me.json()]).toEqual(["no-store", { id: "readerone", role: "customer" }]);
    // guard: no cookie, or one the server never issued, is nobody
    expect(await (await fetch(`${demo}/me`)).json()).toBeNull();
    expect(await (await fetch(`${demo}/me`, { headers: { cookie: "sid=made-up" } })).json()).toBeNull();
  });

  it("the name admin signs in as an admin and no other does; a name with nothing usable is refused", async () => {
    expect(await (await login("ADMIN")).json()).toEqual({ id: "admin", role: "admin" });
    expect(await (await login("administrator")).json()).toEqual({ id: "administrator", role: "customer" });
    for (const name of ["", "!!!", null]) {
      const res = await login(name);
      expect([res.status, await res.json(), res.headers.get("set-cookie")], String(name)).toEqual([400, { error: "name required" }, null]);
    }
    expect((await login("x".repeat(40)).then((r) => r.json())) as { id: string }).toEqual({ id: "x".repeat(32), role: "customer" });
  });

  it("the endpoint reads the viewer from the cookie: an order is placed as the one signed in", async () => {
    const cookie = cookieOf(await login("buyer"));
    const res = await fetch(`${demo}/rayfold`, {
      method: "POST",
      headers: { "content-type": "application/rayfold+json", cookie, origin: demo },
      body: JSON.stringify({ ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 1 }] } }, key: "web-demo-order-01", shape: "{ id customerId }" }] }),
    });
    expect(res.status).toBe(200);
    const state = (await (await fetch(`${demo}/__state?book=b1`)).json()) as { orders: unknown[]; stock: number | null };
    expect(state.orders).toContainEqual({ id: expect.any(String), status: "PLACED", customerId: "buyer" });
    expect(state.stock).toBe(4);
    expect(((await (await fetch(`${demo}/__state?book=nope`)).json()) as { stock: unknown }).stock).toBeNull();
  });

  it("serves the page and its script without caching, with nosniff, and 404 for anything else", async () => {
    const page = await fetch(`${demo}/`);
    expect([page.status, page.headers.get("content-type"), page.headers.get("cache-control"), page.headers.get("x-content-type-options")]).toEqual([200, "text/html; charset=utf-8", "no-store", "nosniff"]);
    const js = await fetch(`${demo}/app.js`);
    expect([js.status, js.headers.get("content-type")]).toEqual([200, "text/javascript; charset=utf-8"]);
    expect(await js.text()).toContain("createFetchTransport");
    const nothing = await fetch(`${demo}/nothing-here`);
    expect([nothing.status, await nothing.text()]).toEqual([404, "not found"]);
    // the other site serves its attack page and nothing else
    expect((await fetch(`${other}/`)).status).toBe(200);
    expect((await fetch(`${other}/elsewhere`)).status).toBe(404);
  });

  it("refuses a sign-in body over 64 KiB without signing anyone in", async () => {
    const res = await fetch(`${demo}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "big", pad: "x".repeat(70_000) }) }).catch((e: unknown) => e);
    // the server stops reading and drops the request: either the 500 or the closed socket reaches the client
    if (res instanceof Response) expect(res.status).toBe(500);
    else expect(res).toBeInstanceOf(Error);
    // guard: the same sign-in under the limit works
    expect(await (await login("small")).json()).toEqual({ id: "small", role: "customer" });
  });

  it("the proxy forwards with the demo's own Host, so a command from the proxy's origin needs RAYFOLD_ALLOWED_ORIGINS; guard: another origin is refused", async () => {
    const cookie = cookieOf(await login("proxied", proxy));
    expect(cookie).toMatch(/^sid=/);
    const placeVia = (origin: string, key: string) =>
      fetch(`${proxy}/rayfold`, {
        method: "POST",
        headers: { "content-type": "application/rayfold+json", cookie, origin },
        body: JSON.stringify({ ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b3", qty: 1 }] } }, key, shape: "{ id }" }] }),
      });
    const allowed = await placeVia(`http://localhost:${new URL(proxy).port}`, "web-demo-proxy-01");
    expect(allowed.status).toBe(200);
    const refused = await placeVia("https://elsewhere.example", "web-demo-proxy-02");
    expect(refused.status).toBe(403);
    // the proxy's own host as the origin is refused too: what the demo sees is its own Host, not the proxy's
    expect((await placeVia(proxy, "web-demo-proxy-03")).status).toBe(403);
    const state = (await (await fetch(`${demo}/__state?book=b3`)).json()) as { orders: Array<{ customerId: string }>; stock: number };
    expect([state.orders.filter((o) => o.customerId === "proxied").length, state.stock]).toEqual([1, 99]);
  });
});
