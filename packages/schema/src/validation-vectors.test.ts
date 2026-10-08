import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RayfoldSchemaIR } from "./ir.ts";
import { loadSchema, schemaHash } from "./load.ts";
import { parseSchemaText } from "./parser.ts";
import { validateIR } from "./validate.ts";

/**
 * The published `validation/` vectors, run against this runtime: which schemas load, and what the text that loads
 * means. `ValidationVectorsTest.kt` runs the same file on the JVM.
 */
const PATH = new URL("../../../conformance/vectors/validation/schemas.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

type Path = Array<string | number>;
interface Case {
  name: string;
  schema: string;
  expect: string;
  irEdit?: { path: Path; value: unknown };
  irHas?: Array<{ path: Path; value: unknown }>;
  sameAs?: string;
  why?: string;
}
const KNOWN = new Set(["name", "schema", "expect", "irEdit", "irHas", "sameAs", "why"]);
const doc = JSON.parse(readFileSync(PATH, "utf8")) as { cases: Case[] };

function at(root: unknown, path: Path): { parent: Record<string | number, unknown>; key: string | number } {
  let cur = root as Record<string | number, unknown>;
  for (const p of path.slice(0, -1)) {
    const next = cur[p];
    if (next === null || typeof next !== "object") throw new Error(`no ${JSON.stringify(path)} in the IR`);
    cur = next as Record<string | number, unknown>;
  }
  return { parent: cur, key: path[path.length - 1]! };
}

/** The case's IR, edited as `irEdit` says, and the error-severity diagnostics it gets; a syntax error counts as one. */
function load(c: Case): { ir?: RayfoldSchemaIR; errors: string[] } {
  let ir: RayfoldSchemaIR;
  try {
    ir = parseSchemaText(c.schema);
  } catch (e) {
    return { errors: [String(e)] };
  }
  if (c.irEdit) {
    ir = JSON.parse(JSON.stringify(ir)) as RayfoldSchemaIR;
    const { parent, key } = at(ir, c.irEdit.path);
    if (!(key in parent)) throw new Error(`${c.name}: irEdit names ${JSON.stringify(c.irEdit.path)}, which the IR does not have`);
    parent[key] = c.irEdit.value;
  }
  const errors = validateIR(ir).filter((d) => d.severity === "error").map((d) => `${d.at}: ${d.message} [${d.code}]`);
  return { ir, errors };
}

describe("conformance vectors: validation", () => {
  it("there are vectors to run", () => {
    expect(doc.cases.length).toBeGreaterThan(10);
  });

  for (const c of doc.cases) {
    it(c.name, () => {
      const unknown = Object.keys(c).filter((k) => !KNOWN.has(k));
      expect(unknown, `${c.name}: no runner for ${unknown.join(", ")}`).toEqual([]);
      const why = c.why ?? c.name;
      const { ir, errors } = load(c);

      if (c.expect === "rejected") {
        expect(c.irHas ?? c.sameAs, `${c.name}: a rejected case has nothing to compare`).toBeUndefined();
        expect(errors.length, `${why}: the schema loaded`).toBeGreaterThan(0);
        return;
      }
      expect(c.expect, `${c.name}: no assertion for expect=${c.expect}`).toBe("accepted");
      expect(errors, why).toEqual([]);
      // the text path too, where there is no edit: loadSchema is what a server calls
      if (!c.irEdit) expect(() => loadSchema(c.schema), why).not.toThrow();
      for (const h of c.irHas ?? []) {
        const { parent, key } = at(ir, h.path);
        expect(parent[key], `${why}: ${JSON.stringify(h.path)}`).toEqual(h.value);
      }
      if (c.sameAs) {
        const other = doc.cases.find((o) => o.name === c.sameAs);
        expect(other, `${c.name}: sameAs names no case`).toBeDefined();
        expect(schemaHash(ir!), why).toBe(schemaHash(load(other!).ir!));
      }
    });
  }
});
