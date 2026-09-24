import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PatchOp } from "@rayfold/server/protocol";
import { parseShapeText } from "@rayfold/schema";
import { RayfoldCache } from "./cache.ts";

/**
 * The published `patch/` vectors, run against this cache.
 *
 * Each case is an initial result, a patch, and the result a client must hold afterwards. Applying a patch is a pure
 * function of the two (spec 13 §3), so these are hand-written from the specification like the rest of the pack, and
 * the expectation is the *materialised* result — it says nothing about how a cache stores anything, which is what
 * lets both runtimes be checked against the same file.
 *
 * `kotlin/rayfold-client/src/test/kotlin/dev/rayfold/client/PatchVectorsTest.kt` runs the identical file on the JVM.
 */
const PATH = new URL("../../../conformance/vectors/patch/apply.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const doc = JSON.parse(readFileSync(PATH, "utf8")) as {
  op: string;
  cases: Array<{
    name: string;
    shape?: string;
    unheld?: boolean;
    result: unknown;
    patch: PatchOp[];
    expect: unknown;
    stale?: { result: boolean; entities: string[] };
    why?: string;
  }>;
};

/** Every `Type:id` the initial result mentions, at any depth. */
function entityKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) entityKeys(x, out);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["$type"] === "string" && typeof o["id"] === "string") out.add(`${o["$type"]}:${o["id"]}`);
    for (const x of Object.values(o)) entityKeys(x, out);
  }
  return out;
}

describe("conformance vectors: applying a patch", () => {
  for (const c of doc.cases) {
    it(c.name, () => {
      const cache = new RayfoldCache();
      const key = RayfoldCache.resultKey(doc.op, {}, undefined, undefined);
      // the shape the result was asked with, where it matters to how the result is stored
      cache.putResult(key, doc.op, c.result, c.shape === undefined ? undefined : parseShapeText(c.shape));
      // same operation, other arguments: a result the client never stored, so nothing may be found by the op name
      const target = c.unheld ? RayfoldCache.resultKey(doc.op, { page: 2 }, undefined, undefined) : key;
      cache.applyPatch(c.patch, target);
      const why = c.why ?? c.name;
      expect(cache.denormalize(cache.getResult(key)!.data), why).toEqual(c.expect);
      if (c.unheld) expect(cache.getResult(target), `${why}: a result the client did not hold was created`).toBeUndefined();
      if (c.stale) {
        expect(cache.getResult(key)!.stale, `${why}: the result's staleness`).toBe(c.stale.result);
        for (const k of entityKeys(c.result)) expect(cache.isStale(k), `${why}: ${k}`).toBe(c.stale.entities.includes(k));
      }
    });
  }

  it("there are vectors to run", () => {
    expect(doc.cases.length).toBeGreaterThan(5);
  });
});
