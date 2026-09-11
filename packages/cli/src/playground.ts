/** Minimal Rayfold playground: edit a batch, watch frames stream in, inspect cost/cache/patches. */
import type { IncomingMessage, ServerResponse } from "node:http";

const HTML = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>Rayfold playground</title>
<style>
  :root { --bg:#f6f4ef; --ink:#222; --muted:#6b6b6b; --acc:#c8552b; --card:#fff; --line:#e3ded4; --code:#1e1e1e; --codeink:#e6e1d6; }
  body { margin:0; font:14px/1.45 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { display:flex; gap:16px; align-items:center; padding:12px 20px; border-bottom:1px solid var(--line); background:var(--card); }
  header h1 { font-size:16px; margin:0; letter-spacing:.04em; } header h1 span { color:var(--acc); }
  header input { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:6px; min-width:220px; }
  main { display:grid; grid-template-columns: 1fr 1fr; gap:16px; padding:16px 20px; height: calc(100vh - 58px); box-sizing:border-box; }
  section { display:flex; flex-direction:column; min-height:0; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 8px; }
  textarea, pre { font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  textarea { flex:1; resize:none; border:1px solid var(--line); border-radius:8px; padding:12px; background:var(--code); color:var(--codeink); }
  pre { flex:1; overflow:auto; margin:0; border:1px solid var(--line); border-radius:8px; padding:12px; background:var(--card); white-space:pre-wrap; }
  .row { display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap; }
  button { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--acc); background:var(--acc); color:#fff; cursor:pointer; }
  button.ghost { background:transparent; color:var(--acc); }
  .frame { border-left:3px solid var(--line); padding:4px 8px; margin:4px 0; }
  .frame.data { border-color:#3a7d44; } .frame.ok { border-color:#2b6cb0; } .frame.error { border-color:#c8552b; } .frame.patch, .frame.at { border-color:#b7791f; } .frame.item { border-color:#6b46c1; }
  .meta { color:var(--muted); font-size:12px; }
  select { font:inherit; padding:6px; border-radius:6px; border:1px solid var(--line); }
</style></head>
<body>
<header><h1><span>Rayfold</span> playground</h1>
  <label>Bearer <input id="token" placeholder="u1, u2 or admin" value="u1"></label>
  <span class="meta" id="schema"></span>
</header>
<main>
  <section>
    <div class="row">
      <select id="examples"></select>
      <button id="run">Run batch</button>
      <button class="ghost" id="explain">Explain</button>
      <span class="meta">Ctrl+Enter runs</span>
    </div>
    <textarea id="req" spellcheck="false"></textarea>
  </section>
  <section>
    <div class="row"><h2 style="margin:0">Frames</h2><span class="meta" id="stats"></span><button class="ghost" id="clear">Clear</button></div>
    <pre id="out"></pre>
    <h2 style="margin-top:12px">Cache (normalized)</h2>
    <pre id="cache" style="max-height:30%"></pre>
  </section>
</main>
<script>
const EX = {
  "default view": { ops: [{ id: 1, op: "book", args: { id: "b1" } }] },
  "nested shape (batched loaders)": { ops: [{ id: 1, op: "books", args: { page: { first: 3 } }, shape: "{ items { id title author { name } reviews(page: { first: 2 }) { items { rating } } } hasMore cursor }" }] },
  "pipelined: place order then read it": { ops: [
    { id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b1", qty: 1 }] } }, key: "playground-" + Math.random().toString(36).slice(2, 12) },
    { id: 2, op: "order", args: { id: { "$ref": "1.id" } }, shape: "{ id status total items { qty book { id stock } } }" } ] },
  "typed domain error": { ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b4", qty: 1 }] } }, key: "playground-error-0001" }] },
  "policy: cost price (try admin / u1 / u2)": { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title costPrice }" }] },
  "deferred @lazy field": { ops: [{ id: 1, op: "author", args: { id: "a1" }, shape: "{ id name bio }" }] },
  "simulate a command": { ops: [{ id: 1, op: "placeOrder", args: { input: { lines: [{ bookId: "b2", qty: 2 }] } }, key: "playground-sim-000001", simulate: true }] },
};
const $ = (s) => document.querySelector(s);
const sel = $("#examples"); for (const k of Object.keys(EX)) sel.append(new Option(k, k));
const load = () => { $("#req").value = JSON.stringify(EX[sel.value], null, 2); }; sel.onchange = load; load();
const cache = {};
function normalize(v) { if (!v || typeof v !== "object") return; if (Array.isArray(v)) return v.forEach(normalize);
  if (typeof v.$type === "string" && v.id !== undefined) { const k = v.$type + ":" + v.id; cache[k] = Object.assign(cache[k] || {}, Object.fromEntries(Object.entries(v).filter(([kk, x]) => !(x && typeof x === "object" && typeof x.$type === "string")))); }
  Object.values(v).forEach(normalize); }
function patch(ops) { for (const p of ops) { if (p.set) { cache[p.set] = Object.assign(cache[p.set] || {}, p.value); } if (p.del) delete cache[p.del]; if (p.inv) for (const k of p.inv) if (cache[k]) cache[k].$stale = true; } }
async function run() {
  const t0 = performance.now(); let n = 0;
  const res = await fetch("/rayfold", { method: "POST", headers: { "content-type": "application/rayfold+json", authorization: "Bearer " + $("#token").value }, body: $("#req").value });
  $("#schema").textContent = "schema " + (res.headers.get("rayfold-schema") || "").slice(0, 12);
  if (!res.headers.get("content-type").startsWith("application/rayfold-frames")) { $("#out").innerHTML += '<div class="frame error">' + esc(await res.text()) + "</div>"; return; }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; show(JSON.parse(line), performance.now() - t0); n++; } }
  $("#stats").textContent = n + " frame" + (n === 1 ? "" : "s") + " in " + (performance.now() - t0).toFixed(0) + " ms";
  $("#cache").textContent = JSON.stringify(cache, null, 1);
}
function show(f, ms) { const kind = "error" in f ? "error" : "ok" in f ? "ok" : "at" in f ? "at" : "patch" in f ? "patch" : "item" in f ? "item" : "data" in f ? "data" : "fin";
  if (f.data) normalize(f.data); if (f.ok) normalize(f.ok); if (f.patch) patch(f.patch); if (f.item) normalize(f.item);
  $("#out").innerHTML += '<div class="frame ' + kind + '"><span class="meta">+' + ms.toFixed(0) + ' ms  op ' + (f.id ?? "batch") + '  ' + kind + (f.fin ? "  fin" : "") + (f.meta ? "  cost " + f.meta.cost + (f.meta.replay ? " replay" : "") : "") + '</span>\n' + esc(JSON.stringify(f, null, 1)) + '</div>'; $("#out").scrollTop = 1e9; }
function esc(s) { return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
$("#run").onclick = run; $("#clear").onclick = () => { $("#out").innerHTML = ""; };
$("#req").addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "Enter") run(); });
$("#explain").onclick = async () => { const m = await (await fetch("/rayfold/manifest")).json(); const req = JSON.parse($("#req").value);
  $("#out").innerHTML += '<div class="frame"><span class="meta">manifest</span>\n' + esc("ops: " + Object.keys(m.schema.ops).join(", ") + "\nlimits: " + JSON.stringify(m.limits) + "\nbatch ops: " + req.ops.map((o) => o.op + " (" + m.schema.ops[o.op]?.kind + ")").join(", ")) + "</div>"; };
</script></body></html>`;

export function playgroundHandler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(HTML);
}
