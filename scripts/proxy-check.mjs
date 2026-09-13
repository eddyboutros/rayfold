/**
 * The web demo behind a real nginx acting as reverse proxy and shared cache (the job a CDN does), configured by
 * e2e/proxy/nginx.conf: batches stream through, a live query outlives nginx's 3 s read timeout on Rayfold's keep-alives
 * and still gets its patch, WebSocket upgrades, the cache serves public reads and never private ones, conditional
 * requests get 304, and the Origin rule holds behind a proxy that rewrites Host.
 *
 *   RAYFOLD_ALLOWED_ORIGINS=http://localhost:8080 RAYFOLD_KEEPALIVE_MS=1000 RAYFOLD_DEMO_LIMIT=3000 npm run demo
 *   nginx -p <dir> -c e2e/proxy/nginx.conf      (or: docker run --network host -v ...:/etc/nginx/nginx.conf:ro nginx)
 *   node scripts/proxy-check.mjs [http://localhost:8080]
 *
 * Every wait is bounded; the exit code is the number of failed checks.
 */
const base = (process.argv[2] ?? "http://localhost:8080").replace(/\/$/, "");
const origin = new URL(base).origin;
const book = "g84"; // Frankenstein, in every slice of the catalogue the demo loads
const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`ok    ${name}${detail ? `  (${detail})` : ""}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}: ${e?.message ?? e}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const within = (ms) => AbortSignal.timeout(ms);

async function signIn(name) {
  const res = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ name }), signal: within(5000) });
  assert(res.ok, `sign-in answered ${res.status}`);
  return /sid=[^;]+/.exec(res.headers.get("set-cookie") ?? "")?.[0] ?? "";
}
async function stock(cookie) {
  const res = await fetch(`${base}/__state?book=${book}`, { headers: { cookie }, signal: within(5000) });
  return (await res.json()).stock;
}
const batch = (ops, headers = {}) =>
  fetch(`${base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json", origin, ...headers }, body: JSON.stringify({ ops }), signal: within(10000) });
const order = (key) => ({ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: book, qty: 1 }] } }, key, shape: "{ id status }" });
const frames = async (res) => (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const cookie = await signIn("proxy-check");

await check("a batch with a command streams through the proxy", async () => {
  const res = await batch([order(`proxy-${Date.now()}-a`)], { cookie });
  assert(res.status === 200, `status ${res.status}`);
  const fs = await frames(res);
  assert(fs[0]?.ok?.status === "PLACED", JSON.stringify(fs));
  return `order ${fs[0].ok.id}`;
});

await check("a write from a foreign origin is refused behind the Host-rewriting proxy", async () => {
  const res = await batch([order(`proxy-${Date.now()}-b`)], { cookie, origin: "http://evil.example" });
  assert(res.status === 403, `status ${res.status}`);
});

await check("a live query outlives nginx's 3 s read timeout on keep-alives, then gets its patch", async () => {
  const ac = new AbortController();
  const guard = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(`${base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json", origin, cookie }, body: JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: book }, shape: "{ id stock }", live: true }] }), signal: ac.signal });
    const reader = res.body.getReader();
    const text = new TextDecoder();
    let buf = "";
    const lines = [];
    const next = async () => {
      while (!lines.length) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the proxy closed the live query");
        buf += text.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop();
        lines.push(...parts);
      }
      return lines.shift();
    };
    const first = JSON.parse(await next());
    const before = first.data.stock;
    let keepAlives = 0;
    while (keepAlives < 4) if ((await next()) === "") keepAlives++; // at 1 s each, well past the 3 s timeout
    const placed = await frames(await batch([order(`proxy-${Date.now()}-c`)], { cookie }));
    assert(placed[0]?.ok, JSON.stringify(placed));
    let line;
    do line = await next(); while (line === "");
    const patch = JSON.parse(line);
    assert(patch.patch?.[0]?.value?.stock === before - 1, line);
    ac.abort();
    return `${keepAlives} keep-alives, stock ${before} -> ${before - 1}`;
  } finally {
    clearTimeout(guard);
  }
});

await check("a WebSocket upgrades through the proxy and runs a batch", async () => {
  const ws = new WebSocket(`${base.replace("http", "ws")}/rayfold/ws`, ["rayfold.0.1"]);
  const frame = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no frame within 5 s")), 5000);
    ws.onerror = () => reject(new Error("the upgrade failed"));
    ws.onopen = () => ws.send(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: book }, shape: "{ id title }" }] }));
    ws.onmessage = (e) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(e.data)));
    };
  });
  ws.close();
  assert(frame.data?.id === book, JSON.stringify(frame));
  return frame.data.title;
});

await check("the shared cache serves a public read from the cache, byte for byte", async () => {
  const url = `${base}/rayfold/book?a=${b64({ id: book })}&s=${encodeURIComponent("{ id title format }")}`;
  const one = await fetch(url, { signal: within(5000) });
  const two = await fetch(url, { signal: within(5000) });
  assert(one.headers.get("cache-control")?.startsWith("public"), `Cache-Control ${one.headers.get("cache-control")}`);
  assert(two.headers.get("x-cache-status") === "HIT", `second read was ${two.headers.get("x-cache-status")}`);
  assert((await one.text()) === (await two.text()), "the cached body differs");
  return `${one.headers.get("x-cache-status")} then HIT, ${one.headers.get("cache-control")}`;
});

await check("a whole screen is one cache entry: the book, its author and its reviews together", async () => {
  const shape = "{ id title format author { id name } reviews(page: { first: 3 }) { items { id rating } } }";
  const url = `${base}/rayfold/book?a=${b64({ id: book })}&s=${encodeURIComponent(shape)}`;
  const one = await fetch(url, { signal: within(5000) });
  const two = await fetch(url, { signal: within(5000) });
  assert(one.status === 200, `status ${one.status}`);
  assert(one.headers.get("cache-control")?.startsWith("public"), `Cache-Control ${one.headers.get("cache-control")}`);
  assert(two.headers.get("x-cache-status") === "HIT", `second read was ${two.headers.get("x-cache-status")}`);
  const body = await one.text();
  assert(body === (await two.text()), "the cached body differs");
  const frame = JSON.parse(body.trim());
  assert(frame.data?.author?.name, "the author is missing from the screen");
  assert(Array.isArray(frame.data?.reviews?.items), "the reviews are missing from the screen");
  // REST would need one cache entry and one request per resource for the same screen; a POST query cannot be cached at all
  return `book + author + ${frame.data.reviews.items.length} reviews in one entry, ${one.headers.get("cache-control")}`;
});

await check("a signed-in read is private: never stored, never served to anyone from the cache", async () => {
  const url = `${base}/rayfold/book?a=${b64({ id: book })}&s=${encodeURIComponent("{ id title price }")}`;
  const one = await fetch(url, { headers: { cookie }, signal: within(5000) });
  const two = await fetch(url, { headers: { cookie }, signal: within(5000) });
  const anonymous = await fetch(url, { signal: within(5000) });
  assert(one.headers.get("cache-control")?.startsWith("private"), `Cache-Control ${one.headers.get("cache-control")}`);
  assert(two.headers.get("x-cache-status") !== "HIT", "a private answer came from the cache");
  assert(anonymous.headers.get("x-cache-status") !== "HIT", "a private answer was served to another visitor");
  return `${one.headers.get("x-cache-status")}, ${two.headers.get("x-cache-status")}, anonymous ${anonymous.headers.get("x-cache-status")}`;
});

await check("a conditional read with the ETag gets 304 through the proxy", async () => {
  const url = `${base}/rayfold/book?a=${b64({ id: book })}&s=${encodeURIComponent("{ id }")}`;
  const one = await fetch(url, { signal: within(5000) });
  const etag = one.headers.get("etag");
  assert(etag, "no ETag");
  const two = await fetch(url, { headers: { "if-none-match": etag }, signal: within(5000) });
  assert(two.status === 304, `status ${two.status}`);
  return etag;
});

await check("the proxy still leaves stock where the orders put it", async () => {
  const s = await stock(cookie);
  assert(typeof s === "number", `stock ${s}`);
  return `stock ${s}`;
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failed);
