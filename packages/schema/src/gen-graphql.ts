/**
 * A Rayfold schema as GraphQL SDL, with the list of what GraphQL has no way to say.
 *
 * Types, fields, arguments, defaults, descriptions and deprecations carry over, and nullability flips: a Rayfold field
 * is non-null unless marked `?`, a GraphQL field nullable unless marked `!`. Queries become `Query` fields, commands
 * `Mutation` fields and streams `Subscription` fields; `Page<Book>` becomes a `BookPage` type, since GraphQL has no
 * generics. What the contract says beyond that (typed errors, patches, idempotency keys, live queries, the rules written
 * as annotations) goes in `lost`, so the SDL is never taken for the whole API. `rayfold import graphql` reads it back.
 */
import { BUILTIN_SCALARS, type Annotation, type ArgDef, type FieldDef, type JsonValue, type OpKind, type RayfoldSchemaIR, type TypeDef, type TypeRef } from "./ir.ts";

export interface GraphqlSchema {
  sdl: string;
  /** What the Rayfold schema says and the SDL cannot, one sentence each. */
  lost: string[];
}

const NATIVE_SCALARS = new Set(["ID", "String", "Int", "Float", "Boolean"]);
const SCALAR_SPEC = "https://rayfold.dev/spec/01-schema";
const ROOTS: Array<[OpKind, string, string]> = [
  ["query", "Query", "query"],
  ["command", "Mutation", "mutation"],
  ["stream", "Subscription", "subscription"],
];

/** What each annotation the SDL leaves out is for, in the words `lost` uses. */
const MEANING: Record<string, string> = {
  allow: "access rules, which the server still enforces",
  cache: "HTTP cache lifetimes",
  cost: "the cost a request is checked against",
  deny: "access rules, which the server still enforces",
  deprecated: "deprecations GraphQL only allows on fields, optional arguments and enum values",
  example: "examples",
  format: "value formats",
  http: "REST routes",
  idempotent: "commands that opt out of idempotency",
  input: "items a client sends into a stream",
  lazy: "fields sent later in the same response",
  live: "live query settings",
  load: "how related data is loaded",
  merge: "merge rules for changes made offline",
  ordinal: "field numbers for the binary format",
  page: "the paging style",
  partial: "fields that may fail on their own",
  range: "allowed ranges",
  simulate: "dry runs",
  unit: "units",
  version: "version checks for conditional writes",
};

const joinAnd = (items: string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export function generateGraphql(ir: RayfoldSchemaIR, opts: { header?: boolean } = {}): GraphqlSchema {
  const used = new Set<string>();
  const pages = new Map<string, TypeRef>();
  const annotated = new Map<string, string[]>();

  /** Remembers the annotations the SDL leaves out; `deprecated` is kept where GraphQL allows it. */
  const record = (annotations: Annotation[], where: string, keepsDeprecation: boolean): void => {
    for (const a of annotations) {
      if (a.name === "interface" || (a.name === "deprecated" && keepsDeprecation)) continue;
      const places = annotated.get(a.name) ?? [];
      if (!places.includes(where)) places.push(where);
      annotated.set(a.name, places);
    }
  };

  const pageName = (item: TypeRef): string => {
    const base = item.kind === "named" ? item.name : "List";
    const key = JSON.stringify(item);
    let name = `${base}Page`;
    for (let n = 2; ir.types[name] || (pages.has(name) && JSON.stringify(pages.get(name)) !== key); n++) name = `${base}Page${n}`;
    pages.set(name, item);
    return name;
  };

  const type = (t: TypeRef): string => {
    let inner: string;
    if (t.kind === "list") inner = `[${type(t.of)}]`;
    else if (t.name === "Page" && t.args?.[0]) inner = pageName(t.args[0]);
    else {
      used.add(t.name);
      inner = t.name;
    }
    return t.nullable ? inner : `${inner}!`;
  };

  /** A default value as a GraphQL literal: enum values bare, input objects with their fields' types. */
  const value = (v: JsonValue, t: TypeRef | undefined): string => {
    if (v === null) return "null";
    if (t?.kind === "list") return Array.isArray(v) ? `[${v.map((x) => value(x, t.of)).join(", ")}]` : value(v, t.of);
    const def = t ? ir.types[t.name] : undefined;
    if (def?.kind === "enum" && typeof v === "string") return v;
    if (Array.isArray(v)) return `[${v.map((x) => value(x, undefined)).join(", ")}]`;
    if (typeof v === "object") {
      const fields = def && "fields" in def ? def.fields : [];
      return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${value(x, fields.find((f) => f.name === k)?.type)}`).join(", ")} }`;
    }
    return JSON.stringify(v);
  };

  const description = (text: string | undefined, indent: string): string[] => {
    if (!text) return [];
    // a block string cannot hold its own fence, nor end on a quote
    if (text.includes('"""') || text.endsWith('"')) return [`${indent}${JSON.stringify(text)}`];
    if (!text.includes("\n")) return [`${indent}"""${text}"""`];
    return [`${indent}"""`, ...text.split("\n").map((line) => (line ? `${indent}${line}` : "")), `${indent}"""`];
  };

  const deprecation = (annotations: Annotation[]): string => {
    const d = annotations.find((a) => a.name === "deprecated");
    if (!d) return "";
    const text = (k: string): string | undefined => (typeof d.args[k] === "string" ? (d.args[k] as string) : undefined);
    const reason = text("reason") ?? text("value");
    const more = [text("replacement") ? `Use ${text("replacement")} instead.` : "", text("sunset") ? `Removed after ${text("sunset")}.` : ""].filter(Boolean);
    if (!reason && !more.length) return " @deprecated";
    const first = reason ? (more.length && !/[.!?]$/.test(reason) ? `${reason}.` : reason) : "";
    return ` @deprecated(reason: ${JSON.stringify([first, ...more].filter(Boolean).join(" "))})`;
  };

  /** GraphQL does not let an argument or input field it requires be deprecated. */
  const optional = (t: TypeRef, fallback: JsonValue | undefined): boolean => t.nullable || fallback !== undefined;

  const args = (list: ArgDef[], owner: string): string => {
    if (!list.length) return "";
    const items = list.map((a) => {
      const keeps = optional(a.type, a.default);
      record(a.annotations, `${owner}(${a.name})`, keeps);
      const fallback = a.default !== undefined ? ` = ${value(a.default, a.type)}` : "";
      return `${a.description ? `${JSON.stringify(a.description)} ` : ""}${a.name}: ${type(a.type)}${fallback}${keeps ? deprecation(a.annotations) : ""}`;
    });
    return `(${items.join(", ")})`;
  };

  const empty: string[] = [];
  const fields = (owner: string, list: FieldDef[], input: boolean): string[] => {
    // GraphQL has no type or input without fields; the placeholder says so, and lost names each one
    if (!list.length) {
      empty.push(owner);
      return [`  """${owner} has no fields in the Rayfold schema, and GraphQL needs one here."""`, "  _: Boolean"];
    }
    return list.flatMap((f) => {
      const keeps = !input || optional(f.type, f.default);
      record(f.annotations, `${owner}.${f.name}`, keeps);
      const fallback = input && f.default !== undefined ? ` = ${value(f.default, f.type)}` : "";
      const line = `  ${f.name}${input ? "" : args(f.args, `${owner}.${f.name}`)}: ${type(f.type)}${fallback}${keeps ? deprecation(f.annotations) : ""}`;
      return [...description(f.description, "  "), line];
    });
  };

  const blocks: string[] = [];
  const ops = Object.values(ir.ops);
  for (const [kind, root, word] of ROOTS) {
    const mine = ops.filter((o) => o.kind === kind);
    if (!mine.length && kind !== "query") continue;
    if (ir.types[root]) throw new Error(`${root} is a type in this schema, and GraphQL needs that name for the ${word} root type`);
    // every root field is nullable: one Rayfold operation failing must not empty the answers of the others
    const lines = mine.length
      ? mine.flatMap((op) => {
          record(op.annotations, `${op.name}()`, true);
          const line = `  ${op.name}${args(op.args, op.name)}: ${type({ ...op.returns, nullable: true })}${deprecation(op.annotations)}`;
          return [...description(op.description, "  "), line];
        })
      : ['  """This schema declares no query, and GraphQL needs a field here."""', "  _: Boolean"];
    blocks.push([`type ${root} {`, ...lines, "}"].join("\n"));
  }

  for (const t of Object.values(ir.types)) {
    if (t.builtin) continue;
    record(t.annotations, t.name, false);
    const head = description(t.description, "");
    switch (t.kind) {
      case "entity":
        blocks.push([...head, `type ${t.name}${t.implements.length ? ` implements ${t.implements.join(" & ")}` : ""} {`, ...fields(t.name, t.fields, false), "}"].join("\n"));
        break;
      case "object":
      case "error":
      case "event":
        blocks.push([...head, `${t.kind === "object" && t.interface ? "interface" : "type"} ${t.name} {`, ...fields(t.name, t.fields, false), "}"].join("\n"));
        break;
      case "input":
        blocks.push([...head, `input ${t.name} {`, ...fields(t.name, t.fields, true), "}"].join("\n"));
        break;
      case "enum": {
        const values = t.values.flatMap((v) => {
          record(v.annotations, `${t.name}.${v.name}`, true);
          return [...description(v.description, "  "), `  ${v.name}${deprecation(v.annotations)}`];
        });
        blocks.push([...head, `enum ${t.name} {`, ...values, "}"].join("\n"));
        break;
      }
      case "union":
        blocks.push([...head, `union ${t.name} = ${t.members.join(" | ")}`].join("\n"));
        break;
      case "scalar":
        blocks.push([...head, `scalar ${t.name}`].join("\n"));
        break;
    }
  }

  const page = ir.types["Page"] as Extract<TypeDef, { kind: "object" }>;
  const substitute = (t: TypeRef, item: TypeRef): TypeRef => (t.kind === "list" ? { ...t, of: substitute(t.of, item) } : t.name === "T" ? item : t);
  for (const [name, item] of pages) blocks.push([`type ${name} {`, ...page.fields.map((f) => `  ${f.name}: ${type(substitute(f.type, item))}`), "}"].join("\n"));
  if (used.has("PageArgs")) blocks.push(["input PageArgs {", ...fields("PageArgs", (ir.types["PageArgs"] as Extract<TypeDef, { kind: "input" }>).fields, true), "}"].join("\n"));
  for (const s of BUILTIN_SCALARS) if (used.has(s) && !NATIVE_SCALARS.has(s)) blocks.push(`scalar ${s} @specifiedBy(url: "${SCALAR_SPEC}")`);

  const lost: string[] = [];
  const has = (kind: OpKind): boolean => ops.some((o) => o.kind === kind);
  const roots = ROOTS.filter(([kind]) => kind === "query" || has(kind)).map(([, root]) => root);
  lost.push(`Each operation succeeds or fails on its own. GraphQL can only show that with nullable fields, so every ${joinAnd(roots)} field is nullable.`);
  if (has("query")) lost.push("Queries: live: true, reads cached by GET or QUERY with an ETag, and the default view a call without a shape gets.");
  else lost.push("The schema declares no query, so Query holds the placeholder field _ that GraphQL requires.");
  if (has("command")) lost.push("Commands: the idempotency key each call carries, and the cache patches each one returns.");
  lost.push("Batches: several operations in one request, where a later one can use an earlier one's result ($ref).");
  const views = Object.keys(ir.views);
  if (views.length) lost.push(`Views (${views.join(", ")}): a GraphQL schema has no named selections; the nearest thing is a fragment in client code.`);
  for (const op of ops) {
    if (!op.throws.length) continue;
    const one = op.throws.length === 1;
    lost.push(`${op.name}() throws ${joinAnd(op.throws)}: GraphQL has no typed errors, so the SDL has ${one ? "the type" : "the types"} but not that ${op.name}() throws ${one ? "it" : "them"}.`);
  }
  const emitted = new Map<string, string[]>();
  for (const op of ops) for (const e of op.emits) emitted.set(e, [...(emitted.get(e) ?? []), `${op.name}()`]);
  if (empty.length) lost.push(`${joinAnd(empty)} ${empty.length === 1 ? "has" : "have"} no fields, and GraphQL allows no type without one, so ${empty.length === 1 ? "it holds" : "each holds"} the placeholder field _.`);
  for (const [event, by] of emitted) lost.push(`${event} is emitted by ${joinAnd(by)}: GraphQL has no events besides subscriptions.`);
  for (const name of [...annotated.keys()].sort()) lost.push(`@${name} (${annotated.get(name)!.join(", ")}): ${MEANING[name] ?? "an annotation GraphQL has no form for"}.`);

  const header = opts.header === false ? [] : ["# Generated by `rayfold gen graphql`. Do not edit."];
  return { sdl: [...header, ...blocks].join("\n\n") + "\n", lost };
}
