import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RbCodec } from "./codec.ts";

/**
 * The published `binary/` vectors under `conformance/vectors`, run against this codec.
 *
 * They are written from spec 09 by hand - tag byte, then payload - rather than captured from a codec, because a byte
 * string recorded from an implementation proves only that the implementations agree. That is exactly what was true
 * while the specification listed 38 protocol keys and both codecs held 40.
 *
 * `VectorsTest.kt` runs the identical file on the JVM. (This lives here rather than beside the other vector areas in
 * `@rayfold/schema` because `@rayfold/rb` depends on the schema package, not the other way round.)
 */
const ROOT = new URL("../../../conformance/vectors/binary/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

interface ValueCase {
  name: string;
  json: string;
  bytes: string;
  why?: string;
}

const hex = (b: Uint8Array): string => [...b].map((n) => n.toString(16).padStart(2, "0")).join("");

const files = readdirSync(ROOT)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ file: f, doc: JSON.parse(readFileSync(join(ROOT, f), "utf8")) as { dictionary: string[]; values: ValueCase[] } }));

describe("conformance vectors: binary", () => {
  it("there are vectors to run", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const { file, doc } of files) {
    describe(file, () => {
      // no schema, so the dictionary is exactly the protocol keys the vector lists
      const codec = new RbCodec();

      it("the protocol keys are those, in that order", () => {
        expect(doc.dictionary.length).toBe(40);
        doc.dictionary.forEach((key, i) => {
          // encoding { key: 1 } puts the key's id on the wire as the varint 2*i. That is the id's only observable
          // effect, and the thing an independent codec has to agree about, so it is what the vector checks.
          expect(hex(codec.encode({ [key]: 1 })), `${key} should be dictionary id ${i}`).toBe(`0801${(2 * i).toString(16).padStart(2, "0")}81`);
        });
      });

      for (const c of doc.values) {
        it(c.name, () => {
          const value = JSON.parse(c.json) as unknown;
          expect(hex(codec.encode(value)), c.why ?? c.name).toBe(c.bytes);
          expect(codec.decode(codec.encode(value)), "reads back as what went in").toEqual(value);
        });
      }
    });
  }
});
