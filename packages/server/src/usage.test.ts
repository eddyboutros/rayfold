import { describe, expect, it } from "vitest";
import { createBookstore } from "../../../examples/bookstore-ts/src/index.ts";
import { MemoryUsage } from "./usage.ts";

const AT = Date.parse("2026-09-13T00:00:00.000Z");

describe("field-usage telemetry (spec 11)", () => {
  it("records the operation and every member the client asked for, once per client", async () => {
    const usage = new MemoryUsage();
    const bs = createBookstore({ usage, now: () => AT });
    await bs.server.collect(
      { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title author { name } }" }], meta: { client: "web" } },
    );
    expect(usage.snapshot().map((e) => `${e.client} ${e.op} ${e.path}`)).toEqual([
      "web book ",
      "web book Author.name",
      "web book Book.author",
      "web book Book.id",
      "web book Book.title",
    ]);
    expect(usage.snapshot()[0]).toMatchObject({ count: 1, lastSeen: new Date(AT).toISOString() });

    // a second client asking for less is a second set of records, so "who still uses this" has an answer
    await bs.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }], meta: { client: "ios" } });
    expect(usage.snapshot().filter((e) => e.client === "ios").map((e) => e.path)).toEqual(["", "Book.id"]);
    expect(usage.snapshot().find((e) => e.client === "web" && e.path === "Book.title")?.count).toBe(1);
  });

  it("counts repeats and keeps the last time it was seen", async () => {
    const usage = new MemoryUsage();
    let now = AT;
    const bs = createBookstore({ usage, now: () => now });
    const call = () => bs.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id }" }], meta: { client: "web" } });
    await call();
    now = AT + 60_000;
    await call();
    const id = usage.snapshot().find((e) => e.path === "Book.id");
    expect(id).toMatchObject({ count: 2, lastSeen: new Date(AT + 60_000).toISOString() });
  });

  it("records nothing when the server was given no sink, and stops at its limit", async () => {
    // without a sink the same request is answered in full, the recording simply skipped
    const quiet = createBookstore();
    expect(await quiet.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title }" }] })).toEqual([
      { id: 1, data: { $type: "Book", id: "b1", title: "The Dispossessed" }, meta: { cost: 1 }, fin: true },
    ]);

    // guard: a sink that is full records no more rather than growing without bound, and still counts what it holds
    const small = new MemoryUsage(2);
    const bs = createBookstore({ usage: small, now: () => AT });
    const ask = () => bs.server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title author { name } }" }] });
    await ask();
    await ask();
    expect(small.snapshot()).toEqual([
      { client: "", op: "book", path: "", lastSeen: new Date(AT).toISOString(), count: 2 },
      { client: "", op: "book", path: "Book.id", lastSeen: new Date(AT).toISOString(), count: 2 },
    ]);
  });
});
