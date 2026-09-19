/** Shapes: parser, canonical form, ids. Spec: spec/02-shapes.md. */
import type { JsonValue, Shape, ShapeItem, ShapeValue, ViewDef } from "./ir.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { TokenStream, tokenize } from "./lexer.ts";

export function parseShapeText(text: string): Shape {
  const ts = new TokenStream(tokenize(text));
  const s = parseShape(ts);
  if (!ts.at("eof")) throw ts.error("Unexpected token after shape");
  return s;
}

/** Nesting limit for shapes and their argument values, checked while parsing so deep input never recurses far. */
export const MAX_SHAPE_NESTING = 64;
let nesting = 0;
function enter(ts: TokenStream): void {
  if (nesting >= MAX_SHAPE_NESTING) throw ts.error(`Shape nested deeper than ${MAX_SHAPE_NESTING} levels`);
  nesting++;
}

export function parseShape(ts: TokenStream): Shape {
  enter(ts);
  try {
    ts.expectPunct("{");
    const items: ShapeItem[] = [];
    while (!ts.atPunct("}")) {
      if (ts.at("eof")) throw ts.error("Unterminated shape");
      items.push(parseItem(ts));
    }
    ts.expectPunct("}");
    return { items };
  } finally {
    nesting--;
  }
}

function parseItem(ts: TokenStream): ShapeItem {
  if (ts.accept("punct", "...")) {
    if (ts.accept("name", "on")) {
      const type = ts.expectName();
      return { kind: "on", type, shape: parseShape(ts) };
    }
    const type = ts.expectName();
    ts.expectPunct(".");
    const view = ts.expectName();
    return { kind: "spread", type, view };
  }
  if (ts.atPunct("@")) {
    ts.next();
    const d = ts.expectName();
    if (d !== "defer") throw ts.error(`Unknown shape directive @${d}`);
    let label: string | undefined;
    if (ts.accept("punct", "(")) {
      const k = ts.expectName();
      if (k !== "label") throw ts.error("@defer accepts only label:");
      ts.expectPunct(":");
      label = ts.expect("string").value;
      ts.expectPunct(")");
    }
    const shape = parseShape(ts);
    return label === undefined ? { kind: "defer", shape } : { kind: "defer", label, shape };
  }
  const first = ts.expectName();
  let alias: string | undefined;
  let name = first;
  if (ts.accept("punct", ":")) {
    alias = first;
    name = ts.expectName();
  }
  const item: ShapeItem = { kind: "field", name };
  if (alias !== undefined) item.alias = alias;
  if (ts.accept("punct", "(")) {
    const args: Record<string, ShapeValue> = {};
    while (!ts.atPunct(")")) {
      const k = ts.expectName();
      ts.expectPunct(":");
      args[k] = parseShapeValue(ts);
    }
    ts.expectPunct(")");
    // `field()` selects exactly what `field` selects, and the canonical form prints it without the parentheses, so
    // recording an empty map here would make the parsed shape disagree with a re-parse of its own printed text.
    if (Object.keys(args).length) item.args = args;
  }
  if (ts.atPunct("{")) item.shape = parseShape(ts);
  // Modifiers belong to this field; anything else after "@" (like @defer) is the next item.
  while (ts.atPunct("@") && ts.peek(1).kind === "name") {
    const m = ts.peek(1).value;
    if (m === "eager") item.eager = true;
    else if (m === "partial") item.partial = true;
    else if (m === "defer") break;
    else throw ts.error(`Unknown field modifier @${m}`, ts.peek(1));
    ts.next();
    ts.next();
  }
  return item;
}

/** Literal with `$var` references allowed at any depth (up to the nesting limit). */
export function parseShapeValue(ts: TokenStream): ShapeValue {
  enter(ts);
  try {
    return parseShapeValueAt(ts);
  } finally {
    nesting--;
  }
}

function parseShapeValueAt(ts: TokenStream): ShapeValue {
  const t = ts.peek();
  if (t.kind === "punct" && t.value === "$") {
    ts.next();
    return { $var: ts.expectName() };
  }
  if (t.kind === "punct" && t.value === "[") {
    ts.next();
    const out: ShapeValue[] = [];
    while (!ts.atPunct("]")) out.push(parseShapeValue(ts));
    ts.expectPunct("]");
    return out as ShapeValue;
  }
  if (t.kind === "punct" && t.value === "{") {
    ts.next();
    const out: Record<string, ShapeValue> = {};
    while (!ts.atPunct("}")) {
      const k = ts.expectName();
      ts.expectPunct(":");
      out[k] = parseShapeValue(ts);
    }
    ts.expectPunct("}");
    return out as ShapeValue;
  }
  return parseLiteral(ts);
}

/** JSON-like literal: scalars, lists, objects, enum identifiers become strings. */
export function parseLiteral(ts: TokenStream): JsonValue {
  const t = ts.peek();
  switch (t.kind) {
    case "string":
      ts.next();
      return t.value;
    case "int":
    case "float":
      ts.next();
      return t.num!;
    case "duration":
      ts.next();
      return t.num!;
    case "name":
      ts.next();
      if (t.value === "true") return true;
      if (t.value === "false") return false;
      if (t.value === "null") return null;
      return t.value;
    case "punct":
      if (t.value === "[") {
        ts.next();
        const out: JsonValue[] = [];
        while (!ts.atPunct("]")) out.push(parseLiteral(ts));
        ts.expectPunct("]");
        return out;
      }
      if (t.value === "{") {
        ts.next();
        const out: Record<string, JsonValue> = {};
        while (!ts.atPunct("}")) {
          const k = ts.expectName();
          ts.expectPunct(":");
          out[k] = parseLiteral(ts);
        }
        ts.expectPunct("}");
        return out;
      }
      throw ts.error(`Unexpected ${JSON.stringify(t.value)} in literal`);
    default:
      throw ts.error("Expected literal");
  }
}

/** Human-readable form (not canonical). */
export function shapeToString(s: Shape): string {
  return `{ ${s.items.map(itemToString).join(" ")} }`;
}
function itemToString(i: ShapeItem): string {
  switch (i.kind) {
    case "spread":
      return `...${i.type}.${i.view}`;
    case "on":
      return `...on ${i.type} ${shapeToString(i.shape)}`;
    case "defer":
      return `@defer${i.label !== undefined ? `(label: ${JSON.stringify(i.label)})` : ""} ${shapeToString(i.shape)}`;
    case "field": {
      let s = i.alias !== undefined ? `${i.alias}: ${i.name}` : i.name;
      if (i.args && Object.keys(i.args).length) s += `(${argsToText(i.args)})`;
      if (i.shape) s += ` ${shapeToString(i.shape)}`;
      if (i.eager) s += " @eager";
      if (i.partial) s += " @partial";
      return s;
    }
  }
}
/** Arguments as shape text that parses back to the same values; the canonical form below quotes keys and is only hashed. */
function argsToText(args: Record<string, ShapeValue>): string {
  return Object.keys(args)
    .sort()
    .map((k) => `${k}: ${valueToText(args[k]!)}`)
    .join(" ");
}
function valueToText(v: ShapeValue): string {
  if (v === null || typeof v !== "object") return canonicalJson(v);
  if (Array.isArray(v)) return `[${v.map((x) => valueToText(x as ShapeValue)).join(" ")}]`;
  if ("$var" in v && typeof v["$var"] === "string") return `$${v["$var"]}`;
  const o = v as Record<string, ShapeValue>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${k}: ${valueToText(o[k]!)}`)
    .join(" ")}}`;
}
function argsToString(args: Record<string, ShapeValue>): string {
  return Object.keys(args)
    .sort()
    .map((k) => `${k}: ${valueToString(args[k]!)}`)
    .join(" ");
}
function valueToString(v: ShapeValue): string {
  if (v === null || typeof v !== "object") return canonicalJson(v);
  if (Array.isArray(v)) return `[${v.map((x) => valueToString(x as ShapeValue)).join(",")}]`;
  if ("$var" in v && typeof v["$var"] === "string") return `$${v["$var"]}`;
  const o = v as Record<string, ShapeValue>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${valueToString(o[k]!)}`)
    .join(",")}}`;
}

export type ViewResolver = (type: string, view: string) => ViewDef | undefined;

/**
 * Canonical form: named-view spreads expanded, items sorted by output name then args,
 * single spaces, no commas. Spec 02 §3.
 */
export function canonicalShape(s: Shape, views: ViewResolver): string {
  const expanded = expandViews(s, views, new Set());
  return canon(expanded);
}

function expandViews(s: Shape, views: ViewResolver, seen: Set<string>): Shape {
  const items: ShapeItem[] = [];
  for (const it of s.items) {
    if (it.kind === "spread") {
      const key = `${it.type}.${it.view}`;
      if (seen.has(key)) throw new Error(`View spread cycle at ${key}`);
      const v = views(it.type, it.view);
      if (!v) throw new Error(`Unknown view ${key}`);
      const inner = expandViews(v.shape, views, new Set([...seen, key]));
      items.push(...inner.items);
    } else if (it.kind === "on") {
      items.push({ kind: "on", type: it.type, shape: expandViews(it.shape, views, seen) });
    } else if (it.kind === "defer") {
      const d: ShapeItem = { kind: "defer", shape: expandViews(it.shape, views, seen) };
      if (it.label !== undefined) d.label = it.label;
      items.push(d);
    } else {
      const f: ShapeItem = { ...it };
      if (it.shape) f.shape = expandViews(it.shape, views, seen);
      items.push(f);
    }
  }
  return { items };
}

function canon(s: Shape): string {
  const parts = s.items.map((i) => ({ key: sortKey(i), text: canonItem(i) }));
  parts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return `{ ${parts.map((p) => p.text).join(" ")} }`;
}
function sortKey(i: ShapeItem): string {
  switch (i.kind) {
    case "field":
      return `0:${i.alias ?? i.name}:${i.args ? argsToString(i.args) : ""}`;
    case "on":
      return `1:${i.type}`;
    case "defer":
      return `2:${i.label ?? ""}`;
    case "spread":
      return `3:${i.type}.${i.view}`;
  }
}
function canonItem(i: ShapeItem): string {
  switch (i.kind) {
    case "field": {
      let s = i.alias !== undefined ? `${i.alias}: ${i.name}` : i.name;
      if (i.args && Object.keys(i.args).length) s += `(${argsToString(i.args)})`;
      if (i.shape) s += ` ${canon(i.shape)}`;
      if (i.eager) s += " @eager";
      if (i.partial) s += " @partial";
      return s;
    }
    case "on":
      return `...on ${i.type} ${canon(i.shape)}`;
    case "defer":
      return `@defer${i.label !== undefined ? `(label: ${JSON.stringify(i.label)})` : ""} ${canon(i.shape)}`;
    case "spread":
      return `...${i.type}.${i.view}`;
  }
}

export function shapeIdOf(canonicalText: string): string {
  return `sha256:${sha256Hex(canonicalText)}`;
}

export function isShapeId(s: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(s);
}
