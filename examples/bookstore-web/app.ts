/**
 * The web demo's browser code: the real @rayfold/client over HTTP (compact frames, cacheable safe requests) and over
 * WebSocket for live stock. Every piece of catalogue text is rendered with textContent, never as HTML.
 */
import { RayfoldClient, RayfoldClientError, createFetchTransport, createWebSocketTransport } from "../../packages/client/src/index.ts";
import type { RayfoldSchemaIR } from "../../packages/schema/src/index.ts";

type Book = { id: string; title: string; author: { id: string; name: string } };
type Page<T> = { items: T[]; hasMore: boolean; cursor: string | null; total: number };
type BookDetail = { id: string; title: string; format: string; price: string; stock: number; author: { id: string; name: string; bio: string | null; books: Page<{ id: string; title: string }> } };
type Order = { id: string; status: string; total: string; items?: Array<{ qty: number; book: { id: string; title: string } }> };

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const el = (tag: string, text?: string, cls?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};

// Every HTTP request the client makes goes through here, so the page can show what the API costs.
const stats = { requests: 0, bytes: 0 };
const counting: typeof fetch = async (input, init) => {
  stats.requests++;
  const res = await fetch(input, init);
  void res.clone().arrayBuffer().then((b) => {
    stats.bytes += b.byteLength;
    $("#stats").textContent = `${stats.requests} HTTP requests, ${stats.bytes.toLocaleString("en-US")} bytes received`;
  });
  return res;
};
const log = (line: string) => {
  const li = el("li", `${new Date().toLocaleTimeString()}  ${line}`);
  $("#log").prepend(li);
};
const showError = (where: string, e: unknown) => {
  const msg = e instanceof RayfoldClientError ? `${e.type ?? e.code}: ${e.message}` : String(e);
  $("#error").textContent = `${where}: ${msg}`;
  log(`error in ${where}: ${msg}`);
};

const manifest = (await (await counting("/rayfold/manifest")).json()) as { schema: RayfoldSchemaIR };
const http = new RayfoldClient({ transport: createFetchTransport({ url: "/rayfold", fetch: counting }), schema: manifest.schema, client: "web-demo/0.1" });
const live = new RayfoldClient({ transport: createWebSocketTransport({ url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rayfold/ws` }), schema: manifest.schema, client: "web-demo/0.1" });

// ------------------------------------------------------------------ sign-in
async function refreshMe(): Promise<void> {
  const me = (await (await fetch("/me")).json()) as { id: string; role: string } | null;
  $("#who").textContent = me ? `Signed in as ${me.id} (${me.role})` : "Not signed in";
  document.body.dataset["signedIn"] = me ? "yes" : "no";
}
$("#login").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const name = $<HTMLInputElement>("#name").value;
  const res = await fetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  log(res.ok ? `signed in as ${name}` : "sign-in failed");
  await refreshMe();
  await loadOrders();
});

// ------------------------------------------------------------------ search
let lastQuery = "";
let cursor: string | null = null;
async function search(more = false): Promise<void> {
  $("#error").textContent = "";
  const q = $<HTMLInputElement>("#q").value.trim();
  if (!more) {
    lastQuery = q;
    cursor = null;
    $("#results").replaceChildren();
  }
  try {
    const page: Record<string, unknown> = { first: 20 };
    if (more && cursor) page["after"] = cursor;
    const started = performance.now();
    const res = await http.query<Page<Book>>("books", { filter: { titleContains: lastQuery }, page }, { shape: "{ items { id title author { id name } } hasMore cursor total }" });
    log(`search "${lastQuery}": ${res.items.length} of ${res.total.toLocaleString("en-US")} matches in ${Math.round(performance.now() - started)} ms`);
    $("#count").textContent = `${res.total.toLocaleString("en-US")} books match`;
    for (const b of res.items) {
      const li = el("li");
      const btn = el("button", b.title, "link");
      btn.dataset["id"] = b.id;
      btn.addEventListener("click", () => void openBook(b.id));
      li.append(btn, el("span", ` by ${b.author.name}`, "muted"));
      $("#results").append(li);
    }
    cursor = res.cursor;
    $<HTMLButtonElement>("#more").hidden = !res.hasMore;
  } catch (e) {
    showError("search", e);
  }
}
$("#search").addEventListener("submit", (ev) => {
  ev.preventDefault();
  void search();
});
$("#more").addEventListener("click", () => void search(true));

// ------------------------------------------------------------------ book page with live stock
let stopLive: (() => void) | undefined;
let current: string | undefined;
async function openBook(id: string): Promise<void> {
  $("#error").textContent = "";
  stopLive?.();
  current = id;
  try {
    const b = await http.query<BookDetail>("book", { id }, { shape: "{ id title format price stock author { id name bio books(page: { first: 8 }) { items { id title } total } } }" });
    $("#book").hidden = false;
    $("#title").textContent = b.title;
    $("#author").textContent = b.author.name;
    $("#bio").textContent = b.author.bio ?? "";
    $("#meta").textContent = `${b.format}, ${b.price === "0.00" ? "free" : b.price}`;
    $("#stock").textContent = b.stock.toLocaleString("en-US");
    const others = $("#others");
    others.replaceChildren();
    for (const o of b.author.books.items.filter((x) => x.id !== id)) {
      const btn = el("button", o.title, "link");
      btn.addEventListener("click", () => void openBook(o.id));
      others.append(el("li"));
      others.lastElementChild!.append(btn);
    }
    $("#others-count").textContent = `${b.author.books.total.toLocaleString("en-US")} books by this author in the catalogue`;
    stopLive = live.live<{ stock: number }>("book", { id }, { shape: "{ id stock }" }, (d, meta) => {
      $("#stock").textContent = d.stock.toLocaleString("en-US");
      if (!meta.initial) log(`live: stock of ${id} is now ${d.stock.toLocaleString("en-US")}`);
    });
    log(`opened ${id}`);
  } catch (e) {
    showError("book", e);
  }
}

// ------------------------------------------------------------------ orders
let lastOrder: string | undefined;
$("#buy").addEventListener("click", async () => {
  if (!current) return;
  try {
    const o = await http.command<Order>("placeOrder", { input: { lines: [{ bookId: current, qty: 1 }] } }, { shape: "{ id status total items { qty book { id title } } }" });
    lastOrder = o.id;
    log(`placed order ${o.id} (${o.status}, total ${o.total})`);
    await loadOrders();
  } catch (e) {
    showError("buy", e);
  }
});
$("#pay").addEventListener("click", async () => {
  if (!lastOrder) return;
  try {
    const o = await http.command<Order>("payOrder", { id: lastOrder }, { shape: "{ id status total }" });
    log(`paid order ${o.id} (${o.status})`);
    await loadOrders();
  } catch (e) {
    showError("pay", e);
  }
});
async function loadOrders(): Promise<void> {
  const list = $("#orders");
  list.replaceChildren();
  if (document.body.dataset["signedIn"] !== "yes") return;
  try {
    const page = await http.query<Page<Order>>("myOrders", { page: { first: 20 } }, { shape: "{ items { id status total } total }" });
    for (const o of page.items) list.append(el("li", `${o.id}: ${o.status}, total ${o.total}`));
  } catch (e) {
    showError("orders", e);
  }
}

await refreshMe();
await loadOrders();
$("#q").focus();
log(`ready: ${manifest.schema ? Object.keys(manifest.schema.ops).length : 0} operations from /rayfold/manifest`);
