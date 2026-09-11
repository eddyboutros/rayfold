/** Schema-aware type restoration for compact frames: re-adds `$type` where the static type is an entity. */
import { fieldsOf, type RayfoldSchemaIR, type TypeRef } from "@rayfold/schema";

export function restoreTypes(ir: RayfoldSchemaIR, t: TypeRef, v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (t.kind === "list") return Array.isArray(v) ? v.map((x) => restoreTypes(ir, t.of, x)) : v;
  if (Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  const explicit = typeof o["$type"] === "string" ? o["$type"] : undefined;
  const def = ir.types[explicit ?? t.name];
  if (!def) return v;
  const out: Record<string, unknown> = {};
  if (def.kind === "entity") out["$type"] = def.name;
  const ref: TypeRef = explicit ? { kind: "named", name: explicit, nullable: false } : t;
  const fields = fieldsOf(ir, ref) ?? [];
  for (const [k, x] of Object.entries(o)) {
    if (k === "$type") continue;
    const f = fields.find((fd) => fd.name === k);
    out[k] = f ? restoreTypes(ir, f.type, x) : x;
  }
  return out;
}

/** Static type at a result path such as "items.0.author" (indices skip list levels). */
export function typeAtPath(ir: RayfoldSchemaIR, root: TypeRef, path: string): TypeRef | undefined {
  let t: TypeRef = root;
  if (path === "") return t;
  for (const seg of path.split(".")) {
    if (/^\d+$/.test(seg)) {
      if (t.kind === "list") t = t.of;
      continue;
    }
    while (t.kind === "list") t = t.of;
    const f = (fieldsOf(ir, t) ?? []).find((fd) => fd.name === seg);
    if (!f) return undefined;
    t = f.type;
  }
  return t;
}
