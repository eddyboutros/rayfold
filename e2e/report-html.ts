/**
 * Builds e2e/report.html: a public decision guide, "Should you use Rayfold?", for readers anywhere in the world.
 * Every number and verdict comes from e2e/results.json, e2e/methods.json, e2e/security.json (when present) and
 * bench/results/latest.json, which the tests write. Nothing here is typed in by hand except plain-language
 * explanations. Run: npx tsx e2e/report-html.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { CATALOGUE_SIZE } from "../examples/bookstore-ts/src/catalogue.ts";
import { demosHtml } from "./report-demos.ts";

type Verdict = "lead" | "tie" | "behind";
type Values = { REST: number | null; GraphQL: number | null; Rayfold: number | null };
interface Ex { label?: string; request: { method: string; target: string; headers: Record<string, string>; body?: string }; response: { status: number; headers: Record<string, string>; body: string } }
type ByStack = { REST: Ex[]; GraphQL: Ex[]; Rayfold: Ex[] };
interface Row { aspect: string; metric: string; REST: string; GraphQL: string; Rayfold: string; note?: string; values?: Values; unit?: string; better?: "lower" | "higher"; verdict?: Verdict; examples?: ByStack }
interface Fact { metric: string; unit?: string; better: "lower" | "higher"; values: Values; REST: string; GraphQL: string; Rayfold: string; verdict?: Verdict }
interface MethodBlock { method: string; title: string; operation: string; exchanges: ByStack; facts: Fact[]; note?: string; verdict?: Verdict }
interface BenchRow { flow: string; impl: string; roundTrips: number; bytesDown: number; bytesUp: number; p50: number; p99: number }
interface Attack { area: string; attack: string; defence: string; result: string; guard: string; runtimes: string[]; exchange?: Ex }

const e2e = JSON.parse(readFileSync("e2e/results.json", "utf8")) as { generatedAt: string; rows: Row[] };
// the released version, from the package that carries it, so the page does not go stale at every release
const version = (JSON.parse(readFileSync("packages/server/package.json", "utf8")) as { version: string }).version;
const bench = JSON.parse(readFileSync("bench/results/latest.json", "utf8")) as { generatedAt: string; node: string; iterations: number; rows: BenchRow[] };
const methods: MethodBlock[] = existsSync("e2e/methods.json") ? (JSON.parse(readFileSync("e2e/methods.json", "utf8")) as { methods: MethodBlock[] }).methods : [];
const security: { generatedAt: string; attacks: Attack[] } | null = existsSync("e2e/security.json") ? JSON.parse(readFileSync("e2e/security.json", "utf8")) : null;
interface RealData { generatedAt: string; rows: Row[]; dataset?: { source?: string; retrieved?: string; books?: number; authors?: number; note?: string } }
const realdata: RealData | null = existsSync("e2e/realdata.json") ? JSON.parse(readFileSync("e2e/realdata.json", "utf8")) : null;
interface Workspace { generatedAt: string; dataset: Record<string, number>; rows: Row[] }
const workspace: Workspace | null = existsSync("e2e/workspace.json") ? JSON.parse(readFileSync("e2e/workspace.json", "utf8")) : null;
interface BrowserRun { at: string; browser: string; how: string; dataset: string; flows: Array<{ step: string; result: string }>; crossSite: { from: string; attempts: Array<{ attempt: string; observed: string }>; outcome: string[] }; proxy: Array<{ setup: string; result: string }>; foundAndFixed: string[] }
const browserRun: BrowserRun | null = existsSync("e2e/browser-run.json") ? JSON.parse(readFileSync("e2e/browser-run.json", "utf8")) : null;
const out = process.argv[2] ?? "e2e/report.html";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const STACKS = ["REST", "GraphQL", "Rayfold"] as const;
type StackName = (typeof STACKS)[number];
const cls: Record<StackName, string> = { REST: "s-rest", GraphQL: "s-gql", Rayfold: "s-rayfold" };

// ------------------------------------------------------------------ plain-language layer
interface Plain { theme: string; task: string; why: string }
/** Plain words for each measured aspect, matched by the start of the aspect name the test reports. */
const PLAIN: Array<[string, Plain]> = [
  ["Product page", { theme: "speed", task: "Show one product page: a book, its author and its reviews.", why: "Every extra request adds a network wait. On a phone far from the server, those waits are most of the loading time." }],
  ["List of 20 books", { theme: "speed", task: "List 20 books with each author's name.", why: "When related data is loaded one item at a time (the 'N+1' problem), a list of 20 costs 21 trips to the database or the network." }],
  ["Payload for 20 books", { theme: "speed", task: "Load only the two fields the screen shows: id and title.", why: "Bytes the screen never shows still cost mobile data, battery and time." }],
  ["Deferring a slow field", { theme: "speed", task: "One field (the author's biography) is slow. Show the rest of the page first.", why: "People see content sooner when a slow part does not hold back the fast parts." }],
  ["Place an order", { theme: "writes", task: "Place an order, then pay for it. Paying needs the new order's id.", why: "Each step that must wait for the previous answer adds one more network wait." }],
  ["Retrying a create", { theme: "writes", task: "The connection drops after the customer taps Buy, so the app sends the order again.", why: "Without a guard that the server enforces, a retry can create a second order and charge twice." }],
  ["Domain error", { theme: "errors", task: "An order fails because a book is out of stock.", why: "The app needs to know what went wrong, with details, to show a helpful message." }],
  ["Invalid input", { theme: "errors", task: "A client sends a wrong quantity: first the text 'two', then 0.", why: "Bad input that reaches your business code can create wrong orders." }],
  ["Field-level authorization", { theme: "access", task: "Only a book's owner may see its cost price.", why: "Permission checks written by hand in every handler are easy to forget in one place." }],
  ["Abusive query", { theme: "access", task: "A client asks for 200 books, each with 200 books, each with 200 books.", why: "One expensive request can slow the service down for everyone." }],
  ["Shared HTTP caching", { theme: "live", task: "Serve a popular product page from a shared cache, such as a CDN.", why: "An answer from a cache near the user is fast and costs your servers nothing." }],
  ["List view after placing", { theme: "live", task: "After an order, the book list already on screen must show the new stock.", why: "Stale screens confuse people, and reloading everything costs requests." }],
  ["Realtime stock", { theme: "live", task: "Show stock changes live while the page is open.", why: "A second system only for live updates is more code to build, secure and run." }],
  ["Removing a field", { theme: "change", task: "Remove a field from the API without breaking the apps that still use it.", why: "APIs live for years. A safe way to remove things keeps them clean without outages." }],
  ["Exposing the API to an AI agent", { theme: "agents", task: "Let an AI assistant find and call the API, and try an order as a dry run first.", why: "Agents need typed tools, clear errors and a safe way to test an action before doing it." }],
];
const THEMES: Array<{ id: string; title: string; lede: string }> = [
  { id: "speed", title: "Speed and data size", lede: "How many requests and how many bytes one screen costs." },
  { id: "writes", title: "Writing data safely", lede: "Actions with several steps, and retries after a network failure." },
  { id: "errors", title: "Errors and bad input", lede: "What the app learns when something goes wrong." },
  { id: "access", title: "Access control and protection", lede: "Who may see what, and how expensive a single request may be." },
  { id: "live", title: "Caching and live data", lede: "Keeping screens fast, cheap and correct." },
  { id: "change", title: "Changing the API over time", lede: "Removing things without breaking the apps that depend on them." },
  { id: "agents", title: "AI agents", lede: "Letting an assistant use the API with the same rules as any other client." },
];
const plainOf = (aspect: string): Plain => PLAIN.find(([p]) => aspect.startsWith(p))?.[1] ?? { theme: "speed", task: aspect, why: "" };

const GLOSSARY: Array<[string, string]> = [
  ["Round trip", "One request sent and its answer received. Each round trip waits for the network."],
  ["Shape", "The list of fields a client wants back, for example { title author { name } }. Rayfold returns exactly that."],
  ["Default view", "The fields a Rayfold operation returns when the client does not send a shape. Plain calls with curl work."],
  ["Batch", "Several operations in one Rayfold request. A later operation can use an earlier one's result with $ref."],
  ["Idempotency key", "A unique label on a write. If the same write arrives twice, the server returns the first answer instead of doing the work again."],
  ["Patch", "A small description of what changed, such as 'Book b1 now has stock 3'. Rayfold sends patches with every write so client caches stay correct."],
  ["Live query", "A normal query with live: true. The server keeps it open and sends patches when the data changes."],
  ["ETag and 304", "An ETag is a fingerprint of an answer. A client that already has the same fingerprint gets 304 Not Modified and no body."],
  ["N+1", "Loading a list, then one more request or database call for every item in it."],
  ["Policy", "A permission rule written in the schema, such as 'only the owner may read costPrice'. Rayfold enforces it on every path."],
  ["RB", "Rayfold Binary, an optional compact encoding of the same messages. JSON always works too."],
  ["MCP", "Model Context Protocol, the common way AI assistants discover and call tools. Every Rayfold server is also an MCP server."],
];

// ------------------------------------------------------------------ numbers derived from the data
const led = e2e.rows.filter((r) => r.verdict === "lead").length;
const tied = e2e.rows.filter((r) => r.verdict === "tie").length;
const behind = e2e.rows.length - led - tied;
const methodFacts = methods.flatMap((m) => m.facts);
const mLead = methods.filter((m) => m.verdict === "lead").length;
const fBehind = methodFacts.filter((f) => f.verdict === "behind").length;
const rt = (impl: string) => bench.rows.filter((r) => r.impl === impl).reduce((n, r) => n + r.roundTrips, 0);
const bytes = (impl: string) => bench.rows.filter((r) => r.impl === impl).reduce((n, r) => n + r.bytesDown, 0);
const rtRest = rt("REST"), rtGql = rt("GraphQL"), rtRayfold = rt("Rayfold (JSON)");
const bRest = bytes("REST"), bGql = bytes("GraphQL"), bJson = bytes("Rayfold (JSON)"), bRb = bytes("Rayfold (RB)");
const chipCls = (v?: Verdict) => (v === "lead" ? "chip-rayfold" : v === "behind" ? "chip-behind" : "chip-tie");
const chipText = (v?: Verdict) => (v === "lead" ? "Rayfold ahead" : v === "behind" ? "Rayfold behind" : "Level");
const find = (prefix: string) => e2e.rows.find((r) => r.aspect.startsWith(prefix));
const rdLead = realdata ? realdata.rows.filter((r) => r.verdict === "lead").length : 0;
const rdTie = realdata ? realdata.rows.filter((r) => r.verdict === "tie").length : 0;
const rdBehind = realdata ? realdata.rows.filter((r) => r.verdict === "behind").length : 0;
const wsRows = workspace?.rows ?? [];
const wsLead = wsRows.filter((r) => r.verdict === "lead").length;
const wsTie = wsRows.filter((r) => r.verdict === "tie").length;
const wsBehind = wsRows.filter((r) => r.verdict === "behind").length;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function valueText(r: { values?: Values; unit?: string }, s: StackName): string {
  const v = r.values?.[s];
  if (v === null || v === undefined) return "not possible";
  if (r.unit?.includes("(1 = yes)")) return v ? "yes" : "no";
  return v.toLocaleString("en-US");
}

// ------------------------------------------------------------------ charts
/** Three horizontal bars for one measured aspect. */
function aspectChart(r: Row): string {
  if (!r.values) return "";
  const max = Math.max(1, ...STACKS.map((s) => r.values![s] ?? 0));
  const W = 280, H = 70, L = 64, BH = 15, GAP = 6;
  const bars = STACKS.map((s, i) => {
    const raw = r.values![s];
    const v = raw ?? 0;
    const w = Math.max(v === 0 ? 0 : 4, Math.round(((W - L - 70) * v) / max));
    const y = 4 + i * (BH + GAP);
    const label = valueText(r, s);
    return `<text x="${L - 8}" y="${y + BH - 3}" text-anchor="end" class="ax">${s}</text><rect x="${L}" y="${y}" width="${w}" height="${BH}" rx="3" class="bar ${cls[s]}"><title>${esc(s)}: ${esc(label)} ${esc(r.unit ?? "")}</title></rect><text x="${L + w + 6}" y="${y + BH - 3}" class="val">${esc(label)}</text>`;
  }).join("");
  return `<svg class="mini" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(r.aspect)}: ${STACKS.map((s) => `${s} ${valueText(r, s)}`).join(", ")} ${esc(r.unit ?? "")}">${bars}</svg>`;
}

function fmt(v: number, measure: string): string {
  if (measure === "p50") return v.toFixed(2);
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
}

/** Grouped bars: groups are flows, bars are implementations. */
function benchChart(measure: "roundTrips" | "bytesDown", title: string, unit: string): string {
  const flows = [...new Set(bench.rows.map((r) => r.flow))];
  const impls = ["REST", "GraphQL", "Rayfold (JSON)", "Rayfold (RB)"];
  const implCls: Record<string, string> = { REST: "s-rest", GraphQL: "s-gql", "Rayfold (JSON)": "s-rayfold-soft", "Rayfold (RB)": "s-rayfold" };
  const max = Math.max(...bench.rows.map((r) => r[measure]));
  const W = 640, H = 210, T = 20, B = 50, Lp = 46, plotH = H - T - B, groupW = (W - Lp - 10) / flows.length, barW = Math.min(28, (groupW - 24) / impls.length);
  let svg = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    const y = T + plotH - (plotH * i) / 4;
    svg += `<line x1="${Lp}" x2="${W - 10}" y1="${y}" y2="${y}" class="grid"/><text x="${Lp - 6}" y="${y + 4}" text-anchor="end" class="ax">${fmt(v, measure)}</text>`;
  }
  flows.forEach((flow, fi) => {
    const gx = Lp + fi * groupW + 12;
    impls.forEach((impl, ii) => {
      const row = bench.rows.find((r) => r.flow === flow && r.impl === impl);
      if (!row) return;
      const v = row[measure];
      const h = Math.max(v === 0 ? 0 : 3, (plotH * v) / max);
      const x = gx + ii * (barW + 2);
      const y = T + plotH - h;
      svg += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" class="bar ${implCls[impl]}"><title>${esc(flow)} / ${esc(impl)}: ${fmt(v, measure)} ${esc(unit)}</title></rect>`;
      if (impl === "Rayfold (RB)" || impl === "REST") svg += `<text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" class="val">${fmt(v, measure)}</text>`;
    });
    svg += `<text x="${gx + (impls.length * (barW + 2)) / 2}" y="${H - B + 18}" text-anchor="middle" class="ax">${esc(flow.replace(/^\d+\.\s*/, "").slice(0, 28))}${flow.length > 32 ? "..." : ""}</text>`;
  });
  return `<figure class="bench"><figcaption><strong>${esc(title)}</strong> <span class="muted">${esc(unit)}, fewer is better</span></figcaption><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(title)} per flow and implementation">${svg}</svg></figure>`;
}

// ------------------------------------------------------------------ recorded exchanges
const REASON: Record<number, string> = { 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 412: "Precondition Failed", 413: "Content Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Content", 429: "Too Many Requests", 431: "Request Header Fields Too Large" };
const MAX_LINES = 16;

/** Bodies are JSON, NDJSON frames (one per line) or an RB note followed by the decoded JSON. */
function pretty(body: string): { head: string; full: string; cut: boolean } {
  const t = body.trim();
  let text = t;
  const rb = /^(RB[^\n]*shown decoded:)\n([\s\S]*)$/.exec(t);
  if (rb) text = `${rb[1]}\n${rb[2]!.split("\n").map((l) => { try { return JSON.stringify(JSON.parse(l)); } catch { return l; } }).join("\n")}`;
  else {
    try {
      text = JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* NDJSON frames or plain text: keep one frame per line */
    }
  }
  const lines = text.split("\n");
  const cut = lines.length > MAX_LINES;
  return { head: cut ? `${lines.slice(0, MAX_LINES).join("\n")}\n... ${lines.length - MAX_LINES} more lines` : text, full: text, cut };
}

const headerLines = (h: Record<string, string>) => Object.entries(h).map(([k, v]) => `\n<span class="hk">${esc(k)}:</span> ${esc(v)}`).join("");

function exchangeHtml(e: Ex): string {
  const st = e.response.status;
  const stCls = st >= 400 ? "st-warn" : st >= 300 ? "st-muted" : "st-ok";
  const req = e.request.body !== undefined ? pretty(e.request.body) : null;
  const res = e.response.body ? pretty(e.response.body) : null;
  const more = [req?.cut ? `<details><summary>Full request body</summary><pre>${esc(req.full)}</pre></details>` : "", res?.cut ? `<details><summary>Full response body</summary><pre>${esc(res.full)}</pre></details>` : ""].join("");
  return `<div class="ex">${e.label ? `<p class="ex-label">${esc(e.label)}</p>` : ""}<pre class="req" aria-label="request"><span class="verb">${esc(e.request.method)}</span> ${esc(e.request.target)}${headerLines(e.request.headers)}${req ? `\n\n${esc(req.head)}` : ""}</pre><pre class="res" aria-label="response"><span class="${stCls}">${st} ${REASON[st] ?? ""}</span>${headerLines(e.response.headers)}${res ? `\n\n${esc(res.head)}` : ""}</pre>${more}</div>`;
}

/** Three columns (stacked on small screens). The first two exchanges show; the rest fold away. */
function stackCols(ex: ByStack, first = 2): string {
  return `<div class="stack-cols">${STACKS.map((st) => {
    const list = ex[st];
    const shown = list.slice(0, first).map(exchangeHtml).join("");
    const rest = list.length > first ? `<details class="more"><summary>${list.length - first} more ${list.length - first === 1 ? "request" : "requests"}</summary>${list.slice(first).map(exchangeHtml).join("")}</details>` : "";
    return `<section class="stack-col ${cls[st]}-col"><h4>${st} <span class="muted">${list.length} ${list.length === 1 ? "request" : "requests"}</span></h4>${list.length ? shown + rest : `<p class="ex-label">No HTTP request on this stack for this step.</p>`}</section>`;
  }).join("")}</div>`;
}

// ------------------------------------------------------------------ sections
const productPage = find("Product page");
const placePay = find("Place an order");
const payEx = placePay?.examples?.Rayfold[0];

const heroCompare = productPage?.examples
  ? `<div class="hero-compare" role="table" aria-label="One product page on three APIs">${STACKS.map((s) => {
      const list = productPage.examples![s];
      return `<div class="hc ${cls[s]}-col" role="row"><span class="hc-name" role="cell">${s}</span><span class="hc-num" role="cell">${list.length}<small>${list.length === 1 ? " request" : " requests"}</small></span><span class="hc-num" role="cell">${valueText(productPage, s)}<small> ${esc((productPage.unit ?? "").replace(/\s*\(.*\)$/, ""))}</small></span><code role="cell">${list.map((e) => `${esc(e.request.method)} ${esc(e.request.target.length > 34 ? e.request.target.slice(0, 33) + "..." : e.request.target)}`).join("<br>")}</code></div>`;
    }).join("")}</div>`
  : "";

const exampleCards = THEMES.map((t) => {
  const rows = e2e.rows.filter((r) => plainOf(r.aspect).theme === t.id);
  if (!rows.length) return "";
  return `<section class="theme" id="t-${t.id}"><div class="theme-head"><h3>${esc(t.title)}</h3><p class="muted">${esc(t.lede)}</p></div>${rows.map((r) => {
    const p = plainOf(r.aspect);
    const n = r.examples ? STACKS.reduce((k, s) => k + r.examples![s].length, 0) : 0;
    return `<article class="case ${r.verdict === "lead" ? "lead" : ""}">
  <div class="case-head"><h4>${esc(p.task)}</h4><span class="chip ${chipCls(r.verdict)}">${chipText(r.verdict)}</span></div>
  ${p.why ? `<p class="why">${esc(p.why)}</p>` : ""}
  <div class="case-body">
    <div class="measure"><p class="metric">Measured: ${esc(r.metric)}${r.unit ? ` <span class="muted">(${esc(r.unit)}${r.better ? `, ${r.better} is better` : ""})</span>` : ""}</p>${aspectChart(r)}</div>
    <dl class="cells">${STACKS.map((s) => `<div><dt class="${cls[s]}-ink">${s}</dt><dd>${esc(r[s])}</dd></div>`).join("")}</dl>
  </div>
  ${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
  ${r.examples && n ? `<details class="examples"><summary>See the real requests and responses (${n})</summary>${stackCols(r.examples)}</details>` : ""}
</article>`;
  }).join("\n")}</section>`;
}).join("\n");

const methodsHtml = methods.map((m) => `
<article class="method" id="m-${m.method}">
  <div class="method-head"><span class="pill">${esc(m.method)}</span><h3>${esc(m.title)}</h3><span class="chip ${chipCls(m.verdict)}">${chipText(m.verdict)}</span></div>
  <p class="op">${esc(m.operation)}</p>
  <div class="tablewrap facts"><table>
    <thead><tr><th scope="col">Measured</th><th scope="col">REST</th><th scope="col">GraphQL</th><th scope="col">Rayfold</th><th scope="col">Result</th></tr></thead>
    <tbody>${m.facts.map((f) => `<tr><td>${esc(f.metric)}${f.unit ? ` <span class="muted">(${esc(f.unit)})</span>` : ""}</td><td>${esc(f.REST)}</td><td>${esc(f.GraphQL)}</td><td class="rayfold-cell">${esc(f.Rayfold)}</td><td><span class="chip ${chipCls(f.verdict)}">${chipText(f.verdict)}</span></td></tr>`).join("")}</tbody>
  </table></div>
  <details class="examples"><summary>See the real requests and responses (${STACKS.reduce((k, s) => k + m.exchanges[s].length, 0)})</summary>${stackCols(m.exchanges)}</details>
  ${m.note ? `<p class="note">${esc(m.note)}</p>` : ""}
</article>`).join("\n");

const securityHtml = security
  ? (() => {
      const areas = [...new Set(security.attacks.map((a) => a.area))];
      const refused = security.attacks.filter((a) => a.result === "refused").length;
      return `<section id="security">
  <span class="eyebrow">Security</span>
  <h2>${refused} attacks tried, ${refused === security.attacks.length ? "every one refused" : `${refused} refused`}</h2>
  <p class="lede">Each row is an automated test that sends the attack to a running Rayfold server and checks that it fails safely. Next to it, a second test proves the defence does not also block honest use. No software can promise it will never be broken; what Rayfold can promise is that these defences are part of the protocol and are tested on every change.</p>
  ${areas.map((area) => `<div class="sec-area"><h3>${esc(area)}</h3><div class="tablewrap"><table>
    <colgroup><col class="c-result"><col class="c-attack"><col class="c-defence"><col class="c-guard"><col class="c-runtimes"></colgroup>
    <thead><tr><th scope="col">Result</th><th scope="col">Attack</th><th scope="col">Defence</th><th scope="col">Honest use still works</th><th scope="col">Runtimes</th></tr></thead>
    <tbody>${security.attacks.filter((a) => a.area === area).map((a) => `<tr><td><span class="chip ${a.result === "refused" ? "chip-ok" : "chip-behind"}">${a.result === "refused" ? "refused" : esc(a.result)}</span></td><td>${esc(a.attack)}${a.exchange ? `<details class="sec-ex"><summary>request and response</summary>${exchangeHtml(a.exchange)}</details>` : ""}</td><td>${esc(a.defence)}</td><td>${esc(a.guard)}</td><td>${esc(a.runtimes.join(", "))}</td></tr>`).join("")}</tbody>
  </table></div></div>`).join("")}
</section>`;
    })()
  : "";

/** One measured comparison as a card: the plain task, the chart, what each stack did, and the recorded exchanges. */
function caseCard(r: Row, task: string, why: string): string {
  const n = r.examples ? STACKS.reduce((k, st) => k + r.examples![st].length, 0) : 0;
  return `<article class="case ${r.verdict === "lead" ? "lead" : ""}">
  <div class="case-head"><h4>${esc(task)}</h4><span class="chip ${chipCls(r.verdict)}">${chipText(r.verdict)}</span></div>
  ${why ? `<p class="why">${esc(why)}</p>` : ""}
  <div class="case-body">
    <div class="measure"><p class="metric">Measured: ${esc(r.metric)}${r.unit ? ` <span class="muted">(${esc(r.unit)}${r.better ? `, ${r.better} is better` : ""})</span>` : ""}</p>${aspectChart(r)}</div>
    <dl class="cells">${STACKS.map((st) => `<div><dt class="${cls[st]}-ink">${st}</dt><dd>${esc(r[st])}</dd></div>`).join("")}</dl>
  </div>
  ${r.note ? `<p class="note">${esc(r.note)}</p>` : ""}
  ${r.examples && n ? `<details class="examples"><summary>See the real requests and responses (${n})</summary>${stackCols(r.examples)}</details>` : ""}
</article>`;
}

const realdataHtml = realdata
  ? `<section id="realdata">
  <span class="eyebrow">Real data</span>
  <h2>${realdata.dataset?.books ? `${realdata.dataset.books.toLocaleString("en-US")} real books` : "Real data"}, the same answers from every API</h2>
  <p class="lede">The same three servers, loaded with the full Project Gutenberg catalogue${realdata.dataset?.authors ? ` (${realdata.dataset.books?.toLocaleString("en-US")} books by ${realdata.dataset.authors.toLocaleString("en-US")} authors${realdata.dataset.retrieved ? `, retrieved ${esc(realdata.dataset.retrieved)}` : ""})` : ""}. Every answer below was checked against the catalogue itself, not against any of the servers, and all three had to agree.</p>
  ${realdata.dataset?.note ? `<details style="margin-top:8px"><summary>What is real and what is the store's own</summary><p class="note" style="margin-top:6px">${esc(realdata.dataset.note)}</p></details>` : ""}
  <div class="theme" style="margin-top:14px">${realdata.rows.map((r) => caseCard(r, r.aspect, "")).join("\n")}</div>
  <p class="caption" style="margin-top:10px">Catalogue data from Project Gutenberg (gutenberg.org). Project Gutenberg is not affiliated with Rayfold.</p>
</section>`
  : "";

const workspaceHtml = workspace
  ? (() => {
      const d = workspace.dataset;
      const n = (k: string) => (d[k] ?? 0).toLocaleString("en-US");
      return `<section id="workspace">
  <span class="eyebrow">A bigger example</span>
  <h2>A whole issue tracker, built three ways</h2>
  <p class="lede">A bookstore is a small API. This is the opposite: a multi-tenant issue tracker with ${n("issues")} issues, ${n("comments")} comments and ${n("activity")} activity entries across ${n("orgs")} organisations, ${n("projects")} projects and ${n("sprints")} sprints. It has the things that make an API hard: boards with a page per column, sub-issues, labels, versions, a feed holding four kinds of entry, search across three kinds of thing, per-tenant and per-field permissions, bulk writes and live updates. The same domain was built as REST, as GraphQL (with and without DataLoader) and as Rayfold, and every scenario below ran against all three over real HTTP, checking that they agree before measuring what they cost.</p>
  <p class="lede">Rayfold was ahead on <strong>${wsLead} of ${wsRows.length}</strong>${wsTie ? `, level on ${wsTie}` : ""} and behind on ${wsBehind ? plural(wsBehind, "one", `${wsBehind}`) : "none"}.</p>
  <div class="theme" style="margin-top:14px">${wsRows.map((r) => caseCard(r, r.aspect, "")).join("")}</div>
  <p class="caption" style="margin-top:10px">The domain is in <code>examples/workspace-ts</code>; the scenarios are <code>e2e/workspace.test.ts</code>. Every number here is produced by that test run, not written by hand.</p>
</section>`;
    })()
  : "";

const shortUA = (ua: string) => {
  const chrome = /Chrome\/(\d+)/.exec(ua)?.[1];
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return chrome ? `Chrome ${chrome}${os ? ` on ${os}` : ""}` : ua;
};
const browserHtml = browserRun
  ? `<section id="browser">
  <span class="eyebrow">Real browser</span>
  <h2>Tested in a real browser, against real data</h2>
  <p class="lede">${esc(browserRun.how)} ${esc(browserRun.dataset)}</p>
  <p class="caption">${esc(shortUA(browserRun.browser))}, ${esc(browserRun.at.slice(0, 10))}. The app is in <code>examples/bookstore-web</code>; run it with <code>npm run demo</code>.</p>
  <div class="two" style="margin-top:16px">
    <div><h3>What a customer did</h3><ol class="steps">${browserRun.flows.map((f) => `<li><strong>${esc(f.step)}.</strong> ${esc(f.result)}</li>`).join("")}</ol></div>
    <div><h3>Behind a reverse proxy</h3><ul>${browserRun.proxy.map((x) => `<li><strong>${esc(x.setup)}.</strong> ${esc(x.result)}</li>`).join("")}</ul></div>
  </div>
  <h3 style="margin-top:20px">Another website tried to act as the customer</h3>
  <p>${esc(browserRun.crossSite.from)}</p>
  <div class="tablewrap" style="margin-top:10px"><table><thead><tr><th scope="col">Attempt</th><th scope="col">What that page could observe</th></tr></thead><tbody>${browserRun.crossSite.attempts.map((a) => `<tr><td>${esc(a.attempt)}</td><td>${esc(a.observed)}</td></tr>`).join("")}</tbody></table></div>
  <ul class="outcome">${browserRun.crossSite.outcome.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
  <h3 style="margin-top:18px">Found and fixed during this run</h3>
  <ul class="outcome">${browserRun.foundAndFixed.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
</section>`
  : "";

const scoreTable = `<table>
<thead><tr><th scope="col">Task</th><th scope="col">Measured</th><th scope="col">REST</th><th scope="col">GraphQL</th><th scope="col">Rayfold</th><th scope="col">Result</th></tr></thead>
<tbody>${e2e.rows.map((r) => `<tr><td>${esc(plainOf(r.aspect).task)}</td><td>${esc(r.metric)}${r.unit ? ` <span class="muted">(${esc(r.unit)})</span>` : ""}</td><td class="num-cell">${esc(valueText(r, "REST"))}</td><td class="num-cell">${esc(valueText(r, "GraphQL"))}</td><td class="num-cell rayfold-cell">${esc(valueText(r, "Rayfold"))}</td><td><span class="chip ${chipCls(r.verdict)}">${chipText(r.verdict)}</span></td></tr>`).join("")}</tbody>
</table>`;

const benchTable = `<table>
<thead><tr><th scope="col">Flow</th><th scope="col">Implementation</th><th scope="col">Round trips</th><th scope="col">Bytes down</th><th scope="col">Bytes up</th><th scope="col">Median ms</th></tr></thead>
<tbody>${bench.rows.map((r) => `<tr><td>${esc(r.flow)}</td><td>${esc(r.impl)}</td><td class="num-cell">${r.roundTrips}</td><td class="num-cell">${r.bytesDown.toLocaleString("en-US")}</td><td class="num-cell">${r.bytesUp.toLocaleString("en-US")}</td><td class="num-cell">${r.p50.toFixed(2)}</td></tr>`).join("")}</tbody>
</table>`;

const html = `<title>Should You Use Rayfold?</title>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="description" content="A measured, side-by-side comparison of Rayfold with REST and GraphQL, with the real requests and responses behind every number.">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root {
  --ground: #f4f6f8; --surface: #ffffff; --ink: #141a21; --muted: #56616d; --rule: #d7dee6; --soft: #e9eef3;
  --rest: #1baf7a; --gql: #eb6834; --rayfold: #2a78d6; --rayfold-soft: #9ec5f4; --rayfold-ink: #1f5fae;
  --lead-bg: #eaf2fc; --good: #0a7d0a; --warn: #c98500; --warn-ink: #8a5a00; --on-accent: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #14181d; --surface: #1b2027; --ink: #eef2f6; --muted: #a4afbb; --rule: #2c343d; --soft: #232a33;
    --rest: #199e70; --gql: #d95926; --rayfold: #3987e5; --rayfold-soft: #2a5a95; --rayfold-ink: #8dbcf5;
    --lead-bg: #1c2a3d; --good: #3ac23a; --warn: #e0a232; --warn-ink: #f0b54a; --on-accent: #ffffff;
  }
}
:root[data-theme="dark"] {
  --ground: #14181d; --surface: #1b2027; --ink: #eef2f6; --muted: #a4afbb; --rule: #2c343d; --soft: #232a33;
  --rest: #199e70; --gql: #d95926; --rayfold: #3987e5; --rayfold-soft: #2a5a95; --rayfold-ink: #8dbcf5;
  --lead-bg: #1c2a3d; --good: #3ac23a; --warn: #e0a232; --warn-ink: #f0b54a; --on-accent: #ffffff;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 16px/1.6 "IBM Plex Sans", "Segoe UI", "Noto Sans", system-ui, sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 0 24px 72px; display: grid; gap: 56px; }
h1, h2, h3, h4, .hc-num, .tile .num { font-family: "Barlow Condensed", "Arial Narrow", "Noto Sans", sans-serif; letter-spacing: .01em; text-wrap: balance; }
h1 { font-size: clamp(44px, 7vw, 72px); font-weight: 700; line-height: .95; margin: 0; }
h2 { font-size: 32px; font-weight: 600; margin: 0 0 12px; line-height: 1.1; }
h3 { font-size: 23px; font-weight: 600; margin: 0; }
h4 { font-size: 20px; font-weight: 600; margin: 0; line-height: 1.2; }
p { max-width: 70ch; margin: 0; }
.lede { font-size: 17px; }
.eyebrow { display: block; font: 500 12px/1 "IBM Plex Mono", ui-monospace, monospace; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); margin-bottom: 10px; }
.muted { color: var(--muted); }
a { color: var(--rayfold-ink); }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--rayfold); outline-offset: 2px; border-radius: 3px; }
code { font: 13.5px "IBM Plex Mono", ui-monospace, monospace; background: var(--soft); padding: 1px 5px; border-radius: 4px; }

/* hero */
.hero { padding: 48px 0 8px; display: grid; gap: 22px; }
.hero .answer { font-size: 19px; max-width: 64ch; }
.hero .answer strong { color: var(--rayfold-ink); }
.hero-compare { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 760px) { .hero-compare { grid-template-columns: 1fr; } }
.hc { background: var(--surface); border: 1px solid var(--rule); border-top: 4px solid var(--rule); border-radius: 8px; padding: 14px 16px; display: grid; gap: 4px; align-content: start; }
.hc-name { font: 600 13px/1 "IBM Plex Mono", ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; }
.hc-num { font-size: 34px; font-weight: 700; line-height: 1.05; font-variant-numeric: tabular-nums; }
.hc-num small { font-size: 16px; font-weight: 500; color: var(--muted); }
.hc code { background: none; padding: 0; font-size: 12px; color: var(--muted); margin-top: 6px; line-height: 1.5; overflow-wrap: anywhere; }
.caption { font-size: 13px; color: var(--muted); }
.meta { display: flex; flex-wrap: wrap; gap: 6px 20px; font: 12.5px "IBM Plex Mono", ui-monospace, monospace; color: var(--muted); }
.legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 13px; }
.legend span::before { content: ""; display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.legend .l-rest::before { background: var(--rest); } .legend .l-gql::before { background: var(--gql); } .legend .l-rayfold::before { background: var(--rayfold); } .legend .l-rayfold-soft::before { background: var(--rayfold-soft); }

/* nav */
nav.toc { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--ground) 92%, transparent); backdrop-filter: blur(6px); border-bottom: 1px solid var(--rule); margin: 0 -24px; padding: 8px 24px; display: flex; flex-wrap: wrap; gap: 2px 6px; }
nav.toc a { font: 500 13px/1 "IBM Plex Mono", ui-monospace, monospace; text-decoration: none; padding: 8px 10px; border-radius: 6px; color: var(--ink); white-space: nowrap; }
nav.toc a:hover { background: var(--soft); }

/* tiles */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: 16px 18px; display: grid; gap: 4px; }
.tile .num { font-size: 42px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.tile .num small { font-size: 16px; font-weight: 500; color: var(--muted); margin-left: 4px; }
.tile .lbl { font-size: 13.5px; color: var(--muted); }

/* one-minute explainer */
.explain { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 24px; align-items: start; }
@media (max-width: 900px) { .explain { grid-template-columns: 1fr; } }
.points { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; }
.points li { display: grid; gap: 2px; }
.points strong { font-weight: 600; }
.kinds { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
.kinds div { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: 10px 12px; font-size: 14px; }
.kinds b { font-family: "IBM Plex Mono", ui-monospace, monospace; font-weight: 500; color: var(--rayfold-ink); }

/* decision */
.decide { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
@media (max-width: 900px) { .decide { grid-template-columns: 1fr; } }
.decide article { background: var(--surface); border: 1px solid var(--rule); border-top: 4px solid var(--rule); border-radius: 8px; padding: 18px; display: grid; gap: 10px; align-content: start; }
.decide ul { margin: 0; padding-left: 18px; display: grid; gap: 8px; font-size: 15px; }
.decide .d-rayfold { border-top-color: var(--rayfold); background: var(--lead-bg); }
.decide .d-rest { border-top-color: var(--rest); } .decide .d-gql { border-top-color: var(--gql); }
.status { margin-top: 16px; background: var(--surface); border: 1px solid var(--rule); border-left: 4px solid var(--warn); border-radius: 8px; padding: 16px 18px; display: grid; gap: 8px; }
.status ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 15px; }

/* examples */
.theme { display: grid; gap: 14px; scroll-margin-top: 60px; }
.theme + .theme { margin-top: 26px; }
.theme-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; border-bottom: 2px solid var(--ink); padding-bottom: 6px; }
.case { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: 18px; display: grid; gap: 10px; }
.case.lead { border-left: 4px solid var(--rayfold); }
.case-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.why { font-size: 15px; color: var(--muted); }
.case-body { display: grid; grid-template-columns: 290px minmax(0, 1fr); gap: 20px; align-items: start; }
@media (max-width: 760px) { .case-body { grid-template-columns: 1fr; } }
.metric { font-size: 13.5px; margin-bottom: 6px; }
.cells { margin: 0; display: grid; gap: 7px; font-size: 14.5px; }
.cells div { display: grid; grid-template-columns: 76px 1fr; gap: 10px; }
.cells dt { font: 500 12.5px/1.7 "IBM Plex Mono", ui-monospace, monospace; } .cells dd { margin: 0; }
.s-rest-ink { color: var(--rest); } .s-gql-ink { color: var(--gql); } .s-rayfold-ink { color: var(--rayfold-ink); }
.note { font-size: 13.5px; color: var(--muted); }
.chip { font: 500 11px/1 "IBM Plex Mono", ui-monospace, monospace; text-transform: uppercase; letter-spacing: .08em; padding: 6px 9px; border-radius: 999px; white-space: nowrap; }
.chip-rayfold { background: var(--rayfold); color: var(--on-accent); } .chip-tie { background: var(--soft); color: var(--muted); } .chip-behind { background: var(--warn); color: #1b1300; } .chip-ok { background: var(--good); color: var(--on-accent); }
details.examples > summary, details.more > summary, .sec-ex summary { cursor: pointer; font-size: 14px; color: var(--rayfold-ink); font-weight: 500; }
details.examples > .stack-cols { margin-top: 12px; }
.stack-cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
@media (max-width: 980px) { .stack-cols { grid-template-columns: 1fr; } }
.stack-col { border-top: 3px solid var(--rule); padding-top: 8px; display: grid; gap: 10px; align-content: start; min-width: 0; }
.s-rest-col { border-top-color: var(--rest); } .s-gql-col { border-top-color: var(--gql); } .s-rayfold-col { border-top-color: var(--rayfold); }
.stack-col h4 { font-size: 17px; }
.ex { display: grid; gap: 4px; min-width: 0; }
.ex-label { font-size: 12.5px; color: var(--muted); }
.ex pre { margin: 0; font: 11.5px/1.5 "IBM Plex Mono", ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--soft); border-radius: 6px; padding: 8px 10px; color: var(--ink); max-height: 420px; overflow: auto; }
.ex pre.res { background: var(--ground); border: 1px solid var(--rule); }
.ex details summary { font-size: 12px; color: var(--muted); cursor: pointer; }
.hk { color: var(--muted); }
.verb { font-weight: 600; color: var(--rayfold-ink); }
.st-ok { color: var(--good); font-weight: 600; } .st-warn { color: var(--warn-ink); font-weight: 600; } .st-muted { color: var(--muted); font-weight: 600; }
svg .bar { stroke: var(--surface); stroke-width: 2px; }
svg .s-rest { fill: var(--rest); } svg .s-gql { fill: var(--gql); } svg .s-rayfold { fill: var(--rayfold); } svg .s-rayfold-soft { fill: var(--rayfold-soft); }
svg .ax { font: 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--muted); }
svg .val { font: 500 11px "IBM Plex Mono", ui-monospace, monospace; fill: var(--ink); }
svg .grid { stroke: var(--rule); stroke-width: 1; }
svg.mini { max-width: 100%; height: auto; }

/* methods */
.method-nav { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 18px; }
.method-nav a { font: 500 13px/1 "IBM Plex Mono", ui-monospace, monospace; text-decoration: none; padding: 8px 11px; border: 1px solid var(--rule); border-radius: 6px; color: var(--ink); background: var(--surface); }
.methods { display: grid; gap: 22px; }
.method { background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; padding: 18px; display: grid; gap: 12px; scroll-margin-top: 60px; }
.method-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.method-head .chip { margin-left: auto; }
.pill { font: 600 13px/1 "IBM Plex Mono", ui-monospace, monospace; padding: 7px 10px; border-radius: 6px; letter-spacing: .04em; background: var(--ink); color: var(--surface); }
.facts td:first-child { width: 28%; }

/* tables, charts */
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
figure.bench { margin: 0; background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; padding: 14px; }
figure.bench figcaption { margin-bottom: 6px; font-size: 14px; }
.tablewrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { text-align: left; vertical-align: top; padding: 9px 11px; border-bottom: 1px solid var(--rule); }
th { font: 500 11px/1.4 "IBM Plex Mono", ui-monospace, monospace; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); background: var(--soft); }
td.rayfold-cell { background: var(--lead-bg); }
td.num-cell { font-variant-numeric: tabular-nums; white-space: nowrap; }
.sec-area { display: grid; gap: 10px; margin-top: 18px; }
.sec-area table { table-layout: fixed; min-width: 760px; }
.sec-area .c-result { width: 96px; } .sec-area .c-attack { width: 32%; } .sec-area .c-defence { width: 32%; } .sec-area .c-runtimes { width: 108px; }
main > section[id], main > header { scroll-margin-top: 64px; }

/* method, glossary */
.two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }
@media (max-width: 860px) { .two { grid-template-columns: 1fr; } }
.two ul { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 6px; font-size: 15px; }
.two ol.steps { margin: 8px 0 0; padding-left: 20px; display: grid; gap: 8px; font-size: 15px; }
ul.outcome { margin: 10px 0 0; padding-left: 18px; display: grid; gap: 6px; font-size: 15px; }
.glossary { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px 24px; }
.glossary div { border-top: 1px solid var(--rule); padding-top: 8px; }
.glossary dt { font-weight: 600; } .glossary dd { margin: 2px 0 0; font-size: 14.5px; color: var(--muted); }
footer { font-size: 13px; color: var(--muted); border-top: 1px solid var(--rule); padding-top: 18px; }
@media (prefers-reduced-motion: no-preference) { html { scroll-behavior: smooth; } }
/* single-column grids size to the page, never to their widest content (long code lines, tables) */
main, .hero, .theme, .case, .method, .methods, .sec-area, .ex, .hc, .stack-col, .decide article { grid-template-columns: minmax(0, 1fr); }
</style>
<main>
<header class="hero">
  <span class="eyebrow">A measured comparison of Rayfold, REST and GraphQL</span>
  <h1>Should you use Rayfold?</h1>
  <p class="answer"><strong>Rayfold is a way for an app to talk to its server</strong> - the job REST and GraphQL do today. The same online bookstore was built all three ways and tested for real. Rayfold was ahead on <strong>${led} of ${e2e.rows.length}</strong> everyday tasks${tied ? `, level on ${tied}` : ""}${behind ? ` and behind on ${behind}` : ""}, and on <strong>${mLead} of ${methods.length}</strong> HTTP methods.${realdata ? ` On the full Project Gutenberg catalogue (${(realdata.dataset?.books ?? 0).toLocaleString("en-US")} real books)${rdBehind ? ` the picture is more mixed: Rayfold was ahead on ${rdLead}, level on ${rdTie} and behind on ${plural(rdBehind, "task", "tasks")}, all shown below.` : ` Rayfold was ahead on ${rdLead} of ${realdata.rows.length} tasks${rdTie ? ` and level on ${rdTie}` : ""}, and behind on none; all are shown below.`}` : ""}${workspace ? ` A second, much larger example, a multi-tenant issue tracker with ${(workspace.dataset["issues"] ?? 0).toLocaleString("en-US")} issues, was built the same three ways: Rayfold was ahead on ${wsLead} of ${wsRows.length} scenarios${wsTie ? `, level on ${wsTie}` : ""} and behind on ${wsBehind ? String(wsBehind) : "none"}.` : ""} Use it if your screens combine related data, you need live updates, or AI assistants will call your API. Be aware that Rayfold is new: version ${version} is published and its core is frozen, but no one runs it in production yet. New to any of this? <a href="#start">Start with the plain-language section</a>, which explains what is being compared before any numbers appear.</p>
  ${heroCompare}
  <p class="caption">One product page (a book, its author and three reviews), loaded from each API. The code lines are the actual requests. Measured: ${esc(productPage?.metric ?? "")}.</p>
  <div class="legend"><span class="l-rest">REST: resources and URLs, with ETags, Idempotency-Key and SSE</span><span class="l-gql">GraphQL: one query language, with DataLoader batching and subscriptions</span><span class="l-rayfold">Rayfold</span></div>
</header>

<nav class="toc" aria-label="Sections"><a href="#start">Start here</a><a href="#one-minute">What Rayfold is</a><a href="#why">Why it comes out ahead</a><a href="#demos">See it work</a><a href="#decide">Choosing</a><a href="#examples">Examples</a><a href="#methods">HTTP methods</a>${realdata ? `<a href="#realdata">Real data</a>` : ""}${workspace ? `<a href="#workspace">Issue tracker</a>` : ""}${browserRun ? `<a href="#browser">Real browser</a>` : ""}${security ? `<a href="#security">Security</a>` : ""}<a href="#numbers">All numbers</a><a href="#how">How it was measured</a><a href="#glossary">Glossary</a></nav>

<section aria-label="Summary">
  <div class="tiles">
    <div class="tile"><span class="num">${led}<small>/ ${e2e.rows.length}</small></span><span class="lbl">tasks where Rayfold was ahead</span></div>
    <div class="tile"><span class="num">${mLead}<small>/ ${methods.length}</small></span><span class="lbl">HTTP methods where Rayfold was ahead${fBehind ? ` (behind on ${fBehind} measured facts)` : ", behind on none of " + methodFacts.length + " measured facts"}</span></div>
    <div class="tile"><span class="num">${rtRayfold}<small>vs ${rtRest} and ${rtGql}</small></span><span class="lbl">network round trips for three common flows: Rayfold vs REST and GraphQL</span></div>
    <div class="tile"><span class="num">${Math.round((bRb / bGql) * 100)}<small>%</small></span><span class="lbl">bytes Rayfold's binary encoding moves, compared with GraphQL (${Math.round((bJson / bGql) * 100)}% with JSON)</span></div>
    ${realdata ? `<div class="tile"><span class="num">${rdLead}<small>/ ${realdata.rows.length}</small></span><span class="lbl">real-data tasks where Rayfold was ahead (${rdTie} level, ${rdBehind} behind)</span></div>` : ""}
    ${workspace ? `<div class="tile"><span class="num">${wsLead}<small>/ ${wsRows.length}</small></span><span class="lbl">scenarios where Rayfold was ahead on the large example, an issue tracker (${wsTie} level, ${wsBehind} behind)</span></div>` : ""}
  </div>
</section>

<section id="start">
  <span class="eyebrow">Start here</span>
  <h2>What this page is comparing, in plain words</h2>
  <p class="lede">Every app you use - a shop, a chat, a bank - is a screen that asks a server for data and tells it
  about changes. The rules for that conversation are called an <strong>API</strong>. This page compares three sets of
  rules doing the same job. The job never changes: draw one product page, which needs a book, the author who wrote it,
  and its first three reviews.</p>
  <div class="decide">
    <article class="d-rest"><h3>REST, the usual way</h3>
      <p>One web address per thing. <code>/books/b1</code> is the book, <code>/authors/a1</code> is its author,
      <code>/reviews?bookId=b1</code> its reviews.</p>
      <ul>
        <li>Simple, and every browser, proxy and CDN already understands it.</li>
        <li>But one screen needs three addresses, so it takes three trips over the network, and the app waits for each.</li>
        <li>And each answer arrives whole, whether the screen needed all of those fields or not.</li>
      </ul></article>
    <article class="d-gql"><h3>GraphQL, the answer to that</h3>
      <p>One address for everything. The app writes a query naming exactly the fields it wants, and gets exactly those
      back, in one trip.</p>
      <ul>
        <li>No wasted trips and no wasted fields.</li>
        <li>Calls go to one address and are POSTs by default, which shared caches and CDNs skip. Persisted queries can put reads behind a GET so a CDN can store them; it is a setup step each team makes, not the default.</li>
        <li>And the things a server must get right anyway - safe retries, who may read what, how expensive a call may be - are left to libraries, conventions and code review.</li>
      </ul></article>
    <article class="d-rayfold"><h3>Rayfold, what is measured here</h3>
      <p>The app names the fields it wants, as in GraphQL, and several steps travel in one request - a later step may
      use an earlier step's result.</p>
      <ul>
        <li>A write comes back saying exactly what changed, so screens already open correct themselves instead of reloading.</li>
        <li>Permissions, cost limits and caching are written in the schema itself, and enforced on every way in.</li>
        <li>Reads stay ordinary HTTP, so ETags, shared caches and CDNs keep working.</li>
      </ul></article>
  </div>
  <p class="caption">The three coloured cards at the top of this page are that product page, loaded from each of these.
  Everything below measures the same kind of everyday task, always against all three.</p>
</section>

<section id="one-minute" class="explain">
  <div>
    <span class="eyebrow">Rayfold in one minute</span>
    <h2>One request per screen, with the safety rules in the contract</h2>
    <ul class="points">
      <li><strong>You ask for exactly the fields you need.</strong><span class="muted">A shape such as <code>{ title author { name } }</code>, like GraphQL. With no shape, you get a sensible default view, so a plain curl call works.</span></li>
      <li><strong>Several steps travel in one request.</strong><span class="muted">A later step can use an earlier step's result, as in the example on the right: place an order, then pay for it, in one round trip.</span></li>
      <li><strong>Writes are safe to retry.</strong><span class="muted">Every write carries an idempotency key. If the network fails and the app sends it again, the server answers with the first result.</span></li>
      <li><strong>Screens stay correct after a write.</strong><span class="muted">Every write returns patches, so every cached screen that shows the changed data updates without reloading.</span></li>
      <li><strong>Rules live in the schema.</strong><span class="muted">Permissions, value ranges, cost limits and caching are declared once and enforced on every path, including live updates and AI tools.</span></li>
      <li><strong>It is still plain HTTP.</strong><span class="muted">GET, POST, PUT, PATCH, DELETE and QUERY all work, with ETags and shared caches. JSON always works; the binary encoding is optional.</span></li>
    </ul>
    <div class="kinds"><div><b>query</b> reads data; can be cached and made live</div><div><b>command</b> changes data; retry-safe, typed errors, patches</div><div><b>stream</b> sends a sequence of items</div><div><b>event</b> a fact others can subscribe to</div></div>
  </div>
  <div>
    ${payEx ? `<p class="ex-label" style="margin-bottom:6px">A real Rayfold request from the tests: place an order for a book, then pay for it using the new order's id (<code>$ref</code>), in one round trip.</p>${exchangeHtml({ request: payEx.request, response: payEx.response })}` : ""}
  </div>
</section>

<section id="why">
  <span class="eyebrow">Why it comes out ahead</span>
  <h2>Five differences, and what each one costs the others</h2>
  <p class="lede">None of these is a trick of the benchmark. Each is a structural choice, and each produces a measured
  difference in the sections below.</p>
  <ul class="points">
    <li><strong>One request per screen, not one per thing.</strong><span class="muted">Several operations travel in one
      batch, and a later one can use an earlier one's result, so placing an order and reading it back is a single trip.
      Across the three benchmark flows: ${rtRest} round trips over REST, ${rtGql} over GraphQL, ${rtRayfold} over
      Rayfold. On a phone far from the server, each trip saved is tens of milliseconds the user does not wait.</span></li>
    <li><strong>Related data is loaded in batches, by default.</strong><span class="muted">A resolver is handed the
      whole level at once, so a list of twenty books costs one author lookup rather than twenty. GraphQL can do this,
      but only with a loader written and wired by hand for each relation; in Rayfold there is no other shape to
      write, so the slow version cannot be reached by accident.</span></li>
    <li><strong>A write says what it changed.</strong><span class="muted">Every write returns patches - small
      statements such as "this book now has stock 3" - so open screens correct themselves. The others report that
      something changed and leave the client to fetch the whole screen again, which is the difference between sending
      one changed row and re-sending an entire board.</span></li>
    <li><strong>The rules are part of the contract.</strong><span class="muted">Who may read a field, how expensive a
      call may be, what may be cached and for how long, and that a retried write must not run twice: all declared in
      the schema and enforced on every way in - batches, REST-style routes, live updates and AI tools alike - instead
      of being remembered in each handler.</span></li>
    <li><strong>It is still plain HTTP.</strong><span class="muted">Reads are ordinary GETs with ETags, so a shared
      cache or a CDN can answer them; the binary encoding is optional and moves ${Math.round((bRb / bGql) * 100)}% of
      GraphQL's bytes, while JSON always works from curl. Nothing here requires a new network stack.</span></li>
  </ul>
</section>

${demosHtml}

<section id="decide">
  <span class="eyebrow">Choosing</span>
  <h2>Which one fits your project?</h2>
  <div class="decide">
    <article class="d-rayfold"><h3>Choose Rayfold if</h3><ul>
      <li>Your screens combine related data (products with authors and reviews, orders with items) and you want one request per screen.</li>
      <li>You want HTTP caching and CDNs to work for those combined screens.</li>
      <li>You need live updates without running a second system.</li>
      <li>AI assistants will call your API and need typed tools and dry runs.</li>
      <li>You want permissions, limits and retry safety enforced by the contract, not remembered in each handler.</li>
      <li>You can accept being an early adopter (see below).</li>
    </ul></article>
    <article class="d-rest"><h3>Stay with REST if</h3><ul>
      <li>Your API is simple: a few resources, few links between them.</li>
      <li>Many outside developers use it and expect plain REST.</li>
      <li>You need the widest support from proxies, gateways and tools today.</li>
      <li>Note: Rayfold can also serve REST-style routes (<code>GET /books/{id}</code>) from the same schema, so moving later can be gradual.</li>
    </ul></article>
    <article class="d-gql"><h3>Stay with GraphQL if</h3><ul>
      <li>You already run GraphQL well, with federation, code generation and trained teams.</li>
      <li>You depend on its large ecosystem, such as Apollo, Relay and IDE tooling.</li>
      <li>You are content to configure persisted queries, cache plugins and retry conventions yourself, or you do not need them.</li>
    </ul></article>
  </div>
  <div class="status">
    <h3>Before you decide: Rayfold's current status</h3>
    <ul>
      <li>Rayfold Core 0.1 (the batch envelope, frames, shapes, errors, permissions, caching and evolution rules) is frozen with the 0.1.0 release: it changes only by errata that no conforming server fails. The live updates, binary encoding, AI bridge and REST-route extensions are drafts and may still change; a server says which it serves in its manifest.</li>
      <li>There are two reference implementations, TypeScript and Kotlin, both complete: batches, live queries over HTTP and WebSocket, the binary encoding, AI tools and REST routes. They produce identical frames for every conformance case.</li>
      <li>The tools a working day needs are there: an explorer served next to the endpoint, a language server so editors underline a broken schema as you type, a mock server that answers from the schema before any resolver exists, importers from an OpenAPI document or a GraphQL SDL, result types that follow the shape you asked for, and a build-time check that every operation and every field taking arguments is actually wired to a resolver.</li>
      <li>Version ${version} is published: twelve npm packages and seven JVM artifacts on Maven Central, with the documentation at rayfold.dev. What is young is the use: no one runs Rayfold in production yet, and it has no ecosystem beside these packages.</li>
      <li>All numbers on this page come from automated tests on one computer, not from production traffic. The next section shows every request, so you can judge them yourself.</li>
    </ul>
  </div>
</section>

<section id="examples">
  <span class="eyebrow">Examples</span>
  <h2>${e2e.rows.length} everyday tasks, built three ways</h2>
  <p class="lede">Each card is one automated test that ran against all three APIs. The bars show what was measured; the text explains each result. Open a card's requests to see exactly what each API sent and received, using real data: ${CATALOGUE_SIZE.books} real books by ${CATALOGUE_SIZE.authors} authors, with ${CATALOGUE_SIZE.reviews} reviews.</p>
  <div style="margin-top:22px">${exampleCards}</div>
</section>

<section id="methods">
  <span class="eyebrow">HTTP methods</span>
  <h2>Every HTTP method, side by side</h2>
  <p class="lede">The same bookstore operation for each method, run against all three APIs. Rayfold answers REST-style routes through <code>@http</code> bindings and also shows its own batch format where that adds something.</p>
  <nav class="method-nav" aria-label="HTTP methods">${methods.map((m) => `<a href="#m-${m.method}">${esc(m.method)}</a>`).join("")}</nav>
  <div class="methods">${methodsHtml}</div>
</section>

${realdataHtml}

${workspaceHtml}

${browserHtml}

${securityHtml}

<section id="numbers">
  <span class="eyebrow">All numbers</span>
  <h2>Every measured result</h2>
  <div class="charts" style="margin:14px 0 18px">
    ${benchChart("roundTrips", "Round trips per flow", "requests")}
    ${benchChart("bytesDown", "Bytes downloaded per flow", "bytes")}
  </div>
  <div class="tablewrap">${scoreTable}</div>
  <details style="margin-top:12px"><summary>Benchmark table (${bench.rows.length} cells, ${bench.iterations} runs each)</summary><div class="tablewrap" style="margin-top:10px">${benchTable}</div></details>
</section>

<section id="how" class="two">
  <div>
    <span class="eyebrow">How it was measured</span>
    <h2>Same data, same tasks, real HTTP</h2>
    <ul>
      <li>One online bookstore with real titles, authors and reviews, built three times: REST, GraphQL (graphql-js) and Rayfold.</li>
      <li>The REST and GraphQL versions use the practices careful teams use: ETags, Idempotency-Key, DataLoader batching, server-sent events and subscriptions.</li>
      <li>Every test sends real HTTP requests to all three servers. A recorder saves each request and response; they are the examples on this page.</li>
      <li>Each result (ahead, level, behind) is calculated from the measured numbers, never written by hand.</li>
      ${realdata ? `<li>A second run loads the full Project Gutenberg catalogue into all three servers and checks every answer against the catalogue itself.</li>` : ""}
      ${browserRun ? `<li>A real Chrome browser used the demo app, attacked it from another site and reached it through a reverse proxy.</li>` : ""}
    </ul>
  </div>
  <div>
    <span class="eyebrow">Limits of this comparison</span>
    <h2>What these numbers do not show</h2>
    <ul>
      <li>All servers ran on one computer. Time differences under a millisecond say little; the request and byte counts are what matter.</li>
      <li>The REST and GraphQL versions were written by the same team as Rayfold. A skilled team could close some gaps with extra code; Rayfold's argument is that it should not have to.</li>
      <li>Ecosystem size, community support and years of production use are not measured here, and REST and GraphQL are far ahead on all three.</li>
    </ul>
  </div>
</section>

<section id="glossary">
  <span class="eyebrow">Glossary</span>
  <h2>Terms used on this page</h2>
  <dl class="glossary">${GLOSSARY.map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join("")}</dl>
</section>

<footer>
  <div class="meta"><span>Tests run ${esc(e2e.generatedAt.slice(0, 16).replace("T", " "))} UTC</span><span>Benchmark run ${esc(bench.generatedAt.slice(0, 16).replace("T", " "))} UTC</span><span>${esc(bench.node)}, local network</span>${security ? `<span>Security tests run ${esc(security.generatedAt.slice(0, 16).replace("T", " "))} UTC</span>` : ""}</div>
  <p style="margin-top:8px">Reproduce: <code>npm run e2e</code>, <code>npm run bench</code>, then <code>npx tsx e2e/report-html.ts</code>.</p>
</footer>
</main>
`;

writeFileSync(out, html);
console.log(`wrote ${out} (${e2e.rows.length} tasks, ${methods.length} methods, ${bench.rows.length} bench rows${security ? `, ${security.attacks.length} attacks` : ""})`);
