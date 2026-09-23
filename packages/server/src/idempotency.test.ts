import { hashJson } from "@rayfold/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIdempotencyStore, type IdempotencyStore } from "./context.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
import { RayfoldError, type Frame } from "./protocol.ts";
import { MemoryCounters } from "./counters.ts";
import { bounded, Signal } from "../../../e2e/wait.ts";

/**
 * A command retried while its first attempt is still running must run once, whichever server it lands on. These tests
 * put two servers behind one store, which is what a second instance behind a load balancer looks like from here.
 */
const SCHEMA = `entity Ticket { id: ID seat: Int } command book(seat: Int): Ticket`;
const KEY = "0123456789abcdef";
const viewer = { id: "u1" };

interface Fleet {
  servers: RayfoldServer[];
  /** How many times the resolver actually ran, across every server. */
  runs: () => number;
  /** Lets the resolvers that are waiting finish. */
  open: () => void;
}

function fleet(count: number, opts: { store: IdempotencyStore; now?: () => number; hold?: boolean; fail?: (run: number) => unknown; leaseMs?: number }): Fleet {
  let runs = 0;
  let open = () => {};
  const held = new Promise<void>((r) => (open = r));
  const resolvers = {
    Command: {
      book: async ({ seat }: { seat: number }) => {
        const run = ++runs;
        if (opts.hold) await held; // the test decides when the command finishes
        const failure = opts.fail?.(run);
        if (failure) throw failure;
        return { id: `t${seat}`, seat };
      },
    },
  };
  const servers = Array.from({ length: count }, () =>
    createRayfoldServer({
      schema: SCHEMA,
      resolvers,
      idempotency: opts.store,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.leaseMs ? { idempotencyLeaseMs: opts.leaseMs } : {}),
    }),
  );
  return { servers, runs: () => runs, open };
}

/** Records what every `claim` on the store answered, so a test can wait until a retry has found the key held. */
function spyClaims(store: MemoryIdempotencyStore): Signal<string> {
  const claims = new Signal<string>();
  const claim = store.claim.bind(store);
  vi.spyOn(store, "claim").mockImplementation(async (scope: string, key: string, lease: number) => {
    const c = await claim(scope, key, lease);
    claims.push(c.state);
    return c;
  });
  return claims;
}
const count = (states: string[], state: string) => states.filter((s) => s === state).length;

const book = (server: RayfoldServer, key = KEY, seat = 1): Promise<Frame[]> => server.collect({ ops: [{ id: 1, op: "book", args: { seat }, key }] }, { viewer });

describe("a store that fails after the command committed", () => {
  /** A store whose `put` throws: the command has run, and recording its result is what fails. */
  class UnwritableStore extends MemoryIdempotencyStore {
    override async put(): Promise<void> {
      throw new Error("the database went away");
    }
  }

  it("still sends one terminal frame for the op, not two", async () => {
    const server = createRayfoldServer({
      schema: SCHEMA,
      resolvers: { Command: { book: async ({ seat }: { seat: number }) => ({ id: `t${seat}`, seat }) } },
      idempotency: new UnwritableStore(),
    });
    const frames = await server.collect({ ops: [{ id: 1, op: "book", args: { seat: 1 }, key: KEY }] }, { viewer });
    // spec 04 §2. The command emitted `ok` with `fin`, then the failing `put` reached the failure path, which used
    // to push a second terminal frame for the same id — two answers to one operation.
    const terminal = frames.filter((f) => (f as { id?: number }).id === 1 && (f as { fin?: boolean }).fin === true);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ id: 1, ok: { id: "t1", seat: 1 } });
  });
});
const replayed = (frames: Frame[]): boolean => Boolean((frames[0] as { meta?: { replay?: boolean } }).meta?.replay);

/** A store whose `renew` fails for the tokens listed: what a server that lost its database sees. */
class LossyStore extends MemoryIdempotencyStore {
  readonly granted = new Signal<string>();
  readonly lost = new Set<string>();
  override async claim(scope: string, key: string, leaseMs: number) {
    const c = await super.claim(scope, key, leaseMs);
    if (c.state === "owned") this.granted.push(c.token);
    return c;
  }
  override async renew(scope: string, key: string, token: string, leaseMs: number): Promise<boolean> {
    return this.lost.has(token) ? false : super.renew(scope, key, token, leaseMs);
  }
}

describe("one command per key, across servers sharing a store", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs the command once however many servers the retries land on, and answers them all with its result", async () => {
    const store = new MemoryIdempotencyStore();
    const claims = spyClaims(store);
    const f = fleet(2, { store, hold: true });
    const calls = Array.from({ length: 20 }, (_, i) => book(f.servers[i % 2]!));
    // every retry but the first must have found the key held before the command is let finish, or nothing here
    // shows that they waited rather than arriving after it was recorded
    await claims.until((c) => count(c, "owned") === 1 && count(c, "inflight") >= 19, "nineteen retries finding the key held");
    expect(f.runs()).toBe(1);
    f.open();
    const answers = await bounded(Promise.all(calls), "twenty retries across two servers");

    expect(f.runs()).toBe(1);
    const ok = (frames: Frame[]) => (frames[0] as { ok: unknown }).ok;
    expect(answers.map(ok)).toEqual(answers.map(() => ({ $type: "Ticket", id: "t1", seat: 1 })));
    expect(answers.filter((a) => !replayed(a))).toHaveLength(1);
    expect(answers.filter(replayed)).toHaveLength(19);
  });

  it("guard: a key used on another server for other arguments is refused, and that command never runs", async () => {
    const store = new MemoryIdempotencyStore();
    const f = fleet(2, { store });
    await book(f.servers[0]!, KEY, 1);
    const other = await book(f.servers[1]!, KEY, 2);

    expect(other[0]).toMatchObject({ error: { code: "already_exists" } });
    expect(f.runs()).toBe(1);
  });

  it("frees the key when the command fails before it changes anything, so the retry on another server runs it", async () => {
    const store = new MemoryIdempotencyStore();
    const f = fleet(2, { store, fail: (run) => (run === 1 ? new Error("the database was down") : undefined) });
    const first = await book(f.servers[0]!);
    expect(first[0]).toMatchObject({ error: { code: "internal" } });

    const second = await book(f.servers[1]!);
    expect(second[0]).toMatchObject({ ok: { id: "t1" } });
    expect(f.runs()).toBe(2);

    // guard: once it has succeeded, a further retry replays instead of running a third time
    expect(replayed(await book(f.servers[0]!))).toBe(true);
    expect(f.runs()).toBe(2);
  });

  it("records a failure that happened after the command ran, so the retry is answered with it instead of running again", async () => {
    const store = new MemoryIdempotencyStore();
    // the resolver returns nothing for a non-null result: the command has run, the answer cannot be built
    const broken = createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { book: async () => null } }, idempotency: store });
    const first = await book(broken);
    expect(first[0]).toMatchObject({ error: { code: "internal" } });

    const other = createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { book: async () => ({ id: "t1", seat: 1 }) } }, idempotency: store });
    const retry = await book(other);
    expect(retry[0]).toMatchObject({ error: { code: "internal" } });
    expect(await store.get(hashJson(viewer), KEY)).toBeDefined();
  });

  it("waits while a server still holds the key, and takes it over once that server's lease runs out", async () => {
    let t = 1_000;
    const store = new MemoryIdempotencyStore(24 * 3_600_000, () => t);
    const f = fleet(1, { store, now: () => t, leaseMs: 60 });
    // a server that claimed the key and then died: nothing renews this lease, and no record is ever written
    const stopped = await store.claim(hashJson(viewer), KEY, 60);
    expect(stopped.state).toBe("owned");

    const claims = spyClaims(store);
    const retry = book(f.servers[0]!);
    await claims.until((c) => c.includes("inflight"), "the retry finding the key held");
    expect(f.runs()).toBe(0); // the lease is still good, so the retry waits instead of running the command

    t += 61;
    const answer = await bounded(retry, "the retry taking the key over");
    expect(answer[0]).toMatchObject({ ok: { id: "t1" } });
    expect(f.runs()).toBe(1);
    expect(await store.get(hashJson(viewer), KEY)).toMatchObject({ frame: { ok: { id: "t1" } } });
  });

  it("keeps one viewer's record away from another's, on the same key", async () => {
    const store = new MemoryIdempotencyStore();
    const f = fleet(2, { store });
    await f.servers[0]!.collect({ ops: [{ id: 1, op: "book", args: { seat: 1 }, key: KEY }] }, { viewer });
    const other = await f.servers[1]!.collect({ ops: [{ id: 1, op: "book", args: { seat: 1 }, key: KEY }] }, { viewer: { id: "u2" } });

    expect(replayed(other)).toBe(false);
    expect(f.runs()).toBe(2);
  });

  it("records a canceled answer when the op ended after the command committed, so the retry is told its effect happened", async () => {
    const store = new MemoryIdempotencyStore();
    const entered = new Signal<string>();
    let runs = 0;
    const stalled = createRayfoldServer({
      schema: `entity Ticket { id: ID seat: Int hold: Hold } entity Hold { id: ID owner: String } command book(seat: Int): Ticket`,
      idempotency: store,
      resolvers: {
        Command: {
          book: async ({ seat }: { seat: number }) => {
            runs++;
            return { id: `t${seat}`, seat };
          },
        },
        // the command has returned by the time this runs: the seat is booked, whatever becomes of the answer
        Ticket: {
          hold: (_tickets: unknown[], _args: unknown, ctx: { signal: AbortSignal }) =>
            new Promise<Array<{ id: string; owner: string }>>((_resolve, reject) => {
              entered.push("hold");
              ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
            }),
        },
      },
    });

    const ac = new AbortController();
    const frames: Frame[] = [];
    const ended = (async () => {
      const envelope = { ops: [{ id: 1, op: "book", args: { seat: 1 }, key: KEY, shape: "{ id hold { owner } }" }] };
      for await (const f of stalled.execute(envelope, { viewer, signal: ac.signal })) frames.push(f);
    })();
    await entered.until((items) => items.length === 1, "the field the op is waiting on");
    ac.abort();
    await bounded(ended, "the op ending when the caller went away");
    expect(frames.at(-1)).toMatchObject({ error: { code: "canceled" } });

    // `deadline_exceeded` is retryable, so replaying the op's own frame would send the client back with a fresh key
    // and book a second seat. The record says the command committed instead.
    const other = createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { book: async () => ({ id: "t1", seat: 1 }) } }, idempotency: store });
    expect((await book(other))[0]).toMatchObject({
      error: { code: "canceled", message: "book() committed, then the op ended before its result was delivered" },
      meta: { replay: true },
    });
    expect(runs).toBe(1);
  });

  it("guard: an op canceled before the command committed frees the key, so the retry runs the command", async () => {
    const store = new MemoryIdempotencyStore();
    const entered = new Signal<string>();
    const stuck = createRayfoldServer({
      schema: SCHEMA,
      idempotency: store,
      resolvers: {
        Command: {
          // the command never returns, so nothing has committed when the caller goes away
          book: (_args: unknown, ctx: { signal: AbortSignal }) =>
            new Promise<{ id: string; seat: number }>((_resolve, reject) => {
              entered.push("book");
              ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
            }),
        },
      },
    });

    const ac = new AbortController();
    const ended = (async () => {
      for await (const _f of stuck.execute({ ops: [{ id: 1, op: "book", args: { seat: 1 }, key: KEY }] }, { viewer, signal: ac.signal })) void _f;
    })();
    await entered.until((items) => items.length === 1, "the command that never returns");
    ac.abort();
    await bounded(ended, "the op ending when the caller went away");
    expect(await store.get(hashJson(viewer), KEY)).toBeUndefined();

    const f = fleet(1, { store });
    expect((await book(f.servers[0]!))[0]).toMatchObject({ ok: { id: "t1" } });
    expect(f.runs()).toBe(1);
  });

  it("replays a recorded failure as a failure, so a later op does not run on an answer that never came", async () => {
    // The seat is booked and the answer is not: the record holds the failure, and every retry gets it. Treating that
    // replay as a success would let a `$ref` op run with nothing to read — and would count a command that never
    // succeeds as one that always does.
    const store = new MemoryIdempotencyStore();
    const counters = new MemoryCounters();
    let runs = 0;
    const brittle = () =>
      createRayfoldServer({
        schema: `entity Ticket { id: ID seat: Int hold: Hold } entity Hold { id: ID owner: String } query ticket(id: ID): Ticket command book(seat: Int): Ticket`,
        idempotency: store,
        counters,
        resolvers: {
          Query: { ticket: ({ id }: { id: string }) => ({ id, seat: 1 }) },
          Command: {
            book: ({ seat }: { seat: number }) => {
              runs++;
              return { id: `t${seat}`, seat };
            },
          },
          // runs after the command returned: the booking happened, whatever becomes of the answer
          Ticket: {
            hold: () => {
              throw new RayfoldError("failed_precondition", "the ledger went away");
            },
          },
        },
      });

    const shape = "{ id hold { owner } }";
    const first = await brittle().collect({ ops: [{ id: 1, op: "book", args: { seat: 1 }, key: KEY, shape }] }, { viewer });
    expect(first.at(-1)).toMatchObject({ id: 1, error: { code: "failed_precondition" } });
    expect(runs).toBe(1);

    const retry = await brittle().collect(
      {
        ops: [
          { id: 1, op: "book", args: { seat: 1 }, key: KEY, shape },
          { id: 2, op: "ticket", args: { id: { $ref: "1.id" } }, shape: "{ id }" },
        ],
      },
      { viewer },
    );
    expect(runs).toBe(1); // replayed, not run again
    expect(retry[0]).toMatchObject({ id: 1, error: { code: "failed_precondition" }, meta: { replay: true } });
    expect(retry[1]).toMatchObject({ id: 2, error: { code: "failed_precondition", type: "DependencyFailed" } });

    const find = (name: string, labels: Record<string, string>) =>
      counters.snapshot().find((e) => e.name === name && Object.entries(labels).every(([k, v]) => e.labels[k] === v))?.count ?? 0;
    expect(find("rayfold.ops", { kind: "command", outcome: "failed_precondition" })).toBe(2); // the run and the replay
    expect(find("rayfold.ops", { kind: "command", outcome: "ok" })).toBe(0);
    expect(find("rayfold.errors", { op: "book", code: "failed_precondition" })).toBe(2);
  });

  it("guard: a replayed success still feeds the op that depends on it", async () => {
    const store = new MemoryIdempotencyStore();
    const counters = new MemoryCounters();
    const server = () =>
      createRayfoldServer({
        schema: `${SCHEMA} query ticket(id: ID): Ticket`,
        idempotency: store,
        counters,
        resolvers: {
          Query: { ticket: ({ id }: { id: string }) => ({ id, seat: 1 }) },
          Command: { book: ({ seat }: { seat: number }) => ({ id: `t${seat}`, seat }) },
        },
      });
    await server().collect({ ops: [{ id: 1, op: "book", args: { seat: 1 }, key: KEY, shape: "{ id }" }] }, { viewer });

    const retry = await server().collect(
      {
        ops: [
          { id: 1, op: "book", args: { seat: 1 }, key: KEY, shape: "{ id }" },
          { id: 2, op: "ticket", args: { id: { $ref: "1.id" } }, shape: "{ id }" },
        ],
      },
      { viewer },
    );
    expect(retry[0]).toMatchObject({ id: 1, ok: { id: "t1" }, meta: { replay: true } });
    expect(retry[1]).toMatchObject({ id: 2, data: { id: "t1" } });
    expect(counters.snapshot().filter((e) => e.name === "rayfold.errors")).toHaveLength(0);
  });

  it("keeps renewing a long command's lease, so a retry arriving after the first lease would have lapsed waits instead of running it again", async () => {
    // the renewals and the clock are faked; the waits below keep their real timers, so they stay bounded
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const store = new MemoryIdempotencyStore(24 * 3_600_000, () => Date.now());
    const renew = vi.spyOn(store, "renew");
    const claims = spyClaims(store);
    const f = fleet(2, { store, now: () => Date.now(), hold: true, leaseMs: 60 });
    const first = book(f.servers[0]!);
    await vi.advanceTimersByTimeAsync(61); // past the lease as first granted; renewals ran at 20, 40 and 60 ms
    expect(renew).toHaveBeenCalledTimes(3);
    expect(f.runs()).toBe(1);

    const retry = book(f.servers[1]!);
    await claims.until((c) => c.includes("inflight"), "the retry finding the key held");
    expect(f.runs()).toBe(1); // held, not taken over: the other server is still running it

    f.open();
    const [a, b] = await bounded(Promise.all([first, retry]), "both answered once the command finished");
    expect(a[0]).toMatchObject({ ok: { id: "t1" } });
    expect(b[0]).toMatchObject({ ok: { id: "t1" }, meta: { replay: true } });
    expect(f.runs()).toBe(1);
    // the sibling is "waits while a server still holds the key, and takes it over once that server's lease runs out":
    // there nothing renews, and the retry takes the key
  });

  it("a server that lost its database loses the key: the next retry takes it over, and the stranded server's answer is never recorded", async () => {
    let t = 1_000;
    const store = new LossyStore(24 * 3_600_000, () => t);
    let runs = 0;
    let open = () => {};
    const held = new Promise<void>((r) => (open = r));
    const schema = `entity Ticket { id: ID seat: Int run: Int } command book(seat: Int): Ticket`;
    const resolvers = {
      Command: {
        book: async ({ seat }: { seat: number }) => {
          const run = ++runs;
          if (run === 1) await held;
          return { id: `t${seat}`, seat, run };
        },
      },
    };
    const [a, b] = [0, 1].map(() => createRayfoldServer({ schema, resolvers, idempotency: store, now: () => t, idempotencyLeaseMs: 60 }));
    const stranded = book(a!);
    await store.granted.atLeast(1, "the first server taking the key");
    expect(runs).toBe(1);
    store.lost.add(store.granted.items[0]!); // from here its renewals fail, as they would with the database gone
    t += 61;

    const taken = await bounded(book(b!), "the retry taking over the lapsed key");
    expect(taken[0]).toMatchObject({ ok: { id: "t1", run: 2 } });
    expect(replayed(taken)).toBe(false);
    expect(runs).toBe(2); // the one case where a command runs twice (spec 12 section 4.6)

    open();
    expect((await bounded(stranded, "the stranded server finishing"))[0]).toMatchObject({ ok: { run: 1 } }); // its own caller still gets its answer
    expect(await store.get(hashJson(viewer), KEY)).toMatchObject({ frame: { ok: { run: 2 } } }); // but the key speaks for the server that took it
    expect((await book(a!))[0]).toMatchObject({ ok: { run: 2 }, meta: { replay: true } });
    expect(runs).toBe(2);
  });

  it("a retry waiting for a held key stops waiting when its caller goes away, never runs the command, and leaves the key with the holder", async () => {
    const store = new MemoryIdempotencyStore();
    const claims = spyClaims(store);
    const f = fleet(2, { store, hold: true });
    const first = book(f.servers[0]!);
    await claims.until((s) => s.includes("owned"), "the first server taking the key");

    const ac = new AbortController();
    const frames: Frame[] = [];
    const waiter = (async () => {
      for await (const fr of f.servers[1]!.execute({ ops: [{ id: 1, op: "book", args: { seat: 1 }, key: KEY }] }, { viewer, signal: ac.signal })) frames.push(fr);
    })();
    await claims.until((s) => s.includes("inflight"), "the retry finding the key held");
    ac.abort();
    await bounded(waiter, "the waiting retry ending when its caller went away");
    expect(frames).toEqual([{ id: 1, error: { code: "canceled", message: "Canceled" }, fin: true }]);
    expect(f.runs()).toBe(1);

    f.open();
    expect((await first)[0]).toMatchObject({ ok: { id: "t1" } });
    expect(replayed(await book(f.servers[1]!))).toBe(true); // the key stayed with the holder, so its answer is there
    expect(f.runs()).toBe(1);
  });

  it("replays a recorded failure in the form the retry asks for, compact included", async () => {
    const store = new MemoryIdempotencyStore();
    const broken = createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { book: async () => null } }, idempotency: store });
    const first = await book(broken);
    expect(first[0]).toMatchObject({ error: { code: "internal" }, fin: true });

    const compact = await broken.collect({ ops: [{ id: 7, op: "book", args: { seat: 1 }, key: KEY, compact: true }] }, { viewer });
    expect(compact).toEqual([{ ...first[0], id: 7, meta: { replay: true } }]);
  });

  it("hands the store the lease the server was configured with, 30 seconds unless set", async () => {
    const store = new MemoryIdempotencyStore();
    const claim = vi.spyOn(store, "claim");
    await book(fleet(1, { store }).servers[0]!);
    expect(claim).toHaveBeenLastCalledWith(hashJson(viewer), KEY, 30_000);
    await book(fleet(1, { store, leaseMs: 1_234 }).servers[0]!, KEY + "b");
    expect(claim).toHaveBeenLastCalledWith(hashJson(viewer), KEY + "b", 1_234);
  });
});
