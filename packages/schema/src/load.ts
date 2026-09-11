import { hashJson } from "./canonical.ts";
import type { RayfoldSchemaIR } from "./ir.ts";
import { parseSchemaText } from "./parser.ts";
import { RayfoldSchemaError, validateIR, type Diagnostic } from "./validate.ts";

export interface LoadedSchema {
  ir: RayfoldSchemaIR;
  /** SHA-256 hex of the canonical IR (spec 01 §9). */
  hash: string;
  warnings: Diagnostic[];
}

/** Parse + validate + hash. Throws RayfoldSyntaxError or RayfoldSchemaError. */
export function loadSchema(text: string): LoadedSchema {
  const ir = parseSchemaText(text);
  const diags = validateIR(ir);
  if (diags.some((d) => d.severity === "error")) throw new RayfoldSchemaError(diags);
  return { ir, hash: schemaHash(ir), warnings: diags };
}

export function schemaHash(ir: RayfoldSchemaIR): string {
  return hashJson(ir);
}
