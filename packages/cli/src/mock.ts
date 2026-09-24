/**
 * A server that answers from the schema alone.
 *
 * Before any resolver exists, a client team needs something to call: `rayfold mock schema.rayfold` serves every
 * operation with data the schema itself describes - enum values, `@range` bounds, `@example` values, the formats the
 * scalars carry, pages with items - so screens can be built against the real wire, shapes and all.
 *
 * The answers are made up, but they are not random: the same call gives the same result, so a screenshot, a test or a
 * demo does not change under you. Nothing here is a substitute for a resolver; it is a stand-in until there is one.
 */
import { annotation, baseName, type ArgDef, type FieldDef, type OpDef, type RayfoldSchemaIR, type TypeDef, type TypeRef } from "@rayfold/schema";
import type { Resolvers } from "@rayfold/server";

export interface MockOptions {
  /** Items in a list or a page when the call does not ask for a number. Default 3. */
  pageSize?: number;
  /** How deep a nested object goes before references stop. Default 4. */
  depth?: number;
}

const WORDS = ["amber", "harbour", "lantern", "meadow", "quartz", "willow", "cinder", "pebble", "thistle", "marrow"];
/** A fixed point in time, so a mock's answers do not drift between runs. */
const EPOCH = Date.UTC(2026, 0, 15, 9, 30, 0);

export function mockResolvers(ir: RayfoldSchemaIR, options: MockOptions = {}): Resolvers {
  const resolvers: Record<string, Record<string, unknown>> = { Query: {}, Command: {}, Stream: {} };

  for (const op of Object.values(ir.ops)) {
    const answer = (args: Record<string, unknown>): unknown => {
      // the call is the seed all the way down: every field seeds from this, so a different call is a different answer
      const call = `${op.name}:${stable(args)}`;
      const value = valueFor(ir, op.returns, call, seeded(call), 0, options, sizeFrom(args, options));
      return op.kind === "command" ? echo(value, args) : value;
    };
    if (op.kind === "query") resolvers["Query"]![op.name] = (args: Record<string, unknown>) => answer(args);
    else if (op.kind === "command") resolvers["Command"]![op.name] = (args: Record<string, unknown>) => answer(args);
    else {
      resolvers["Stream"]![op.name] = async function* (args: Record<string, unknown>) {
        for (let i = 0; i < (options.pageSize ?? 3); i++) {
          yield valueFor(ir, op.returns, `${op.name}:${i}`, seeded(`${op.name}:${i}:${stable(args)}`), 0, options, 1);
        }
      };
    }
  }

  // a field that takes arguments has no value on its parent to fall back to, so it needs a loader of its own
  for (const type of Object.values(ir.types)) {
    if (type.builtin || !("fields" in type)) continue;
    for (const field of type.fields) {
      if (!field.args.length) continue;
      const loaders = (resolvers[type.name] ??= {});
      loaders[field.name] = (parents: Array<Record<string, unknown>>, args: Record<string, unknown>) =>
        parents.map((parent) => {
          const key = `${type.name}.${field.name}:${String(parent["id"] ?? "")}:${stable(args)}`;
          return valueFor(ir, field.type, key, seeded(key), 1, options, sizeFrom(args, options));
        });
    }
  }

  return resolvers as Resolvers;
}

/** `page: { first: n }` decides how many items a page holds, so a caller still controls the size. */
function sizeFrom(args: Record<string, unknown>, options: MockOptions): number {
  const page = args["page"];
  const first = page && typeof page === "object" ? (page as Record<string, unknown>)["first"] : undefined;
  const asked = typeof first === "number" ? first : typeof args["first"] === "number" ? (args["first"] as number) : undefined;
  return Math.max(0, Math.min(asked ?? options.pageSize ?? 3, 50));
}

/** What a command was given comes back in what it returns, so a create looks like what was sent. */
function echo(value: unknown, args: Record<string, unknown>): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out = value as Record<string, unknown>;
  const sources = [args, ...Object.values(args).filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && !Array.isArray(a))];
  for (const source of sources) {
    for (const [key, given] of Object.entries(source)) {
      if (key in out && given !== null && typeof given !== "object") out[key] = given;
    }
  }
  return out;
}

function valueFor(
  ir: RayfoldSchemaIR,
  ref: TypeRef,
  hint: string,
  rng: () => number,
  depth: number,
  options: MockOptions,
  size: number,
): unknown {
  if (ref.kind === "list") {
    const n = depth > (options.depth ?? 4) ? 0 : Math.min(size, 5);
    return Array.from({ length: n }, (_, i) => valueFor(ir, ref.of, `${hint}:${i}`, seeded(`${hint}:${i}`), depth + 1, options, size));
  }
  if (ref.name === "Page" && ref.args?.[0]) {
    const items = Array.from({ length: size }, (_, i) => valueFor(ir, ref.args![0]!, `${hint}:${i}`, seeded(`${hint}:${i}`), depth + 1, options, size));
    return { items, cursor: items.length ? `${hint}:${items.length}` : null, hasMore: false, total: items.length };
  }

  const def = ir.types[ref.name];
  if (!def) return null;
  if (def.kind === "enum") return def.values[Math.floor(rng() * def.values.length)]?.name ?? null;
  if (def.kind === "union") {
    const member = def.members[Math.floor(rng() * def.members.length)];
    return member ? valueFor(ir, { kind: "named", name: member, nullable: false }, hint, rng, depth, options, size) : null;
  }
  if (def.kind === "scalar") return scalar(def.name, hint, rng);

  if (depth > (options.depth ?? 4)) return ref.nullable ? null : {};
  const out: Record<string, unknown> = {};
  if (def.kind === "entity") out["$type"] = def.name;
  for (const field of def.fields) {
    if (field.args.length) continue; // a loader answers that one, with the arguments the caller gave
    out[field.name] = fieldValue(ir, def, field, `${hint}.${field.name}`, depth, options, size);
  }
  return out;
}

function fieldValue(ir: RayfoldSchemaIR, owner: TypeDef, field: FieldDef, hint: string, depth: number, options: MockOptions, size: number): unknown {
  const example = exampleOf(field);
  if (example !== undefined) return example;
  const rng = seeded(hint);
  if (field.name === "id" && baseName(field.type) === "ID") return `${owner.name.toLowerCase()}-${Math.floor(rng() * 900 + 100)}`;
  const range = annotation(field, "range");
  const value = valueFor(ir, field.type, hint, rng, depth + 1, options, size);
  return clamp(value, range?.args["min"], range?.args["max"]);
}

function exampleOf(def: FieldDef | ArgDef | OpDef): unknown {
  const example = annotation(def, "example")?.args["value"];
  // `@example(EBOOK)` and `@example(5m)` are tagged in the IR; the wire carries the enum value and the milliseconds
  if (example && typeof example === "object" && !Array.isArray(example)) {
    if ("$ident" in example) return example.$ident;
    if ("$duration" in example) return example.$duration;
  }
  return example === undefined ? undefined : (example as unknown);
}

function clamp(value: unknown, min: unknown, max: unknown): unknown {
  if (typeof value !== "number") return value;
  const low = typeof min === "number" ? min : undefined;
  const high = typeof max === "number" ? max : undefined;
  return Math.min(high ?? value, Math.max(low ?? value, value));
}

function scalar(name: string, hint: string, rng: () => number): unknown {
  switch (name) {
    case "ID":
      return `${hint.split(/[.:]/)[0] || "id"}-${Math.floor(rng() * 900 + 100)}`;
    case "Int":
      return Math.floor(rng() * 100);
    case "Long":
      return Math.floor(rng() * 1_000_000);
    case "Float":
      return Math.round(rng() * 10_000) / 100;
    case "Decimal":
      return (Math.round(rng() * 10_000) / 100).toFixed(2);
    case "Boolean":
      return rng() > 0.5;
    case "Instant":
      return new Date(EPOCH + Math.floor(rng() * 30) * 86_400_000).toISOString();
    case "Date":
      return new Date(EPOCH + Math.floor(rng() * 30) * 86_400_000).toISOString().slice(0, 10);
    case "Duration":
      return Math.floor(rng() * 60) * 1000;
    case "Bytes":
      return btoa(words(rng, 1));
    case "JSON":
      return {};
    default:
      return words(rng, 2); // a scalar of the schema's own: a word is the most it can assume
  }
}

function words(rng: () => number, count: number): string {
  return Array.from({ length: count }, () => WORDS[Math.floor(rng() * WORDS.length)]!).join(" ");
}

/** The same call gives the same answer: the seed is the call, not the clock. */
function seeded(key: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${k}:${stable((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
