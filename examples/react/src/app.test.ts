import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { createElement as h } from "react";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { RayfoldProvider } from "@rayfold/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { devToken } from "./auth.ts";
import { bookshopHttp, createBookshop } from "./bookshop.ts";
import type { Store } from "./resolvers.ts";

// The app renders into a jsdom document and its client talks HTTP to the real bookshop server on a loopback port,
// so each test goes component -> client -> server -> patch -> re-render.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const DOM_GLOBALS = { window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver };
Object.assign(globalThis as Record<string, unknown>, DOM_GLOBALS);
// react-dom checks for a DOM when it loads, so it comes after the globals
const { createRoot } = await import("react-dom/client");
const { App } = await import("./App.tsx");

// React runs a commit's passive effects in a setImmediate that reads `window`; let it run before the DOM goes away.
const drainReact = async () => {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
};

/** Where Vite serves the page in development. A browser names it in the Origin header of each request. */
const PAGE_ORIGIN = "http://localhost:5173";

let http: Server;
let store: Store;
/** Tokens as the identity provider issues them at sign-in. */
let customer = "";
let staffToken = "";
beforeAll(async () => {
  customer = await devToken("u1", "customer");
  staffToken = await devToken("s1", "staff");
});
let base: string;
let unmount = () => {};

beforeEach(async () => {
  const shop = createBookshop();
  store = shop.store;
  http = bookshopHttp(shop.server);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  unmount();
  unmount = () => {};
  await drainReact();
  await new Promise<void>((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
});

afterAll(async () => {
  await drainReact();
  for (const k of Object.keys(DOM_GLOBALS)) delete (globalThis as Record<string, unknown>)[k];
  dom.window.close();
});

type Answer = { ops: string[]; status: number };

/** Renders the app as a page on `origin` would run it, and records the status the server answered each request with. */
function renderApp(origin: string): { answers: Answer[] } {
  const answers: Answer[] = [];
  const client = new RayfoldClient({
    transport: createFetchTransport({
      url: `${base}/rayfold`,
      headers: () => ({ authorization: `Bearer ${customer}`, origin }),
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        answers.push({ ops: (JSON.parse(String(init?.body)) as { ops: Array<{ op: string }> }).ops.map((o) => o.op), status: res.status });
        return res;
      },
    }),
  });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  root.render(h(RayfoldProvider, { client }, h(App)));
  unmount = () => {
    root.unmount();
    container.remove();
  };
  return { answers };
}

/** Resolves once `test` passes, checking again on every change to the page; fails after 5 s. */
function until(test: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (test()) return resolve();
    const observer = new dom.window.MutationObserver(() => {
      if (!test()) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`still waiting for ${what}; the page says: ${dom.window.document.body.textContent}`));
    }, 5000);
    observer.observe(dom.window.document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
}

const row = (title: string) => [...dom.window.document.querySelectorAll("li")].find((li) => li.textContent?.includes(title));
const stockOf = (id: string) => dom.window.document.querySelector(`[data-stock="${id}"]`)?.textContent;
const click = (el: Element | null | undefined) => el?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
const purchases = (answers: Answer[]) => answers.filter((a) => a.ops.includes("buy"));

it("lists the books, and buying one updates its stock on the page", async () => {
  const { answers } = renderApp(PAGE_ORIGIN);
  await until(() => stockOf("b1") === "3 in stock", "the first book's stock");
  expect(row("A Wizard of Earthsea")?.textContent).toContain("Ursula K. Le Guin");

  click(row("A Wizard of Earthsea")?.querySelector("button"));
  await until(() => stockOf("b1") === "2 in stock", "the stock after buying");
  expect(store.books.get("b1")?.stock).toBe(2);
  expect(purchases(answers)).toEqual([{ ops: ["buy"], status: 200 }]);
});

it("says Sold out when there is none left, and sells nothing", async () => {
  renderApp(PAGE_ORIGIN);
  await until(() => stockOf("b2") === "0 in stock", "the sold-out book");
  click(row("The Left Hand of Darkness")?.querySelector("button"));
  await until(() => !!row("The Left Hand of Darkness")?.textContent?.includes("Sold out"), "the sold-out message");
  expect(store.books.get("b2")?.stock).toBe(0);
  expect(row("A Wizard of Earthsea")?.textContent).not.toContain("Sold out");
});

it("shows a restock made by someone else, as it happens", async () => {
  renderApp(PAGE_ORIGIN);
  await until(() => stockOf("b3") === "7 in stock", "the third book's stock");
  const staff = new RayfoldClient({ transport: createFetchTransport({ url: `${base}/rayfold`, headers: () => ({ authorization: `Bearer ${staffToken}` }) }) });
  await staff.command("restock", { bookId: "b3", qty: 5 });
  await until(() => stockOf("b3") === "12 in stock", "the restocked count");
});

it("a copy of the page on another site is refused: it shows the error, and a purchase sent from there sells nothing", async () => {
  const elsewhere = "https://elsewhere.example";
  const { answers } = renderApp(elsewhere);
  await until(() => dom.window.document.querySelector('[role="alert"]') !== null, "the refusal on the page");
  expect(dom.window.document.body.textContent).toBe("BookshopCould not load the books.");
  expect(answers).toEqual([{ ops: ["books"], status: 403 }]);

  const client = new RayfoldClient({ transport: createFetchTransport({ url: `${base}/rayfold`, headers: () => ({ authorization: `Bearer ${customer}`, origin: elsewhere }) }) });
  await expect(client.command("buy", { bookId: "b1", qty: 1 })).rejects.toMatchObject({ code: "permission_denied", message: `Origin ${elsewhere} is not allowed` });
  expect(store.books.get("b1")?.stock).toBe(3);
});
