/** Policy expressions: parser, evaluator, analysis. Spec: spec/01-schema.md §5. */
import type { Expr } from "./ir.ts";
import { TokenStream, tokenize } from "./lexer.ts";

export type BareRoot = "this" | "args";

export function parseExprText(text: string, bareRoot: BareRoot): Expr {
  const ts = new TokenStream(tokenize(text));
  const e = parseExpr(ts, bareRoot);
  if (!ts.at("eof")) throw ts.error("Unexpected token after expression");
  return e;
}

/** Parses an expression from the current position; stops at a token that cannot continue it. */
export function parseExpr(ts: TokenStream, bareRoot: BareRoot): Expr {
  return parseOr(ts, bareRoot);
}

function parseOr(ts: TokenStream, r: BareRoot): Expr {
  let l = parseAnd(ts, r);
  while (ts.accept("punct", "||")) l = { k: "bin", op: "||", l, r: parseAnd(ts, r) };
  return l;
}
function parseAnd(ts: TokenStream, r: BareRoot): Expr {
  let l = parseNot(ts, r);
  while (ts.accept("punct", "&&")) l = { k: "bin", op: "&&", l, r: parseNot(ts, r) };
  return l;
}
function parseNot(ts: TokenStream, r: BareRoot): Expr {
  if (ts.accept("punct", "!")) return { k: "not", e: parseNot(ts, r) };
  return parseCmp(ts, r);
}
const CMP_OPS = ["==", "!=", "<", "<=", ">", ">="] as const;
function parseCmp(ts: TokenStream, r: BareRoot): Expr {
  const l = parsePrimary(ts, r);
  const t = ts.peek();
  if (t.kind === "punct" && (CMP_OPS as readonly string[]).includes(t.value)) {
    ts.next();
    return { k: "bin", op: t.value as (typeof CMP_OPS)[number], l, r: parsePrimary(ts, r) };
  }
  if (t.kind === "name" && t.value === "in") {
    ts.next();
    return { k: "bin", op: "in", l, r: parsePrimary(ts, r) };
  }
  return l;
}
function parsePrimary(ts: TokenStream, r: BareRoot): Expr {
  const t = ts.peek();
  switch (t.kind) {
    case "string":
      ts.next();
      return { k: "lit", v: t.value };
    case "int":
    case "float":
      ts.next();
      return { k: "lit", v: t.num! };
    case "duration":
      ts.next();
      return { k: "lit", v: t.num! };
    case "punct":
      if (t.value === "(") {
        ts.next();
        const e = parseExpr(ts, r);
        ts.expectPunct(")");
        return e;
      }
      if (t.value === "[") {
        ts.next();
        const items: Expr[] = [];
        while (!ts.atPunct("]")) items.push(parseExpr(ts, r));
        ts.expectPunct("]");
        return { k: "list", items };
      }
      throw ts.error(`Unexpected ${JSON.stringify(t.value)} in expression`);
    case "name": {
      ts.next();
      if (t.value === "true") return { k: "lit", v: true };
      if (t.value === "false") return { k: "lit", v: false };
      if (t.value === "null") return { k: "lit", v: null };
      if (ts.atPunct("(")) {
        ts.next();
        const args: Expr[] = [];
        while (!ts.atPunct(")")) args.push(parseExpr(ts, r));
        ts.expectPunct(")");
        if (!BUILTIN_FNS.has(t.value)) throw ts.error(`Unknown function ${t.value}()`, t);
        return { k: "call", fn: t.value, args };
      }
      const path: string[] = [];
      while (ts.accept("punct", ".")) path.push(ts.expectName());
      if (t.value === "viewer" || t.value === "args" || t.value === "this") return { k: "path", root: t.value, path };
      return { k: "path", root: r, path: [t.value, ...path] };
    }
    default:
      throw ts.error("Expected expression");
  }
}

const BUILTIN_FNS = new Set(["has", "len", "now"]);

export interface ExprEnv {
  viewer: unknown;
  args: unknown;
  this: unknown;
  now?: () => number;
}

/** Total evaluation: missing paths are null, comparisons with null are false. */
export function evalExpr(e: Expr, env: ExprEnv): unknown {
  switch (e.k) {
    case "lit":
      return e.v;
    case "path": {
      let cur: unknown = env[e.root];
      // own members of objects only, as the JVM reads a JSON object: an array has none, and neither `length` nor
      // `constructor` is data, or a policy would decide differently on each runtime
      for (const p of e.path) {
        if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.hasOwn(cur, p)) return null;
        cur = (cur as Record<string, unknown>)[p];
      }
      return cur === undefined ? null : cur;
    }
    case "not":
      return !truthy(evalExpr(e.e, env));
    case "list":
      return e.items.map((i) => evalExpr(i, env));
    case "call": {
      const a = e.args.map((x) => evalExpr(x, env));
      switch (e.fn) {
        case "has":
          return Array.isArray(a[0]) && a[0].some((x) => looseEq(x, a[1]));
        case "len":
          return Array.isArray(a[0]) || typeof a[0] === "string" ? (a[0] as string | unknown[]).length : null;
        case "now":
          return env.now ? env.now() : Date.now();
        default:
          return null;
      }
    }
    case "bin": {
      if (e.op === "&&") return truthy(evalExpr(e.l, env)) && truthy(evalExpr(e.r, env));
      if (e.op === "||") return truthy(evalExpr(e.l, env)) || truthy(evalExpr(e.r, env));
      const l = evalExpr(e.l, env);
      const r = evalExpr(e.r, env);
      switch (e.op) {
        case "==":
          return looseEq(l, r);
        case "!=":
          return !looseEq(l, r);
        case "in":
          return Array.isArray(r) && r.some((x) => looseEq(l, x));
        default: {
          if (l === null || r === null || l === undefined || r === undefined) return false;
          const c = compareValues(l, r);
          if (e.op === "<") return c < 0;
          if (e.op === "<=") return c <= 0;
          if (e.op === ">") return c > 0;
          return c >= 0;
        }
      }
    }
  }
}

function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false;
}

/** Raised when an expression compares values that cannot be ordered; a policy that errors fails closed. */
export class ExprError extends Error {}

/**
 * Equality that treats null/undefined as equal to each other only; a number equals numeric text of the same value
 * (Decimal and Long travel as text), and ids of any scalar type are equal by string.
 */
function looseEq(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return false;
  if (typeof a !== typeof b && (typeof a === "number" || typeof b === "number")) {
    const x = numericText(a);
    const y = numericText(b);
    if (x !== undefined && y !== undefined) return compareDecimal(x, y) === 0;
  }
  if (typeof a === typeof b) return a === b;
  return String(a) === String(b);
}

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/** Order of two non-null values: numbers and numeric text compare exactly by value, other text by code point. */
function compareValues(a: unknown, b: unknown): number {
  const x = numericText(a);
  const y = numericText(b);
  if (x !== undefined && y !== undefined) return compareDecimal(x, y);
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  throw new ExprError(`Cannot order ${typeof a} and ${typeof b}`);
}

function numericText(v: unknown): string | undefined {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return undefined;
    const s = String(v);
    return /e/i.test(s) ? v.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : s;
  }
  return typeof v === "string" && DECIMAL_TEXT.test(v) ? v : undefined;
}

/** Exact comparison of decimal text, any length (no floating point, so values beyond 2^53 stay exact). */
function compareDecimal(a: string, b: string): number {
  const x = splitDecimal(a);
  const y = splitDecimal(b);
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  let c = x.int.length - y.int.length;
  if (c === 0) c = x.int < y.int ? -1 : x.int > y.int ? 1 : 0;
  if (c === 0) {
    const n = Math.max(x.frac.length, y.frac.length);
    const fx = x.frac.padEnd(n, "0");
    const fy = y.frac.padEnd(n, "0");
    c = fx < fy ? -1 : fx > fy ? 1 : 0;
  }
  return x.neg ? -Math.sign(c) : Math.sign(c);
}

function splitDecimal(t: string): { neg: boolean; int: string; frac: string } {
  const neg = t.startsWith("-");
  const [i = "0", f = ""] = (neg ? t.slice(1) : t).split(".");
  const int = i.replace(/^0+(?=\d)/, "");
  const frac = f.replace(/0+$/, "");
  return { neg: neg && !(int === "0" && frac === ""), int, frac };
}

export function exprToString(e: Expr): string {
  switch (e.k) {
    case "lit":
      return JSON.stringify(e.v);
    case "path":
      return [e.root, ...e.path].join(".");
    case "not":
      return `!${wrap(e.e)}`;
    case "list":
      return `[${e.items.map(exprToString).join(", ")}]`;
    case "call":
      return `${e.fn}(${e.args.map(exprToString).join(", ")})`;
    case "bin":
      return `${wrap(e.l)} ${e.op} ${wrap(e.r)}`;
  }
}
function wrap(e: Expr): string {
  return e.k === "bin" ? `(${exprToString(e)})` : exprToString(e);
}

/** Every path referenced by the expression. */
export function exprPaths(e: Expr): Array<{ root: "viewer" | "args" | "this"; path: string[] }> {
  const out: Array<{ root: "viewer" | "args" | "this"; path: string[] }> = [];
  const walk = (x: Expr): void => {
    switch (x.k) {
      case "path":
        out.push({ root: x.root, path: x.path });
        break;
      case "bin":
        walk(x.l);
        walk(x.r);
        break;
      case "not":
        walk(x.e);
        break;
      case "call":
        x.args.forEach(walk);
        break;
      case "list":
        x.items.forEach(walk);
        break;
      default:
    }
  };
  walk(e);
  return out;
}

export function referencesViewer(e: Expr): boolean {
  return exprPaths(e).some((p) => p.root === "viewer");
}

/**
 * Pushable = can be handed to a data source as a row filter: only viewer/args/literals and
 * top-level scalar fields of `this` (depth 1), no calls except has/len on viewer/args.
 */
export function isPushable(e: Expr): boolean {
  switch (e.k) {
    case "lit":
      return true;
    case "path":
      return e.root !== "this" || e.path.length === 1;
    case "not":
      return isPushable(e.e);
    case "bin":
      return isPushable(e.l) && isPushable(e.r);
    case "list":
      return e.items.every(isPushable);
    case "call":
      return e.fn !== "now" && e.args.every((a) => isPushable(a) && !(a.k === "path" && a.root === "this"));
  }
}
