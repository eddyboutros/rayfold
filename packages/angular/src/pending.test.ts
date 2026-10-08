/**
 * An application is stable once nothing is awaited: `whenStable()` in a test, and server rendering, wait for that.
 * These tests run Angular's own `ApplicationRef` and `PendingTasks`, in a root injector with zoneless change detection
 * as an application has, and check that a query, a live query and a command each keep it from being stable for as
 * long as their answer is awaited, and no longer.
 *
 * The bookshop answers nothing until the application has ticked once. Angular's scheduler holds the application
 * unstable until that tick on its own account, so an answer that came sooner would make every test here pass whether
 * the bindings held a task or not.
 */
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import {
  ApplicationRef,
  EnvironmentInjector,
  Injector,
  afterNextRender,
  createEnvironmentInjector,
  provideZonelessChangeDetection,
  runInInjectionContext,
  signal,
  ɵINJECTOR_SCOPE as INJECTOR_SCOPE,
} from "@angular/core";
import { RayfoldClient, createLocalTransport } from "@rayfold/client";
import { collect } from "@rayfold/client/testing";
import { createRayfoldServer } from "@rayfold/server";
import type { RequestEnvelope } from "@rayfold/server/protocol";
import { bounded } from "../../../e2e/wait.ts";
import { resolvers, seed, type Viewer } from "../../../examples/typescript/src/resolvers.ts";
import { injectCommand, injectLive, injectQuery, provideRayfold } from "./index.ts";

interface Book {
  id: string;
  stock: number;
}

let open: EnvironmentInjector | undefined;
afterEach(() => {
  open?.destroy();
  open = undefined;
});

function start(viewer: Viewer | null = { id: "s1", role: "staff" }) {
  const store = seed();
  let count: (name: string) => void = () => {};
  const counted = collect<string>((next) => ((count = next), () => {}));
  const schema = readFileSync(new URL("../../../examples/typescript/src/bookshop.rayfold", import.meta.url), "utf8");
  const server = createRayfoldServer({ schema, resolvers: resolvers(store), counters: { add: (name) => count(name) } });
  let release = () => {};
  const ticked = new Promise<void>((r) => (release = r));
  const sent: string[] = [];
  const held = {
    async *execute(envelope: RequestEnvelope, opts?: { viewer?: unknown; signal?: AbortSignal }) {
      sent.push(...envelope.ops.map((op) => op.op));
      await ticked;
      yield* server.execute(envelope, opts);
    },
  };
  const client = new RayfoldClient({ transport: createLocalTransport(held, () => viewer) });
  // Injector.create makes the R3Injector an environment injector needs above it; the root scope is what brings
  // ApplicationRef and PendingTasks, both `providedIn: "root"`, as bootstrapping an application does
  const injector = createEnvironmentInjector(
    [{ provide: INJECTOR_SCOPE, useValue: "root" }, provideZonelessChangeDetection(), provideRayfold(client)],
    Injector.create({ providers: [] }) as EnvironmentInjector,
  );
  open = injector;
  afterNextRender(() => release(), { injector });
  const app = injector.get(ApplicationRef);
  /**
   * Waits for `whenStable()`, and answers what `read` returned at the very moment the application turned stable, which
   * `whenStable()` reports only a little later. Fails, saying so, if it never is.
   */
  const stable = async <T>(read: () => T, what: string): Promise<T> => {
    let first: { value: T } | undefined;
    const watching = app.isStable.subscribe((now) => void (now && !first && (first = { value: read() })));
    try {
      await bounded(app.whenStable(), `stable: ${what}`, 4000);
    } finally {
      watching.unsubscribe();
    }
    if (!first) throw new Error(`whenStable() resolved, but isStable never said so: ${what}`);
    return first.value;
  };
  return { injector, stable, sent, counted, server, store, client };
}

it("a query keeps the application unstable until its result is in the signal", async () => {
  const { injector, stable } = start();
  const book = runInInjectionContext(injector, () => injectQuery<Book>("book", { id: "b1" }, { shape: "{ id stock }" }));
  expect([book.loading(), book.data()]).toEqual([true, undefined]);

  expect(await stable(() => [book.loading(), book.data()], "the book")).toEqual([false, { $type: "Book", id: "b1", stock: 3 }]);
});

it("a query the server refuses lets the application be stable once the refusal is in the signal", async () => {
  const { injector, stable } = start({ id: "u1", role: "customer" });
  const book = runInInjectionContext(injector, () => injectQuery<Book>("book", { id: "b1" }, { shape: "{ id costPrice }" }));

  const [loading, error] = await stable(() => [book.loading(), book.error()], "the refusal");
  expect(loading).toBe(false);
  expect(error).toMatchObject({ name: "RayfoldClientError", code: "permission_denied", path: "costPrice" });
});

it("guard: a query that is not enabled sends nothing, and the application is stable without it", async () => {
  const { injector, stable, sent } = start();
  const book = runInInjectionContext(injector, () => injectQuery<Book>("book", { id: "b1" }, { enabled: false }));

  expect(await stable(() => [book.loading(), book.data()], "nothing to wait for")).toEqual([false, undefined]);
  expect(sent).toEqual([]);
});

it("a query whose arguments change waits for the new book, not the one it asked for first", async () => {
  const { injector, stable, sent } = start();
  const id = signal("b1");
  const book = runInInjectionContext(injector, () => injectQuery<Book>("book", () => ({ id: id() }), { shape: "{ id stock }" }));
  id.set("b3"); // before anything has answered: the first request is still on its way

  expect(await stable(() => book.data(), "the second book")).toEqual({ $type: "Book", id: "b3", stock: 7 });
  expect(sent).toEqual(["book", "book"]);
});

it("a query switched off while its answer is awaited lets the application be stable", async () => {
  const { injector, stable } = start();
  const on = signal(true);
  const book = runInInjectionContext(injector, () => injectQuery<Book>("book", { id: "b1" }, { enabled: () => on(), shape: "{ id stock }" }));
  on.set(false);

  expect(await stable(() => [book.loading(), book.data()], "the query switched off")).toEqual([false, undefined]);
});

it("a live query keeps the application unstable until its first result only, however long it stays open", async () => {
  const { injector, stable, counted, server, client } = start();
  const book = runInInjectionContext(injector, () => injectLive<Book>("book", { id: "b3" }, { shape: "{ id stock }" }));

  // still subscribed, and the application is stable all the same
  expect(await stable(() => [book.data()?.stock, server.changes.size], "the first result")).toEqual([7, 1]);

  await client.command("restock", { bookId: "b3", qty: 2 });
  expect(await stable(() => book.data()?.stock, "after the restock")).toBe(9);

  injector.destroy();
  open = undefined;
  while ((await counted.next("the live query closing")) !== "rayfold.live.closed");
  expect(server.changes.size).toBe(0);
});

it("a live query switched off before its first result lets the application be stable", async () => {
  const { injector, stable, server } = start();
  const on = signal(true);
  const book = runInInjectionContext(injector, () => injectLive<Book>("book", { id: "b3" }, { enabled: () => on(), shape: "{ id stock }" }));
  on.set(false);

  expect(await stable(() => [book.loading(), book.data(), server.changes.size], "the live query switched off")).toEqual([false, undefined, 0]);
});

it("a live query destroyed before its first result lets the application be stable", async () => {
  const { injector, stable, server } = start();
  const view = createEnvironmentInjector([], injector);
  runInInjectionContext(view, () => injectLive<Book>("book", { id: "b3" }, { shape: "{ id stock }" }));
  view.destroy();

  expect(await stable(() => server.changes.size, "the destroyed live query")).toBe(0);
});

it("a live query the server refuses lets the application be stable once the refusal is in the signal", async () => {
  const { injector, stable, server } = start({ id: "u1", role: "customer" });
  const book = runInInjectionContext(injector, () => injectLive<Book>("book", { id: "b3" }, { shape: "{ id costPrice }" }));

  const [loading, error, subscribed] = await stable(() => [book.loading(), book.error(), server.changes.size], "the refusal");
  expect([loading, subscribed]).toEqual([false, 0]);
  expect(error).toMatchObject({ code: "permission_denied", path: "costPrice" });
});

it("a command keeps the application unstable while it runs, whether it succeeds or is refused", async () => {
  const { injector, stable, store } = start();
  const [restock, buy] = runInInjectionContext(injector, () => [injectCommand<Book>("restock"), injectCommand<Book>("buy")]);

  const restocked = restock.run({ bookId: "b2", qty: 4 });
  expect(await stable(() => [restock.running(), restock.data()?.stock, store.books.get("b2")?.stock], "the restock")).toEqual([false, 4, 4]);
  await restocked;

  const refused = buy.run({ bookId: "b2", qty: 9 });
  refused.catch(() => {});
  const [running, error] = await stable(() => [buy.running(), buy.error()], "the refused purchase");
  expect(running).toBe(false);
  expect(error).toMatchObject({ code: "domain", type: "OutOfStock", data: { bookId: "b2", available: 4 } });
  await expect(refused).rejects.toMatchObject({ type: "OutOfStock" });
});

it("a query destroyed before its answer came lets the application be stable", async () => {
  const { injector, stable } = start();
  // a component's injector, below the application's
  const view = createEnvironmentInjector([], injector);
  runInInjectionContext(view, () => injectQuery<Book>("book", { id: "b1" }));
  view.destroy();

  // nothing is left to take the answer, so nothing may hold the application for it
  expect(await stable(() => "stable", "the destroyed query")).toBe("stable");
});
