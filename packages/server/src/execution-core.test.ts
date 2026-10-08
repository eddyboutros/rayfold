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

describe("projection, through the batch", () => {
  const frames = (schema: string, resolvers: Record<string, unknown>, op: Record<string, unknown>, viewer?: unknown) =>
    createRayfoldServer({ schema, resolvers: resolvers as never }).collect({ ops: [{ id: 1, ...op } as never] }, { viewer });

  it("a command that emits an event it did not declare fails internal, and the event goes nowhere", async () => {
    const schema = `entity A { id: ID } event Made { id: ID } event Other { id: ID } command make(other: Boolean): A emits Made @idempotent(false)`;
    const s = createRayfoldServer({
      schema,
      resolvers: { Command: { make: (a: { other: boolean }) => ok({ id: "a1" }, { emit: [{ event: a.other ? "Other" : "Made", payload: { id: "a1" } }] }) } },
    });
    const heard: string[] = [];
    s.events.on("*", (p) => heard.push((p as { event: string }).event));
    expect(await s.collect({ ops: [{ id: 1, op: "make", args: { other: true }, shape: "{ id }" }] })).toEqual([{ id: 1, error: { code: "internal", message: "make emitted undeclared event Other" }, fin: true }]);
    expect(heard).toEqual([]);
    // guard: the declared one is published and the command answers
    expect(await s.collect({ ops: [{ id: 1, op: "make", args: { other: false }, shape: "{ id }" }] })).toEqual([
      { id: 1, ok: { $type: "A", id: "a1" }, patch: [{ set: "A:a1", value: { $type: "A", id: "a1" } }], meta: { cost: 1 }, fin: true },
    ]);
    expect(heard).toEqual(["Made"]);
  });

  const partialName = `entity A { id: ID name: String? @partial } command make: A @idempotent(false) stream feed: A`;
  const nameError = { code: "internal", message: "Internal error", path: "name" };
  const failing = () => {
    throw new Error("the name service is down");
  };

  it("a command's @partial errors travel on its compact frame as on its full one", async () => {
    const resolvers = { A: { name: failing }, Command: { make: () => ({ id: "a1" }) } };
    expect(await frames(partialName, resolvers, { op: "make", shape: "{ id name }", compact: true })).toEqual([{ id: 1, ok: { id: "a1", name: null }, patch: [], errors: [nameError], fin: true }]);
    expect(await frames(partialName, resolvers, { op: "make", shape: "{ id name }" })).toEqual([
      { id: 1, ok: { $type: "A", id: "a1", name: null }, patch: [{ set: "A:a1", value: { $type: "A", id: "a1", name: null } }], meta: { cost: 1 }, errors: [nameError], fin: true },
    ]);
  });

  it("a stream item carries its own @partial errors, and the item without them carries none (guard)", async () => {
    let n = 0;
    const resolvers = {
      A: { name: (ps: unknown[]) => (n++ === 0 ? failing() : ps.map(() => "second")) },
      Stream: {
        feed: async function* () {
          yield { id: "a1" };
          yield { id: "a2" };
        },
      },
    };
    expect(await frames(partialName, resolvers, { op: "feed", shape: "{ id name }" })).toEqual([
      { id: 1, item: { $type: "A", id: "a1", name: null }, errors: [nameError] },
      { id: 1, item: { $type: "A", id: "a2", name: "second" } },
      { id: 1, fin: true },
    ]);
  });

  it("a stream stopped between two items ends with the reason it was stopped for", async () => {
    // the drain lands while the first item is being projected, so the stream sees it at the top of its loop
    const holder: { s?: ReturnType<typeof createRayfoldServer> } = {};
    const s = createRayfoldServer({
      schema: `entity A { id: ID name: String } stream feed: A`,
      resolvers: {
        A: { name: (ps: unknown[]) => (void holder.s?.drain({ timeoutMs: 5_000 }), ps.map(() => "n")) },
        Stream: {
          feed: async function* () {
            yield { id: "a1" };
            yield { id: "a2" };
          },
        },
      } as never,
    });
    holder.s = s;
    expect(await s.collect({ ops: [{ id: 1, op: "feed", shape: "{ id name }" }] })).toEqual([
      { id: 1, item: { $type: "A", id: "a1", name: "n" } },
      { id: 1, error: { code: "unavailable", message: "The server is shutting down" }, fin: true },
    ]);
  });

  const docs = `entity Doc @allow(read: viewer.id == ownerId) { id: ID ownerId: ID } query docs: [Doc?]`;
  const docResolvers = { Query: { docs: () => [{ id: "d1", ownerId: "u1" }, null] } };

  it("a denied entity in a top-level list whose elements may be null fails the op for an explicit shape", async () => {
    expect(await frames(docs, docResolvers, { op: "docs", shape: "{ id }" }, { id: "u2" })).toEqual([{ id: 1, error: { code: "permission_denied", message: "Not allowed to access Doc at 0", path: "0" }, fin: true }]);
    // guards: the owner reads it, and the genuinely null element stays null
    expect(await frames(docs, docResolvers, { op: "docs", shape: "{ id }" }, { id: "u1" })).toEqual([{ id: 1, data: [{ $type: "Doc", id: "d1" }, null], meta: { cost: 1 }, fin: true }]);
    // guard: a default view never fails on policy, it reads the denied element as null
    expect(await frames(docs, docResolvers, { op: "docs" }, { id: "u2" })).toEqual([{ id: 1, data: [null, null], meta: { cost: 1 }, fin: true }]);
  });

  it("a field selected without a sub-shape gets its default view, which never fails on policy", async () => {
    const schema = `entity Secret @allow(read: viewer != null) { id: ID } entity Box { id: ID secret: Secret } query box: Box`;
    const resolvers = { Query: { box: () => ({ id: "x", secret: { id: "s" } }) } };
    expect(await frames(schema, resolvers, { op: "box", shape: "{ id secret }" })).toEqual([{ id: 1, data: { $type: "Box", id: "x", secret: null }, meta: { cost: 2 }, fin: true }]);
    // guard: the same field with a shape of its own is explicit, and a denial at that non-null position fails the op
    expect(await frames(schema, resolvers, { op: "box", shape: "{ id secret { id } }" })).toEqual([
      { id: 1, error: { code: "unauthenticated", message: "Sign in to access Secret at secret", path: "secret" }, fin: true },
    ]);
  });

  it("a field with arguments and no loader is served only when every parent carries it", async () => {
    const schema = `entity Author { id: ID books(page: PageArgs = { first: 10 }): Page<Book> } entity Book { id: ID } query authors: [Author]`;
    const page = { items: [], hasMore: false };
    expect(await frames(schema, { Query: { authors: () => [{ id: "a1", books: page }, { id: "a2" }] } }, { op: "authors", shape: "{ id books { hasMore } }" })).toEqual([
      { id: 1, error: { code: "unimplemented", message: "No loader for Author.books", path: "0.books" }, fin: true },
    ]);
    // guard: when they all do, it is
    expect(await frames(schema, { Query: { authors: () => [{ id: "a1", books: page }, { id: "a2", books: page }] } }, { op: "authors", shape: "{ id books { hasMore } }" })).toEqual([
      { id: 1, data: [{ $type: "Author", id: "a1", books: { hasMore: false } }, { $type: "Author", id: "a2", books: { hasMore: false } }], meta: { cost: 12 }, fin: true },
    ]);
  });
});

describe("loads remembered for the batch", () => {
  type Call = { parents: string[]; upper: boolean };
  const labels = (calls: Call[], fail = 0) =>
    createRayfoldServer({
      schema: `entity A { id: ID label(upper: Boolean): String } object Row { id: ID v: String } query a(id: ID): A query same: [A] query rows: [Row]`,
      resolvers: {
        Query: { a: (x: { id: string }) => ({ id: x.id }), same: () => [{ id: "a1" }, { id: "a1" }], rows: () => [{ id: "1", x: "first" }, { id: "1", x: "second" }] },
        A: {
          label: (ps: Array<{ id: string }>, args: { upper: boolean }) => {
            calls.push({ parents: ps.map((p) => p.id), upper: args.upper });
            if (calls.length <= fail) throw new Error("the store blinked");
            return ps.map((p) => (args.upper ? p.id.toUpperCase() : p.id));
          },
        },
        Row: { v: (ps: Array<{ x: string }>) => ps.map((p) => p.x) },
      } as never,
    });

  it("are kept apart by their arguments", async () => {
    const calls: Call[] = [];
    expect(await labels(calls).collect({ ops: [{ id: 1, op: "a", args: { id: "a1" }, shape: "{ lo: label(upper: false) hi: label(upper: true) }" }] })).toEqual([
      { id: 1, data: { $type: "A", lo: "a1", hi: "A1" }, meta: { cost: 1 }, fin: true },
    ]);
    expect(calls).toEqual([{ parents: ["a1"], upper: false }, { parents: ["a1"], upper: true }]);
  });

  it("serve an entity that appears twice at one level from one load of it", async () => {
    const calls: Call[] = [];
    expect(await labels(calls).collect({ ops: [{ id: 1, op: "same", shape: "{ id label(upper: true) }" }] })).toEqual([
      { id: 1, data: [{ $type: "A", id: "a1", label: "A1" }, { $type: "A", id: "a1", label: "A1" }], meta: { cost: 1 }, fin: true },
    ]);
    expect(calls).toEqual([{ parents: ["a1"], upper: true }]);
  });

  it("guard: objects have no identity, so two with the same id are loaded as two", async () => {
    expect(await labels([]).collect({ ops: [{ id: 1, op: "rows", shape: "{ id v }" }] })).toEqual([{ id: 1, data: [{ id: "1", v: "first" }, { id: "1", v: "second" }], meta: { cost: 1 }, fin: true }]);
  });

  it("forget a load that failed, so a later op of the same batch loads it again", async () => {
    const calls: Call[] = [];
    const frames = await labels(calls, 1).collect({
      ops: [
        { id: 1, op: "a", args: { id: "a1" }, shape: "{ id label(upper: true) @partial }" },
        { id: 2, op: "a", args: { id: { $ref: "1.id" } }, shape: "{ label(upper: true) }" },
      ],
    });
    expect(frames).toEqual([
      { id: 1, data: { $type: "A", id: "a1", label: null }, meta: { cost: 1 }, errors: [{ code: "internal", message: "Internal error", path: "label" }], fin: true },
      { id: 2, data: { $type: "A", label: "A1" }, meta: { cost: 1 }, fin: true },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("refuse a loader that answers for fewer parents than it was given, rather than waiting for the rest", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID name: String } query all: [A]`,
      resolvers: { Query: { all: () => [{ id: "a1" }, { id: "a2" }] }, A: { name: () => ["only one"] } } as never,
    });
    expect(await bounded(s.collect({ ops: [{ id: 1, op: "all", shape: "{ name }" }] }), "the short loader refused")).toEqual([
      { id: 1, error: { code: "internal", message: "Loader for A.name returned 1 for 2 parents", path: "0.name" }, fin: true },
    ]);
  });

  it("refuse a loader that answers for more parents than it was given, rather than dropping the extra answers", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID name: String } query all: [A]`,
      resolvers: { Query: { all: () => [{ id: "a1" }, { id: "a2" }] }, A: { name: () => ["one", "two", "three"] } } as never,
    });
    expect(await bounded(s.collect({ ops: [{ id: 1, op: "all", shape: "{ name }" }] }), "the long loader refused")).toEqual([
      { id: 1, error: { code: "internal", message: "Loader for A.name returned 3 for 2 parents", path: "0.name" }, fin: true },
    ]);
  });

  it("one alias asked twice with different arguments is refused; asked twice alike it merges, @partial included", async () => {
    const calls: Call[] = [];
    expect(await labels(calls).collect({ ops: [{ id: 1, op: "a", args: { id: "a1" }, shape: "{ label(upper: true) label(upper: false) }" }] })).toEqual([
      { id: 1, error: { code: "invalid_argument", message: "Conflicting selections for label on A" }, fin: true },
    ]);
    expect(calls).toEqual([]);
    // the second mention's @partial applies to the merged selection, so the failed load is an errors entry, not a failed op
    expect(await labels(calls, 1).collect({ ops: [{ id: 1, op: "a", args: { id: "a1" }, shape: "{ id label(upper: true) label(upper: true) @partial }" }] })).toEqual([
      { id: 1, data: { $type: "A", id: "a1", label: null }, meta: { cost: 1 }, errors: [{ code: "internal", message: "Internal error", path: "label" }], fin: true },
    ]);
  });
});

describe("scalars and patches on the way out", () => {
  it("each scalar is written in its wire form, in lists too", async () => {
    const s = createRayfoldServer({
      schema: `entity S { id: ID big: Long small: Long huge: Long bigs: [Long] when: Instant day: Date price: Decimal raw: Bytes } query s: S`,
      resolvers: {
        Query: {
          s: () => ({
            id: "s",
            big: 2n ** 60n,
            small: 7,
            huge: 2 ** 60,
            bigs: [2n ** 60n, 3],
            when: new Date("2026-09-13T10:20:30.000Z"),
            day: new Date("2026-09-13T23:00:00.000Z"),
            price: 12.5,
            raw: Uint8Array.of(251, 255),
          }),
        },
      } as never,
    });
    expect(await s.collect({ ops: [{ id: 1, op: "s", shape: "{ big small huge bigs when day price raw }" }] })).toEqual([
      {
        id: 1,
        data: { $type: "S", big: "1152921504606846976", small: 7, huge: "1152921504606847000", bigs: ["1152921504606846976", 3], when: "2026-09-13T10:20:30.000Z", day: "2026-09-13", price: "12.5", raw: "-_8" },
        meta: { cost: 1 },
        fin: true,
      },
    ]);
  });

  it("an entity met at two places in a command's result is one set patch holding both selections", async () => {
    const author = { id: "a1", name: "Ann", born: 1929 };
    const s = createRayfoldServer({
      schema: `entity Author { id: ID name: String born: Int } entity Book { id: ID author: Author translator: Author } command touch: Book @idempotent(false)`,
      resolvers: { Command: { touch: () => ({ id: "b1", author, translator: author }) } },
    });
    const [f] = await s.collect({ ops: [{ id: 1, op: "touch", shape: "{ id author { id name } translator { id born } }" }] });
    expect((f as { patch: unknown }).patch).toEqual([
      { set: "Book:b1", value: { $type: "Book", id: "b1", author: { $ref: "Author:a1" }, translator: { $ref: "Author:a1" } } },
      { set: "Author:a1", value: { $type: "Author", id: "a1", name: "Ann", born: 1929 } },
    ]);
  });

  it("a union or interface value whose $type is not one of its members is refused, not projected as that type", async () => {
    const s = createRayfoldServer({
      schema: `entity A { id: ID } entity B { id: ID } entity R { id: ID } union H = A | B object N @interface { id: ID } entity P implements N { id: ID } query h: H query i: N`,
      resolvers: { Query: { h: () => ({ $type: "R", id: "r" }), i: () => ({ $type: "R", id: "r" }) } },
    });
    expect(await s.collect({ ops: [{ id: 1, op: "h" }, { id: 2, op: "i" }] })).toEqual([
      { id: 1, error: { code: "internal", message: "Union H value at  lacks a valid $type", path: "" }, fin: true },
      { id: 2, error: { code: "internal", message: "Interface N value at  lacks a valid $type", path: "" }, fin: true },
    ]);
  });
});

describe("a batch counts as in flight until its reader is done with it", () => {
  /** A server whose batch hook says when the batch has finished running. */
  const settledServer = () => {
    const ran = new Signal<true>();
    const s = createRayfoldServer({
      schema: `entity A { id: ID bio: String @lazy } query a: A`,
      resolvers: { Query: { a: () => ({ id: "a", bio: "b" }) } },
      instrumentation: { batch: async (_info, run) => { const o = await run(); ran.push(true); return o; } },
    });
    return { s, ran };
  };

  it("a reader still reading holds it, however long ago the batch finished running", async () => {
    const { s, ran } = settledServer();
    const it = s.execute({ ops: [{ id: 1, op: "a", shape: "{ id bio }" }] })[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ id: 1, data: { $type: "A", id: "a" }, meta: { cost: 1 } });
    await ran.atLeast(1, "the batch finished running");
    await new Promise((r) => setImmediate(r)); // past the settle callback that follows the hook
    expect(s.inflight).toBe(1); // two frames are still unread
    while (!(await it.next()).done);
    expect(s.inflight).toBe(0);
  });

  it("a reader that stops early lets it go, and a drain waiting on it wakes", async () => {
    const { s } = settledServer();
    for await (const f of s.execute({ ops: [{ id: 1, op: "a", shape: "{ id bio }" }] })) {
      expect(f).toEqual({ id: 1, data: { $type: "A", id: "a" }, meta: { cost: 1 } });
      break;
    }
    await bounded(s.drain({ timeoutMs: 60_000 }), "drain waking once the reader stopped");
    expect(s.inflight).toBe(0);
  });
});
