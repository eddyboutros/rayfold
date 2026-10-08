/**
 * Schema-aware type restoration for compact frames: re-adds `$type` where the static type is an entity, and keeps the
 * `$type` the server sent on a union or interface member, the one place compact frames keep it.
 */
import { fieldsOf, type RayfoldSchemaIR, type Shape, type TypeRef, type ViewResolver } from "@rayfold/schema";

/**
 * A result's keys are the shape's output names, so with [shape] an aliased field (`mine: shelf { ... }`) is typed as
 * the field it names. Without it a key is read as a field name, and an alias's value went untyped: no `$type`, and its
 * entities were never normalized.
 */
export function restoreTypes(ir: RayfoldSchemaIR, t: TypeRef, v: unknown, shape?: Shape, views?: ViewResolver): unknown {
  if (v === null || typeof v !== "object") return v;
  if (t.kind === "list") return Array.isArray(v) ? v.map((x) => restoreTypes(ir, t.of, x, shape, views)) : v;
  if (Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  const explicit = typeof o["$type"] === "string" ? o["$type"] : undefined;
  const def = ir.types[explicit ?? t.name];
  if (!def) return v;
  const out: Record<string, unknown> = {};
  if (def.kind === "entity" || explicit) out["$type"] = def.name;
  const ref: TypeRef = explicit ? { kind: "named", name: explicit, nullable: false } : t;
  const fields = fieldsOf(ir, ref) ?? [];
  const selected = outputs(ir, shape, def.name, views);
  for (const [k, x] of Object.entries(o)) {
    if (k === "$type") continue;
    const sel = selected.get(k);
    const f = fields.find((fd) => fd.name === (sel?.name ?? k));
    out[k] = f ? restoreTypes(ir, f.type, x, sel?.shape, views) : x;
  }
  return out;
}

/** Static type at a result path such as "items.0.author" (indices skip list levels); segments are output names. */
export function typeAtPath(ir: RayfoldSchemaIR, root: TypeRef, path: string, shape?: Shape, views?: ViewResolver): TypeRef | undefined {
  let t: TypeRef = root;
  if (path === "") return t;
  let at = shape;
  for (const seg of path.split(".")) {
    if (/^\d+$/.test(seg)) {
      if (t.kind === "list") t = t.of;
      continue;
    }
    while (t.kind === "list") t = t.of;
    const sel = outputs(ir, at, t.name, views).get(seg);
    const f = (fieldsOf(ir, t) ?? []).find((fd) => fd.name === (sel?.name ?? seg));
    if (!f) return undefined;
    t = f.type;
    at = sel?.shape;
  }
  return t;
}

/** The fields a shape selects on a value of [type], by output name: the field each names and the shape below it. */
function outputs(ir: RayfoldSchemaIR, shape: Shape | undefined, type: string, views: ViewResolver | undefined): Map<string, { name: string; shape: Shape | undefined }> {
  const out = new Map<string, { name: string; shape: Shape | undefined }>();
  const visit = (s: Shape, seen: Set<string>): void => {
    for (const it of s.items) {
      if (it.kind === "field") {
        const key = it.alias ?? it.name;
        if (!out.has(key)) out.set(key, { name: it.name, shape: it.shape });
      } else if (it.kind === "defer") visit(it.shape, seen);
      // a member's fragment applies to that member only; one on a union or interface, to whatever is there
      else if (it.kind === "on") {
        const on = ir.types[it.type];
        const concrete = on !== undefined && (on.kind === "entity" || (on.kind === "object" && !on.interface));
        if (it.type === type || !concrete) visit(it.shape, seen);
      } else {
        const key = `${it.type}.${it.view}`;
        const view = seen.has(key) ? undefined : views?.(it.type, it.view);
        if (view) visit(view.shape, new Set([...seen, key]));
      }
    }
  };
  if (shape) visit(shape, new Set());
  return out;
}
