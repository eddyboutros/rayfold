/**
 * Shape-typed results, with no code generation.
 *
 * A shape is a string at the call site, so TypeScript can read it: `Select` parses that string in the type system and
 * narrows the result type to the fields it selects. `typedClient` puts it on a client, so `query("book", { id },
 * { shape: "{ id title }" })` returns `{ $type: "Book"; id: string; title: string }` and nothing else.
 *
 * What it understands (spec/02 section 1): fields, `alias: field`, arguments (skipped, they do not change the type),
 * nested shapes, `@partial` and `@eager`, `@defer` blocks and `...on Type { }` spreads (both contribute optional
 * fields, since neither is certain to arrive in the first frame). A field with no sub-shape is typed as the default
 * view the server derives for its type (spec 01 §2.7): scalars and enums, no nested objects.
 *
 * What it does not: a named-view spread (`...Book.card`) names a view whose text lives in the schema, not in the call,
 * so a shape that uses one falls back to the whole type. That is wider than the truth, never narrower. Nor does it see
 * a `default` view the schema declares, or a scalar field's arguments (which keep it out of the derived view).
 */
import type { InferArgs, InferResult } from "./index.ts";

// ------------------------------------------------------------------ parsing a shape in the type system

type Space = " " | "\n" | "\r" | "\t" | ",";
type Delimiter = Space | "{" | "}" | "(" | ")" | ":" | "@" | ".";

type Skip<S extends string> = S extends `${Space}${infer Rest}` ? Skip<Rest> : S;

type ReadName<S extends string, Acc extends string = ""> = S extends `${infer C}${infer Rest}`
  ? C extends Delimiter
    ? [Acc, S]
    : ReadName<Rest, `${Acc}${C}`>
  : [Acc, ""];

/** The text inside the next balanced pair, and what follows it. */
type TakeBlock<
  S extends string,
  Open extends string,
  Close extends string,
  Depth extends unknown[] = [],
  Acc extends string = "",
> = S extends `${infer C}${infer Rest}`
  ? C extends Open
    ? Depth["length"] extends 0
      ? TakeBlock<Rest, Open, Close, [0], "">
      : TakeBlock<Rest, Open, Close, [...Depth, 0], `${Acc}${C}`>
    : C extends Close
      ? Depth extends [unknown]
        ? [Acc, Rest]
        : TakeBlock<Rest, Open, Close, Pop<Depth>, `${Acc}${C}`>
      : TakeBlock<Rest, Open, Close, Depth, Depth["length"] extends 0 ? "" : `${Acc}${C}`>
  : [Acc, ""];

type Pop<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : [];

interface Entry {
  alias: string;
  name: string;
  sub: string | null;
  optional: boolean;
}

/** The sentinel a named-view spread leaves behind: the shape cannot be read here, so the whole type stands. */
type Opaque = { alias: ""; name: "..."; sub: null; optional: false };

type ParseShape<S extends string> = Skip<S> extends `{${infer Body}}` ? ParseItems<Body> : [Opaque];

type ParseItems<S extends string, Acc extends Entry[] = []> = Skip<S> extends ""
  ? Acc
  : Skip<S> extends `...${infer AfterDots}`
    ? ParseSpread<Skip<AfterDots>, Acc>
    : Skip<S> extends `@defer${infer AfterDefer}`
      ? ParseBlock<SkipArgs<Skip<AfterDefer>>, Acc>
      : ParseField<Skip<S>, Acc>;

type SkipArgs<S extends string> = S extends `(${string}` ? Second<TakeBlock<S, "(", ")">> : S;

type Second<T> = T extends [unknown, infer R extends string] ? R : "";

/** `@defer { ... }` and `...on Type { ... }` both add fields that need not be in the first frame. */
type ParseBlock<S extends string, Acc extends Entry[]> = Skip<S> extends `{${string}`
  ? TakeBlock<Skip<S>, "{", "}"> extends [infer Inner extends string, infer Rest extends string]
    ? ParseItems<Rest, [...Acc, ...AsOptional<ParseItems<Inner>>]>
    : Acc
  : Acc;

type AsOptional<E extends Entry[]> = { [I in keyof E]: { alias: E[I]["alias"]; name: E[I]["name"]; sub: E[I]["sub"]; optional: true } };

type ParseSpread<S extends string, Acc extends Entry[]> = S extends `on${Space}${infer AfterOn}`
  ? ReadName<Skip<AfterOn>> extends [string, infer Rest extends string]
    ? ParseBlock<Skip<Rest>, Acc>
    : Acc
  : [Opaque]; // a named view: its text is in the schema, not here

type ParseField<S extends string, Acc extends Entry[]> = ReadName<S> extends [infer Name extends string, infer Rest extends string]
  ? Name extends ""
    ? Acc // something we cannot read; keep what we have rather than guess
    : Skip<Rest> extends `:${infer AfterColon}`
      ? ReadName<Skip<AfterColon>> extends [infer Field extends string, infer AfterField extends string]
        ? FinishField<Name, Field, AfterField, Acc>
        : Acc
      : FinishField<"", Name, Rest, Acc>
  : Acc;

type FinishField<Alias extends string, Name extends string, S extends string, Acc extends Entry[]> =
  SkipArgs<Skip<S>> extends infer AfterArgs extends string
    ? Skip<AfterArgs> extends `{${string}`
      ? TakeBlock<Skip<AfterArgs>, "{", "}"> extends [infer Sub extends string, infer Rest extends string]
        ? ParseItems<SkipModifiers<Skip<Rest>>, [...Acc, { alias: Alias; name: Name; sub: `{${Sub}}`; optional: false }]>
        : Acc
      : ParseItems<SkipModifiers<Skip<AfterArgs>>, [...Acc, { alias: Alias; name: Name; sub: null; optional: false }]>
    : Acc;

/** `@partial` and `@eager` say how a field is delivered, not what it is. `@defer` opens a block, so it is left alone. */
type SkipModifiers<S extends string> = S extends `@${infer AfterAt}`
  ? ReadName<AfterAt> extends [infer Name extends string, infer Rest extends string]
    ? Name extends "defer"
      ? S
      : SkipModifiers<Skip<SkipArgs<Skip<Rest>>>>
    : S
  : S;

// ------------------------------------------------------------------ applying it to a type

type OutName<E extends Entry> = E["alias"] extends "" ? E["name"] : E["alias"];

type Marker<T> = T extends { $type: infer N } ? { $type: N } : unknown;

type Narrow<T, E extends Entry, Depth extends unknown[]> = E["name"] extends keyof T
  ? E["sub"] extends string
    ? Pick<T, E["name"]>[E["name"]] extends infer V
      ? SelectDeep<V, E["sub"], [...Depth, 0]>
      : never
    : DefaultView<Pick<T, E["name"]>[E["name"]]>
  : unknown; // a field the schema does not have: the server will answer for it, we will not pretend to know

/** A value the derived default view keeps: a scalar or an enum, or a list of them (JSON is `unknown`, and a scalar). */
type ScalarLike<V> = unknown extends V
  ? true
  : [NonNullable<V>] extends [never]
    ? true
    : NonNullable<V> extends readonly (infer E)[]
      ? ScalarLike<E>
      : NonNullable<V> extends object
        ? false
        : true;

type PageLike = { items: readonly unknown[]; hasMore: boolean };

/**
 * What a field selected with no sub-shape brings back: its type's derived default view (spec 01 §2.7), every scalar
 * and enum field, nested objects left out, and a page's `items` through their own default view. A `default` view the
 * schema declares is not visible here, so this is the view the server derives when none is declared.
 */
type DefaultView<T> = T extends readonly (infer E)[]
  ? DefaultView<E>[]
  : T extends PageLike
    ? Flat<{ [K in keyof T as K extends "items" ? K : ScalarLike<T[K]> extends true ? K : never]: K extends "items" ? DefaultView<T[K]> : T[K] }>
    : T extends object
      ? Flat<{ [K in keyof T as ScalarLike<T[K]> extends true ? K : never]: T[K] }>
      : T;

type Applied<T, E extends Entry[], Depth extends unknown[]> = Marker<T> & {
  [K in E[number] as K["optional"] extends true ? never : undefined extends Narrow<T, K, Depth> ? never : OutName<K>]: Narrow<T, K, Depth>;
} & {
  [K in E[number] as K["optional"] extends true ? OutName<K> : undefined extends Narrow<T, K, Depth> ? OutName<K> : never]?: Narrow<T, K, Depth>;
};

type SelectDeep<T, Shape extends string, Depth extends unknown[]> = Depth["length"] extends 8
  ? T
  : [T] extends [never]
    ? never
    : T extends readonly (infer Element)[]
      ? SelectDeep<Element, Shape, Depth>[]
      : null extends T
        ? SelectDeep<NonNullable<T>, Shape, Depth> | null
        : undefined extends T
          ? SelectDeep<NonNullable<T>, Shape, Depth> | undefined
          : keyof T extends never
            ? T
            : ParseShape<Shape> extends infer E extends Entry[]
              ? Opaque extends E[number]
                ? T
                : Flat<Applied<T, E, Depth>>
              : T;

type Flat<T> = { [K in keyof T]: T[K] } & {};

/** [T], narrowed to what [Shape] selects. Lists and nulls are kept; the shape applies to what is inside them. */
export type Select<T, Shape extends string> = SelectDeep<T, Shape, []>;

/** What an operation returns under a shape. `SelectResult<typeof schema, "book", "{ id title }">`. */
export type SelectResult<S, Op extends string, Shape extends string> = Select<InferResult<S, Op>, Shape>;

// ------------------------------------------------------------------ a client that knows the schema

type OpNames<S> = S extends { ops: infer Ops } ? keyof Ops & string : never;

/** Only what a typed client needs of a client, so this package depends on no other at runtime. */
export interface ShapedClient {
  query<T>(op: string, args?: Record<string, unknown>, options?: Record<string, unknown>): Promise<T>;
  command<T>(op: string, args?: Record<string, unknown>, options?: Record<string, unknown>): Promise<T>;
}

interface CallOptions {
  vars?: Record<string, unknown>;
  key?: string;
  deadline?: number;
  simulate?: boolean;
  ifVersion?: string | number;
  [option: string]: unknown;
}

export interface TypedClient<S> {
  query<Op extends OpNames<S>, Shape extends string = "">(
    op: Op,
    args: InferArgs<S, Op>,
    options?: CallOptions & { shape?: Shape },
  ): Promise<Shape extends "" ? InferResult<S, Op> : Select<InferResult<S, Op>, Shape>>;

  command<Op extends OpNames<S>, Shape extends string = "">(
    op: Op,
    args: InferArgs<S, Op>,
    options?: CallOptions & { shape?: Shape },
  ): Promise<Shape extends "" ? InferResult<S, Op> : Select<InferResult<S, Op>, Shape>>;
}

/**
 * The same client, typed by a schema: operation names, their arguments, and results narrowed to the shape asked for.
 *
 *     const api = typedClient<typeof schema>(client);
 *     const book = await api.query("book", { id: "b1" }, { shape: "{ id title author { name } }" });
 *     book.author.name;   // string
 *     book.stock;         // a type error: it was not asked for
 */
export function typedClient<S>(client: ShapedClient): TypedClient<S> {
  return {
    query: (op, args, options) => client.query(op, args as Record<string, unknown>, options),
    command: (op, args, options) => client.command(op, args as Record<string, unknown>, options),
  } as TypedClient<S>;
}
