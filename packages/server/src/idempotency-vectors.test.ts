import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createRayfoldServer, type RayfoldServer } from "./server.ts";
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
    ops: Array<{ op: string; args: Record<string, unknown>; key?: string; viewer?: unknown }>;
    expect: "replay" | "replayMeta" | "error" | "bothRan" | "ok";
    code?: string;
    runs?: number;
    why?: string;
  }>;
};

const DEFAULT_VIEWER = { id: "u1" };
let runs = 0;
let server: RayfoldServer;

beforeEach(() => {
  runs = 0;
  const stock = new Map([["b1", 3]]);
  const bump = ({ id, qty = 1 }: { id: string; qty?: number }) => {
    runs++;
    stock.set(id, (stock.get(id) ?? 0) + qty);
    return ok({ id, stock: stock.get(id) });
  };
  server = createRayfoldServer({
    schema: doc.schema,
    resolvers: { Command: { restock: bump, other: bump, free: bump } },
  });
});

const send = (o: (typeof doc.cases)[number]["ops"][number]): Promise<Frame[]> =>
  server.collect({ ops: [{ id: 1, op: o.op, args: o.args, ...(o.key ? { key: o.key } : {}) }] }, { viewer: "viewer" in o ? o.viewer : DEFAULT_VIEWER });

const errorOf = (frames: Frame[]) => (frames.find((f) => "error" in f) as { error: { code: string } } | undefined)?.error;
const okOf = (frames: Frame[]) => frames.find((f) => "ok" in f) as { ok: Record<string, unknown>; meta?: { replay?: boolean } } | undefined;

describe("conformance vectors: idempotency", () => {
  for (const c of doc.cases) {
    it(c.name, async () => {
      const why = c.why ?? c.name;
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
      }
    });
  }
});
