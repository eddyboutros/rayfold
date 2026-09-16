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
});
