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
  cases: Array<{ name: string; shape?: string; result: unknown; patch: PatchOp[]; expect: unknown; why?: string }>;
};

describe("conformance vectors: applying a patch", () => {
  for (const c of doc.cases) {
    it(c.name, () => {
      const cache = new RayfoldCache();
      const key = RayfoldCache.resultKey(doc.op, {}, undefined, undefined);
      // the shape the result was asked with, where it matters to how the result is stored
      cache.putResult(key, doc.op, c.result, c.shape === undefined ? undefined : parseShapeText(c.shape));
      cache.applyPatch(c.patch, key);
      expect(cache.denormalize(cache.getResult(key)!.data), c.why ?? c.name).toEqual(c.expect);
    });
  }

  it("there are vectors to run", () => {
    expect(doc.cases.length).toBeGreaterThan(5);
  });
});
