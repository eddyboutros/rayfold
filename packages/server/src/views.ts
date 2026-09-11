/** Default views and shape helpers. Spec: spec/01 §2.7, spec/02 §2. */
import {
  baseName,
  canonicalShape,
  fieldsOf,
  isShapeId,
  parseShapeText,
  shapeIdOf,
  type FieldDef,
  type RayfoldSchemaIR,
  type Shape,
  type TypeRef,
} from "@rayfold/schema";
import { RayfoldError } from "./protocol.ts";

const SCALAR_LIKE = new Set(["scalar", "enum"]);

export function isScalarLike(ir: RayfoldSchemaIR, t: TypeRef): boolean {
  const d = ir.types[baseName(t)];
  return !!d && SCALAR_LIKE.has(d.kind);
}

export function isEntity(ir: RayfoldSchemaIR, t: TypeRef): boolean {
  return ir.types[baseName(t)]?.kind === "entity";
}

/**
 * Default view of a type: the `Type.default` view if declared, else every scalar/enum field
 * (nested entities and objects are omitted). Memoised per IR.
 */
export function defaultShape(ir: RayfoldSchemaIR, t: TypeRef): Shape {
  const name = t.kind === "list" ? baseNameThroughLists(t) : t.name;
  const key = `${name}.default`;
  const declared = ir.views[key];
  if (declared) return declared.shape;
  let memo = defaultMemo.get(ir);
  if (!memo) defaultMemo.set(ir, (memo = new Map()));
  const cached = memo.get(name);
  if (cached) return cached;
  const fields = fieldsOf(ir, t) ?? [];
  const shape: Shape = {
    items: fields
      .filter((f) => f.args.length === 0 && (isScalarLike(ir, f.type) || (name === "Page" && f.name === "items")))
      .map((f) => ({ kind: "field", name: f.name })),
  };
  memo.set(name, shape);
  return shape;
}
const defaultMemo = new WeakMap<RayfoldSchemaIR, Map<string, Shape>>();

function baseNameThroughLists(t: TypeRef): string {
  return t.kind === "list" ? baseNameThroughLists(t.of) : t.name;
}

export interface ShapeRegistry {
  /** Resolve a `sha256:` id to a parsed shape; undefined if unknown. */
  get(id: string): Shape | undefined;
  /** Register an inline shape (dev mode) and return its id. */
  /** Pinned shapes (registered by the server) are never evicted; shapes learned from requests may be. */
  register(shape: Shape, pin?: boolean): string;
}

/**
 * Shapes by id. Shapes the server registers are pinned. Shapes learned from requests are kept up to `max`, least
 * recently used out first, so clients cannot grow the server's memory without bound.
 */
export class MemoryShapeRegistry implements ShapeRegistry {
  private readonly pinned = new Map<string, Shape>();
  private readonly learned = new Map<string, Shape>();
  constructor(
    private readonly ir: RayfoldSchemaIR,
    private readonly max = 10_000,
  ) {}
  get(id: string): Shape | undefined {
    const p = this.pinned.get(id);
    if (p) return p;
    const s = this.learned.get(id);
    if (s) {
      this.learned.delete(id);
      this.learned.set(id, s);
    }
    return s;
  }
  register(shape: Shape, pin = false): string {
    const id = shapeIdOf(canonicalShape(shape, (t, v) => this.ir.views[`${t}.${v}`]));
    if (pin) {
      this.pinned.set(id, shape);
      this.learned.delete(id);
      return id;
    }
    if (this.pinned.has(id)) return id;
    this.learned.delete(id);
    this.learned.set(id, shape);
    if (this.learned.size > this.max) this.learned.delete(this.learned.keys().next().value!);
    return id;
  }
  get size(): number {
    return this.pinned.size + this.learned.size;
  }
}

/** Turn the request's `shape` string into a Shape, honouring trusted-shapes mode. */
export function resolveRequestShape(
  ir: RayfoldSchemaIR,
  shapeText: string | undefined,
  returns: TypeRef,
  registry: ShapeRegistry,
  trustedOnly: boolean,
): Shape {
  if (shapeText === undefined) return defaultShape(ir, returns);
  if (isShapeId(shapeText)) {
    const s = registry.get(shapeText);
    if (!s) throw new RayfoldError("not_found", `Unknown shape ${shapeText}`);
    return s;
  }
  if (trustedOnly) throw new RayfoldError("permission_denied", "Only registered shapes are accepted");
  let parsed: Shape;
  try {
    parsed = parseShapeText(shapeText);
  } catch (e) {
    throw new RayfoldError("invalid_argument", `Bad shape: ${(e as Error).message}`);
  }
  return parsed; // registered by the batch planner once depth, field and cost checks pass
}

export function findField(fields: FieldDef[], name: string): FieldDef | undefined {
  return fields.find((f) => f.name === name);
}
