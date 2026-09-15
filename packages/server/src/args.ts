/** Argument validation and coercion at the system boundary. */
import { typeRefToString, type Annotation, type ArgDef, type FieldDef, type RayfoldSchemaIR, type TypeRef } from "@rayfold/schema";
import { RayfoldError } from "./protocol.ts";

const MAX_PAGE_FIRST = 200;
const NUMERIC = new Set(["Int", "Long", "Float", "Decimal"]);

export function coerceArgs(ir: RayfoldSchemaIR, defs: ArgDef[], raw: unknown, path: string): Record<string, unknown> {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new RayfoldError("invalid_argument", `${path}: expected an object`);
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(input)) {
    if (!defs.some((d) => d.name === k)) throw new RayfoldError("invalid_argument", `${path}.${k}: unknown argument`);
  }
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const v = input[d.name];
    const p = `${path}.${d.name}`;
    if (v === undefined) {
      if (d.default !== undefined) {
        out[d.name] = coerceValue(ir, d.type, d.default, p);
        continue;
      }
      if (!d.type.nullable) throw new RayfoldError("invalid_argument", `${p}: required`);
      continue; // absent stays absent: partial updates (PATCH) depend on the difference from null
    }
    if (v === null) {
      // An explicit null is never replaced by the default: the caller asked for null.
      if (!d.type.nullable) throw new RayfoldError("invalid_argument", d.default === undefined ? `${p}: required` : `${p}: must not be null`);
      out[d.name] = null;
      continue;
    }
    out[d.name] = coerceValue(ir, d.type, v, p);
    checkConstraints(d.annotations, d.type, out[d.name], p);
  }
  return out;
}

/**
 * Declarative value constraints from the schema (spec 01 section 4): `@range(min, max)` on numbers and
 * on string/list lengths. Enforced before any resolver runs, so a bad value never causes a side effect.
 */
export function checkConstraints(annotations: Annotation[], t: TypeRef, v: unknown, path: string): void {
  if (v === null || v === undefined) return;
  const range = annotations.find((a) => a.name === "range");
  if (range) {
    const min = typeof range.args["min"] === "number" ? range.args["min"] : undefined;
    const max = typeof range.args["max"] === "number" ? range.args["max"] : undefined;
    // The declared type decides: a String "1984" is four characters long, a Decimal "10.50" is a value.
    const n =
      t.kind === "list" ? (Array.isArray(v) ? v.length : undefined)
      : NUMERIC.has(t.name) ? (typeof v === "number" ? v : typeof v === "string" ? Number(v) : undefined)
      : typeof v === "string" ? v.length
      : undefined;
    if (n !== undefined) {
      if (min !== undefined && n < min) throw new RayfoldError("invalid_argument", `${path}: must be >= ${min}`);
      if (max !== undefined && n > max) throw new RayfoldError("invalid_argument", `${path}: must be <= ${max}`);
    }
  }
  const fmt = annotations.find((a) => a.name === "format");
  const pattern = fmt?.args["pattern"];
  if (typeof pattern === "string" && typeof v === "string" && !new RegExp(pattern).test(v)) throw new RayfoldError("invalid_argument", `${path}: must match ${pattern}`);
}

export function coerceValue(ir: RayfoldSchemaIR, t: TypeRef, v: unknown, path: string): unknown {
  if (v === null || v === undefined) {
    if (t.nullable) return null;
    throw new RayfoldError("invalid_argument", `${path}: must not be null`);
  }
  if (t.kind === "list") {
    if (!Array.isArray(v)) throw new RayfoldError("invalid_argument", `${path}: expected a list`);
    return v.map((x, i) => coerceValue(ir, t.of, x, `${path}.${i}`));
  }
  const def = ir.types[t.name];
  if (!def) throw new RayfoldError("internal", `${path}: unknown type ${t.name}`);
  switch (def.kind) {
    case "scalar":
      return coerceScalar(t.name, v, path);
    case "enum":
      if (typeof v !== "string" || !def.values.some((x) => x.name === v)) {
        throw new RayfoldError("invalid_argument", `${path}: expected one of ${def.values.map((x) => x.name).join(", ")}`);
      }
      return v;
    case "input": {
      if (typeof v !== "object" || Array.isArray(v)) throw new RayfoldError("invalid_argument", `${path}: expected ${t.name}`);
      const obj = coerceArgs(ir, def.fields.map(fieldAsArg), v, path);
      if (t.name === "PageArgs") {
        const first = obj["first"];
        if (typeof first === "number" && first > MAX_PAGE_FIRST) obj["first"] = MAX_PAGE_FIRST;
        if (typeof first === "number" && first < 0) throw new RayfoldError("invalid_argument", `${path}.first: must be >= 0`);
        const offset = obj["offset"];
        if (typeof offset === "number" && offset < 0) throw new RayfoldError("invalid_argument", `${path}.offset: must be >= 0`);
      }
      return obj;
    }
    default:
      throw new RayfoldError("invalid_argument", `${path}: ${typeRefToString(t)} is not an input type`);
  }
}

function fieldAsArg(f: FieldDef): ArgDef {
  const a: ArgDef = { name: f.name, type: f.type, annotations: f.annotations };
  if (f.default !== undefined) a.default = f.default;
  return a;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

export function coerceScalar(name: string, v: unknown, path: string): unknown {
  const bad = (want: string): never => {
    throw new RayfoldError("invalid_argument", `${path}: expected ${want}`);
  };
  switch (name) {
    case "ID":
      if (typeof v === "string" && v.length > 0) return v;
      if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
      return bad("ID");
    case "String":
      return typeof v === "string" ? v : bad("String");
    case "Int":
      return typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= 2_147_483_647 ? v : bad("Int");
    case "Long":
      if (typeof v === "number" && Number.isSafeInteger(v)) return v; // larger values lose digits as JSON numbers: send them as text
      if (typeof v === "string" && /^-?\d+$/.test(v)) return v;
      return bad("Long");
    case "Float":
      return typeof v === "number" && Number.isFinite(v) ? v : bad("Float");
    case "Boolean":
      return typeof v === "boolean" ? v : bad("Boolean");
    case "Decimal":
      if (typeof v === "string" && DECIMAL.test(v)) return v;
      if (typeof v === "number" && Number.isFinite(v) && DECIMAL.test(String(v))) return String(v); // 1e21 would become "1e+21"
      return bad("Decimal");
    case "Instant":
      return typeof v === "string" && RFC3339.test(v) ? v : bad("Instant (RFC 3339)");
    case "Date":
      return typeof v === "string" && DATE.test(v) ? v : bad("Date (YYYY-MM-DD)");
    case "Duration":
      if (typeof v === "number" && v >= 0) return v;
      if (typeof v === "string" && /^\d+(ms|s|m|h|d)$/.test(v)) return v;
      return bad("Duration");
    case "Bytes":
      return typeof v === "string" && /^[A-Za-z0-9_-]*$/.test(v) ? v : bad("Bytes (base64url)");
    case "JSON":
      return v;
    default:
      // user-defined scalar: accept any JSON scalar
      return typeof v === "object" ? bad(`scalar ${name}`) : v;
  }
}

/** Replace `{ "$ref": "id.path" }` objects with values from earlier results. Spec 03 §2. */
export function resolveRefs(value: unknown, lookup: (opId: number, path: string[]) => unknown, at: string): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((x, i) => resolveRefs(x, lookup, `${at}.${i}`));
  const obj = value as Record<string, unknown>;
  const ref = obj["$ref"];
  if (typeof ref === "string" && Object.keys(obj).length === 1) {
    const [idText, ...path] = ref.split(".");
    const id = Number(idText);
    if (!Number.isInteger(id) || id <= 0) throw new RayfoldError("invalid_argument", `${at}: bad $ref ${JSON.stringify(ref)}`);
    const v = lookup(id, path);
    if (v === undefined) throw new RayfoldError("invalid_argument", `${at}: $ref ${ref} resolved to nothing`);
    return v;
  }
  const out: Record<string, unknown> = {};
  // an own property, as JSON.parse made it: assigning "__proto__" would replace the copy's prototype and smuggle in arguments
  for (const [k, v] of Object.entries(obj)) Object.defineProperty(out, k, { value: resolveRefs(v, lookup, `${at}.${k}`), enumerable: true, writable: true, configurable: true });
  return out;
}

/** Ids of ops referenced by `$ref` anywhere inside `value`. */
export function collectRefs(value: unknown, out = new Set<number>()): Set<number> {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((x) => collectRefs(x, out));
    return out;
  }
  const obj = value as Record<string, unknown>;
  const ref = obj["$ref"];
  if (typeof ref === "string" && Object.keys(obj).length === 1) {
    out.add(Number(ref.split(".")[0]));
    return out;
  }
  for (const v of Object.values(obj)) collectRefs(v, out);
  return out;
}

export function getPath(value: unknown, path: string[]): unknown {
  let cur = value;
  for (const p of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      cur = cur[Number(p)];
      continue;
    }
    // own data only: "__proto__", "constructor" and friends are never reachable through a $ref path
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
