import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StrictMode, createElement as h, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { RayfoldError, createRayfoldServer, listen } from "@rayfold/server";
import { RayfoldClient, RayfoldClientError, createFetchTransport, type CommandOptions } from "@rayfold/client";
import { Signal, bounded } from "../../../e2e/wait.ts";
import { RayfoldProvider, useCommand, useLive, useQuery, type CommandState, type QueryResult, type UseQueryOptions } from "./index.ts";

// React renders into a jsdom document. fetch, AbortController and streams stay Node's: the client talks HTTP to a
// real Rayfold server on a loopback port, so every test drives hook -> client -> server -> cache -> re-render.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const DOM_GLOBALS = { window: dom.window, document: dom.window.document, MutationObserver: dom.window.MutationObserver };
Object.assign(globalThis as Record<string, unknown>, DOM_GLOBALS);
// react-dom decides at load time whether a DOM exists, so it is loaded after the globals are in place
const { createRoot } = await import("react-dom/client");

/**
 * React flushes a commit's passive effects in a scheduler task (a setImmediate in Node) that reads `window`.
 * Awaiting a later immediate lets that task run while the DOM still exists. Event-loop order, not a clock.
 */
const drainReact = async () => {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
};

afterAll(async () => {
  await drainReact();
  for (const k of Object.keys(DOM_GLOBALS)) delete (globalThis as Record<string, unknown>)[k];
  dom.window.close();
});

const SCHEMA = `
entity Book {
  id: ID
  title: String
  stock: Int
}
error OutOfStock { available: Int }
query book(id: ID): Book?
command restock(id: ID, qty: Int): Book
command buy(id: ID, qty: Int): Book throws OutOfStock
`;

interface Book {
  id: string;
  title: string;
  stock: number;
}

let books: Map<string, Book>;
/** While set, commands wait for it: lets a test see the in-flight state without racing the network. */
let gate: Promise<void> | undefined;
/** The quantity of every restock, as the server starts it (and reads the gate). */
let arrived: Signal<number>;
let http: Server;
let url: string;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  books = new Map([
    ["b1", { id: "b1", title: "Dune", stock: 3 }],
    ["b2", { id: "b2", title: "Emma", stock: 7 }],
  ]);
  gate = undefined;
  arrived = new Signal<number>();
  const find = (id: string): Book => {
    const b = books.get(id);
    if (!b) throw new RayfoldError("not_found", `no book ${id}`);
    return b;
  };
  const server = createRayfoldServer({
    schema: SCHEMA,
    resolvers: {
      Query: { book: ({ id }: { id: string }) => books.get(id) ?? null },
      Command: {
        restock: async ({ id, qty }: { id: string; qty: number }) => {
          arrived.push(qty);
          await gate;
          const b = find(id);
          b.stock += qty;
          return b;
        },
        buy: async ({ id, qty }: { id: string; qty: number }) => {
          await gate;
          const b = find(id);
          if (qty > b.stock) throw RayfoldError.domain("OutOfStock", { available: b.stock }, `Only ${b.stock} left`);
          b.stock -= qty;
          return b;
        },
      },
    },
  });
  http = await listen(server, 0, {
    viewer: (req) => (req.headers.authorization?.startsWith("Bearer ") ? { id: req.headers.authorization.slice(7) } : null),
  });
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold`;
});

afterEach(async () => {
  try {
    for (const c of cleanups.splice(0)) c();
    await drainReact();
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
    for (const k of Object.keys(queries)) delete queries[k];
    for (const k of Object.keys(commands)) delete commands[k];
  }
});

interface Sent {
  ops: string[];
  live: boolean;
  signal: AbortSignal | undefined;
}

/** A client for one user, recording every request it sends and how many watch()/live() subscriptions are open. */
function makeClient(user = "u1") {
  const sent: Sent[] = [];
  const client = new RayfoldClient({
    transport: createFetchTransport({
      url,
      headers: () => ({ authorization: `Bearer ${user}` }),
      fetch: (input, init) => {
        const ops = (JSON.parse(String(init?.body)) as { ops: Array<{ op: string; live?: boolean }> }).ops;
        sent.push({ ops: ops.map((o) => o.op), live: ops.some((o) => o.live), signal: init?.signal ?? undefined });
        return fetch(input, init);
      },
    }),
  });
  let open = 0;
  const watch = client.watch.bind(client);
  const live = client.live.bind(client);
  client.watch = ((...a: Parameters<typeof watch>) => {
    open++;
    const stop = watch(...a);
    return () => (open--, stop());
  }) as typeof client.watch;
  client.live = ((...a: Parameters<typeof live>) => {
    open++;
    const stop = live(...a);
    return () => (open--, stop());
  }) as typeof client.live;
  return { client, sent, open: () => open, requests: () => sent.map((s) => s.ops) };
}

function mount(client: RayfoldClient, ui: ReactElement, opts: { strict?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const wrap = (el: ReactElement) => {
    const tree = h(RayfoldProvider, { client }, el);
    return opts.strict ? h(StrictMode, null, tree) : tree;
  };
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    root.unmount();
    container.remove();
  };
  cleanups.push(unmount);
  root.render(wrap(ui));
  return { container, text: () => container.textContent ?? "", rerender: (el: ReactElement) => root.render(wrap(el)), unmount };
}

/** Resolves once `cond` holds for the container's text: checked now and after every DOM mutation, bounded to 5 s. */
function waitForText(container: HTMLElement, cond: (text: string) => boolean, label: string): Promise<string> {
  const read = () => container.textContent ?? "";
  if (cond(read())) return Promise.resolve(read());
  let observer: MutationObserver | undefined;
  const seen = new Promise<string>((resolve) => {
    observer = new MutationObserver(() => {
      if (cond(read())) resolve(read());
    });
    observer.observe(container, { subtree: true, childList: true, characterData: true });
  });
  return bounded(seen, `${label} (text now: "${read()}")`).finally(() => observer?.disconnect());
}

// ------------------------------------------------------------------ components under test

const queries: Record<string, QueryResult<Book>> = {};
const commands: Record<string, { run: (args: Record<string, unknown>) => Promise<Book>; state: CommandState<Book> }> = {};

function Stock(props: { id: string | undefined; label: string; log?: string[]; opts?: UseQueryOptions }) {
  const q = useQuery<Book>("book", { id: props.id }, props.opts);
  queries[props.label] = q;
  const text = q.error
    ? `${props.label}: error ${(q.error as RayfoldClientError).code}`
    : q.data
      ? `${props.label}: ${q.data.title} ${q.data.stock}${q.loading ? " (refreshing)" : ""}`
      : q.loading
        ? `${props.label}: loading`
        : `${props.label}: idle`;
  props.log?.push(text);
  return h("p", null, text);
}

function LiveStock(props: { id: string; label: string }) {
  const l = useLive<Book>("book", { id: props.id }, { shape: "{ id title stock }" });
  return h("p", null, l.data ? `${props.label}: ${l.data.stock}` : l.error ? `${props.label}: error` : `${props.label}: loading`);
}

function Command(props: { op: string; label: string; options?: CommandOptions }) {
  const [run, state] = useCommand<Book>(props.op, props.options);
  commands[props.label] = { run, state };
  const err = state.error as RayfoldClientError | undefined;
  const text = state.running ? "running" : err ? `failed ${err.type ?? err.code}` : state.data ? `done ${state.data.stock}` : "ready";
  return h("p", null, `${props.label}: ${text}`);
}

// ------------------------------------------------------------------ tests

describe("useQuery", () => {
  it("renders loading, then the server's data", async () => {
    const { client } = makeClient();
    const log: string[] = [];
    const view = mount(client, h(Stock, { id: "b1", label: "A", log }));
    await waitForText(view.container, (t) => t === "A: Dune 3", "book loaded");
    expect(log[0]).toBe("A: loading");
  });

  it("a command's patch re-renders every component showing that book, without refetching it", async () => {
    const { client, requests } = makeClient();
    const unrelated: string[] = [];
    const view = mount(
      client,
      h("div", null, h(Stock, { id: "b1", label: "A" }), h(Stock, { id: "b1", label: "B" }), h(Stock, { id: "b2", label: "C", log: unrelated }), h(Command, { op: "restock", label: "R" })),
    );
    await waitForText(view.container, (t) => t.includes("A: Dune 3") && t.includes("B: Dune 3") && t.includes("C: Emma 7"), "three components loaded");
    const before = requests().length;
    const rendersOfC = unrelated.length;
    await commands["R"]!.run({ id: "b1", qty: 2 });
    await waitForText(view.container, (t) => t.includes("A: Dune 5") && t.includes("B: Dune 5") && t.includes("R: done 5"), "both b1 components patched");
    expect(requests().slice(before)).toEqual([["restock"]]);
    // guard: the component showing another book did not re-render
    expect(unrelated.slice(rendersOfC)).toEqual([]);
    expect(view.text()).toContain("C: Emma 7");
  });

  it("a failing query shows its error, and a valid query in the same tree still loads", async () => {
    const { client } = makeClient();
    const view = mount(client, h("div", null, h(Stock, { id: undefined, label: "E" }), h(Stock, { id: "b1", label: "A" })));
    await waitForText(view.container, (t) => t.includes("E: error invalid_argument") && t.includes("A: Dune 3"), "error and data side by side");
  });

  it("enabled: false sends nothing until it becomes true", async () => {
    const { client, requests } = makeClient();
    const view = mount(client, h(Stock, { id: "b1", label: "A", opts: { enabled: false } }));
    await waitForText(view.container, (t) => t === "A: idle", "idle");
    expect(requests()).toEqual([]);
    view.rerender(h(Stock, { id: "b1", label: "A", opts: { enabled: true } }));
    await waitForText(view.container, (t) => t === "A: Dune 3", "loaded once enabled");
    expect(requests()).toEqual([["book"]]);
  });

  it("new arguments move the subscription: one open watch, and the old book's changes no longer show", async () => {
    const { client, open } = makeClient();
    const log: string[] = [];
    const view = mount(client, h(Stock, { id: "b1", label: "A", log }));
    await waitForText(view.container, (t) => t === "A: Dune 3", "b1");
    expect(open()).toBe(1);
    view.rerender(h(Stock, { id: "b2", label: "A", log }));
    await waitForText(view.container, (t) => t === "A: Emma 7", "b2");
    expect(open()).toBe(1);
    const afterSwitch = log.length;
    await client.command("restock", { id: "b1", qty: 1 });
    await client.command("restock", { id: "b2", qty: 1 });
    await waitForText(view.container, (t) => t === "A: Emma 8", "b2 patched");
    expect(log.slice(afterSwitch).some((l) => l.includes("Dune"))).toBe(false);
  });

  it("refetch picks up a change made behind the cache's back", async () => {
    const { client, requests } = makeClient();
    const view = mount(client, h(Stock, { id: "b1", label: "A" }));
    await waitForText(view.container, (t) => t === "A: Dune 3", "loaded");
    books.get("b1")!.stock = 42; // no command, so no patch reaches the client
    expect(view.text()).toBe("A: Dune 3");
    const before = requests().length;
    await queries["A"]!.refetch();
    await waitForText(view.container, (t) => t === "A: Dune 42", "refetched");
    expect(requests().length).toBe(before + 1);
  });

  it("mounting a query that ran before shows the cached result at once while it refreshes", async () => {
    const { client } = makeClient();
    const first: string[] = [];
    const a = mount(client, h(Stock, { id: "b1", label: "A", log: first }));
    await waitForText(a.container, (t) => t === "A: Dune 3", "first mount loaded");
    a.unmount();
    const second: string[] = [];
    const b = mount(client, h(Stock, { id: "b1", label: "A", log: second }));
    await waitForText(b.container, (t) => t === "A: Dune 3", "second mount refreshed");
    expect(first[0]).toBe("A: loading");
    expect(second[0]).toBe("A: Dune 3 (refreshing)");
  });
});

describe("useCommand", () => {
  it("shows running while the command is in flight, then the result", async () => {
    const { client } = makeClient();
    const view = mount(client, h("div", null, h(Stock, { id: "b1", label: "A" }), h(Command, { op: "restock", label: "R" })));
    await waitForText(view.container, (t) => t.includes("A: Dune 3") && t.includes("R: ready"), "ready");
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const done = commands["R"]!.run({ id: "b1", qty: 1 });
    await waitForText(view.container, (t) => t.includes("R: running"), "running");
    release();
    expect((await done).stock).toBe(4);
    await waitForText(view.container, (t) => t.includes("R: done 4") && t.includes("A: Dune 4"), "done");
  });

  it("a declared error lands in state.error and rejects the returned promise; nothing changes", async () => {
    const { client } = makeClient();
    const view = mount(client, h("div", null, h(Stock, { id: "b1", label: "A" }), h(Command, { op: "buy", label: "X" })));
    await waitForText(view.container, (t) => t.includes("A: Dune 3"), "loaded");
    const failed = commands["X"]!.run({ id: "b1", qty: 10 });
    await waitForText(view.container, (t) => t.includes("X: failed OutOfStock"), "failure shown");
    const e = await failed.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(RayfoldClientError);
    expect((e as RayfoldClientError).is("OutOfStock")).toBe(true);
    expect((e as RayfoldClientError).data).toEqual({ available: 3 });
    expect(view.text()).toContain("A: Dune 3");
    expect(books.get("b1")!.stock).toBe(3);
    // guard: a purchase that fits goes through and updates the book on screen
    await commands["X"]!.run({ id: "b1", qty: 2 });
    await waitForText(view.container, (t) => t.includes("X: done 1") && t.includes("A: Dune 1"), "bought");
  });

  it("runs that share an idempotency key are one purchase: the retry answers with the first result and sells nothing more", async () => {
    const { client, requests } = makeClient();
    const view = mount(client, h("div", null, h(Stock, { id: "b1", label: "A" }), h(Command, { op: "buy", label: "X", options: { key: "buy-b1-0123456789" } })));
    await waitForText(view.container, (t) => t.includes("A: Dune 3") && t.includes("X: ready"), "ready");
    const first = await commands["X"]!.run({ id: "b1", qty: 1 });
    const retry = await commands["X"]!.run({ id: "b1", qty: 1 });
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ id: "b1", stock: 2 });
    expect(books.get("b1")!.stock).toBe(2);
    expect(requests()).toEqual([["book"], ["buy"], ["buy"]]);
    await waitForText(view.container, (t) => t.includes("A: Dune 2") && t.includes("X: done 2"), "one purchase on screen");
  });

  it("guard: runs without a key are separate purchases", async () => {
    const { client, requests } = makeClient();
    const view = mount(client, h("div", null, h(Stock, { id: "b1", label: "A" }), h(Command, { op: "buy", label: "X" })));
    await waitForText(view.container, (t) => t.includes("A: Dune 3") && t.includes("X: ready"), "ready");
    await commands["X"]!.run({ id: "b1", qty: 1 });
    await commands["X"]!.run({ id: "b1", qty: 1 });
    expect(books.get("b1")!.stock).toBe(1);
    expect(requests()).toEqual([["book"], ["buy"], ["buy"]]);
    await waitForText(view.container, (t) => t.includes("A: Dune 1") && t.includes("X: done 1"), "two purchases on screen");
  });

  it("only the latest run speaks for the state, whichever of the runs finishes last", async () => {
    const { client } = makeClient();
    const view = mount(client, h(Command, { op: "restock", label: "R" }));
    await waitForText(view.container, (t) => t === "R: ready", "ready");
    const release: Array<() => void> = [];
    const hold = () => (gate = new Promise<void>((r) => release.push(r)));
    // one at a time onto the server, each held by its own gate, so the test decides which finishes first
    hold();
    const first = commands["R"]!.run({ id: "b1", qty: 1 });
    await arrived.atLeast(1, "the first run reaching the server");
    hold();
    const second = commands["R"]!.run({ id: "b1", qty: 2 });
    await arrived.atLeast(2, "the second run reaching the server");

    release[1]!();
    expect((await second).stock).toBe(5);
    await waitForText(view.container, (t) => t === "R: done 5", "the second run's result");
    release[0]!();
    expect((await first).stock).toBe(6); // its caller still gets its own answer

    // the barrier: a third run's update is queued after anything the first run's answer could have queued
    hold();
    const third = commands["R"]!.run({ id: "b1", qty: 4 });
    await waitForText(view.container, (t) => t === "R: running", "the third run under way");
    const { data, error, running } = commands["R"]!.state;
    expect([data?.stock, error, running]).toEqual([5, undefined, true]);
    release[2]!();
    expect((await third).stock).toBe(10);
    await waitForText(view.container, (t) => t === "R: done 10", "the third run's result");
  });

  it("an unawaited failing run leaves no unhandled rejection behind", async () => {
    const { client } = makeClient();
    const view = mount(client, h(Command, { op: "buy", label: "X" }));
    await waitForText(view.container, (t) => t === "X: ready", "ready");
    void commands["X"]!.run({ id: "b1", qty: 99 });
    await waitForText(view.container, (t) => t === "X: failed OutOfStock", "failure shown");
    // vitest fails the run on an unhandled rejection; give one full event-loop turn for it to surface
    await new Promise<void>((r) => setImmediate(r));
  });
});

describe("useLive", () => {
  it("another user's change is pushed to the component, with no request from this client", async () => {
    const alice = makeClient("alice");
    const bob = makeClient("bob");
    const carol = makeClient("carol");
    const live = mount(alice.client, h(LiveStock, { id: "b1", label: "L" }));
    const plain = mount(carol.client, h(Stock, { id: "b1", label: "P" }));
    await waitForText(live.container, (t) => t === "L: 3", "live loaded");
    await waitForText(plain.container, (t) => t === "P: Dune 3", "plain loaded");
    const before = alice.requests().length;
    await bob.client.command("restock", { id: "b1", qty: 4 });
    await waitForText(live.container, (t) => t === "L: 7", "change pushed");
    expect(alice.requests().length).toBe(before);
    // guard: a component on a client without a live query keeps what it fetched
    expect(plain.text()).toBe("P: Dune 3");
  });
});

describe("lifecycle", () => {
  it("unmounting closes every subscription and aborts the live stream, also under StrictMode", async () => {
    const { client, open, sent } = makeClient();
    const view = mount(client, h("div", null, h(Stock, { id: "b1", label: "A" }), h(Stock, { id: "b2", label: "C" }), h(LiveStock, { id: "b1", label: "L" })), { strict: true });
    await waitForText(view.container, (t) => t.includes("A: Dune 3") && t.includes("C: Emma 7") && t.includes("L: 3"), "all loaded");
    expect(open()).toBe(3);
    const liveRequests = sent.filter((s) => s.live);
    // StrictMode mounts, unmounts and mounts again: the first stream was aborted by that unmount, the second is open
    expect(liveRequests.map((s) => s.signal?.aborted)).toEqual([true, false]);
    view.unmount();
    expect(open()).toBe(0);
    expect(liveRequests.map((s) => s.signal?.aborted)).toEqual([true, true]);
  });

  it("server rendering renders the loading state and sends no request; the browser then fetches", async () => {
    const { client, requests } = makeClient();
    const html = renderToString(h(RayfoldProvider, { client }, h(Stock, { id: "b1", label: "A" })));
    expect(html).toContain("A: loading");
    expect(requests()).toEqual([]);
    const view = mount(client, h(Stock, { id: "b1", label: "A" }));
    await waitForText(view.container, (t) => t === "A: Dune 3", "fetched in the browser");
    expect(requests()).toEqual([["book"]]);
  });

  it("a hook outside a provider says how to fix it", () => {
    expect(() => renderToString(h(Stock, { id: "b1", label: "A" }))).toThrow(/RayfoldProvider/);
  });
});
