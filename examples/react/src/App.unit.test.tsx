// @vitest-environment jsdom
/**
 * The components tested with no network: rendered into jsdom, on a client that calls the bookshop server in this
 * process. app.test.ts runs the same app over HTTP, tokens and origins included.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { RayfoldClient, createLocalTransport } from "@rayfold/client";
import { RayfoldProvider } from "@rayfold/react";
// the runtime without its Node transports: this file runs as browser code, and nothing here listens on a port
import { createRayfoldServer } from "@rayfold/server/core";
import { afterEach, expect, it } from "vitest";
import { App } from "./App.tsx";
import schema from "./bookshop.rayfold?raw";
import { resolvers, seed, type Viewer } from "./resolvers.ts";

// #region test-setup
let unmount = () => {};
afterEach(() => {
  unmount();
  unmount = () => {};
});

/** Renders the app on a bookshop of its own. Nothing listens on a port: the client calls the server directly. */
function renderApp(viewer: Viewer | null = { id: "u1", role: "customer" }, store = seed()) {
  const server = createRayfoldServer({ schema, resolvers: resolvers(store) });
  const as = (who: Viewer | null) => new RayfoldClient({ transport: createLocalTransport(server, () => who) });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  unmount = () => {
    flushSync(() => root.unmount());
    container.remove();
  };
  // flushSync: the first render is on the page when this returns, before any answer can have arrived
  const app = <RayfoldProvider client={as(viewer)}><App /></RayfoldProvider>;
  flushSync(() => root.render(app));
  return { container, store, as };
}
// #endregion test-setup

// #region test-wait
/** Resolves once `test` passes, looking again whenever the page changes. Fails after 4 s, saying what the page shows. */
function until(test: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (done: () => void) => {
      observer.disconnect();
      clearTimeout(timer);
      done();
    };
    const observer = new MutationObserver(() => test() && settle(resolve));
    // under the test runner's own 5 s, so that this message is the one the failure shows
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`still waiting for ${what}; the page says: ${document.body.textContent}`)));
    }, 4000);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    if (test()) settle(resolve);
  });
}

const row = (title: string) => [...document.querySelectorAll("li")].find((li) => li.textContent?.includes(title));
const stockOf = (id: string) => document.querySelector(`[data-stock="${id}"]`)?.textContent;
// #endregion test-wait

// #region test-component
it("says Loading..., then lists the books with their authors and stock", async () => {
  const { container } = renderApp();
  expect(container.textContent).toBe("BookshopLoading...");

  await until(() => stockOf("b3") === "7 in stock", "the last book's stock");
  expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
    "A Wizard of Earthsea by Ursula K. Le Guin 3 in stock Buy",
    "The Left Hand of Darkness by Ursula K. Le Guin 0 in stock Buy",
    "Dune by Frank Herbert 7 in stock Buy",
  ]);
});
// #endregion test-component

// #region test-command
it("Buy sells a copy, and the page shows the new stock of that book only", async () => {
  const { store } = renderApp();
  await until(() => stockOf("b1") === "3 in stock" && stockOf("b3") === "7 in stock", "the books' stock");

  row("A Wizard of Earthsea")?.querySelector("button")?.click();

  await until(() => stockOf("b1") === "2 in stock", "the stock after buying");
  expect(store.books.get("b1")?.stock).toBe(2);
  expect(stockOf("b3")).toBe("7 in stock");
});
// #endregion test-command

it("says Sold out beside the book there is none left of, and sells nothing", async () => {
  const { store } = renderApp();
  await until(() => stockOf("b2") === "0 in stock", "the sold-out book");
  expect(document.querySelector('[role="alert"]')).toBeNull();

  row("The Left Hand of Darkness")?.querySelector("button")?.click();

  await until(() => document.querySelector('[role="alert"]') !== null, "the sold-out message");
  expect(row("The Left Hand of Darkness")?.textContent).toBe("The Left Hand of Darkness by Ursula K. Le Guin 0 in stock Buy Sold out");
  expect(store.books.get("b2")?.stock).toBe(0);
  // guard: the message belongs to that book; the one in stock has none
  expect(row("A Wizard of Earthsea")?.textContent).toBe("A Wizard of Earthsea by Ursula K. Le Guin 3 in stock Buy");
});

it("shows a restock someone else makes, as it happens", async () => {
  const { as } = renderApp();
  await until(() => stockOf("b3") === "7 in stock", "the book's stock");

  await as({ id: "s1", role: "staff" }).command("restock", { bookId: "b3", qty: 5 });

  await until(() => stockOf("b3") === "12 in stock", "the restocked count");
  expect(stockOf("b1")).toBe("3 in stock");
});

it("shows ... for a book's stock until its live query has answered", async () => {
  renderApp();
  await until(() => document.querySelectorAll("li").length === 3, "the list");
  expect([stockOf("b1"), stockOf("b2"), stockOf("b3")]).toEqual(["...", "...", "..."]);

  await until(() => stockOf("b1") === "3 in stock", "the stock");
});

it("Buy is disabled while the purchase runs, so a second click sells nothing more", async () => {
  const { store } = renderApp();
  await until(() => stockOf("b1") === "3 in stock", "the book's stock");
  const buy = row("A Wizard of Earthsea")?.querySelector("button");
  if (!buy) throw new Error("no Buy button beside the book");

  // flushSync: what the click rendered is on the page when it returns, before the shop can have answered
  flushSync(() => buy.click());
  expect(buy.disabled).toBe(true);
  buy.click();

  await until(() => !buy.disabled, "the purchase to finish");
  await until(() => stockOf("b1") === "2 in stock", "the stock after buying");
  expect(store.books.get("b1")?.stock).toBe(2);
});

it("guard: a purchase refused for another reason than the stock does not say Sold out", async () => {
  const { store } = renderApp(null);
  await until(() => stockOf("b1") === "3 in stock", "the book's stock");
  const buy = row("A Wizard of Earthsea")?.querySelector("button");
  if (!buy) throw new Error("no Buy button beside the book");

  flushSync(() => buy.click()); // nobody is signed in, so the shop refuses
  expect(buy.disabled).toBe(true);
  await until(() => !buy.disabled, "the refusal");

  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(store.books.get("b1")?.stock).toBe(3);
});

it("says it could not load the books when the shop fails to list them", async () => {
  const store = seed();
  store.books.values = () => {
    throw new Error("the database is down");
  };
  const { container } = renderApp(undefined, store);

  await until(() => container.querySelector('[role="alert"]') !== null, "the failure");
  expect(container.textContent).toBe("BookshopCould not load the books.");
});
