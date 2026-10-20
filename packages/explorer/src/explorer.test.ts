import { afterEach, describe, expect, it } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpHandler, createRayfoldServer, type Instrumentation, type Outcome } from "@rayfold/server";
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
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
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

  it("loads nothing from anywhere else, so it works offline and on a closed network", () => {
    const html = explorerHtml();
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\ssrc="(?!data:)/); // no script or image is fetched
    expect(html).not.toMatch(/<link\b/);
    expect(html.length).toBeLessThan(100_000);
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
entity Author {
  id: ID
  name: String
}
entity Book {
  id: ID
  title: String
  stock: Int
  author: Author?
  cost: Int? @allow(read: viewer.id == "ada")
}
union Hit = Book | Author
query book(id: ID): Book?
query search(text: String): [Hit]
command restock(id: ID, qty: Int): Book @simulate
`;

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface OpenOptions {
  endpoint?: string;
  manifest?: "off";
  /** Answers a POST to the endpoint instead of the Rayfold handler, as a proxy in front of it might. */
  intercept?: (req: IncomingMessage, res: ServerResponse) => void;
  /** What the browser already holds for this origin, as a page opened again would find it. */
  storage?: Record<string, string>;
  /** localStorage throws on every touch, as it does in some private windows. */
  storageThrows?: boolean;
}

const opened: JSDOM[] = [];
/** What a page threw: an exception in an event handler, or a promise of its own that was rejected and never handled. */
const thrown: string[] = [];
afterEach(() => {
  for (const dom of opened.splice(0)) dom.window.close();
  expect(thrown.splice(0), "the page threw").toEqual([]);
});

const DUNE = { id: "b1", title: "Dune", author: { id: "a1", name: "Frank Herbert" } };

/** A time of day on this machine's clock, as the page shows it: the page and the test share the time zone. */
const clock = (at: number) => [new Date(at).getHours(), new Date(at).getMinutes(), new Date(at).getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");

/**
 * The page's own script running in jsdom, against a real Rayfold server that serves both the page and the endpoint.
 * fetch, TextDecoder, AbortController and streams are Node's, recorded on the way out; Math.random and Date.now are
 * pinned so the idempotency key, the history times and the timing line are exact.
 */
async function openExplorer(opts: OpenOptions = {}) {
  let stock = 3;
  const seen: Array<{ qty: number; simulate: boolean; viewer: unknown }> = [];
  const outcomes = new Signal<{ name: string; outcome: Outcome }>();
  const instrumentation: Instrumentation = {
    op: async (info, run) => {
      const outcome = await run();
      outcomes.push({ name: info.name, outcome });
      return outcome;
    },
  };
  const rayfold = createRayfoldServer({
    schema: SHOP,
    instrumentation,
    resolvers: {
      Query: {
        book: ({ id }: { id: string }) => (id === "b1" ? { ...DUNE, stock } : null),
        search: () => [{ $type: "Book", ...DUNE, stock }, { $type: "Author", ...DUNE.author }],
      },
      Command: {
        restock: ({ qty }: { id: string; qty: number }, ctx) => {
          seen.push({ qty, simulate: ctx.simulate, viewer: ctx.viewer });
          const next = stock + qty;
          if (!ctx.simulate) stock = next;
          return { ...DUNE, stock: next };
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
    if (opts.intercept && req.method === "POST") return opts.intercept(req, res);
    if (req.url?.startsWith("/rayfold")) return void endpoint(req, res);
    res.writeHead(404, { "content-type": "text/plain" }).end("the rest of the application");
  });
  running = server;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const pageUrl = `${base}${opts.endpoint ?? "/rayfold"}/explorer`;
  const html = await (await fetch(pageUrl)).text();
  const sent: Sent[] = [];
  const copied: string[] = [];

  const load = (storage: Record<string, string>) => {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (e) => thrown.push(e.message));
    const dom = new JSDOM(html, {
      url: pageUrl,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.addEventListener("unhandledrejection", (e) => thrown.push(String((e as PromiseRejectionEvent).reason)));
        window.fetch = ((input: string, init: RequestInit = {}) => {
          const url = new URL(input, base).href;
          sent.push({ method: init.method ?? "GET", url, headers: { ...(init.headers as Record<string, string>) }, body: init.body === undefined ? undefined : JSON.parse(init.body as string) });
          return fetch(url, init);
        }) as never;
        const w = window as unknown as { TextDecoder: typeof TextDecoder; AbortController: typeof AbortController };
        w.TextDecoder = TextDecoder;
        w.AbortController = AbortController;
        window.Math.random = () => 0.5;
        window.Date.now = () => 0;
        Object.defineProperty(window.navigator, "clipboard", { value: { writeText: (s: string) => (copied.push(s), Promise.resolve()) } });
        if (opts.storageThrows) {
          Object.defineProperty(window, "localStorage", {
            get() {
              throw new window.DOMException("storage is off in this window", "SecurityError");
            },
          });
        } else for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
      },
    });
    opened.push(dom);
    return dom;
  };

  const page = (dom: JSDOM) => {
    const doc = dom.window.document;
    const changes = new Signal<null>();
    new dom.window.MutationObserver(() => changes.push(null)).observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
    const $ = <T extends Element = HTMLElement>(sel: string) => doc.querySelector(sel) as unknown as T;
    const all = (sel: string) => [...doc.querySelectorAll(sel)];
    const click = (sel: string | Element) => (typeof sel === "string" ? $(sel) : sel).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const until = (cond: () => boolean, label: string) => changes.until(() => cond(), label);
    const req = () => $<HTMLTextAreaElement>("#req");
    return {
      dom,
      doc,
      $,
      all,
      click,
      until,
      /** The page's own functions, as its script declared them. */
      fn: dom.window as unknown as Record<string, (...args: unknown[]) => unknown>,
      ready: () => until(() => $("button.op.on") !== null, "first op shown"),
      write: (value: string, caret = value.length) => {
        req().value = value;
        req().selectionStart = req().selectionEnd = caret;
        req().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      },
      key: (key: string, ctrlKey = false) => req().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true })),
      /** What the output pane shows: each frame's class, its tag line and the frame it printed. */
      frames: () => all("#out .frame").map((f) => ({ cls: f.className, tag: f.querySelector(".tag")?.textContent, text: f.querySelector("pre")?.textContent })),
      json: () => all("#out .frame pre").map((p) => JSON.parse(p.textContent ?? "null")),
      problems: () => all("#problems li").map((li) => li.textContent),
      suggestions: () => ($("#complete").hasAttribute("hidden") ? [] : all("#complete li").map((li) => li.firstChild?.textContent)),
      storage: () => Object.fromEntries(Object.entries(dom.window.localStorage)),
      /** Sends what the editor holds and waits for the page to finish reading the response. */
      send: async () => {
        click("#send");
        // the click shows "sending..." at once; the send is over when the button reads Send again
        expect($("#status").textContent).toBe("sending...");
        await until(() => $("#send").textContent === "Send" && $("#status").textContent !== "sending...", "the explorer finished sending");
      },
    };
  };

  const first = page(load(opts.storage ?? {}));
  return {
    ...first,
    base,
    sent,
    seen,
    copied,
    outcomes,
    stock: () => stock,
    /** The same page opened again in the same browser: what it kept in storage is there. */
    reopen: () => page(load(first.storage())),
  };
}

describe("the explorer page script, against a real server", () => {
  it("reads the manifest, lists the operations and opens the first query with a request ready to send", async () => {
    const page = await openExplorer();
    await page.until(() => page.doc.querySelectorAll("button.op").length === 3, "operations listed");
    expect(page.sent).toEqual([{ method: "GET", url: `${page.base}/rayfold/manifest`, headers: {}, body: undefined }]);
    expect(page.$("#title").textContent).toBe("Shop");
    expect(page.$("#about").textContent).toMatch(/^rayfold 0\.1 · schema [0-9a-f]{12} · extensions /);
    expect(page.all("#ops > *").map((n) => n.textContent)).toEqual(["queries", "bookBook?", "search[Hit]", "commands", "restockBook"]);
    expect(page.$("button.op.on").dataset.op).toBe("book");
    expect(page.all("#doc dt, #doc dd").map((n) => n.textContent)).toEqual(["kind", "query", "returns", "Book?", "cost", "default", "policies", "none on the operation"]);
    expect(JSON.parse(page.$<HTMLTextAreaElement>("#req").value)).toEqual({ ops: [{ id: 1, op: "book", args: { id: "" }, shape: "{ id title stock }" }] });
    expect(page.$<HTMLInputElement>("#simulate").disabled).toBe(true); // a query has nothing to dry-run
    expect(page.$<HTMLInputElement>("#live").disabled).toBe(false);
    expect(page.all("#tabs button").map((b) => b.textContent)).toEqual(["book", "+"]);
  });

  it("sends the batch in the editor and renders each frame it reads back, under the status the response came with", async () => {
    const page = await openExplorer();
    await page.ready();
    const batch = { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title stock }" }] };
    page.write(JSON.stringify(batch));
    await page.send();
    expect(page.sent.slice(1).map(({ method, url, headers, body }) => ({ method, url, headers, body }))).toEqual([
      { method: "POST", url: `${page.base}/rayfold`, headers: { "content-type": "application/rayfold+json" }, body: batch },
    ]);
    const frame = { id: 1, data: { $type: "Book", id: "b1", title: "Dune", stock: 3 }, meta: { cost: 1 }, fin: true };
    expect(page.frames().map(({ cls, tag }) => ({ cls, tag }))).toEqual([{ cls: "frame data", tag: "data · op 1  cost 1" }]);
    expect(page.json()).toEqual([frame]);
    // the size is the body's own bytes, read the same way here
    const body = await (await fetch(`${page.base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: JSON.stringify(batch) })).arrayBuffer();
    expect(page.$("#status").textContent).toBe(`HTTP 200 · 1 frame · 0 ms · ${body.byteLength} B`);
  });

  it("dry-runs a command when the box is ticked, so nothing is written", async () => {
    const page = await openExplorer();
    await page.ready();
    page.click('button.op[data-op="restock"]');
    expect(page.$("button.op.on").dataset.op).toBe("restock");
    expect(page.$<HTMLInputElement>("#simulate").disabled).toBe(false);
    expect(page.$<HTMLInputElement>("#live").disabled).toBe(true);
    expect(page.all("#doc dt, #doc dd").map((n) => n.textContent).slice(-2)).toEqual(["dry run", "allowed: tick it and nothing is written"]);
    const op = { id: 1, op: "restock", args: { id: "", qty: 0 }, shape: "{ id title stock }", key: "explorer-i000000000000000" };
    expect(JSON.parse(page.$<HTMLTextAreaElement>("#req").value)).toEqual({ ops: [op] });

    page.write(JSON.stringify({ ops: [{ ...op, args: { id: "b1", qty: 2 } }] }));
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
    expect(page.frames()[0]).toMatchObject({ cls: "frame ok", tag: "ok · op 1  cost 1" });
    expect(page.json()[0].ok).toEqual({ $type: "Book", id: "b1", title: "Dune", stock: 5 });

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

describe("a live query in the explorer", () => {
  it("follows the server's changes, and Stop ends it: the server ends the op and the button sends again", async () => {
    const page = await openExplorer();
    await page.ready();
    page.write(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title stock }" }] }));
    page.$<HTMLInputElement>("#live").checked = true;
    page.click("#send");
    await page.until(() => page.frames().length === 1, "the first answer");
    expect(page.$("#send").textContent).toBe("Stop");
    expect(page.sent[1]?.body).toEqual({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title stock }", live: true }] });
    page.key("Enter", true); // Ctrl+Enter sends; with a request open it does nothing, and only Stop stops
    expect(page.sent.length).toBe(2);

    // guard: while it is open, a change made by another client arrives as a patch
    const restock = { ops: [{ id: 1, op: "restock", args: { id: "b1", qty: 2 }, key: "elsewhere-0000000000000001" }] };
    await fetch(`${page.base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json", authorization: "Bearer bob" }, body: JSON.stringify(restock) }).then((r) => r.text());
    await page.until(() => page.frames().length === 2, "the patch for the change");
    expect(page.json()[1]).toEqual({ id: 1, patch: [{ set: "Book:b1", value: { stock: 5 } }] });
    expect(page.outcomes.items.filter((o) => o.name === "book")).toEqual([]); // still open on the server

    page.click("#send");
    await page.until(() => page.$("#send").textContent === "Send", "stopped");
    expect(page.$("#status").textContent).toMatch(/^HTTP 200 · 2 frames · 0 ms · \d+ B · stopped$/);
    const ended = await page.outcomes.until((os) => os.some((o) => o.name === "book"), "the server ends the live op");
    expect(ended.find((o) => o.name === "book")?.outcome.error?.code).toBe("canceled");

    // and the page can send again at once
    page.$<HTMLInputElement>("#live").checked = false;
    await page.send();
    expect(page.json()[0].data).toEqual({ $type: "Book", id: "b1", title: "Dune", stock: 5 });
  });

  it("the Result view shows what the frames add up to: a fresh query of the server's state", async () => {
    const page = await openExplorer();
    await page.ready();
    const op = { id: 1, op: "book", args: { id: "b1" }, shape: "{ id title stock author { name } }" };
    page.write(JSON.stringify({ ops: [op] }));
    page.$<HTMLInputElement>("#live").checked = true;
    page.click("#send");
    await page.until(() => page.frames().length === 1, "the first answer");
    const restock = { ops: [{ id: 1, op: "restock", args: { id: "b1", qty: 4 }, key: "elsewhere-0000000000000002" }] };
    await fetch(`${page.base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json", authorization: "Bearer bob" }, body: JSON.stringify(restock) }).then((r) => r.text());
    await page.until(() => page.frames().length === 2, "the patch");
    const frames = page.json();

    page.click("#view-result");
    expect(page.$("#view-result").getAttribute("aria-pressed")).toBe("true");
    expect(page.all("#out .frame .tag").map((t) => t.textContent)).toEqual(["op 1 · book · open"]);
    const leaves = page.all("#out .tree .leaf").map((l) => l.textContent);
    expect(leaves).toEqual(['$type: "Book"', 'id: "b1"', 'title: "Dune"', "stock: 7", '$type: "Author"', 'name: "Frank Herbert"']);

    // the invariant of spec 13 §8: every patch applied in order equals a fresh query of the final state
    const fresh = (await (await fetch(`${page.base}/rayfold`, { method: "POST", headers: { "content-type": "application/rayfold+json" }, body: JSON.stringify({ ops: [op] }) })).text()).trim();
    const held = page.fn["applyFrames"]!({ ops: [op] }, frames) as { byId: Record<string, { root: unknown }> };
    expect(JSON.parse(page.dom.window.JSON.stringify(page.fn["materialize"]!(held.byId["1"]!.root)))).toEqual(JSON.parse(fresh).data);

    // guard: the Frames view is still the frames themselves
    page.click("#view-frames");
    expect(page.json().map((f) => Object.keys(f))).toEqual([["id", "data", "meta"], ["id", "patch"]]);
    page.click("#send");
    await page.until(() => page.$("#send").textContent === "Send", "stopped");
  });
});

describe("a deferred part in the Result view", () => {
  it("merges into what the first answer held, as a client cache would", async () => {
    const page = await openExplorer();
    await page.ready();
    page.write(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title @defer { stock } }" }] }));
    await page.send();
    expect(page.json().map((f) => ({ at: f.at, data: f.data, fin: f.fin }))).toEqual([
      { at: undefined, data: { $type: "Book", id: "b1", title: "Dune" }, fin: undefined },
      { at: "", data: { stock: 3 }, fin: undefined },
      { at: undefined, data: undefined, fin: true },
    ]);
    page.click("#view-result");
    expect(page.all("#out .tree .leaf").map((l) => l.textContent)).toEqual(['$type: "Book"', 'id: "b1"', 'title: "Dune"', "stock: 3"]);
  });
});

describe("the patch rules the published vectors leave open", () => {
  type Held = { byId: Record<string, { root: unknown }> };
  const result = async (request: unknown, frames: unknown[]) => {
    const page = await openExplorer();
    await page.ready();
    const held = page.fn["applyFrames"]!(request, frames) as Held;
    return (id: string) => JSON.parse(page.dom.window.JSON.stringify(page.fn["materialize"]!(held.byId[id]!.root)) ?? "null");
  };

  it("a field selected under the name of another stays the result's: a set of the entity's own field leaves it", async () => {
    const get = await result({ ops: [{ id: 1, op: "book", shape: "{ id stock: title }" }] }, [
      { id: 1, data: { $type: "Book", id: "b1", stock: "Dune" } },
      { id: 1, patch: [{ set: "Book:b1", value: { stock: 9 } }] },
    ]);
    expect(get("1")).toEqual({ $type: "Book", id: "b1", stock: "Dune" });
  });

  it("at onto an entity under such an alias stays with this result, and does not reach the entity elsewhere (guard - a plain field does)", async () => {
    const request = { ops: [{ id: 1, op: "book", shape: "{ id stock: title }" }, { id: 2, op: "book", shape: "{ id stock }" }] };
    const held = [{ id: 1, data: { $type: "Book", id: "b1", stock: "Dune" } }, { id: 2, data: { $type: "Book", id: "b1", stock: 3 } }];
    const aliased = await result(request, [...held, { id: 1, patch: [{ at: "", value: { stock: "Dune (1965)" } }] }]);
    expect([aliased("1"), aliased("2")]).toEqual([{ $type: "Book", id: "b1", stock: "Dune (1965)" }, { $type: "Book", id: "b1", stock: 3 }]);
    const plain = await result(request, [...held, { id: 2, patch: [{ at: "", value: { stock: 9 } }] }]);
    expect([plain("1"), plain("2")]).toEqual([{ $type: "Book", id: "b1", stock: "Dune" }, { $type: "Book", id: "b1", stock: 9 }]);
  });

  it("a list removes several positions as the client held them, not one after another", async () => {
    const rows = ["a", "b", "c", "d"].map((id) => ({ $type: "Book", id }));
    const get = await result({ ops: [{ id: 1, op: "books" }] }, [{ id: 1, data: rows }, { id: 1, patch: [{ list: "", del: [0, 2] }] }]);
    expect(get("1")).toEqual([{ $type: "Book", id: "b" }, { $type: "Book", id: "d" }]);
  });
});

describe("what a response that is not Rayfold frames looks like", () => {
  it("a proxy's error page shows under its HTTP status, as text, instead of failing to parse", async () => {
    const body = "<html>\n<h1>Bad gateway</h1>\n</html>\n";
    const page = await openExplorer({ intercept: (_req, res) => res.writeHead(502, { "content-type": "text/html; charset=utf-8" }).end(body) });
    await page.ready();
    await page.send();
    expect(page.frames()).toEqual([{ cls: "frame http", tag: "HTTP 502 · text/html · not Rayfold frames", text: body }]);
    expect(page.$("#status").textContent).toBe(`HTTP 502 · 0 frames · 0 ms · ${body.length} B`);
    expect(page.all("#history li button").map((b) => b.textContent)).toEqual([`${clock(0)}bookHTTP 502`]);
  });

  it("guard: a refusal the endpoint itself sends is shown as its frames, not as a foreign body", async () => {
    const page = await openExplorer();
    await page.ready();
    page.write(JSON.stringify({ ops: [{ id: 1, op: "nothing", args: {} }] }));
    await page.send();
    expect(page.all("#out .frame.http")).toEqual([]);
    // an unknown op refuses the whole batch, so the frame names no op
    expect(page.frames().map(({ cls, tag }) => ({ cls, tag }))).toEqual([{ cls: "frame error", tag: "error" }]);
    expect(page.json()[0].error.code).toBe("invalid_argument");
    expect(page.$("#status").textContent).toMatch(/^HTTP 200 · 1 frame · 0 ms · \d+ B$/);
  });
});

describe("the result a client cache would hold, checked against the published patch vectors", () => {
  const PATH = new URL("../../../conformance/vectors/patch/apply.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const doc = JSON.parse(readFileSync(PATH, "utf8")) as {
    op: string;
    cases: Array<{ name: string; shape?: string; unheld?: boolean; result: unknown; patch: unknown[]; expect: unknown; stale?: { result: boolean; entities: string[] }; merge?: unknown; predict?: unknown; refetch?: unknown }>;
  };
  // predictions and @merge policies are the client cache's own layers; the explorer shows only what the server sent
  const applicable = doc.cases.filter((c) => !c.predict && !c.merge && !c.refetch);

  it("runs every case that is not about predictions, and only those are left out", () => {
    expect(doc.cases.length - applicable.length).toBe(6);
    expect(doc.cases.filter((c) => !applicable.includes(c)).every((c) => c.predict !== undefined)).toBe(true);
  });

  for (const c of applicable) {
    it(c.name, async () => {
      const page = await openExplorer();
      await page.ready();
      const request = { ops: [{ id: 1, op: doc.op, ...(c.shape ? { shape: c.shape } : {}) }, { id: 2, op: "another" }] };
      const frames = [{ id: 1, data: c.result }, { id: c.unheld ? 2 : 1, patch: c.patch }];
      const held = page.fn["applyFrames"]!(request, frames) as { byId: Record<string, { root: unknown; stale: boolean }>; stale: Record<string, boolean> };
      const plain = (v: unknown) => JSON.parse(page.dom.window.JSON.stringify(v) ?? "null");
      expect(plain(page.fn["materialize"]!(held.byId["1"]!.root))).toEqual(c.expect);
      if (c.stale) {
        expect(held.byId["1"]!.stale).toBe(c.stale.result);
        const keys = new Set<string>();
        (function walk(v: unknown) {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") {
            const o = v as Record<string, unknown>;
            if (typeof o["$type"] === "string" && o["id"] !== undefined) keys.add(`${o["$type"]}:${o["id"]}`);
            Object.values(o).forEach(walk);
          }
        })(c.result);
        for (const k of keys) expect(!!held.stale[k], k).toBe(c.stale.entities.includes(k));
      }
    });
  }
});

describe("suggestions while writing a request", () => {
  const two = JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }, { id: 2, op: "restock", args: { id: "b1" }, key: "k" }] }, null, 2);

  it("offers the operations where an op name goes, narrowed by what is typed, and Enter puts it in", async () => {
    const page = await openExplorer();
    await page.ready();
    const at = '{ "ops": [{ "id": 1, "op": "bo';
    page.write(at + '" }] }', at.length);
    expect(page.suggestions()).toEqual(["book"]);
    page.key("Enter");
    expect(page.$<HTMLTextAreaElement>("#req").value).toBe('{ "ops": [{ "id": 1, "op": "book" }] }');
    expect(page.suggestions()).toEqual([]);

    // Ctrl+Space with nothing typed offers every one of them
    const empty = '{ "ops": [{ "id": 1, "op": "';
    page.write(empty + '" }] }', empty.length);
    expect(page.suggestions()).toEqual([]); // typing nothing opens nothing
    page.key(" ", true);
    expect(page.suggestions()).toEqual(["book", "restock", "search"]);
    page.key("ArrowDown");
    page.key("Tab");
    expect(page.$<HTMLTextAreaElement>("#req").value).toBe('{ "ops": [{ "id": 1, "op": "restock" }] }');
  });

  it("offers the fields of the type the shape is selecting at the cursor, a level down too, and a union's members", async () => {
    const page = await openExplorer();
    await page.ready();
    const top = '{ "ops": [{ "id": 1, "op": "book", "shape": "{ id ti';
    page.write(top + '" }] }', top.length);
    expect(page.suggestions()).toEqual(["title"]);

    const nested = '{ "ops": [{ "id": 1, "op": "book", "shape": "{ id author { n';
    page.write(nested + ' } }" }] }', nested.length);
    expect(page.suggestions()).toEqual(["name"]);

    const union = '{ "ops": [{ "id": 1, "op": "search", "shape": "{ ';
    page.write(union + '}" }] }', union.length);
    page.key(" ", true);
    expect(page.suggestions()).toEqual(["...on Author", "...on Book"]);
    page.key("ArrowDown");
    page.key("Enter");
    expect(page.$<HTMLTextAreaElement>("#req").value).toBe('{ "ops": [{ "id": 1, "op": "search", "shape": "{ ...on Book { id }}" }] }');
  });

  it("offers an op's arguments where an argument name goes, for the op that object belongs to", async () => {
    const page = await openExplorer();
    await page.ready();
    // the cursor at the start of an argument name in restock's args
    page.write(two, two.lastIndexOf('"id": "b1"') + 1);
    page.key(" ", true);
    expect(page.suggestions()).toEqual(["id", "qty"]); // restock's, not book's
  });

  it("guard: where nothing is a name the schema decides, nothing is offered", async () => {
    const page = await openExplorer();
    await page.ready();
    const at = '{ "ops": [{ "id": 1';
    page.write(at + ', "op": "book" }] }', at.length);
    page.key(" ", true);
    expect(page.suggestions()).toEqual([]);
    expect(page.$("#complete").hasAttribute("hidden")).toBe(true);
  });
});

describe("checks made before anything is sent", () => {
  it("names an unknown operation, argument or field, with the nearest real one, and a command with no key", async () => {
    const page = await openExplorer();
    await page.ready();
    page.write(JSON.stringify({ ops: [{ id: 1, op: "boook", args: {} }, { id: 2, op: "book", args: { idd: "b1" }, shape: "{ id titel author { nam } }" }, { id: 3, op: "restock", args: { id: "b1", qty: 1 } }] }));
    await page.until(() => page.problems().length > 0, "problems listed");
    expect(page.problems()).toEqual([
      'op 1: there is no operation "boook"; did you mean book?',
      "op 2: book takes no argument idd; did you mean id?",
      "op 2: book needs id",
      "op 2: Book has no field titel; did you mean title?",
      "op 2: Author has no field nam; did you mean name?",
      "op 3: a command needs an idempotency key",
    ]);
    // the server is the judge: a request with problems still goes when sent
    await page.send();
    expect(page.sent.length).toBe(2);
  });

  it("guard: the request the page writes for an op has nothing to report", async () => {
    const page = await openExplorer();
    await page.ready();
    const written = page.$<HTMLTextAreaElement>("#req").value;
    page.write('{ "ops": [{ "id": 1, "op": "boook" }] }');
    await page.until(() => page.problems().length === 1, "a problem listed");
    // the check runs after a pause in typing; back to what the page wrote, the list empties
    page.write(written);
    await page.until(() => page.problems().length === 0, "nothing listed");
    page.click('button.op[data-op="restock"]');
    expect(page.fn["problemsOf"]!(page.$<HTMLTextAreaElement>("#req").value)).toEqual([]);
    page.click('button.op[data-op="search"]');
    expect(page.fn["problemsOf"]!(page.$<HTMLTextAreaElement>("#req").value)).toEqual([]);
  });
});

describe("the shape panel", () => {
  it("ticks what the shape selects, and ticking or unticking a field rewrites the shape of that op only", async () => {
    const page = await openExplorer();
    await page.ready();
    page.write(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title stock }" }, { id: 2, op: "restock", args: { id: "b1", qty: 1 }, key: "k", shape: "{ id }" }] }));
    page.click("#toggle-shape");
    const boxes = () => page.all("#shape-panel input[type=checkbox]") as HTMLInputElement[];
    // a field behind a policy is not in the request the page wrote, and is there to tick
    expect(boxes().map((b) => [b.dataset.field, b.checked])).toEqual([["id", true], ["title", true], ["stock", true], ["author", false], ["cost", false]]);

    const tick = (field: string) => {
      const box = boxes().find((b) => b.dataset.field === field)!;
      box.checked = !box.checked;
      box.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
    };
    const shapes = () => (JSON.parse(page.$<HTMLTextAreaElement>("#req").value) as { ops: Array<{ shape?: string }> }).ops.map((o) => o.shape);
    tick("author");
    expect(shapes()).toEqual(["{ id title stock author { id name } }", "{ id }"]);
    // the new level is listed under it, already ticked as written
    expect(boxes().map((b) => [b.dataset.field, b.checked])).toEqual([["id", true], ["title", true], ["stock", true], ["author", true], ["id", true], ["name", true], ["cost", false]]);
    tick("title");
    expect(shapes()).toEqual(["{ id stock author { id name } }", "{ id }"]);
    tick("author");
    expect(shapes()).toEqual(["{ id stock }", "{ id }"]);
  });

  it("an object field with nothing ticked under it is selected as the server's default for it, never as an empty { }", async () => {
    const page = await openExplorer();
    await page.ready();
    page.write(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id author { id name } }" }] }));
    page.click("#toggle-shape");
    const untick = (n: number) => {
      const box = (page.all("#shape-panel input[type=checkbox]") as HTMLInputElement[]).filter((b) => b.dataset.field === "id" || b.dataset.field === "name")[n]!;
      box.checked = false;
      box.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
    };
    untick(1); // author's id
    untick(1); // author's name
    expect(JSON.parse(page.$<HTMLTextAreaElement>("#req").value).ops[0].shape).toBe("{ id author }");
  });

  it("edits the op picked on the left wherever it sits in the batch", async () => {
    const page = await openExplorer();
    await page.ready();
    page.write(JSON.stringify({ ops: [{ id: 1, op: "restock", args: { id: "b1", qty: 1 }, key: "k", shape: "{ id }" }, { id: 2, op: "book", args: { id: "b1" }, shape: "{ id }" }] }));
    page.click("#toggle-shape");
    const box = (page.all("#shape-panel input[type=checkbox]") as HTMLInputElement[]).find((b) => b.dataset.field === "title")!;
    box.checked = true;
    box.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
    expect((JSON.parse(page.$<HTMLTextAreaElement>("#req").value) as { ops: Array<{ shape: string }> }).ops.map((o) => o.shape)).toEqual(["{ id }", "{ id title }"]);
  });

  it("keeps an alias, arguments and modifiers as they were written while other fields are ticked", async () => {
    const page = await openExplorer();
    await page.ready();
    page.write(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ name: title @partial author { id } }" }] }));
    page.click("#toggle-shape");
    const box = (page.all("#shape-panel input[type=checkbox]") as HTMLInputElement[]).find((b) => b.dataset.field === "stock")!;
    box.checked = true;
    box.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
    expect(JSON.parse(page.$<HTMLTextAreaElement>("#req").value).ops[0].shape).toBe("{ name: title @partial author { id } stock }");
  });

  it("offers a union's members as conditions, each with its own fields", async () => {
    const page = await openExplorer();
    await page.ready();
    page.click('button.op[data-op="search"]');
    page.click("#toggle-shape");
    const boxes = () => page.all("#shape-panel input[type=checkbox]") as HTMLInputElement[];
    expect(boxes().map((b) => b.dataset.on)).toEqual(["Author", "Book"]);
    const author = boxes().find((b) => b.dataset.on === "Author")!;
    author.checked = true;
    author.dispatchEvent(new page.dom.window.Event("change", { bubbles: true }));
    expect(JSON.parse(page.$<HTMLTextAreaElement>("#req").value).ops[0].shape).toBe("{ ...on Author { id name } }");
  });
});

describe("tabs, history and what the browser keeps", () => {
  it("a new tab holds its own request, and switching back finds each as it was left", async () => {
    const page = await openExplorer();
    await page.ready();
    page.write('{ "ops": [] }');
    page.click("#tabs .tab-add");
    expect(page.all("#tabs .tab").map((b) => [b.textContent, b.getAttribute("aria-current")])).toEqual([["book", null], ["book", "true"]]);
    page.click('button.op[data-op="restock"]');
    expect(page.all("#tabs .tab").map((b) => b.textContent)).toEqual(["book", "restock"]);
    page.click(page.all("#tabs .tab")[0]!);
    expect(page.$<HTMLTextAreaElement>("#req").value).toBe('{ "ops": [] }');
    page.click(page.all("#tabs .tab-close")[0]!);
    expect(page.all("#tabs .tab").map((b) => b.textContent)).toEqual(["restock"]);
    expect(JSON.parse(page.$<HTMLTextAreaElement>("#req").value).ops[0].op).toBe("restock");
  });

  it("opened again, the page finds its tabs and its history; a history entry puts its request back", async () => {
    const page = await openExplorer();
    await page.ready();
    const batch = JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ title }" }] });
    page.write(batch);
    await page.send();
    page.write(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b2" } }] }));

    const again = page.reopen();
    await again.until(() => again.$("button.op.on") !== null, "restored");
    expect(JSON.parse(again.$<HTMLTextAreaElement>("#req").value)).toEqual({ ops: [{ id: 1, op: "book", args: { id: "b2" } }] });
    expect(again.all("#history li button").map((b) => b.textContent)).toEqual([`${clock(0)}bookHTTP 200`]);
    again.click("#history li button");
    expect(again.$<HTMLTextAreaElement>("#req").value).toBe(batch);
  });

  it("keeps no token or headers unless asked to (guard - asked, it keeps both)", async () => {
    const page = await openExplorer();
    await page.ready();
    page.$<HTMLInputElement>("#token").value = "secret-token";
    page.$<HTMLInputElement>("#token").dispatchEvent(new page.dom.window.Event("input"));
    page.$<HTMLTextAreaElement>("#headers").value = '{ "x-tenant": "acme" }';
    page.$<HTMLTextAreaElement>("#headers").dispatchEvent(new page.dom.window.Event("input"));
    expect(Object.values(page.storage()).join("")).not.toContain("secret-token");
    expect(Object.values(page.storage()).join("")).not.toContain("acme");
    expect(page.reopen().$<HTMLInputElement>("#token").value).toBe("");

    page.$<HTMLInputElement>("#remember").checked = true;
    page.$<HTMLInputElement>("#remember").dispatchEvent(new page.dom.window.Event("change"));
    const again = page.reopen();
    await again.until(() => again.$("button.op.on") !== null, "restored");
    expect(again.$<HTMLInputElement>("#token").value).toBe("secret-token");
    expect(again.$<HTMLTextAreaElement>("#headers").value).toBe('{ "x-tenant": "acme" }');
    expect(again.$<HTMLInputElement>("#remember").checked).toBe(true);
  });

  it("keeps the last fifty sends, newest first", async () => {
    const page = await openExplorer();
    await page.ready();
    const key = Object.keys(page.storage())[0]!;
    const kept = JSON.parse(page.storage()[key]!);
    kept.history = Array.from({ length: 50 }, (_, i) => ({ at: 1000 * (i + 1), ops: `old${i}`, status: 200, text: "{}" }));
    const again = (await openExplorer({ storage: { [key.replace(/:.*$/, ":/rayfold")]: JSON.stringify(kept) } }));
    await again.ready();
    expect(again.all("#history li button").length).toBe(50);
    await again.send();
    const rows = again.all("#history li button").map((b) => b.textContent);
    expect(rows.length).toBe(50);
    expect(rows[0]).toBe(`${clock(0)}bookHTTP 200`);
    expect(rows[1]).toBe(`${clock(1000)}old0HTTP 200`);
    expect(rows[49]).toBe(`${clock(49000)}old48HTTP 200`); // the oldest, old49, is the one let go
  });

  it("works the same where the browser refuses storage", async () => {
    const page = await openExplorer({ storageThrows: true });
    await page.ready();
    page.write(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ title }" }] }));
    await page.send();
    expect(page.json()[0].data).toEqual({ $type: "Book", title: "Dune" });
    expect(page.all("#history li button").length).toBe(1);
  });
});

describe("headers and copying", () => {
  it("sends the headers given as JSON beside the token, and refuses to send headers that are not JSON", async () => {
    const page = await openExplorer();
    await page.ready();
    page.$<HTMLTextAreaElement>("#headers").value = '{ "X-Tenant": "acme" }';
    page.$<HTMLInputElement>("#token").value = "ada";
    await page.send();
    expect(page.sent[1]?.headers).toEqual({ "content-type": "application/rayfold+json", "x-tenant": "acme", authorization: "Bearer ada" });

    page.$<HTMLTextAreaElement>("#headers").value = "x-tenant: acme";
    page.click("#send");
    expect(page.sent.length).toBe(2); // nothing went
    expect(page.frames()[0]).toMatchObject({ cls: "frame error", tag: "explorer" });
    expect(page.frames()[0]?.text).toMatch(/^the headers are not JSON: /);
  });

  it("copies the request as a curl command that sends exactly what Send would", async () => {
    const page = await openExplorer();
    await page.ready();
    page.write(JSON.stringify({ ops: [{ id: 1, op: "book", args: { id: "it's" } }] }));
    page.$<HTMLInputElement>("#live").checked = true;
    page.click("#curl");
    await page.until(() => page.$("#note").textContent === "curl command copied", "copied");
    expect(page.copied).toEqual([
      `curl -N '${page.base}/rayfold' -H 'content-type: application/rayfold+json' --data-raw '{"ops":[{"id":1,"op":"book","args":{"id":"it'\\''s"},"live":true}]}'`,
    ]);
    // guard: with a token, the command carries it as Send would
    page.$<HTMLInputElement>("#token").value = "ada";
    page.click("#curl");
    await page.until(() => page.copied.length === 2, "copied again");
    expect(page.copied[1]).toContain("-H 'authorization: Bearer ada'");
  });
});
