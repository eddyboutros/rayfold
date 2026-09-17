import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.ts";

/**
 * The published vectors under `conformance/vectors`, run against this runtime.
 *
 * These are not the same kind of artifact as `conformance/fixtures`: a fixture is a request and the frames it must
 * produce, while a vector is a pure function and the answer the specification says it has. They are written from the
 * specification rather than captured from a runtime, which is the whole point — a vector taken from an implementation
 * proves only that the implementations agree, and two implementations can agree on the same wrong answer.
 *
 * `VectorsTest.kt` runs the identical files on the JVM.
 */
const ROOT = new URL("../../../conformance/vectors/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

interface NumberCase {
  name: string;
  literal: string;
  canonical: string;
  why?: string;
}

function load<T>(area: string): Array<{ file: string; about: string; cases: T[] }> {
  const dir = join(ROOT, area);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const doc = JSON.parse(readFileSync(join(dir, f), "utf8")) as { about: string; cases: T[] };
      return { file: f, about: doc.about, cases: doc.cases };
    });
}

describe("conformance vectors: numbers", () => {
  const files = load<NumberCase>("numbers");

  it("there are vectors to run", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((f) => f.cases).length).toBeGreaterThan(10);
  });

  for (const { file, cases } of files) {
    describe(file, () => {
      for (const c of cases) {
        it(c.name, () => {
          // the literal is text so the fixture keeps it exactly as a client would send it: JSON parsing is part of
          // what is under test, since it is where 2.50 and 2.5 become one number
          const value = JSON.parse(c.literal) as number;
          expect(canonicalJson(value), c.why ?? c.name).toBe(c.canonical);
        });
      }
    });
  }
});
