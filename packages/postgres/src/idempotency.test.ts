import { PGlite } from "@electric-sql/pglite";
import { hashJson } from "@rayfold/schema";
import { createRayfoldServer, type RayfoldServer } from "@rayfold/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgIdempotencyStore, type Queryable } from "./index.ts";

/**
 * The idempotency store in Postgres, with two servers behind it: what a second instance behind a load balancer looks
 * like from the runtime's side. Both servers run the same schema and share nothing but the database.
 */
const SCHEMA = `entity Ticket { id: ID seat: Int } command book(seat: Int): Ticket`;
const KEY = "0123456789abcdef";
const viewer = { id: "u1" };

let db: PGlite;
let sql: Queryable;
let now = 1_000;

beforeEach(async () => {
  db = new PGlite();
  sql = { query: async (text, params) => (await db.query(text, params)) as never };
  now = 1_000;
});

afterEach(async () => {
  await db.close();
});

interface Fleet {
  servers: RayfoldServer[];
  store: PgIdempotencyStore;
  runs: () => number;
  open: () => void;
}

async function fleet(count: number, opts: { hold?: boolean; fail?: (run: number) => unknown; ttlMs?: number; leaseMs?: number } = {}): Promise<Fleet> {
  const store = new PgIdempotencyStore(sql, { now: () => now, ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}) });
  await store.migrate();
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
    createRayfoldServer({ schema: SCHEMA, resolvers, idempotency: store, now: () => now, ...(opts.leaseMs ? { idempotencyLeaseMs: opts.leaseMs } : {}) }),
  );
  return { servers, store, runs: () => runs, open };
}

const book = (server: RayfoldServer, key = KEY, seat = 1, who: unknown = viewer) => server.collect({ ops: [{ id: 1, op: "book", args: { seat }, key }] }, { viewer: who });
const replayed = (frames: Array<{ meta?: { replay?: boolean } }>): boolean => Boolean(frames[0]?.meta?.replay);

describe("idempotency records in Postgres", () => {
  it("runs a command once for retries that arrive together on two servers, and answers every one of them with its result", async () => {
    const f = await fleet(2, { hold: true });
    const calls = Array.from({ length: 20 }, (_, i) => book(f.servers[i % 2]!));
    f.open();
    const answers = await Promise.all(calls);

    expect(f.runs()).toBe(1);
    expect(answers.map((a) => (a[0] as { ok: unknown }).ok)).toEqual(answers.map(() => ({ $type: "Ticket", id: "t1", seat: 1 })));
    expect(answers.filter((a) => !replayed(a as never))).toHaveLength(1);
    expect(await f.store.size()).toBe(1);
  });

  it("frees the key when the command failed before changing anything, and keeps it once the command has run", async () => {
    const f = await fleet(2, { fail: (run) => (run === 1 ? new Error("the database was down") : undefined) });
    expect((await book(f.servers[0]!))[0]).toMatchObject({ error: { code: "internal" } });
    expect(await f.store.size()).toBe(0); // nothing recorded, and the key is free

    expect((await book(f.servers[1]!))[0]).toMatchObject({ ok: { id: "t1" } });
    expect(replayed((await book(f.servers[0]!)) as never)).toBe(true);
    expect(f.runs()).toBe(2);
  });

  it("waits while a server still holds the key, and takes it over once that server's lease runs out", async () => {
    const f = await fleet(1, { leaseMs: 60 });
    // a server that claimed the key and then died: nothing renews this lease, and no record is ever written
    const stopped = await f.store.claim(hashJson(viewer), KEY, 60);
    expect(stopped.state).toBe("owned");

    const retry = book(f.servers[0]!);
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(f.runs()).toBe(0); // the lease is still good, so the retry waits instead of running the command

    now += 61;
    expect((await retry)[0]).toMatchObject({ ok: { id: "t1" } });
    expect(f.runs()).toBe(1);
    expect(replayed((await book(f.servers[0]!)) as never)).toBe(true);
  });

  it("stops replaying once a record is past its lifetime, and sweeps it away", async () => {
    const f = await fleet(1, { ttlMs: 60_000 });
    await book(f.servers[0]!);
    now += 60_000;
    expect(replayed((await book(f.servers[0]!)) as never)).toBe(true);

    now += 1;
    expect(replayed((await book(f.servers[0]!)) as never)).toBe(false);
    expect(f.runs()).toBe(2);
    expect(await f.store.size()).toBe(1); // the expired record was swept, the fresh one is there
  });

  it("keeps one viewer's record away from another's on the same key", async () => {
    const f = await fleet(2);
    await book(f.servers[0]!);
    const other = await book(f.servers[1]!, KEY, 1, { id: "u2" });

    expect(replayed(other as never)).toBe(false);
    expect(f.runs()).toBe(2);
    expect(await f.store.get(hashJson(viewer), KEY)).toBeDefined();
    expect(await f.store.get(hashJson({ id: "u2" }), KEY)).toBeDefined();
  });
});
