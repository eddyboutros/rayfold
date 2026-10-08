import { PGlite } from "@electric-sql/pglite";
import { hashJson } from "@rayfold/schema";
import { createRayfoldServer, type RayfoldServer } from "@rayfold/server";
import type { IdempotencyClaim } from "@rayfold/server/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Signal } from "../../../e2e/wait.ts";
import { PgIdempotencyStore, type Queryable } from "./index.ts";

// every test boots its own PGlite, a Postgres compiled to WASM, which on a busy runner takes seconds by itself, the
// first one in a worker longest; the waits for a signal inside each test keep their own 5 s bound
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

/** A store whose `renew` fails for the tokens listed: what a server that lost its database sees. */
class LossyPgStore extends PgIdempotencyStore {
  readonly granted: string[] = [];
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

describe("idempotency records in Postgres", () => {
  // Across servers a waiter can only ask the database again, so every retry here polls one PGlite, a single-threaded
  // Postgres that the rest of the suite's Postgres tests share while the whole suite runs: the bound is wider than
  // the default for that reason alone, and nothing in the test depends on how long it takes.
  it("runs a command once for retries that arrive together on two servers, and answers every one of them with its result", async () => {
    const f = await fleet(2, { hold: true });
    const calls = Array.from({ length: 10 }, (_, i) => book(f.servers[i % 2]!));
    f.open();
    const answers = await Promise.all(calls);

    expect(f.runs()).toBe(1);
    expect(answers.map((a) => (a[0] as { ok: unknown }).ok)).toEqual(answers.map(() => ({ $type: "Ticket", id: "t1", seat: 1 })));
    expect(answers.filter((a) => !replayed(a as never))).toHaveLength(1);
    expect(answers.filter((a) => replayed(a as never))).toHaveLength(9);
    expect(await f.store.size()).toBe(1);
  }, 20_000);

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

    const answers = new Signal<IdempotencyClaim["state"]>();
    const claim = f.store.claim.bind(f.store);
    f.store.claim = async (...args) => {
      const c = await claim(...args);
      answers.push(c.state);
      return c;
    };
    const retry = book(f.servers[0]!);
    expect(await answers.atLeast(1, "the retry asked the database for the key")).toEqual(["inflight"]);
    expect(f.runs()).toBe(0); // the lease is still good, so the retry waits instead of running the command

    now += 61;
    expect((await retry)[0]).toMatchObject({ ok: { id: "t1" } });
    expect(f.runs()).toBe(1);
    expect(answers.items.at(-1)).toBe("owned");
    expect(replayed((await book(f.servers[0]!)) as never)).toBe(true);
  });

  it("replays while a record is younger than its lifetime, and runs the command again at that age", async () => {
    const f = await fleet(1, { ttlMs: 60_000 });
    await book(f.servers[0]!);
    now += 59_999;
    expect(replayed((await book(f.servers[0]!)) as never)).toBe(true);

    now += 1;
    expect(replayed((await book(f.servers[0]!)) as never)).toBe(false);
    expect(f.runs()).toBe(2);
    expect(await f.store.size()).toBe(1); // the key holds the second run's record, in place of the expired one
  });

  // spec 03 section 4: a record has expired once it is as old as its time to live. Reading, claiming and sweeping are
  // three statements, so each is held to that line from both sides: JdbcIdempotencyStore draws it in the same place,
  // and a fleet of both runtimes reads one table.
  describe("at the age a record expires", () => {
    const record = (at: number) => ({ argsHash: "h", frame: { id: 1, ok: { id: "t1" }, fin: true }, at });
    const store = async () => {
      const s = new PgIdempotencyStore(sql, { now: () => now, ttlMs: 1_000 });
      await s.migrate();
      return s;
    };
    /** A finished key, as a command leaves it: claimed, then recorded under that claim's token. */
    const finish = async (s: PgIdempotencyStore, key: string) => {
      const claim = await s.claim("s", key, 100);
      if (claim.state !== "owned") throw new Error(`${key} was not free: ${claim.state}`);
      await s.put("s", key, record(now), claim.token);
    };
    const keys = async () => (await sql.query<{ key: string }>("SELECT key FROM rayfold_idempotency ORDER BY key")).rows.map((r) => r.key);

    it("a read answers a millisecond short of it, and nothing at it", async () => {
      const s = await store();
      now = 5_000;
      await finish(s, "a");
      now = 5_999;
      expect(await s.get("s", "a")).toEqual(record(5_000));
      now = 6_000;
      expect(await s.get("s", "a")).toBeUndefined();
    });

    it("a claim finds the record a millisecond short of it, and takes the key at it", async () => {
      const s = await store();
      now = 5_000;
      await finish(s, "a");
      now = 5_999;
      expect(await s.claim("s", "a", 100)).toEqual({ state: "done", record: record(5_000) });
      now = 6_000;
      expect(await s.claim("s", "a", 100)).toEqual({ state: "owned", token: expect.any(String) });
    });

    it("a write sweeps nothing a millisecond short of it, and the record at it", async () => {
      const s = await store();
      now = 5_000;
      await finish(s, "old");
      now = 5_999;
      await finish(s, "young");
      expect(await keys()).toEqual(["old", "young"]);
      now = 6_000;
      await finish(s, "new");
      expect(await keys()).toEqual(["new", "young"]);
    });

    it("a record is as old as the time it carries, whenever it was written", async () => {
      const s = await store();
      now = 5_500;
      const claim = await s.claim("s", "a", 100);
      if (claim.state !== "owned") throw new Error(`a was not free: ${claim.state}`);
      await s.put("s", "a", record(5_200), claim.token); // answered at 5_200, written at 5_500
      now = 6_199;
      expect(await s.get("s", "a")).toEqual(record(5_200));
      now = 6_200;
      expect(await s.get("s", "a")).toBeUndefined();
    });

    it("a command still running past the time to live keeps its key through a write's sweep", async () => {
      const s = await store();
      now = 5_000;
      const running = await s.claim("s", "running", 500);
      if (running.state !== "owned") throw new Error(`running was not free: ${running.state}`);
      now = 5_400;
      expect(await s.renew("s", "running", running.token, 1_600)).toBe(true); // held until 7_000
      now = 6_000; // the claim is as old as the time to live
      await finish(s, "other");
      expect(await keys()).toEqual(["other", "running"]);
      expect(await s.claim("s", "running", 100)).toEqual({ state: "inflight", heldUntil: 7_000 });
    });

    it("a record the JVM store finished, which zeroes the lease and keeps the token, expires at the same age", async () => {
      const s = await store();
      const written = JSON.stringify(record(5_000).frame);
      for (const key of ["read", "claimed"])
        await sql.query(
          "INSERT INTO rayfold_idempotency (scope, key, args_hash, frame, compact_frame, token, held_until, at) VALUES ('s', $1, 'h', $2, $2, 'jvm-token', 0, 5000)",
          [key, written],
        );
      now = 5_999;
      expect(await s.get("s", "read")).toEqual({ ...record(5_000), compactFrame: record(5_000).frame });
      expect(await s.claim("s", "claimed", 100)).toEqual({ state: "done", record: { ...record(5_000), compactFrame: record(5_000).frame } });
      now = 6_000;
      expect(await s.get("s", "read")).toBeUndefined();
      expect(await s.claim("s", "claimed", 100)).toEqual({ state: "owned", token: expect.any(String) });
    });
  });

  it("keeps one viewer's record away from another's on the same key", async () => {
    const f = await fleet(2);
    await book(f.servers[0]!);
    // another seat on the same key: in a scope shared with u1 this would be refused as a reused key
    const other = await book(f.servers[1]!, KEY, 2, { id: "u2" });

    expect(replayed(other as never)).toBe(false);
    expect(f.runs()).toBe(2);
    const mine = await f.store.get(hashJson(viewer), KEY);
    const theirs = await f.store.get(hashJson({ id: "u2" }), KEY);
    expect([mine?.frame, mine?.compactFrame, mine?.at]).toEqual([
      { id: 1, ok: { $type: "Ticket", id: "t1", seat: 1 }, patch: [{ set: "Ticket:t1", value: { $type: "Ticket", id: "t1", seat: 1 } }], meta: { cost: 1 }, fin: true },
      { id: 1, ok: { id: "t1", seat: 1 }, patch: [], fin: true },
      1_000,
    ]);
    expect([theirs?.frame, theirs?.compactFrame, theirs?.at]).toEqual([
      { id: 1, ok: { $type: "Ticket", id: "t2", seat: 2 }, patch: [{ set: "Ticket:t2", value: { $type: "Ticket", id: "t2", seat: 2 } }], meta: { cost: 1 }, fin: true },
      { id: 1, ok: { id: "t2", seat: 2 }, patch: [], fin: true },
      1_000,
    ]);
    expect(theirs?.argsHash).not.toBe(mine?.argsHash);
  });

  it("guard: a key reused for other arguments on another server is refused from the database record, and that command never runs", async () => {
    const f = await fleet(2);
    await book(f.servers[0]!, KEY, 1);
    const other = await book(f.servers[1]!, KEY, 2);
    expect(other[0]).toMatchObject({ error: { code: "already_exists", message: `Idempotency key ${KEY} was used for another operation or other arguments` } });
    expect(f.runs()).toBe(1);
  });

  it("replays in the form the retry asks for: the compact frame comes back from its own column", async () => {
    const f = await fleet(2);
    const full = await book(f.servers[0]!);
    expect(full[0]).toMatchObject({ ok: { $type: "Ticket", id: "t1", seat: 1 } });
    const compact = await f.servers[1]!.collect({ ops: [{ id: 3, op: "book", args: { seat: 1 }, key: KEY, compact: true }] }, { viewer });
    expect(compact).toEqual([{ id: 3, ok: { id: "t1", seat: 1 }, patch: [], fin: true, meta: { replay: true } }]);
    expect(f.runs()).toBe(1);
  });

  it("renew extends the lease for the holder's token only, by exact amounts", async () => {
    const f = await fleet(1);
    const scope = hashJson(viewer);
    const owned = await f.store.claim(scope, KEY, 60);
    if (owned.state !== "owned") throw new Error(`expected to own the key, got ${owned.state}`);
    expect(await f.store.claim(scope, KEY, 60)).toEqual({ state: "inflight", heldUntil: 1_060 });
    now = 1_050;
    expect(await f.store.renew(scope, KEY, owned.token, 60)).toBe(true);
    expect(await f.store.renew(scope, KEY, "someone-else", 60)).toBe(false);
    now = 1_061;
    expect(await f.store.claim(scope, KEY, 60)).toEqual({ state: "inflight", heldUntil: 1_110 }); // renewed once, at 1050, untouched by the stranger
    now = 1_110;
    expect((await f.store.claim(scope, KEY, 60)).state).toBe("owned"); // the lease has run out
  });

  it("a put or release with a lost token changes nothing: the server that took the key over speaks for it", async () => {
    const f = await fleet(1);
    const scope = hashJson(viewer);
    const a = await f.store.claim(scope, KEY, 60);
    now += 61;
    const b = await f.store.claim(scope, KEY, 60);
    if (a.state !== "owned" || b.state !== "owned") throw new Error("both claims should have been granted in turn");
    const record = (run: number) => ({ argsHash: "h", frame: { id: 1, ok: { run }, fin: true }, at: now });
    await f.store.put(scope, KEY, record(1), a.token);
    expect(await f.store.get(scope, KEY)).toBeUndefined(); // ignored: b's claim is still in flight
    await f.store.put(scope, KEY, record(2), b.token);
    expect(await f.store.get(scope, KEY)).toMatchObject({ frame: { ok: { run: 2 } } });
    await f.store.release(scope, KEY, a.token);
    expect(await f.store.get(scope, KEY)).toMatchObject({ frame: { ok: { run: 2 } } });
    expect(await f.store.size()).toBe(1);
  });

  it("through two servers: the one that lost its database loses the key, and its answer is never recorded", async () => {
    const store = new LossyPgStore(sql, { now: () => now });
    await store.migrate();
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
    const [a, b] = [0, 1].map(() => createRayfoldServer({ schema, resolvers, idempotency: store, now: () => now, idempotencyLeaseMs: 60 }));
    const stranded = book(a!);
    for (let turn = 0; turn < 50; turn++) await Promise.resolve();
    expect(store.granted).toHaveLength(1);
    store.lost.add(store.granted[0]!);
    now += 61;

    const taken = await book(b!);
    expect(taken[0]).toMatchObject({ ok: { id: "t1", run: 2 } });
    expect(replayed(taken as never)).toBe(false);
    expect(runs).toBe(2);

    open();
    expect((await stranded)[0]).toMatchObject({ ok: { run: 1 } });
    expect(await store.get(hashJson(viewer), KEY)).toMatchObject({ frame: { ok: { run: 2 } } });
    expect((await book(a!))[0]).toMatchObject({ ok: { run: 2 }, meta: { replay: true } });
    expect(runs).toBe(2);
    expect(await store.size()).toBe(1);
  });

  it("keeps no more than maxRecords, dropping the oldest first", async () => {
    const store = new PgIdempotencyStore(sql, { now: () => now, maxRecords: 3 });
    await store.migrate();
    let runs = 0;
    const server = createRayfoldServer({
      schema: SCHEMA,
      resolvers: { Command: { book: async ({ seat }: { seat: number }) => (runs++, { id: `t${seat}`, seat }) } },
      idempotency: store,
      now: () => now,
    });
    const key = (n: number) => `key-${String(n).padStart(12, "0")}`;
    for (let n = 1; n <= 100; n++) {
      now += 1;
      await book(server, key(n));
    }
    expect(runs).toBe(100);
    expect(await store.size()).toBe(3); // the hundredth write trimmed the table to the cap
    expect(replayed((await book(server, key(100))) as never)).toBe(true);
    expect(replayed((await book(server, key(98))) as never)).toBe(true);
    expect(replayed((await book(server, key(97))) as never)).toBe(false); // gone, so it ran again
    expect(runs).toBe(101);
  });

  it("counts a key held by a running command against the bound, and never evicts it", async () => {
    // spec 12 §3. This store ranked and trimmed only recorded rows, so claims in flight sat outside the bound
    // altogether: a fleet could hold maxRecords records *plus* a claim per running command.
    const store = new PgIdempotencyStore(sql, { now: () => now, maxRecords: 3 });
    await store.migrate();
    const held = await store.claim("v", "held-key", 60_000);
    expect(held.state).toBe("owned");

    let runs = 0;
    const server = createRayfoldServer({
      schema: SCHEMA,
      resolvers: { Command: { book: async ({ seat }: { seat: number }) => (runs++, { id: `t${seat}`, seat }) } },
      idempotency: store,
      now: () => now,
    });
    const key = (n: number) => `key-${String(n).padStart(12, "0")}`;
    for (let n = 1; n <= 100; n++) {
      now += 1;
      await book(server, key(n));
    }
    // three rows in all, not three records beside the live claim
    expect(await store.size()).toBe(3);
    // and the live claim is one of them: it was never evicted, because evicting it would let a second request run
    // the same command
    expect((await store.claim("v", "held-key", 60_000)).state).toBe("inflight");

    // guard: a claim whose lease has run out holds no command, so it does not keep older entries behind it
    now += 120_000;
    await store.claim("v", "stale-key", 1);
    now += 1000;
    for (let n = 101; n <= 200; n++) {
      now += 1;
      await book(server, key(n));
    }
    expect(await store.size()).toBe(3);
  });

  it("works in a schema-qualified table, with the index named after it", async () => {
    await db.query("CREATE SCHEMA app");
    const store = new PgIdempotencyStore(sql, { now: () => now, table: "app.rayfold_idempotency" });
    await store.migrate();
    let runs = 0;
    const server = createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { book: async () => (runs++, { id: "t1", seat: 1 }) } }, idempotency: store, now: () => now });
    await book(server);
    expect(replayed((await book(server)) as never)).toBe(true);
    expect(runs).toBe(1);
    const { rows } = await db.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'app' AND tablename = 'rayfold_idempotency'");
    expect(rows.map((r) => r.indexname).sort()).toEqual(["app_rayfold_idempotency_at", "rayfold_idempotency_pkey"]);
  });

  it("names a mixed-case table as written, as JdbcIdempotencyStore does, so a mixed fleet shares one table", async () => {
    await db.query(`CREATE SCHEMA "Shop"`);
    const store = new PgIdempotencyStore(sql, { now: () => now, table: "Shop.Idempotency" });
    await store.migrate();
    let runs = 0;
    const server = createRayfoldServer({ schema: SCHEMA, resolvers: { Command: { book: async () => (runs++, { id: "t1", seat: 1 }) } }, idempotency: store, now: () => now });
    await book(server);
    expect(replayed((await book(server)) as never)).toBe(true);
    expect(runs).toBe(1);
    // unquoted, Postgres folded it to shop.idempotency, a table the JVM store (which quotes) never reads
    const tables = await db.query<{ name: string }>(`SELECT schemaname || '.' || tablename AS name FROM pg_tables WHERE tablename ILIKE 'idempotency'`);
    expect(tables.rows.map((r) => r.name)).toEqual(["Shop.Idempotency"]);
    const { rows } = await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'Shop' AND tablename = 'Idempotency'`);
    expect(rows.map((r) => r.indexname).sort()).toEqual(["Idempotency_pkey", "Shop_Idempotency_at"]);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Shop"."Idempotency"`)).rows[0]?.n).toBe(1);
  });
});

describe("a statement the store sends that fails", () => {
  const record = { argsHash: "h", frame: { id: 1, ok: { id: "t1" }, fin: true }, at: 1_000 };
  const sweepFails = (): Queryable => ({
    query: async (text, params) => {
      if (/^DELETE FROM .* WHERE frame IS NOT NULL AND at <= \$1$/.test(text)) throw new Error("the disk is full");
      return (await db.query(text, params)) as never;
    },
  });

  it("fails the put that sent it, rather than going unseen", async () => {
    const store = new PgIdempotencyStore(sweepFails(), { now: () => now });
    await store.migrate();
    const claim = await store.claim("s", KEY, 1_000);
    if (claim.state !== "owned") throw new Error(`expected to own the key, got ${claim.state}`);
    await expect(store.put("s", KEY, record, claim.token)).rejects.toThrow("the disk is full");
  });

  it("fails the hundredth put when trimming to the bound fails", async () => {
    let trims = 0;
    const trimFails: Queryable = {
      query: async (text, params) => {
        if (/row_number\(\) OVER/.test(text)) {
          trims++;
          throw new Error("the trim failed");
        }
        return (await db.query(text, params)) as never;
      },
    };
    const store = new PgIdempotencyStore(trimFails, { now: () => now, maxRecords: 3 });
    await store.migrate();
    for (let i = 1; i <= 100; i++) {
      const key = `key-${String(i).padStart(12, "0")}`;
      const claim = await store.claim("s", key, 1_000);
      if (claim.state !== "owned") throw new Error(`expected to own ${key}, got ${claim.state}`);
      if (i < 100) await store.put("s", key, record, claim.token);
      else await expect(store.put("s", key, record, claim.token)).rejects.toThrow("the trim failed");
    }
    expect(trims).toBe(1);
  }, 30_000);

  it("guard: the same put over a working connection resolves, and the record reads back", async () => {
    const store = new PgIdempotencyStore(sql, { now: () => now });
    await store.migrate();
    const claim = await store.claim("s", KEY, 1_000);
    if (claim.state !== "owned") throw new Error(`expected to own the key, got ${claim.state}`);
    await store.put("s", KEY, record, claim.token);
    expect(await store.get("s", KEY)).toEqual(record);
  });
});
