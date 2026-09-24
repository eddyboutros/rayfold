import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpHandler, createRayfoldServer } from "@rayfold/server";
import { Signal } from "../../../e2e/wait.ts";
import { createExplorerHandler, explorerHtml, type ExplorerOptions } from "./index.ts";

let running: Server | undefined;

/** The handler in front of an application, as a server would mount it. */
async function start(opts: ExplorerOptions = {}): Promise<string> {
  const explorer = createExplorerHandler(opts);
  const server = createServer((req, res) => {
    if (explorer(req, res)) return;
    res.writeHead(404, { "content-type": "text/plain" }).end("the rest of the application");
  });
  running = server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(
  () =>
    new Promise<void>((r) => {
      if (!running) return r();
      running.closeAllConnections();
      running.close(() => r());
      running = undefined;
    }),
);

describe("the explorer page", () => {
  it("serves itself at its own path and leaves everything else alone", async () => {
    const base = await start();
    const page = await fetch(`${base}/rayfold/explorer`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toBe("no-store"); // never cached: it carries the endpoint it talks to
    const html = await page.text();
    expect(html).toContain('"endpoint":"/rayfold"');

    const elsewhere = await fetch(`${base}/rayfold`);
    expect(elsewhere.status).toBe(404);
    expect(await elsewhere.text()).toBe("the rest of the application");
  });

  it("takes the endpoint, the path and the title it is given", async () => {
    const base = await start({ endpoint: "/api", path: "/tools/explorer", title: "Acme API" });
    expect((await fetch(`${base}/rayfold/explorer`)).status).toBe(404);
    const html = await (await fetch(`${base}/tools/explorer`)).text();
    expect(html).toContain('"endpoint":"/api"');
    expect(html).toContain('"title":"Acme API"');
  });

  it("answers HEAD without a body and refuses anything but a read", async () => {
    const base = await start();
    const head = await fetch(`${base}/rayfold/explorer`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const post = await fetch(`${base}/rayfold/explorer`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("loads nothing from anywhere else, so it works behind a strict policy and offline", () => {
    const html = explorerHtml();
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\ssrc="(?!data:)/); // no script or image is fetched
  });

  it("is the page the JVM serves too, character for character", () => {
    // one page, two runtimes: `node scripts/sync-explorer.mjs` copies it across, and this fails if they drift
    const resource = readFileSync(
      new URL("../../../kotlin/rayfold-core/src/main/resources/dev/rayfold/core/explorer.html", import.meta.url),
      "utf8",
    );
    const config = JSON.stringify({ endpoint: "/rayfold", title: "Rayfold" }).replace(/</g, "\\u003c");
    expect(resource.replace("__RAYFOLD_EXPLORER_CONFIG__", config)).toBe(explorerHtml());
  });

  it("a title cannot break out of the configuration it is written into", () => {
    const html = explorerHtml({ title: "</script><script>alert(1)</script>" });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script>"); // escaped, so the browser reads it as text
  });

  it("a title with $ patterns in it is served as written (guard - a plain title too)", async () => {
    for (const title of ["Prices in $$ and $' here, $& and $`", "Acme API"]) {
      const base = await start({ title });
      const html = await (await fetch(`${base}/rayfold/explorer`)).text();
      const config = /id="config"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
      expect(JSON.parse(config ?? "null")).toEqual({ endpoint: "/rayfold", title });
      running?.closeAllConnections();
      await new Promise<void>((r) => running?.close(() => r()));
      running = undefined;
    }
  });
});

const SHOP = `
entity Book {
  id: ID
  title: String
  stock: Int
}
query book(id: ID): Book?
command restock(id: ID, qty: Int): Book @simulate
`;

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const opened: JSDOM[] = [];
afterEach(() => {
  for (const dom of opened.splice(0)) dom.window.close();
});

/**
 * The page's own script running in jsdom, against a real Rayfold server that serves both the page and the endpoint.
 * fetch, TextDecoder and streams are Node's, recorded on the way out; Math.random and Date.now are pinned so the
 * idempotency key and the timing line are exact.
 */
async function openExplorer(opts: { endpoint?: string; manifest?: "off" } = {}) {
  let stock = 3;
  const seen: Array<{ qty: number; simulate: boolean; viewer: unknown }> = [];
  const rayfold = createRayfoldServer({
    schema: SHOP,
    resolvers: {
      Query: { book: ({ id }: { id: string }) => (id === "b1" ? { id: "b1", title: "Dune", stock } : null) },
      Command: {
        restock: ({ qty }: { id: string; qty: number }, ctx) => {
          seen.push({ qty, simulate: ctx.simulate, viewer: ctx.viewer });
          const next = stock + qty;
          if (!ctx.simulate) stock = next;
          return { id: "b1", title: "Dune", stock: next };
        },
      },
    },
  });
  const endpoint = createHttpHandler(rayfold, {
    ...(opts.manifest ? { manifest: opts.manifest } : {}),
    viewer: (req) => (req.headers.authorization?.startsWith("Bearer ") ? { id: req.headers.authorization.slice(7) } : null),
  });
  const explorer = createExplorerHandler({ title: "Shop", ...(opts.endpoint ? { endpoint: opts.endpoint } : {}) });
  const server = createServer((req, res) => {
    if (explorer(req, res)) return;
    if (req.url?.startsWith("/rayfold")) return void endpoint(req, res);
    res.writeHead(404, { "content-type": "text/plain" }).end("the rest of the application");
  });
  running = server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const sent: Sent[] = [];
  const pageUrl = `${base}${opts.endpoint ?? "/rayfold"}/explorer`;
  const html = await (await fetch(pageUrl)).text();
  const dom = new JSDOM(html, {
    url: pageUrl,
    runScripts: "dangerously",
    beforeParse(window) {
      window.fetch = ((input: string, init: RequestInit = {}) => {
        const url = new URL(input, base).href;
        sent.push({ method: init.method ?? "GET", url, headers: { ...(init.headers as Record<string, string>) }, body: init.body === undefined ? undefined : JSON.parse(init.body as string) });
        return fetch(url, init);
      }) as never;
      (window as unknown as { TextDecoder: typeof TextDecoder }).TextDecoder = TextDecoder;
      window.Math.random = () => 0.5;
      window.Date.now = () => 0;
    },
  });
  opened.push(dom);
  const doc = dom.window.document;
  const changes = new Signal<null>();
  new dom.window.MutationObserver(() => changes.push(null)).observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
  const $ = <T extends Element = HTMLElement>(sel: string) => doc.querySelector(sel) as unknown as T;
  const click = (sel: string) => $(sel).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  return {
    base,
    doc,
    sent,
    seen,
    stock: () => stock,
    $,
    click,
    /** Resolves once `cond` holds, re-checked after every DOM change; bounded, so a page that never gets there fails. */
    until: (cond: () => boolean, label: string) => changes.until(() => cond(), label),
    /** What the output pane shows: each frame's class, its tag line and the frame it printed. */
    frames: () =>
      [...doc.querySelectorAll("#out .frame")].map((f) => ({ cls: f.className, tag: f.querySelector(".tag")?.textContent, frame: JSON.parse(f.querySelector("pre")?.textContent ?? "null") })),
    /** Sends what the editor holds and waits for the page to finish reading the response. */
    send: async () => {
      click("#send");
      await changes.until(() => !$<HTMLButtonElement>("#send").disabled, "the explorer finished sending");
    },
  };
}

describe("the explorer page script, against a real server", () => {
  it("reads the manifest, lists the operations and opens the first query with a request ready to send", async () => {
    const page = await openExplorer();
    await page.until(() => page.doc.querySelectorAll("button.op").length === 2, "operations listed");
    expect(page.sent).toEqual([{ method: "GET", url: `${page.base}/rayfold/manifest`, headers: {}, body: undefined }]);
    expect(page.$("#title").textContent).toBe("Shop");
    expect(page.$("#about").textContent).toMatch(/^rayfold 0\.1 · schema [0-9a-f]{12} · extensions /);
    expect([...page.doc.querySelectorAll("#ops > *")].map((n) => n.textContent)).toEqual(["queries", "bookBook?", "commands", "restockBook"]);
    expect(page.$("button.op.on").dataset.op).toBe("book");
    expect([...page.doc.querySelectorAll("#doc dt, #doc dd")].map((n) => n.textContent)).toEqual(["kind", "query", "returns", "Book?", "cost", "default", "policies", "none on the operation"]);
    expect(JSON.parse(page.$<HTMLTextAreaElement>("#req").value)).toEqual({ ops: [{ id: 1, op: "book", args: { id: "" }, shape: "{ id title stock }" }] });
    expect(page.$<HTMLInputElement>("#simulate").disabled).toBe(true); // a query has nothing to dry-run
    expect(page.$<HTMLInputElement>("#live").disabled).toBe(false);
  });

  it("sends the batch in the editor and renders each frame it reads back", async () => {
    const page = await openExplorer();
    await page.until(() => page.$("button.op.on") !== null, "first op shown");
    page.$<HTMLTextAreaElement>("#req").value = JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title stock }" }] });
    await page.send();
    expect(page.sent.slice(1).map(({ method, url, headers, body }) => ({ method, url, headers, body }))).toEqual([
      { method: "POST", url: `${page.base}/rayfold`, headers: { "content-type": "application/rayfold+json" }, body: { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title stock }" }] } },
    ]);
    expect(page.frames()).toEqual([{ cls: "frame data", tag: "data · op 1  cost 1", frame: { id: 1, data: { $type: "Book", id: "b1", title: "Dune", stock: 3 }, meta: { cost: 1 }, fin: true } }]);
    expect(page.$("#status").textContent).toBe("1 frame in 0 ms");
  });

  it("dry-runs a command when the box is ticked, so nothing is written", async () => {
    const page = await openExplorer();
    await page.until(() => page.$("button.op.on") !== null, "first op shown");
    page.click('button.op[data-op="restock"]');
    expect(page.$("button.op.on").dataset.op).toBe("restock");
    expect(page.$<HTMLInputElement>("#simulate").disabled).toBe(false);
    expect(page.$<HTMLInputElement>("#live").disabled).toBe(true);
    expect([...page.doc.querySelectorAll("#doc dt, #doc dd")].map((n) => n.textContent).slice(-2)).toEqual(["dry run", "allowed: tick it and nothing is written"]);
    const op = { id: 1, op: "restock", args: { id: "", qty: 0 }, shape: "{ id title stock }", key: "explorer-i000000000000000" };
    expect(JSON.parse(page.$<HTMLTextAreaElement>("#req").value)).toEqual({ ops: [op] });

    page.$<HTMLTextAreaElement>("#req").value = JSON.stringify({ ops: [{ ...op, args: { id: "b1", qty: 2 } }] });
    page.$<HTMLInputElement>("#simulate").checked = true;
    page.$<HTMLInputElement>("#token").value = "ada";
    await page.send();
    expect(page.sent.slice(1).map(({ headers, body }) => ({ headers, body }))).toEqual([
      {
        headers: { "content-type": "application/rayfold+json", authorization: "Bearer ada" },
        body: { ops: [{ ...op, args: { id: "b1", qty: 2 }, simulate: true }] },
      },
    ]);
    expect(page.seen).toEqual([{ qty: 2, simulate: true, viewer: { id: "ada" } }]);
    expect(page.stock()).toBe(3);
    expect(page.frames().map((f) => ({ cls: f.cls, tag: f.tag, ok: f.frame.ok }))).toEqual([{ cls: "frame ok", tag: "ok · op 1  cost 1", ok: { $type: "Book", id: "b1", title: "Dune", stock: 5 } }]);

    // guard: unticked, the same command goes without the flag and does write
    page.$<HTMLInputElement>("#simulate").checked = false;
    await page.send();
    expect(page.sent[2]?.body).toEqual({ ops: [{ ...op, args: { id: "b1", qty: 2 } }] });
    expect(page.seen[1]).toEqual({ qty: 2, simulate: false, viewer: { id: "ada" } });
    expect(page.stock()).toBe(5);
  });

  it("says so when nothing answers with a manifest where it was told the endpoint is", async () => {
    const page = await openExplorer({ endpoint: "/nowhere" });
    await page.until(() => page.$("#about").textContent !== "reading the manifest...", "manifest read attempted");
    expect(page.sent).toEqual([{ method: "GET", url: `${page.base}/nowhere/manifest`, headers: {}, body: undefined }]);
    expect(page.$("#about").textContent).toBe("no manifest at /nowhere/manifest");
    expect(page.doc.querySelectorAll("button.op").length).toBe(0);
  });

  it("says so when the server has its manifest turned off, rather than listing nothing under an undefined version", async () => {
    const page = await openExplorer({ manifest: "off" });
    await page.until(() => page.$("#about").textContent !== "reading the manifest...", "manifest read attempted");
    expect(page.sent).toEqual([{ method: "GET", url: `${page.base}/rayfold/manifest`, headers: {}, body: undefined }]);
    expect(page.$("#about").textContent).toBe("no manifest at /rayfold/manifest");
    expect(page.doc.querySelectorAll("button.op").length).toBe(0);
  });
});
