import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
import { MemoryIdempotencyStore } from "./context.ts";
import { ok } from "./executor.ts";
import type { Frame } from "./protocol.ts";

/**
 * The published `idempotency/` vectors, run against this runtime.
 *
 * Each case is a sequence of operations sent as separate batches, since a retry is a second request — sending both in
 * one batch would test something else. `runs` counts how many times the resolver actually executed, which is the only
 * thing that distinguishes a replay from a command that ran twice and happened to return the same answer.
 *
 * `VectorsTest.kt` runs the same file.
 */
const PATH = new URL("../../../conformance/vectors/idempotency/keys-and-replays.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const doc = JSON.parse(readFileSync(PATH, "utf8")) as {
  schema: string;
  cases: Array<{
    name: string;
    ops: Array<{ op: string; args: Record<string, unknown>; key?: string; viewer?: unknown; at?: number; with?: { op: string; args: Record<string, unknown> } }>;
    store?: "failsToRecord";
    expect: "replay" | "replayMeta" | "error" | "bothRan" | "ok";
    code?: string;
    runs?: number;
    why?: string;
  }>;
};

const DEFAULT_VIEWER = { id: "u1" };
const CASE_FIELDS = new Set(["name", "ops", "store", "expect", "code", "runs", "why"]);
const OP_FIELDS = new Set(["op", "args", "key", "viewer", "at", "with"]);
/** The server clock when a case starts; an op's `at` is counted from here. */
const T0 = 1_700_000_000_000;
let runs = 0;
let clock = T0;
let stock: Map<string, number>;

/** A store whose write of a record fails, as a database that drops the connection at that moment would. */
class FailsToRecord extends MemoryIdempotencyStore {
  override async put(): Promise<void> {
    throw new Error("the store is unavailable");
  }
}

function serverFor(c: (typeof doc.cases)[number]): RayfoldServer {
  const bump = ({ id, qty = 1 }: { id: string; qty?: number }) => {
    runs++;
    stock.set(id, (stock.get(id) ?? 0) + qty);
    return ok({ id, stock: stock.get(id) });
  };
  if (c.store !== undefined && c.store !== "failsToRecord") throw new Error(`${c.name}: no store called ${String(c.store)}`);
  const now = () => clock;
  return createRayfoldServer({
    schema: doc.schema,
    resolvers: { Query: { book: ({ id }: { id: string }) => ({ id, stock: stock.get(id) }) }, Command: { restock: bump, other: bump, free: bump } },
    now,
    ...(c.store === "failsToRecord" ? { idempotency: new FailsToRecord(undefined, now) } : {}),
  });
}

let server: RayfoldServer;

beforeEach(() => {
  runs = 0;
  clock = T0;
  stock = new Map([["b1", 3]]);
});

const send = (o: (typeof doc.cases)[number]["ops"][number]): Promise<Frame[]> => {
  clock = T0 + (o.at ?? 0);
  const ops = [{ id: 1, op: o.op, args: o.args, ...(o.key ? { key: o.key } : {}) }, ...(o.with ? [{ id: 2, ...o.with }] : [])];
  return server.collect({ ops }, { viewer: "viewer" in o ? o.viewer : DEFAULT_VIEWER });
};

const errorOf = (frames: Frame[]) => (frames.find((f) => "error" in f && "id" in f && f.id === 1) as { error: { code: string } } | undefined)?.error;
const okOf = (frames: Frame[]) => frames.find((f) => "ok" in f && "id" in f && f.id === 1) as { ok: Record<string, unknown>; meta?: { replay?: boolean } } | undefined;

describe("conformance vectors: idempotency", () => {
  for (const c of doc.cases) {
    it(c.name, async () => {
      const why = c.why ?? c.name;
      // a field this runner does not read is an expectation it would silently skip
      for (const k of Object.keys(c)) expect(CASE_FIELDS.has(k), `${c.name}: no runner for case field "${k}"`).toBe(true);
      for (const o of c.ops) for (const k of Object.keys(o)) expect(OP_FIELDS.has(k), `${c.name}: no runner for op field "${k}"`).toBe(true);
      server = serverFor(c);
      const answers: Frame[][] = [];
      for (const o of c.ops) answers.push(await send(o));
      const last = answers[answers.length - 1]!;

      switch (c.expect) {
        case "replay":
          expect(errorOf(last), why).toBeUndefined();
          // the same answer, and the resolver ran once: either alone would be satisfied by a command that is simply
          // deterministic, which is not what a key promises
          expect(okOf(last)!.ok, why).toEqual(okOf(answers[0]!)!.ok);
          expect(runs, `${why}: the resolver ran ${runs} times`).toBe(c.runs);
          break;
        case "replayMeta":
          expect(okOf(last)!.meta?.replay, why).toBe(true);
          expect(okOf(answers[0]!)!.meta?.replay, `${why}: the first attempt is not a replay`).toBeUndefined();
          break;
        case "error":
          expect(errorOf(last)?.code, why).toBe(c.code);
          break;
        case "bothRan":
          expect(errorOf(last), why).toBeUndefined();
          expect(okOf(last)!.meta?.replay, `${why}: the second caller got its own answer, not a replay`).toBeUndefined();
          expect(runs, `${why}: the resolver ran ${runs} times`).toBe(c.runs);
          break;
        case "ok": {
          expect(errorOf(last), why).toBeUndefined();
          // every "ok" case sends one op against a shelf that starts at 3, so the answer is known exactly
          expect(c.ops, why).toHaveLength(1);
          const { id, qty = 1 } = c.ops[0]!.args as { id: string; qty?: number };
          expect(okOf(last)!.ok, why).toEqual({ $type: "Book", id, stock: 3 + qty });
          expect(runs, `${why}: the resolver ran ${runs} times`).toBe(1);
          break;
        }
        default:
          throw new Error(`${c.name}: no assertion for expect=${String(c.expect)}`);
      }
      if (c.runs !== undefined) expect(runs, `${why}: the resolver ran ${runs} times`).toBe(c.runs);
      // an op is answered once: a second frame after the answer, such as an error, contradicts what the caller was told
      for (const [i, a] of answers.entries()) {
        expect(a.filter((f) => "id" in f && f.id === 1), why).toHaveLength(1);
        // the op sent with it reads the command's result through a reference, so it runs only if the command succeeded
        if (c.ops[i]!.with) expect(a.filter((f) => "id" in f && f.id === 2), `${why}: the op that depends on it`).toEqual([expect.objectContaining({ data: expect.anything(), fin: true })]);
        else expect(a, why).toHaveLength(1);
      }
    });
  }
});
