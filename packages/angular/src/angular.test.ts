import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Injector,
  type DestroyableInjector,
  runInInjectionContext,
  signal,
  untracked,
  ɵChangeDetectionScheduler as ChangeDetectionScheduler,
  ɵEffectScheduler as EffectScheduler,
} from "@angular/core";
import { createWatch } from "@angular/core/primitives/signals";
import { MemoryCounters, RayfoldError, createRayfoldServer, listen, shutdown, type RayfoldServer } from "@rayfold/server";
import { RayfoldClient, RayfoldClientError, createFetchTransport } from "@rayfold/client";
import { Signal, bounded } from "../../../e2e/wait.ts";
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
/** While set, the book query fails with it: a query that answered once can then fail. */
let refusal: RayfoldError | undefined;
/** A restock of this quantity waits for its gate to open, so a test decides the order overlapping runs finish in. */
const gates = new Map<number, Promise<void>>();
/** The quantity of every restock, as the server starts it. */
let restocking = new Signal<number>();

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

async function start(): Promise<{ client: RayfoldClient; injector: DestroyableInjector; counters: CountingCounters; flush: () => void }> {
  stock.set("b1", { id: "b1", title: "Dune", stock: 5 });
  const counters = new CountingCounters();
  const server = createRayfoldServer({
    counters,
    schema: SCHEMA,
    resolvers: {
      Query: {
        book: ({ id }: { id: string }) => {
          if (refusal) throw refusal;
          return stock.get(id) ?? null;
        },
      },
      Command: {
        restock: async ({ id, qty }: { id: string; qty: number }) => {
          restocking.push(qty);
          await gates.get(qty);
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
  gates.clear();
  refusal = undefined;
  restocking = new Signal<number>();
});

/**
 * Waits, bounded, for what `read` returns to satisfy `done`: checked now and each time a signal it reads changes, so it
 * wakes on the change itself rather than on a timer.
 */
async function until<T>(read: () => T, done: (v: T) => boolean, label: string): Promise<T> {
  let watch: ReturnType<typeof createWatch> | undefined;
  const reached = new Promise<void>((resolve) => {
    watch = createWatch(() => void (done(read()) && resolve()), (dirty) => queueMicrotask(() => dirty.run()), false);
    watch.run();
  });
  try {
    await bounded(reached, `${label} (now: ${JSON.stringify(untracked(read))})`);
  } finally {
    watch?.destroy();
  }
  return read();
}

/** What the server counted, by name, as it counts it: a test waits on the count it needs instead of polling. */
class CountingCounters extends MemoryCounters {
  readonly added = new Signal<string>();
  override add(name: string, n = 1, labels: Record<string, string> = {}): void {
    super.add(name, n, labels);
    this.added.push(name);
  }
  /** Resolves once `name` has been counted `times` times. */
  reach(name: string, times: number, label: string): Promise<unknown> {
    return this.added.until(() => counted(this, name) === times, label);
  }
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

  it("a query that fails after it answered keeps its data beside the error, and the next result clears the error", async () => {
    const { injector } = await start();
    const q = runInInjectionContext(injector, () => injectQuery<{ stock: number }>("book", { id: "b1" }, { shape: "{ id title stock }" }));
    await until(() => q.loading(), (l) => !l, "the first result");
    refusal = new RayfoldError("unavailable", "The shop is closed");
    await q.refetch();
    expect([q.data(), (q.error() as RayfoldClientError).code, q.loading()]).toEqual([
      { $type: "Book", id: "b1", title: "Dune", stock: 5 },
      "unavailable",
      false,
    ]);
    // guard: the error is not kept for good either. The next answer clears it, even one that changes nothing, so
    // nothing in the cache moves to clear it on the refetch's behalf
    refusal = undefined;
    await q.refetch();
    expect([q.data()?.stock, q.error()]).toEqual([5, undefined]);
  });

  it("sends nothing when it is not enabled", async () => {
    const { client, injector, counters } = await start();
    const q = runInInjectionContext(injector, () => injectQuery("book", { id: "b1" }, { enabled: false }));
    expect(q.loading()).toBe(false);
    expect(q.data()).toBeUndefined();
    // the barrier: a query of its own, asked after the injected one would have been, answered by the same server
    await client.query("book", { id: "b2" }, { shape: "{ id }" });
    expect(sent(counters)).toBe(1); // the barrier's, and nothing from the query that is not enabled
  });

  it("reports a failure without throwing", async () => {
    const { injector } = await start();
    const q = runInInjectionContext(injector, () => injectQuery("book", { id: "b1" }, { shape: "{ nope }" }));
    await until(() => q.error(), (e) => e !== undefined, "the failure arrived");
    expect(q.error()).toBeInstanceOf(RayfoldClientError);
    expect((q.error() as RayfoldClientError).code).toBe("invalid_argument");
    expect(q.loading()).toBe(false);
  });

  it("refetch asks the server again, past the cache, and shows what it answers now", async () => {
    const { injector, counters } = await start();
    const q = runInInjectionContext(injector, () => injectQuery<{ stock: number }>("book", { id: "b1" }, { shape: "{ id title stock }" }));
    await until(() => q.data(), (d) => d !== undefined, "the first result");
    expect([q.data()?.stock, sent(counters)]).toEqual([5, 1]);

    stock.get("b1")!.stock = 9; // changed behind the API's back: no patch reaches the cache
    await q.refetch();
    expect([q.data()?.stock, q.error(), q.loading(), sent(counters)]).toEqual([9, undefined, false, 2]);
  });

  it("stops following the cache once its injector is destroyed", async () => {
    const { client, injector } = await start();
    const shape = "{ id title stock }";
    const q = runInInjectionContext(injector, () => injectQuery<{ stock: number }>("book", { id: "b1" }, { shape }));
    // guard: a query on an injector that lives on still follows, and is the barrier for the destroyed one
    const other = Injector.create({ providers: [...provideRayfold(client)] as never[] });
    const kept = runInInjectionContext(other, () => injectQuery<{ stock: number }>("book", { id: "b1" }, { shape }));
    await until(() => [q.data()?.stock, kept.data()?.stock], ([a, b]) => a === 5 && b === 5, "both results");

    injector.destroy();
    await client.command("restock", { id: "b1", qty: 3 }, { shape });
    await until(() => kept.data()?.stock, (s) => s === 8, "the living query saw the command's patch");
    expect(q.data()?.stock).toBe(5);
    other.destroy();
  });

  it("runs again when a signal the arguments read changes", async () => {
    stock.set("b2", { id: "b2", title: "Kindred", stock: 2 });
    const { client, injector, flush } = await start();
    const id = signal("b1");
    const q = runInInjectionContext(injector, () => injectQuery<{ title: string }>("book", () => ({ id: id() }), { shape: "{ id title stock }" }));
    await until(() => q.data()?.title, (t) => t === "Dune", "the first book");

    id.set("b2");
    flush();
    await until(() => q.data()?.title, (t) => t === "Kindred", "the query following the signal");
    // the first book's watch ended with the move: its change, patched into the cache, reaches nothing here
    await client.command("restock", { id: "b1", qty: 1 }, { shape: "{ id title stock }" });
    expect(q.data()).toEqual({ $type: "Book", id: "b2", title: "Kindred", stock: 2 });
    // guard: the book it follows now still reaches it
    await client.command("restock", { id: "b2", qty: 1 }, { shape: "{ id title stock }" });
    expect(q.data()).toEqual({ $type: "Book", id: "b2", title: "Kindred", stock: 3 });
  });

  it("an effect run that comes to the same call sends nothing again; one that changes it sends once", async () => {
    stock.set("b2", { id: "b2", title: "Kindred", stock: 2 });
    const { client, injector, counters, flush } = await start();
    const id = signal("b1");
    const unrelated = signal(0);
    // reads a signal that does not change the call, as a component's arguments often do
    const q = runInInjectionContext(injector, () => injectQuery<{ title: string }>("book", () => (unrelated(), { id: id() }), { shape: "{ id title stock }" }));
    await until(() => q.data()?.title, (t) => t === "Dune", "the first book");
    flush(); // the effect's first run, which only learns what the call reads
    unrelated.set(1);
    flush();
    await client.query("book", { id: "b1" }, { shape: "{ id }" }); // the barrier
    expect(sent(counters)).toBe(2); // the first book's and the barrier's

    id.set("b2");
    flush();
    await until(() => q.data()?.title, (t) => t === "Kindred", "the second book");
    unrelated.set(2);
    flush();
    await client.query("book", { id: "b1" }, { shape: "{ id }" });
    expect(sent(counters)).toBe(4); // guard: the move sent one request, and the run after it none
  });

  it("injected again after a query ran, a refusal keeps the cached result beside the error", async () => {
    const { client, injector } = await start();
    const shape = "{ id title stock }";
    await client.query("book", { id: "b1" }, { shape });
    refusal = new RayfoldError("unavailable", "The shop is closed");
    const q = runInInjectionContext(injector, () => injectQuery<{ stock: number }>("book", { id: "b1" }, { shape }));
    expect([q.data()?.stock, q.loading()]).toEqual([5, true]);
    await until(() => q.loading(), (l) => !l, "the refusal");
    expect([q.data(), (q.error() as RayfoldClientError).code]).toEqual([{ $type: "Book", id: "b1", title: "Dune", stock: 5 }, "unavailable"]);
    // guard: a call the cache holds nothing for has nothing to keep
    const other = runInInjectionContext(injector, () => injectQuery<{ stock: number }>("book", { id: "b2" }, { shape }));
    await until(() => other.loading(), (l) => !l, "the other refusal");
    expect([other.data(), (other.error() as RayfoldClientError).code]).toEqual([undefined, "unavailable"]);
  });

  it("refetch asks the server even for a query that reads the cache or is not enabled, and its answer clears an error", async () => {
    const { injector, counters } = await start();
    const shape = "{ id title stock }";
    const [cacheFirst, off] = runInInjectionContext(injector, () => [
      injectQuery<{ stock: number }>("book", { id: "b1" }, { shape, policy: "cache" }),
      injectQuery<{ stock: number }>("book", { id: "b1" }, { shape, enabled: false }),
    ]);
    await until(() => cacheFirst.data()?.stock, (s) => s === 5, "the cache-first query");
    stock.get("b1")!.stock = 9; // behind the cache's back
    await cacheFirst.refetch();
    expect([cacheFirst.data()?.stock, sent(counters)]).toEqual([9, 2]);

    refusal = new RayfoldError("unavailable", "The shop is closed");
    await off.refetch();
    expect([off.data(), (off.error() as RayfoldClientError).code]).toEqual([undefined, "unavailable"]);
    refusal = undefined;
    await off.refetch();
    expect([off.data()?.stock, off.error(), off.loading(), sent(counters)]).toEqual([9, undefined, false, 4]);
  });

  it("waits until enabled says so, then sends", async () => {
    // the shape every detail screen has: the id is not known when the component is created
    const { client, injector, counters, flush } = await start();
    const ready = signal(false);
    const q = runInInjectionContext(injector, () =>
      injectQuery<{ title: string }>("book", { id: "b1" }, { shape: "{ id title stock }", enabled: () => ready() }),
    );
    expect(q.loading()).toBe(false);
    await client.query("book", { id: "b2" }, { shape: "{ id }" }); // the barrier, as above
    expect(sent(counters)).toBe(1); // guard: nothing was asked of the server, not merely hidden from the signals

    ready.set(true);
    flush();
    await until(() => q.data()?.title, (t) => t === "Dune", "the query that was waiting to be enabled");
    expect(sent(counters)).toBe(2);
  });
});

/** Queries the server actually ran, from its own counters: the only honest way to assert that nothing was sent. */
function sent(counters: MemoryCounters): number {
  // every outcome: one series per outcome, and a refused query was still asked
  return counters.snapshot().reduce((n, e) => n + (e.name === "rayfold.ops" && e.labels["kind"] === "query" ? e.count : 0), 0);
}

describe("injectCommand", () => {
  it("runs, and the cache updates the query that shows the same entity", async () => {
    const { injector } = await start();
    const q = runInInjectionContext(injector, () => injectQuery<{ stock: number }>("book", { id: "b1" }, { shape: "{ id title stock }" }));
    await until(() => q.data(), (d) => d !== undefined, "the first result");
    expect(q.data()?.stock).toBe(5);

    const cmd = runInInjectionContext(injector, () => injectCommand<{ stock: number }>("restock"));
    expect(cmd.running()).toBe(false);
    const run = cmd.run({ id: "b1", qty: 3 });
    expect(cmd.running()).toBe(true);
    await run;

    expect(cmd.data()?.stock).toBe(8);
    expect(cmd.running()).toBe(false);
    // the point of the binding: the query updated from the command's patch, with no refetch
    await until(() => q.data()?.stock, (s) => s === 8, "the query saw the command's patch");
  });

  it("a run that fails clears what the run before it returned, so an old success never shows beside a new error", async () => {
    const { injector } = await start();
    const cmd = runInInjectionContext(injector, () => injectCommand<{ stock: number }>("restock"));
    await cmd.run({ id: "b1", qty: 1 });
    expect(cmd.data()?.stock).toBe(6);
    await expect(cmd.run({ id: "nope", qty: 1 })).rejects.toBeInstanceOf(RayfoldClientError);
    expect([cmd.data(), (cmd.error() as RayfoldClientError).code]).toEqual([undefined, "internal"]);
    // guard: a run that starts keeps the last result until its own answer, and clears only the error
    const next = cmd.run({ id: "b1", qty: 1 });
    expect([cmd.running(), cmd.error()]).toEqual([true, undefined]);
    await next;
    expect([cmd.data()?.stock, cmd.error()]).toEqual([7, undefined]);
  });

  it("keeps a failure in the signals rather than only rejecting", async () => {
    const { injector } = await start();
    const cmd = runInInjectionContext(injector, () => injectCommand("restock"));
    await expect(cmd.run({ id: "nope", qty: 1 })).rejects.toBeInstanceOf(RayfoldClientError);
    expect((cmd.error() as RayfoldClientError).code).toBe("internal");
    expect(cmd.running()).toBe(false);
  });

  it("only the latest run speaks for the state, whichever of the runs finishes last", async () => {
    const { injector } = await start();
    const cmd = runInInjectionContext(injector, () => injectCommand<{ stock: number }>("restock"));
    let openFirst = () => {};
    let openSecond = () => {};
    gates.set(1, new Promise<void>((r) => (openFirst = r)));
    gates.set(2, new Promise<void>((r) => (openSecond = r)));
    // one at a time onto the server, so each is its own request and neither waits in a batch behind the other
    const first = cmd.run({ id: "b1", qty: 1 });
    await restocking.until((q) => q.includes(1), "the first run reaching the server");
    const second = cmd.run({ id: "b1", qty: 2 });
    await restocking.until((q) => q.includes(2), "the second run reaching the server");

    openSecond();
    expect((await second).stock).toBe(7);
    expect([cmd.data()?.stock, cmd.running()]).toEqual([7, false]);
    openFirst();
    expect((await first).stock).toBe(8); // its caller still gets its own answer
    expect([cmd.data()?.stock, cmd.error(), cmd.running()]).toEqual([7, undefined, false]);
  });

  it("leaves its state alone once its injector is destroyed", async () => {
    const { injector } = await start();
    const cmd = runInInjectionContext(injector, () => injectCommand<{ stock: number }>("restock"));
    const run = cmd.run({ id: "b1", qty: 3 });
    injector.destroy();
    expect((await run).stock).toBe(8);
    expect([cmd.data(), cmd.running()]).toEqual([undefined, true]);
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

  it("shows what the cache holds for the same call at once, while it opens", async () => {
    const { client, injector } = await start();
    const shape = "{ id title stock }";
    await client.query("book", { id: "b1" }, { shape });
    const live = runInInjectionContext(injector, () => injectLive<{ stock: number }>("book", { id: "b1" }, { shape }));
    expect([live.data(), live.loading()]).toEqual([{ $type: "Book", id: "b1", title: "Dune", stock: 5 }, true]);
    // guard: a call the cache holds nothing for starts empty
    const other = runInInjectionContext(injector, () => injectLive<{ stock: number }>("book", { id: "b1" }, { shape: "{ id stock }" }));
    expect([other.data(), other.loading()]).toEqual([undefined, true]);
    await until(() => [live.loading(), other.loading()], ([a, b]) => !a && !b, "both opened");
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
    await counters.reach("rayfold.live.closed", 1, "the first subscription ending");
    expect(counted(counters, "rayfold.live.opened")).toBe(2);
  });
});

describe("injectLive, destroyed", () => {
  it("ends its subscription on the server when its injector is destroyed, and hears nothing after", async () => {
    const { client, injector, counters } = await start();
    const live = runInInjectionContext(injector, () => injectLive<{ stock: number }>("book", { id: "b1" }, { shape: "{ id title stock }" }));
    await until(() => live.data(), (d) => d !== undefined, "the first live result");
    expect([counted(counters, "rayfold.live.opened"), counted(counters, "rayfold.live.closed")]).toEqual([1, 0]);

    injector.destroy();
    await counters.reach("rayfold.live.closed", 1, "the subscription ending");
    await client.command("restock", { id: "b1", qty: 2 });
    expect(counted(counters, "rayfold.live.opened")).toBe(1);
    expect(live.data()?.stock).toBe(5);
  });
});

const counted = (counters: MemoryCounters, name: string): number => counters.snapshot().find((e) => e.name === name)?.count ?? 0;

describe("provideRayfold", () => {
  it("says what is missing when nothing provided a client", () => {
    const empty = Injector.create({ providers: [] });
    expect(() => runInInjectionContext(empty, () => injectRayfoldClient())).toThrow(new Error("Rayfold needs provideRayfold(client) in the application's providers"));
  });

  it("gives the same client back", async () => {
    const { client, injector } = await start();
    expect(runInInjectionContext(injector, () => injectRayfoldClient())).toBe(client);
  });
});
