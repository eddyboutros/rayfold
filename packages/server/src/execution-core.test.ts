import { afterEach, describe, expect, it, vi } from "vitest";
import { createRayfoldServer } from "./server.ts";
import { ok } from "./executor.ts";
import type { Outcome } from "./instrumentation.ts";
import type { Change } from "./live.ts";
import type { Frame } from "./protocol.ts";
import type { MemoryShapeRegistry } from "./views.ts";
import { Signal, bounded } from "../../../e2e/wait.ts";

const KEY = "0123456789abcdef";
const u1 = { id: "u1" };

afterEach(() => {
  vi.useRealTimers();
});

describe("a command that commits and then fails to answer", () => {
  const schema = `entity A { id: ID name: String }
    event Made { id: ID }
    command make(id: ID): A emits Made
    command refuse(id: ID): A emits Made throws Nope
    error Nope {}`;
  const server = () =>
    createRayfoldServer({
      schema,
      resolvers: {
        Command: {
          // `name` is non-null and missing, so projecting the result fails after the write happened
          make: (a: { id: string }) => ok({ id: a.id }, { emit: [{ event: "Made", payload: { id: a.id } }] }),
          refuse: () => {
            throw new Error("no");
          },
        },
      },
    });

  it("still publishes its change and its declared events", async () => {
    const s = server();
    const changes: Change[] = [];
    const events: unknown[] = [];
    s.changes.subscribe((c) => changes.push(c));
    s.events.on("Made", (p) => events.push(p));
    const frames = await s.collect({ ops: [{ id: 1, op: "make", args: { id: "a1" }, key: KEY }] }, { viewer: u1 });
    expect(frames).toEqual([{ id: 1, error: { code: "internal", message: "Non-null field A.name resolved to null", path: "name" }, fin: true }]);
    expect(changes.map((c) => ({ keys: [...c.keys], ops: [...c.ops] }))).toEqual([{ keys: ["A:a1"], ops: [] }]);
    expect(events).toEqual([{ id: "a1", seq: 1 }]);
  });

  it("guard: a command that failed before it committed publishes nothing", async () => {
    const s = server();
    const changes: Change[] = [];
    const events: unknown[] = [];
    s.changes.subscribe((c) => changes.push(c));
    s.events.on("Made", (p) => events.push(p));
    expect(await s.collect({ ops: [{ id: 1, op: "refuse", args: { id: "a1" }, key: KEY }] }, { viewer: u1 })).toEqual([{ id: 1, error: { code: "internal", message: "Internal error" }, fin: true }]);
    expect(changes).toEqual([]);
    expect(events).toEqual([]);
  });

  it("an open live query hears it and reads again", async () => {
    let name: string | null = "old";
    const s = createRayfoldServer({
      schema: `entity A { id: ID name: String } query a(id: ID): A command rename(id: ID, to: String?): A`,
      resolvers: {
        Query: { a: (x: { id: string }) => ({ id: x.id, name: name ?? "gone" }) },
        Command: { rename: (x: { id: string; to: string | null }) => ((name = x.to), { id: x.id, name: x.to }) },
      },
    });
    const frames = new Signal<Frame>();
    const ac = new AbortController();
    const live = (async () => {
      for await (const f of s.execute({ ops: [{ id: 1, op: "a", args: { id: "a1" }, shape: "{ id name }", live: true }] }, { signal: ac.signal })) frames.push(f);
    })();
    await frames.atLeast(1, "the live query's first answer");
    // the answer fails (name is non-null), but the rename happened
    expect(await s.collect({ ops: [{ id: 1, op: "rename", args: { id: "a1", to: null }, key: KEY }] }, { viewer: u1 })).toMatchObject([{ id: 1, error: { code: "internal" } }]);
    await frames.atLeast(2, "the live query hearing the change");
    expect(frames.items[1]).toEqual({ id: 1, patch: [{ set: "A:a1", value: { name: "gone" } }] });
    ac.abort();
    await bounded(live, "live op ended");
  });
});

describe("@defer and type conditions at a union position", () => {
  const schema = `object Named @interface { name: String }
    entity Author implements Named { id: ID name: String }
    entity Book { id: ID title: String }
    union Hit = Book | Author
    query hit(book: Boolean): Hit`;
  const s = () =>
    createRayfoldServer({
      schema,
      resolvers: { Query: { hit: (a: { book: boolean }) => (a.book ? { $type: "Book", id: "b1", title: "T" } : { $type: "Author", id: "a1", name: "A" }) } },
    });

  it("a deferred block reaches the member, in a later frame", async () => {
    expect(await s().collect({ ops: [{ id: 1, op: "hit", args: { book: false }, shape: "{ ...on Author { id } @defer { name } }" }] })).toEqual([
      { id: 1, data: { $type: "Author", id: "a1" }, meta: { cost: 2 } },
      { id: 1, at: "", data: { name: "A" } },
      { id: 1, fin: true },
    ]);
  });

  it("a condition on an interface the member implements selects its fields", async () => {
    expect(await s().collect({ ops: [{ id: 1, op: "hit", args: { book: false }, shape: "{ ...on Named { name } }" }] })).toEqual([
      { id: 1, data: { $type: "Author", name: "A" }, meta: { cost: 1 }, fin: true },
    ]);
  });

  it("guard: a condition on an interface the member does not implement selects nothing, so its default view applies", async () => {
    expect(await s().collect({ ops: [{ id: 1, op: "hit", args: { book: true }, shape: "{ ...on Named { name } }" }] })).toEqual([
      { id: 1, data: { $type: "Book", id: "b1", title: "T" }, meta: { cost: 1 }, fin: true },
    ]);
  });
});

describe("errors of a deferred frame", () => {
  const s = () =>
    createRayfoldServer({
      schema: `entity Book { id: ID bio: String @lazy } query books: [Book] query book: Book`,
      resolvers: {
        Query: { books: () => Array.from({ length: 12 }, (_, i) => ({ id: `b${i}` })), book: () => ({ id: "b10" }) },
        Book: { bio: (ps: Array<{ id: string }>) => ps.map((p) => (p.id === "b10" ? null : `bio of ${p.id}`)) },
      },
    });

  it("belong to the frame at their own path, not to one whose path is a prefix of it", async () => {
    const frames = (await s().collect({ ops: [{ id: 1, op: "books", shape: "{ id bio @partial }" }] })) as Array<Frame & { at?: string; errors?: unknown }>;
    const withErrors = frames.filter((f) => f.errors).map((f) => ({ at: f.at, errors: f.errors }));
    expect(withErrors).toEqual([{ at: "10", errors: [{ code: "internal", message: "Non-null field Book.bio resolved to null", path: "10.bio" }] }]);
  });

  it("guard: a deferred frame at the root carries every error beneath it", async () => {
    expect(await s().collect({ ops: [{ id: 1, op: "book", shape: "{ id bio @partial }" }] })).toEqual([
      { id: 1, data: { $type: "Book", id: "b10" }, meta: { cost: 1 } },
      { id: 1, at: "", data: { bio: null }, errors: [{ code: "internal", message: "Non-null field Book.bio resolved to null", path: "bio" }] },
      { id: 1, fin: true },
    ]);
  });
});

describe("argument coercion agrees with the JVM runtime", () => {
  const s = () =>
    createRayfoldServer({
      schema: `entity A { id: ID } query slug(s: String @format("slug", pattern: "[a-z]+")): A query int(n: Int): A query long(n: Long): A`,
      resolvers: { Query: { slug: () => ({ id: "s" }), int: () => ({ id: "i" }), long: () => ({ id: "l" }) } },
    });
  const outcome = async (op: string, args: Record<string, unknown>) => {
    const f = (await s().collect({ ops: [{ id: 1, op, args, shape: "{ id }" }] }))[0]!;
    return "error" in f ? f.error.message : "ok";
  };

  it("@format(pattern:) must match the whole value", async () => {
    expect(await outcome("slug", { s: "abc'; DROP--" })).toBe("slug().s: must match [a-z]+");
    expect(await outcome("slug", { s: "--abc" })).toBe("slug().s: must match [a-z]+");
    expect(await outcome("slug", { s: "abc" })).toBe("ok"); // guard
  });

  it("@format refuses an input too long to match before matching it", async () => {
    expect(await outcome("slug", { s: "a".repeat(10_001) })).toBe("slug().s: longer than 10000 characters, too long to match [a-z]+");
    expect(await outcome("slug", { s: "a".repeat(10_000) })).toBe("ok"); // guard: the bound itself matches
  });

  it("Int takes exactly the 32-bit range, its minimum included", async () => {
    expect(await outcome("int", { n: -2_147_483_648 })).toBe("ok");
    expect(await outcome("int", { n: 2_147_483_647 })).toBe("ok");
    expect(await outcome("int", { n: -2_147_483_649 })).toBe("int().n: expected Int");
    expect(await outcome("int", { n: 2_147_483_648 })).toBe("int().n: expected Int");
  });

  it("Long text takes exactly the 64-bit range", async () => {
    expect(await outcome("long", { n: "9223372036854775807" })).toBe("ok");
    expect(await outcome("long", { n: "-9223372036854775808" })).toBe("ok");
    expect(await outcome("long", { n: "9223372036854775808" })).toBe("long().n: expected Long");
    expect(await outcome("long", { n: "99999999999999999999999" })).toBe("long().n: expected Long");
    expect(await outcome("long", { n: "-9223372036854775809" })).toBe("long().n: expected Long");
  });
});

describe("@idempotent(false) takes no key", () => {
  const s = (runs: string[]) =>
    createRayfoldServer({
      schema: `entity A { id: ID } command free(n: Int): A @idempotent(false) command kept(n: Int): A`,
      resolvers: { Command: { free: () => (runs.push("free"), { id: `f${runs.length}` }), kept: () => (runs.push("kept"), { id: `k${runs.length}` }) } },
    });

  it("a key sent anyway is ignored: every call runs, and none is a replay", async () => {
    const runs: string[] = [];
    const server = s(runs);
    const call = () => server.collect({ ops: [{ id: 1, op: "free", args: { n: 1 }, key: KEY }] }, { viewer: u1 });
    expect(await call()).toEqual([{ id: 1, ok: { $type: "A", id: "f1" }, patch: [{ set: "A:f1", value: { $type: "A", id: "f1" } }], meta: { cost: 1 }, fin: true }]);
    expect(await call()).toEqual([{ id: 1, ok: { $type: "A", id: "f2" }, patch: [{ set: "A:f2", value: { $type: "A", id: "f2" } }], meta: { cost: 1 }, fin: true }]);
    // nor does a key from an anonymous caller refuse it: there is no replay scope to share
    expect(await server.collect({ ops: [{ id: 1, op: "free", args: { n: 1 }, key: KEY }] })).toMatchObject([{ ok: { id: "f3" } }]);
    expect(runs).toEqual(["free", "free", "free"]);
  });

  it("guard: a command that does not opt out still replays its key", async () => {
    const runs: string[] = [];
    const server = s(runs);
    const call = () => server.collect({ ops: [{ id: 1, op: "kept", args: { n: 1 }, key: KEY }] }, { viewer: u1 });
    await call();
    expect(await call()).toMatchObject([{ ok: { id: "k1" }, meta: { replay: true } }]);
    expect(runs).toEqual(["kept"]);
  });
});

describe("what a resolver threw reaches the op hook, never the client", () => {
  const boom = new TypeError("db connection string postgres://secret");
  const s = (outcomes: Outcome[]) =>
    createRayfoldServer({
      schema: `entity A { id: ID name: String } query bad: A query good: A command make: A @idempotent(false)`,
      resolvers: {
        Query: {
          bad: () => {
            throw boom;
          },
          good: () => ({ id: "g", name: "G" }),
        },
        Command: { make: () => ({ id: "m", name: "M" }) },
        A: {
          name: () => {
            throw boom;
          },
        },
      },
      instrumentation: { op: async (_info, run) => { const o = await run(); outcomes.push(o); return o; } },
    });

  it("a query's exception is the outcome's cause, and the client is told only internal", async () => {
    const outcomes: Outcome[] = [];
    expect(await s(outcomes).collect({ ops: [{ id: 1, op: "bad" }] })).toEqual([{ id: 1, error: { code: "internal", message: "Internal error" }, fin: true }]);
    expect(outcomes).toEqual([{ error: { code: "internal", message: "Internal error" }, cause: boom }]);
  });

  it("a command that committed and then failed in a loader reports the loader's exception", async () => {
    const outcomes: Outcome[] = [];
    expect(await s(outcomes).collect({ ops: [{ id: 1, op: "make", shape: "{ id name }" }] })).toEqual([{ id: 1, error: { code: "internal", message: "Internal error" }, fin: true }]);
    expect(outcomes[0]!.cause).toBe(boom);
  });

  it("guard: an op that succeeded has no cause", async () => {
    const outcomes: Outcome[] = [];
    await s(outcomes).collect({ ops: [{ id: 1, op: "good", shape: "{ id }" }] });
    expect(outcomes).toEqual([{}]);
  });
});

describe("an op's own deadline counts from the start of the batch", () => {
  const s = () =>
    createRayfoldServer({
      schema: `entity A { id: ID } command slow: A @idempotent(false) query read(id: ID): A`,
      resolvers: {
        Command: { slow: () => new Promise((r) => setTimeout(() => r({ id: "s" }), 80)) },
        Query: { read: (a: { id: string }) => ({ id: a.id }) },
      },
    });

  it("time spent waiting for the op it refers to counts, and it ends while it waits", async () => {
    vi.useFakeTimers();
    const frames = new Signal<Frame>();
    const done = (async () => {
      for await (const f of s().execute({ ops: [{ id: 1, op: "slow", shape: "{ id }" }, { id: 2, op: "read", args: { id: { $ref: "1.id" } }, shape: "{ id }", deadline: 50 }] })) frames.push(f);
    })();
    await vi.advanceTimersByTimeAsync(50);
    // op 1 is still running; op 2 ran out of time waiting for it
    expect(frames.items).toEqual([{ id: 2, error: { code: "deadline_exceeded", message: "Deadline exceeded" }, fin: true }]);
    await vi.advanceTimersByTimeAsync(30);
    await done;
    expect(frames.items.slice(1)).toEqual([{ id: 1, ok: { $type: "A", id: "s" }, patch: [{ set: "A:s", value: { $type: "A", id: "s" } }], meta: { cost: 1 }, fin: true }]);
  });

  it("guard: a deadline long enough for the wait and the op lets it run", async () => {
    vi.useFakeTimers();
    const p = s().collect({ ops: [{ id: 1, op: "slow", shape: "{ id }" }, { id: 2, op: "read", args: { id: { $ref: "1.id" } }, shape: "{ id }", deadline: 100 }] });
    await vi.advanceTimersByTimeAsync(80);
    expect((await p).map((f) => ("error" in f ? f.error.code : "ok"))).toEqual(["ok", "ok"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("order of checks", () => {
  it("an unauthorized dry run of a command without @simulate is refused for permission, revealing nothing else", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID } command careless: A @idempotent(false) @allow(write: viewer.role == "admin")`,
      resolvers: { Command: { careless: () => ({ id: "a" }) } },
    });
    expect(await s.collect({ ops: [{ id: 1, op: "careless", simulate: true }] }, { viewer: { id: "u1", role: "customer" } })).toMatchObject([{ id: 1, error: { code: "permission_denied" } }]);
    // guard: an authorized caller learns the command takes no dry run
    expect(await s.collect({ ops: [{ id: 1, op: "careless", simulate: true }] }, { viewer: { id: "u9", role: "admin" } })).toMatchObject([{ id: 1, error: { code: "failed_precondition" } }]);
  });

  it("an inline shape is remembered only when its batch is within budget", async () => {
    const s = createRayfoldServer({ schema: `entity A { id: ID } query a: A`, resolvers: { Query: { a: () => ({ id: "a" }) } }, budget: 1 });
    const shapes = s.shapes as MemoryShapeRegistry; // the default registry
    const before = shapes.size;
    expect(await s.collect({ ops: [{ id: 1, op: "a", shape: "{ id }" }, { id: 2, op: "a", shape: "{ id }" }] })).toMatchObject([{ error: { code: "resource_exhausted" } }]);
    expect(shapes.size).toBe(before);
    await s.collect({ ops: [{ id: 1, op: "a", shape: "{ id }" }] }); // guard
    expect(shapes.size).toBe(before + 1);
  });
});

describe("drain()", () => {
  it("waits for a batch that is running though nobody reads its frames, and every concurrent caller wakes when it ends", async () => {
    let release: () => void = () => {};
    const started = new Signal<string>();
    const s = createRayfoldServer({
      schema: `entity A { id: ID } command hold: A @idempotent(false)`,
      resolvers: { Command: { hold: () => (started.push("hold"), new Promise((r) => (release = () => r({ id: "h" })))) } },
    });
    s.execute({ ops: [{ id: 1, op: "hold" }] }); // started, never read
    await started.atLeast(1, "the command running");
    expect(s.inflight).toBe(1);
    const drained: string[] = [];
    const first = s.drain({ timeoutMs: 60_000 }).then(() => drained.push("first"));
    const second = s.drain({ timeoutMs: 60_000 }).then(() => drained.push("second"));
    await new Promise((r) => setImmediate(r));
    expect(drained).toEqual([]); // the command still runs
    release();
    await bounded(Promise.all([first, second]), "both drains waking when the batch ended");
    expect(drained.sort()).toEqual(["first", "second"]);
    expect(s.inflight).toBe(0);
  });

  it("guard: a batch that is read to its end stops counting then", async () => {
    const s = createRayfoldServer({ schema: `entity A { id: ID } query a: A`, resolvers: { Query: { a: () => ({ id: "a" }) } } });
    const frames = s.execute({ ops: [{ id: 1, op: "a", shape: "{ id }" }] });
    expect(s.inflight).toBe(1); // counted from execute(), before the first frame is asked for
    for await (const _ of frames) void _;
    await bounded(s.drain({ timeoutMs: 60_000 }), "drain waking once the batch ended");
    expect(s.inflight).toBe(0);
  });
});
