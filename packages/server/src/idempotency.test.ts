import { hashJson } from "@rayfold/schema";
import { describe, expect, it } from "vitest";
import { MemoryIdempotencyStore, type IdempotencyStore } from "./context.ts";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
import type { Frame } from "./protocol.ts";
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

const book = (server: RayfoldServer, key = KEY, seat = 1): Promise<Frame[]> => server.collect({ ops: [{ id: 1, op: "book", args: { seat }, key }] }, { viewer });
const replayed = (frames: Frame[]): boolean => Boolean((frames[0] as { meta?: { replay?: boolean } }).meta?.replay);

describe("one command per key, across servers sharing a store", () => {
  it("runs the command once however many servers the retries land on, and answers them all with its result", async () => {
    const store = new MemoryIdempotencyStore();
    const f = fleet(2, { store, hold: true });
    const calls = Array.from({ length: 20 }, (_, i) => book(f.servers[i % 2]!));
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

    const retry = book(f.servers[0]!);
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
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
});
