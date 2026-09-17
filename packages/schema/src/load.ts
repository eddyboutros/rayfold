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

/**
 * SHA-256 of the canonical IR (spec 01 §9), which is every member but `extensions`.
 *
 * Vendor data is ignored by implementations that do not know it, so an identity that moved with it would make two
 * servers offering the same conversation look different to a client, and a gateway that strips vendor metadata look
 * like a schema change. The JVM has always projected it out; this is the same rule written down.
 */
export function schemaHash(ir: RayfoldSchemaIR): string {
  const { extensions: _vendor, ...hashed } = ir;
  return hashJson(hashed);
}
