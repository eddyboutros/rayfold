/**
 * Rayfold schema IR — the canonical, JSON-serialisable form every other package consumes.
 * Spec: spec/01-schema.md §9.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export type TypeRef =
  | { kind: "named"; name: string; nullable: boolean; args?: TypeRef[] }
  | { kind: "list"; of: TypeRef; nullable: boolean };

/** Policy expression AST (spec/01-schema.md §5). Roots are resolved at parse time. */
export type Expr =
  | { k: "lit"; v: string | number | boolean | null }
  | { k: "path"; root: "viewer" | "args" | "this"; path: string[] }
  | { k: "bin"; op: "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "&&" | "||"; l: Expr; r: Expr }
  | { k: "not"; e: Expr }
  | { k: "call"; fn: string; args: Expr[] }
  | { k: "list"; items: Expr[] };

/** Annotation argument values stay JSON: identifiers, durations and expressions are tagged objects. */
export type AnnotValue =
  | JsonValue
  | { $ident: string }
  | { $duration: number } // milliseconds
  | { $expr: Expr }
  | { $type: TypeRef };

export interface Annotation {
  name: string;
  args: Record<string, AnnotValue>;
}

export interface ArgDef {
  name: string;
  description?: string;
  type: TypeRef;
  default?: JsonValue;
  annotations: Annotation[];
}

export interface FieldDef {
  name: string;
  description?: string;
  type: TypeRef;
  args: ArgDef[];
  /** Only meaningful on `input` fields. */
  default?: JsonValue;
  annotations: Annotation[];
  ordinal: number;
}

export interface EnumValueDef {
  name: string;
  description?: string;
  annotations: Annotation[];
  ordinal: number;
}

interface TypeBase {
  name: string;
  description?: string;
  annotations: Annotation[];
  builtin?: boolean;
}

export type TypeDef =
  | (TypeBase & { kind: "entity"; fields: FieldDef[]; implements: string[] })
  | (TypeBase & { kind: "object"; fields: FieldDef[]; typeParams?: string[]; interface?: boolean })
  | (TypeBase & { kind: "input"; fields: FieldDef[] })
  | (TypeBase & { kind: "enum"; values: EnumValueDef[] })
  | (TypeBase & { kind: "union"; members: string[] })
  | (TypeBase & { kind: "scalar" })
  | (TypeBase & { kind: "error"; fields: FieldDef[] })
  | (TypeBase & { kind: "event"; fields: FieldDef[] });

export type TypeKind = TypeDef["kind"];
export type OpKind = "query" | "command" | "stream";

export interface OpDef {
  kind: OpKind;
  name: string;
  description?: string;
  args: ArgDef[];
  returns: TypeRef;
  throws: string[];
  emits: string[];
  annotations: Annotation[];
}

/** Shape AST (spec/02-shapes.md). */
export type ShapeValue = JsonValue | { $var: string };

export type ShapeItem =
  | {
      kind: "field";
      name: string;
      alias?: string;
      args?: Record<string, ShapeValue>;
      shape?: Shape;
      eager?: boolean;
      partial?: boolean;
    }
  | { kind: "spread"; type: string; view: string }
  | { kind: "on"; type: string; shape: Shape }
  | { kind: "defer"; label?: string; shape: Shape };

export interface Shape {
  items: ShapeItem[];
}

export interface ViewDef {
  type: string;
  name: string;
  shape: Shape;
}

export interface RayfoldSchemaIR {
  rayfold: "0.1";
  types: Record<string, TypeDef>;
  ops: Record<string, OpDef>;
  /** keyed "Type.view" */
  views: Record<string, ViewDef>;
  extensions?: Record<string, JsonValue>;
}

export const BUILTIN_SCALARS = [
  "ID",
  "String",
  "Int",
  "Long",
  "Float",
  "Boolean",
  "Decimal",
  "Instant",
  "Date",
  "Duration",
  "Bytes",
  "JSON",
] as const;
export type BuiltinScalar = (typeof BUILTIN_SCALARS)[number];

export const RESERVED_FIELD_NAMES = new Set(["$type"]);
export const RESERVED_OP_NAMES = new Set(["subscribe", "manifest", "simulate", "sync"]);

export function named(name: string, nullable = false, args?: TypeRef[]): TypeRef {
  return args ? { kind: "named", name, nullable, args } : { kind: "named", name, nullable };
}
export function list(of: TypeRef, nullable = false): TypeRef {
  return { kind: "list", of, nullable };
}

/** Innermost named type of a ref (through lists and Page<T>). */
export function baseName(t: TypeRef): string {
  if (t.kind === "list") return baseName(t.of);
  if (t.name === "Page" && t.args?.[0]) return baseName(t.args[0]);
  return t.name;
}

export function typeRefToString(t: TypeRef): string {
  const q = t.nullable ? "?" : "";
  if (t.kind === "list") return `[${typeRefToString(t.of)}]${q}`;
  if (t.args && t.args.length) return `${t.name}<${t.args.map(typeRefToString).join(", ")}>${q}`;
  return `${t.name}${q}`;
}

export function isPageRef(t: TypeRef): t is Extract<TypeRef, { kind: "named" }> {
  return t.kind === "named" && t.name === "Page";
}

export function annotation(defs: { annotations: Annotation[] }, name: string): Annotation | undefined {
  return defs.annotations.find((a) => a.name === name);
}

/** Built-in definitions present in every IR. */
export function builtinTypes(): Record<string, TypeDef> {
  const out: Record<string, TypeDef> = {};
  for (const s of BUILTIN_SCALARS) out[s] = { kind: "scalar", name: s, annotations: [], builtin: true };
  out["Page"] = {
    kind: "object",
    name: "Page",
    builtin: true,
    typeParams: ["T"],
    annotations: [],
    fields: [
      { name: "items", type: list(named("T")), args: [], annotations: [], ordinal: 1 },
      { name: "cursor", type: named("String", true), args: [], annotations: [], ordinal: 2 },
      { name: "hasMore", type: named("Boolean"), args: [], annotations: [], ordinal: 3 },
      { name: "total", type: named("Int", true), args: [], annotations: [], ordinal: 4 },
    ],
  };
  out["PageArgs"] = {
    kind: "input",
    name: "PageArgs",
    builtin: true,
    annotations: [],
    fields: [
      { name: "first", type: named("Int"), args: [], default: 20, annotations: [], ordinal: 1 },
      { name: "after", type: named("String", true), args: [], annotations: [], ordinal: 2 },
      { name: "offset", type: named("Int", true), args: [], annotations: [], ordinal: 3 },
    ],
  };
  return out;
}
