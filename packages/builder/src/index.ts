/**
 * Code-first schema builder. Produces the same IR as the `.rayfold` parser, with TypeScript types inferred
 * from the builder calls so a TS project needs no codegen step.
 *
 *   const Book = entity("Book", { id: t.id(), title: t.string(), price: t.decimal(), author: t.ref("Author") });
 *   const schema = defineSchema({ types: [Book, Author], ops: { book: query({ id: t.id() }, t.ref("Book").nullable()) } });
 *   type Book = Infer<typeof schema, "Book">;   // { $type: "Book"; id: string; title: string; ... }
 */
import {
  assertValid,
  builtinTypes,
  type Annotation,
  type AnnotValue,
  type ArgDef,
  type Expr,
  type FieldDef,
  type JsonValue,
  type OpDef,
  type RayfoldSchemaIR,
  type Shape,
  type TypeDef,
  type TypeRef,
} from "@rayfold/schema";
import { parseExprText, parseShapeText } from "@rayfold/schema";

// ------------------------------------------------------------------ type refs

type Phantom<T> = { readonly __t?: T };

export interface TRef<T = unknown> extends Phantom<T> {
  readonly ref: TypeRef;
  readonly annotations: Annotation[];
  readonly default?: JsonValue;
  readonly description?: string;
  nullable(): TRef<T | null>;
  list(): TRef<T[]>;
  doc(text: string): TRef<T>;
  withDefault(v: JsonValue): TRef<T>;
  /** Policy expression text, e.g. allow('viewer.role == "admin"') */
  allow(read: string, write?: string): TRef<T>;
  lazy(): TRef<T>;
  partial(): TRef<T | null>;
  cost(base: number, perItem?: number): TRef<T>;
  unit(u: string): TRef<T>;
  range(min?: number, max?: number): TRef<T>;
  deprecated(sunset?: string, replacement?: string, reason?: string): TRef<T>;
  load(mode: "batch" | "single"): TRef<T>;
  annotate(name: string, args?: Record<string, AnnotValue>): TRef<T>;
}

function mk<T>(ref: TypeRef, annotations: Annotation[] = [], extra: { default?: JsonValue; description?: string } = {}): TRef<T> {
  const self: TRef<T> = {
    ref,
    annotations,
    ...(extra.default !== undefined ? { default: extra.default } : {}),
    ...(extra.description !== undefined ? { description: extra.description } : {}),
    nullable: () => mk<T | null>({ ...ref, nullable: true }, annotations, extra),
    list: () => mk<T[]>({ kind: "list", of: ref, nullable: false }, annotations, extra),
    doc: (text) => mk<T>(ref, annotations, { ...extra, description: text }),
    withDefault: (v) => mk<T>(ref, annotations, { ...extra, default: v }),
    allow: (read, write) => {
      const args: Record<string, AnnotValue> = { read: { $expr: parseExprText(read, "this") } };
      if (write) args["write"] = { $expr: parseExprText(write, "this") };
      return mk<T>(ref, [...annotations, { name: "allow", args }], extra);
    },
    lazy: () => mk<T>(ref, [...annotations, { name: "lazy", args: {} }], extra),
    partial: () => mk<T | null>({ ...ref, nullable: true }, [...annotations, { name: "partial", args: {} }], extra),
    cost: (base, perItem) => mk<T>(ref, [...annotations, { name: "cost", args: perItem === undefined ? { base } : { base, perItem } }], extra),
    unit: (u) => mk<T>(ref, [...annotations, { name: "unit", args: { value: u } }], extra),
    range: (min, max) => mk<T>(ref, [...annotations, { name: "range", args: { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } }], extra),
    deprecated: (sunset, replacement, reason) =>
      mk<T>(ref, [...annotations, { name: "deprecated", args: { ...(sunset ? { sunset } : {}), ...(replacement ? { replacement } : {}), ...(reason ? { reason } : {}) } }], extra),
    load: (mode) => mk<T>(ref, [...annotations, { name: "load", args: { value: { $ident: mode } } }], extra),
    annotate: (name, args = {}) => mk<T>(ref, [...annotations, { name, args }], extra),
  };
  return self;
}

const named = (name: string): TypeRef => ({ kind: "named", name, nullable: false });

/** Scalar and reference constructors. */
export const t = {
  id: () => mk<string>(named("ID")),
  string: () => mk<string>(named("String")),
  int: () => mk<number>(named("Int")),
  long: () => mk<number | string>(named("Long")),
  float: () => mk<number>(named("Float")),
  boolean: () => mk<boolean>(named("Boolean")),
  decimal: () => mk<string>(named("Decimal")),
  instant: () => mk<string>(named("Instant")),
  date: () => mk<string>(named("Date")),
  duration: () => mk<number | string>(named("Duration")),
  bytes: () => mk<string>(named("Bytes")),
  json: () => mk<unknown>(named("JSON")),
  /** Reference to a named type (entity, object, input, enum, union, scalar). The TS type is resolved by `Infer`. */
  ref: <N extends string>(name: N) => mk<RefTo<N>>(named(name)),
  page: <N extends string>(name: N) => mk<PageOf<N>>({ kind: "named", name: "Page", nullable: false, args: [named(name)] }),
  pageArgs: () => mk<{ first?: number; after?: string | null; offset?: number | null }>(named("PageArgs")),
  enumOf: <V extends string>(name: string, ..._values: V[]) => mk<V>(named(name)),
};

/** Marker types resolved by Infer<>. */
export interface RefTo<N extends string> {
  readonly __ref: N;
}
export interface PageOf<N extends string> {
  readonly __page: N;
}

// ------------------------------------------------------------------ definitions

type FieldMap = Record<string, TRef<unknown>>;

export interface TypeBuilder<K extends TypeDef["kind"], N extends string, F extends FieldMap> {
  readonly kind: K;
  readonly name: N;
  readonly fields: F;
  readonly def: TypeDef;
  readonly views: Record<string, Shape>;
  /** Named view; `default` is what callers get with no shape. */
  view(name: string, shape: string): TypeBuilder<K, N, F>;
  annotate(name: string, args?: Record<string, AnnotValue>): TypeBuilder<K, N, F>;
  cache(maxAgeMs: number, scope?: "public" | "private", swrMs?: number): TypeBuilder<K, N, F>;
  allow(read: string, write?: string): TypeBuilder<K, N, F>;
  doc(text: string): TypeBuilder<K, N, F>;
}

function fieldDefs(fields: FieldMap, allowDefaults: boolean): FieldDef[] {
  return Object.entries(fields).map(([name, f], i) => {
    const d: FieldDef = { name, type: f.ref, args: [], annotations: f.annotations, ordinal: i + 1 };
    if (f.description !== undefined) d.description = f.description;
    if (allowDefaults && f.default !== undefined) d.default = f.default;
    return d;
  });
}

function typeBuilder<K extends TypeDef["kind"], N extends string, F extends FieldMap>(kind: K, name: N, fields: F, def: TypeDef, views: Record<string, Shape> = {}): TypeBuilder<K, N, F> {
  const withDef = (d: TypeDef, v = views) => typeBuilder(kind, name, fields, d, v);
  return {
    kind,
    name,
    fields,
    def,
    views,
    view: (vn, shape) => withDef(def, { ...views, [vn]: parseShapeText(shape) }),
    annotate: (an, args = {}) => withDef({ ...def, annotations: [...def.annotations, { name: an, args }] }),
    cache: (maxAgeMs, scope = "public", swrMs) =>
      withDef({ ...def, annotations: [...def.annotations, { name: "cache", args: { maxAge: { $duration: maxAgeMs }, scope: { $ident: scope }, ...(swrMs !== undefined ? { swr: { $duration: swrMs } } : {}) } }] }),
    allow: (read, write) => {
      const args: Record<string, AnnotValue> = { read: { $expr: parseExprText(read, "this") } };
      if (write) args["write"] = { $expr: parseExprText(write, "this") };
      return withDef({ ...def, annotations: [...def.annotations, { name: "allow", args }] });
    },
    doc: (text) => withDef({ ...def, description: text }),
  };
}

export function entity<N extends string, F extends FieldMap>(name: N, fields: F): TypeBuilder<"entity", N, F> {
  return typeBuilder("entity", name, fields, { kind: "entity", name, annotations: [], fields: fieldDefs(fields, false), implements: [] });
}
export function object<N extends string, F extends FieldMap>(name: N, fields: F): TypeBuilder<"object", N, F> {
  return typeBuilder("object", name, fields, { kind: "object", name, annotations: [], fields: fieldDefs(fields, false) });
}
export function input<N extends string, F extends FieldMap>(name: N, fields: F): TypeBuilder<"input", N, F> {
  return typeBuilder("input", name, fields, { kind: "input", name, annotations: [], fields: fieldDefs(fields, true) });
}
export function error<N extends string, F extends FieldMap>(name: N, fields: F): TypeBuilder<"error", N, F> {
  return typeBuilder("error", name, fields, { kind: "error", name, annotations: [], fields: fieldDefs(fields, false) });
}
export function event<N extends string, F extends FieldMap>(name: N, fields: F): TypeBuilder<"event", N, F> {
  return typeBuilder("event", name, fields, { kind: "event", name, annotations: [], fields: fieldDefs(fields, false) });
}
export function enumType<N extends string, V extends string>(name: N, values: readonly V[]): TypeBuilder<"enum", N, Record<never, never>> & { readonly values: readonly V[] } {
  const b = typeBuilder("enum", name, {}, { kind: "enum", name, annotations: [], values: values.map((v, i) => ({ name: v, annotations: [], ordinal: i + 1 })) });
  return { ...b, values };
}
export function union<N extends string, M extends string>(name: N, members: readonly M[]): TypeBuilder<"union", N, Record<never, never>> & { readonly members: readonly M[] } {
  const b = typeBuilder("union", name, {}, { kind: "union", name, annotations: [], members: [...members] });
  return { ...b, members };
}
export function scalar<N extends string>(name: N): TypeBuilder<"scalar", N, Record<never, never>> {
  return typeBuilder("scalar", name, {}, { kind: "scalar", name, annotations: [] });
}

// ------------------------------------------------------------------ operations

export interface OpBuilder<K extends OpDef["kind"], A extends FieldMap, R> {
  readonly kind: K;
  readonly args: A;
  readonly returns: TRef<R>;
  readonly def: Omit<OpDef, "name">;
  throws(...errors: string[]): OpBuilder<K, A, R>;
  emits(...events: string[]): OpBuilder<K, A, R>;
  allow(expr: string): OpBuilder<K, A, R>;
  cost(base: number, perItem?: number): OpBuilder<K, A, R>;
  cache(maxAgeMs: number, scope?: "public" | "private"): OpBuilder<K, A, R>;
  doc(text: string): OpBuilder<K, A, R>;
  annotate(name: string, args?: Record<string, AnnotValue>): OpBuilder<K, A, R>;
}

function argDefs(args: FieldMap): ArgDef[] {
  return Object.entries(args).map(([name, a]) => {
    const d: ArgDef = { name, type: a.ref, annotations: a.annotations };
    if (a.description !== undefined) d.description = a.description;
    if (a.default !== undefined) d.default = a.default;
    return d;
  });
}

function opBuilder<K extends OpDef["kind"], A extends FieldMap, R>(kind: K, args: A, returns: TRef<R>, def: Omit<OpDef, "name">): OpBuilder<K, A, R> {
  const next = (d: Omit<OpDef, "name">) => opBuilder(kind, args, returns, d);
  const ann = (name: string, a: Record<string, AnnotValue>) => next({ ...def, annotations: [...def.annotations, { name, args: a }] });
  return {
    kind,
    args,
    returns,
    def,
    throws: (...errors) => next({ ...def, throws: [...def.throws, ...errors] }),
    emits: (...events) => next({ ...def, emits: [...def.emits, ...events] }),
    allow: (expr) => ann("allow", { [kind === "command" ? "write" : "read"]: { $expr: parseExprText(expr, "args") } }),
    cost: (base, perItem) => ann("cost", perItem === undefined ? { base } : { base, perItem }),
    cache: (maxAgeMs, scope = "public") => ann("cache", { maxAge: { $duration: maxAgeMs }, scope: { $ident: scope } }),
    doc: (text) => next({ ...def, description: text }),
    annotate: (name, a = {}) => ann(name, a),
  };
}

export function query<A extends FieldMap, R>(args: A, returns: TRef<R>): OpBuilder<"query", A, R> {
  return opBuilder("query", args, returns, { kind: "query", args: argDefs(args), returns: returns.ref, throws: [], emits: [], annotations: [] });
}
export function command<A extends FieldMap, R>(args: A, returns: TRef<R>): OpBuilder<"command", A, R> {
  return opBuilder("command", args, returns, { kind: "command", args: argDefs(args), returns: returns.ref, throws: [], emits: [], annotations: [] });
}
export function stream<A extends FieldMap, R>(args: A, returns: TRef<R>): OpBuilder<"stream", A, R> {
  return opBuilder("stream", args, returns, { kind: "stream", args: argDefs(args), returns: returns.ref, throws: [], emits: [], annotations: [] });
}

// ------------------------------------------------------------------ schema

type AnyTypeBuilder = TypeBuilder<TypeDef["kind"], string, FieldMap>;
type AnyOpBuilder = OpBuilder<OpDef["kind"], FieldMap, unknown>;

export interface SchemaDef<T extends readonly AnyTypeBuilder[], O extends Record<string, AnyOpBuilder>> {
  readonly ir: RayfoldSchemaIR;
  readonly types: { [B in T[number] as B["name"]]: B };
  readonly ops: O;
}

export function defineSchema<T extends readonly AnyTypeBuilder[], O extends Record<string, AnyOpBuilder>>(input: { types: T; ops: O }): SchemaDef<T, O> {
  const ir: RayfoldSchemaIR = { rayfold: "0.1", types: builtinTypes(), ops: {}, views: {} };
  const types = {} as Record<string, AnyTypeBuilder>;
  for (const b of input.types) {
    if (ir.types[b.name]) throw new Error(`Type ${b.name} defined twice (or shadows a built-in)`);
    ir.types[b.name] = b.def;
    types[b.name] = b;
    for (const [vn, shape] of Object.entries(b.views)) ir.views[`${b.name}.${vn}`] = { type: b.name, name: vn, shape };
  }
  for (const [name, op] of Object.entries(input.ops)) ir.ops[name] = { name, ...op.def };
  assertValid(ir);
  return { ir, types: types as SchemaDef<T, O>["types"], ops: input.ops };
}

// ------------------------------------------------------------------ inference

type Resolve<S, T, Depth extends unknown[]> = Depth["length"] extends 6
  ? unknown
  : T extends RefTo<infer N>
    ? Infer<S, N, [...Depth, 0]>
    : T extends PageOf<infer N>
      ? { items: Infer<S, N, [...Depth, 0]>[]; cursor: string | null; hasMore: boolean; total?: number | null }
      : T extends (infer E)[]
        ? Resolve<S, E, Depth>[]
        : T extends null
          ? null
          : T;

type FieldsOf<B> = B extends TypeBuilder<infer _K, infer _N, infer F> ? F : never;
type KindOf<B> = B extends TypeBuilder<infer K, infer _N, infer _F> ? K : never;

type InferFields<S, F extends FieldMap, Depth extends unknown[]> = {
  [K in keyof F as F[K] extends TRef<infer V> ? (null extends V ? never : K) : never]: F[K] extends TRef<infer V> ? Resolve<S, V, Depth> : never;
} & {
  [K in keyof F as F[K] extends TRef<infer V> ? (null extends V ? K : never) : never]?: F[K] extends TRef<infer V> ? Resolve<S, V, Depth> : never;
};

/** TS type of a schema type by name. Entities carry `$type`, enums become string unions, unions become member unions. */
export type Infer<S, N extends string, Depth extends unknown[] = []> = S extends { types: infer TS }
  ? N extends keyof TS
    ? KindOf<TS[N]> extends "enum"
      ? TS[N] extends { values: readonly (infer V)[] }
        ? V
        : string
      : KindOf<TS[N]> extends "union"
        ? TS[N] extends { members: readonly (infer M extends string)[] }
          ? Infer<S, M, Depth>
          : never
        : KindOf<TS[N]> extends "entity"
          ? { $type: N } & Simplify<InferFields<S, FieldsOf<TS[N]>, Depth>>
          : Simplify<InferFields<S, FieldsOf<TS[N]>, Depth>>
    : unknown
  : unknown;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** Argument and result types of an operation. */
export type InferArgs<S, OpName extends string> = S extends { ops: infer OS } ? (OpName extends keyof OS ? (OS[OpName] extends OpBuilder<infer _K, infer A, infer _R> ? Simplify<InferFields<S, A, []>> : never) : never) : never;
export type InferResult<S, OpName extends string> = S extends { ops: infer OS } ? (OpName extends keyof OS ? (OS[OpName] extends OpBuilder<infer _K, infer _A, infer R> ? Resolve<S, R, []> : never) : never) : never;

export type { Expr, TypeRef, RayfoldSchemaIR };

export { typedClient, type Select, type SelectResult, type ShapedClient, type TypedClient } from "./select.ts";
