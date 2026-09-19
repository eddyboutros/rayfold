import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Injector,
  runInInjectionContext,
  signal,
  ɵChangeDetectionScheduler as ChangeDetectionScheduler,
  ɵEffectScheduler as EffectScheduler,
} from "@angular/core";
import { MemoryCounters, createRayfoldServer, listen, shutdown, type RayfoldServer } from "@rayfold/server";
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { bounded } from "../../../e2e/wait.ts";
import { injectCommand, injectLive, injectQuery, injectRayfoldClient, provideRayfold } from "./index.ts";

/**
 * The bindings against a real server on a loopback port, so every test drives inject -> client -> server -> cache ->
 * signal. No DOM and no TestBed: signals are plain values and an `Injector` is all an `inject*` needs, which is one
 * of the reasons this fits Angular better than a hook API fits React.
 */
const SCHEMA = `
entity Book { id: ID  title: String  stock: Int }
query book(id: ID): Book?
command restock(id: ID, qty: Int): Book
`;

let http: Server | undefined;
let rayfold: RayfoldServer | undefined;
const stock = new Map<string, { id: string; title: string; stock: number }>();

/**
 * What an application's change detection does for us: hold the effects Angular schedules, and run them when asked.
 * An application provides this; an `Injector` on its own does not, and without it `effect()` cannot even be created.
 */
function effects(): { providers: unknown[]; flush: () => void } {
  const queued = new Set<{ dirty: boolean; run(): void }>();
  const scheduler = {
    add: (h: { dirty: boolean; run(): void }) => queued.add(h),
    schedule: () => {},
    remove: (h: { dirty: boolean; run(): void }) => queued.delete(h),
    // Angular refuses a scheduler that runs watches while scheduling, so notify() records and the test flushes.
    flush: () => {
      for (const h of [...queued]) if (h.dirty) h.run();
    },
  };
  return {
    providers: [
      { provide: EffectScheduler, useValue: scheduler },
      { provide: ChangeDetectionScheduler, useValue: { notify: () => {} } },
    ],
    flush: () => scheduler.flush(),
  };
}

async function start(): Promise<{ client: RayfoldClient; injector: Injector; counters: MemoryCounters; flush: () => void }> {
  stock.set("b1", { id: "b1", title: "Dune", stock: 5 });
  const counters = new MemoryCounters();
  const server = createRayfoldServer({
    counters,
    schema: SCHEMA,
    resolvers: {
      Query: { book: ({ id }: { id: string }) => stock.get(id) ?? null },
      Command: {
        restock: ({ id, qty }: { id: string; qty: number }) => {
          const b = stock.get(id)!;
          b.stock += qty;
          return b;
        },
      },
    },
  });
  rayfold = server;
  http = await listen(server, 0, { viewer: () => ({ id: "u1" }) });
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/rayfold`;
  const client = new RayfoldClient({ transport: createFetchTransport({ url }) });
  const scheduled = effects();
  return {
    client,
    injector: Injector.create({ providers: [...provideRayfold(client), ...scheduled.providers] as never[] }),
    counters,
    flush: scheduled.flush,
  };
}

afterEach(async () => {
  // a live query holds its connection open, so plain close() would wait for it: shutdown() drains first, ends the
  // subscriptions with a retryable error, and only then closes
  if (rayfold && http) await shutdown(rayfold, http, { timeoutMs: 2_000, flushMs: 200 });
  http = undefined;
  rayfold = undefined;
  stock.clear();
});

/** Waits, bounded, for a signal to satisfy `done` — the client answers over a real socket, so this is not instant. */
async function until<T>(read: () => T, done: (v: T) => boolean, label: string): Promise<T> {
  await bounded(
    (async () => {
      while (!done(read())) await new Promise<void>((r) => setTimeout(r, 5));
    })(),
    label,
  );
  return read();
}

describe("injectQuery", () => {
  it("is in flight the moment it is injected, and lands in the signals", async () => {
    const { injector } = await start();
    const q = runInInjectionContext(injector, () => injectQuery<{ title: string }>("book", { id: "b1" }, { shape: "{ id title stock }" }));
    // subscribed synchronously: no change detection has run, and it is already loading
    expect(q.loading()).toBe(true);
    expect(q.data()).toBeUndefined();

    await until(() => q.loading(), (l) => !l, "the query settled");
    expect(q.data()?.title).toBe("Dune");
    expect(q.error()).toBeUndefined();
  });

  it("sends nothing when it is not enabled", async () => {
    const { injector } = await start();
    const q = runInInjectionContext(injector, () => injectQuery("book", { id: "b1" }, { enabled: false }));
    expect(q.loading()).toBe(false);
    expect(q.data()).toBeUndefined();
  });

  it("reports a failure without throwing", async () => {
    const { injector } = await start();
    const q = runInInjectionContext(injector, () => injectQuery("book", { id: "b1" }, { shape: "{ nope }" }));
    await until(() => q.error(), (e) => e !== undefined, "the failure arrived");
    expect(q.loading()).toBe(false);
  });

  it("runs again when a signal the arguments read changes", async () => {
    stock.set("b2", { id: "b2", title: "Kindred", stock: 2 });
    const { injector, flush } = await start();
    const id = signal("b1");
    const q = runInInjectionContext(injector, () => injectQuery<{ title: string }>("book", () => ({ id: id() }), { shape: "{ id title stock }" }));
    await until(() => q.data()?.title, (t) => t === "Dune", "the first book");

    id.set("b2");
    flush();
    await until(() => q.data()?.title, (t) => t === "Kindred", "the query following the signal");
  });

  it("waits until enabled says so, then sends", async () => {
    // the shape every detail screen has: the id is not known when the component is created
    const { injector, counters, flush } = await start();
    const ready = signal(false);
    const q = runInInjectionContext(injector, () =>
      injectQuery<{ title: string }>("book", { id: "b1" }, { shape: "{ id title stock }", enabled: () => ready() }),
    );
    expect(q.loading()).toBe(false);
    expect(sent(counters)).toBe(0); // guard: nothing was asked of the server, not merely hidden from the signals

    ready.set(true);
    flush();
    await until(() => q.data()?.title, (t) => t === "Dune", "the query that was waiting to be enabled");
    expect(sent(counters)).toBe(1);
  });
});

/** Queries the server actually ran, from its own counters: the only honest way to assert that nothing was sent. */
function sent(counters: MemoryCounters): number {
  return counters.snapshot().find((e) => e.name === "rayfold.ops" && e.labels["kind"] === "query")?.count ?? 0;
}

describe("injectCommand", () => {
  it("runs, and the cache updates the query that shows the same entity", async () => {
    const { injector } = await start();
    const q = runInInjectionContext(injector, () => injectQuery<{ stock: number }>("book", { id: "b1" }, { shape: "{ id title stock }" }));
    await until(() => q.data(), (d) => d !== undefined, "the first result");
    expect(q.data()?.stock).toBe(5);

    const cmd = runInInjectionContext(injector, () => injectCommand<{ stock: number }>("restock"));
    expect(cmd.running()).toBe(false);
    await cmd.run({ id: "b1", qty: 3 });

    expect(cmd.data()?.stock).toBe(8);
    expect(cmd.running()).toBe(false);
    // the point of the binding: the query updated from the command's patch, with no refetch
    await until(() => q.data()?.stock, (s) => s === 8, "the query saw the command's patch");
  });

  it("keeps a failure in the signals rather than only rejecting", async () => {
    const { injector } = await start();
    const cmd = runInInjectionContext(injector, () => injectCommand("restock"));
    await expect(cmd.run({ id: "nope", qty: 1 })).rejects.toBeDefined();
    expect(cmd.error()).toBeDefined();
    expect(cmd.running()).toBe(false);
  });
});

describe("injectLive", () => {
  it("receives what a command changed, whoever ran it", async () => {
    const { client, injector } = await start();
    const live = runInInjectionContext(injector, () => injectLive<{ stock: number }>("book", { id: "b1" }, { shape: "{ id title stock }" }));
    await until(() => live.data(), (d) => d !== undefined, "the first live result");
    expect(live.data()?.stock).toBe(5);

    await client.command("restock", { id: "b1", qty: 2 });
    await until(() => live.data()?.stock, (s) => s === 7, "the live query saw the change");
  });

  it("moves to another subscription when its arguments change, and ends the old one", async () => {
    // what every screen with a filter does; leaking the old subscription would leave the server re-running a query
    // nobody is reading
    stock.set("b2", { id: "b2", title: "Kindred", stock: 2 });
    const { injector, counters, flush } = await start();
    const id = signal("b1");
    const live = runInInjectionContext(injector, () => injectLive<{ title: string }>("book", () => ({ id: id() }), { shape: "{ id title stock }" }));
    await until(() => live.data()?.title, (t) => t === "Dune", "the first subscription");

    id.set("b2");
    flush();
    await until(() => live.data()?.title, (t) => t === "Kindred", "the subscription following the signal");
    await until(() => counted(counters, "rayfold.live.closed"), (n) => n === 1, "the first subscription ending");
    expect(counted(counters, "rayfold.live.opened")).toBe(2);
  });
});

const counted = (counters: MemoryCounters, name: string): number => counters.snapshot().find((e) => e.name === name)?.count ?? 0;

describe("provideRayfold", () => {
  it("says what is missing when nothing provided a client", () => {
    const empty = Injector.create({ providers: [] });
    expect(() => runInInjectionContext(empty, () => injectRayfoldClient())).toThrow(/provideRayfold/);
  });

  it("gives the same client back", async () => {
    const { client, injector } = await start();
    expect(runInInjectionContext(injector, () => injectRayfoldClient())).toBe(client);
  });
});
