/** Static cost, depth and field-count estimation. Spec: spec/06 §5, spec/02 §5. */
import { annotation, fieldsOf, isPageRef, type ArgDef, type OpDef, type RayfoldSchemaIR, type Shape, type ShapeItem, type TypeRef } from "@rayfold/schema";
import { defaultShape, isScalarLike } from "./views.ts";

export interface CostEstimate {
  cost: number;
  depth: number;
  fields: number;
}

const DEFAULT_FIRST = 20;
/** Largest page the runtime serves; any page size the cost model cannot trust counts as this. */
const MAX_FIRST = 200;

/**
 * cost = op.base + op.perItem × first + Σ over selected fields of (field.base + field.perItem × childFirst) × mult
 * where mult is the product of page sizes enclosing the field (fields inside `items` of a Page<T> count `first` times).
 * A field's base defaults to 1 when it returns objects (an entity, an object, a page, a list of them) and to 0 when
 * it returns scalars or enums: those come with the row that is already loaded. The perItem of a page, op or field,
 * defaults to 1, so every row a page can return is charged. `@cost` overrides each default.
 */
export function estimateCost(ir: RayfoldSchemaIR, op: OpDef, args: Record<string, unknown>, shape: Shape, vars: Record<string, unknown> = {}): CostEstimate {
  const c = annotation(op, "cost");
  const base = num(c?.args["base"]) ?? 1;
  const perItem = num(c?.args["perItem"]) ?? (isPageRef(op.returns) ? 1 : 0);
  const first = isPageRef(op.returns) ? pageFirst(args, op.args) : 1;
  const acc = { fields: 0, depth: 0 };
  const shapeCost = walk(ir, op.returns, shape, 1, first, 1, acc, vars);
  return { cost: Math.max(1, base + perItem * first + shapeCost), depth: acc.depth, fields: acc.fields };
}

/** Fields without a sub-shape that resolve to objects get that type's default view, exactly as the executor does. */
function walk(ir: RayfoldSchemaIR, t: TypeRef, shape: Shape, mult: number, itemsFirst: number, depth: number, acc: { fields: number; depth: number }, vars: Record<string, unknown>): number {
  acc.depth = Math.max(acc.depth, depth);
  const isPage = isPageRef(t) || (t.kind === "list" && isPageRef(t.of));
  let total = 0;
  const visit = (items: ShapeItem[], ref: TypeRef): void => {
    const fields = fieldsOf(ir, ref) ?? [];
    for (const it of items) {
      switch (it.kind) {
        case "field": {
          acc.fields++;
          const f = fields.find((x) => x.name === it.name);
          const fc = f ? annotation(f, "cost") : undefined;
          const childFirst = f && isPageRef(f.type) ? pageFirst(substituteVars(it.args ?? {}, vars), f.args) : 1;
          const defaultBase = f && isScalarLike(ir, f.type) ? 0 : 1;
          const defaultPerItem = f && isPageRef(f.type) ? 1 : 0;
          total += mult * ((num(fc?.args["base"]) ?? defaultBase) + (num(fc?.args["perItem"]) ?? defaultPerItem) * childFirst);
          if (f && !isScalarLike(ir, f.type)) {
            const sub = it.shape ?? defaultShape(ir, f.type);
            const childMult = isPage && it.name === "items" ? mult * itemsFirst : mult;
            total += walk(ir, f.type, sub, childMult, childFirst, depth + 1, acc, vars);
          }
          break;
        }
        case "spread": {
          const v = ir.views[`${it.type}.${it.view}`];
          if (v) visit(v.shape.items, ref);
          break;
        }
        case "on":
          visit(it.shape.items, { kind: "named", name: it.type, nullable: false });
          break;
        case "defer":
          visit(it.shape.items, ref);
          break;
      }
    }
  };
  visit(shape.items, t);
  return total;
}

/**
 * Page size for costing. The estimate runs on the request as sent, before coercion, so anything that is not a whole
 * number from 0 to MAX_FIRST (negative, fractional, huge, a $ref, a missing variable) counts as MAX_FIRST:
 * bad input can raise the estimate but never lower it.
 */
function pageFirst(args: Record<string, unknown>, defs: ArgDef[]): number {
  const page = args["page"];
  if (page !== undefined) {
    if (!page || typeof page !== "object" || Array.isArray(page)) return MAX_FIRST;
    if ("first" in page) return pageSize((page as Record<string, unknown>)["first"]);
  }
  if ("first" in args) return pageSize(args["first"]);
  const def = defs.find((a) => a.name === "page")?.default;
  if (def && typeof def === "object" && !Array.isArray(def) && "first" in def) return pageSize((def as Record<string, unknown>)["first"]);
  const firstDef = defs.find((a) => a.name === "first")?.default;
  if (firstDef !== undefined) return pageSize(firstDef);
  return DEFAULT_FIRST;
}

function pageSize(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_FIRST) : MAX_FIRST;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function substituteVars(v: unknown, vars: Record<string, unknown>): Record<string, unknown> {
  const walkV = (x: unknown): unknown => {
    if (x === null || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map(walkV);
    const o = x as Record<string, unknown>;
    if (typeof o["$var"] === "string") return vars[o["$var"]];
    const out: Record<string, unknown> = {};
    for (const [k, y] of Object.entries(o)) out[k] = walkV(y);
    return out;
  };
  return walkV(v) as Record<string, unknown>;
}
