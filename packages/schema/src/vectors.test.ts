import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, hashJson } from "./canonical.ts";
import { canonicalShape, parseShapeText, shapeIdOf } from "./shape.ts";

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

interface ShapeCase {
  name: string;
  shape: string;
  canonical?: string;
  id?: string;
  rejected?: boolean;
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

describe("conformance vectors: hashing", () => {
  const docs = load<never>("hashing").map((f) => ({
    file: f.file,
    doc: JSON.parse(readFileSync(join(ROOT, "hashing", f.file), "utf8")) as {
      bindings: Array<{ name: string; op: string; args: Record<string, unknown>; canonical: string; hash: string; why?: string }>;
      scopes: Array<{ name: string; viewer: unknown; canonical: string; hash: string; why?: string }>;
    },
  }));

  for (const { file, doc } of docs) {
    describe(file, () => {
      for (const c of doc.bindings) {
        it(`binding: ${c.name}`, () => {
          // the canonical text is checked as well as the digest: when a hash disagrees, the text says whether the
          // canonicaliser or the hashing is at fault, which is the difference between a five-minute fix and a day
          expect(canonicalJson({ op: c.op, args: c.args }), c.why ?? c.name).toBe(c.canonical);
          expect(hashJson({ op: c.op, args: c.args })).toBe(c.hash);
        });
      }
      for (const c of doc.scopes) {
        it(`scope: ${c.name}`, () => {
          expect(canonicalJson(c.viewer), c.why ?? c.name).toBe(c.canonical);
          expect(hashJson(c.viewer)).toBe(c.hash);
        });
      }
    });
  }
});

describe("conformance vectors: canonicalization", () => {
  const files = load<{ name: string; json: string; canonical: string; why?: string }>("canonicalization");

  it("there are vectors to run", () => {
    expect(files.flatMap((f) => f.cases).length).toBeGreaterThan(10);
  });

  for (const { file, cases } of files) {
    describe(file, () => {
      for (const c of cases) {
        it(c.name, () => {
          expect(canonicalJson(JSON.parse(c.json)), c.why ?? c.name).toBe(c.canonical);
        });
      }
    });
  }
});

describe("conformance vectors: shapes", () => {
  const files = load<ShapeCase>("shapes");
  // no vector uses a named-view spread, so nothing should ask to resolve one
  const noViews = () => undefined;

  it("there are vectors to run", () => {
    expect(files.flatMap((f) => f.cases).length).toBeGreaterThan(5);
  });

  for (const { file, cases } of files) {
    describe(file, () => {
      for (const c of cases) {
        it(c.name, () => {
          if (c.rejected) {
            expect(() => canonicalShape(parseShapeText(c.shape), noViews), c.why ?? c.name).toThrow();
            return;
          }
          const canonical = canonicalShape(parseShapeText(c.shape), noViews);
          expect(canonical, c.why ?? c.name).toBe(c.canonical);
          // the id in the vector is the SHA-256 of the canonical text above, taken independently: this asserts the
          // runtime's own hashing agrees with it rather than assuming it does
          expect(shapeIdOf(canonical)).toBe(c.id);
        });
      }
    });
  }
});
