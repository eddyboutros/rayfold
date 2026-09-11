/**
 * Conformance fixture format and the declarative resolver interpreter.
 * Both runtimes (TS, Kotlin) implement this interpreter so fixtures need no code.
 */
import { RayfoldError, ok, type Frame, type PatchOp, type RayfoldContext, type RequestEnvelope, type Resolvers } from "@rayfold/server";

export interface Fixture {
  name: string;
  /** `.rayfold` schema text */
  schema: string;
  /** rows per type name; re-seeded before every case */
  data: Record<string, Array<Record<string, unknown>>>;
  resolvers: {
    Query?: Record<string, QuerySpec>;
    Command?: Record<string, CommandSpec>;
    Stream?: Record<string, StreamSpec>;
    fields?: Record<string, Record<string, FieldSpec>>; // "Type": { "field": spec }
  };
  options?: { budget?: number; maxDepth?: number; trustedShapes?: boolean; registerShapes?: string[] };
  cases: Case[];
}

export interface Case {
  name: string;
  viewer?: unknown;
  request: RequestEnvelope;
  /** Expected frames. Frames of different ops may interleave; per-op order must match. */
  frames: Frame[];
  /** Expected loader call counts, e.g. { "Book.author": 1 } */
  calls?: Record<string, number>;
  /** Run this many times in sequence against the same store (idempotency cases). */
  repeat?: number;
}

/** Value templates: "$args.x.y", "$viewer.id", "$parent.field", "$row.field", literals. */
type Tmpl = unknown;

export interface QuerySpec {
  from: string;
  where?: Record<string, Tmpl>;
  /** "one" returns the first match or null; "page" returns a Page from $args.page; "list" returns all matches */
  mode: "one" | "page" | "list";
  pageArg?: string; // default "page"
}

export interface FieldSpec {
  from: string;
  /** parent field to match against row field: parent[key] == row[match] */
  key: string;
  match: string;
  mode: "one" | "page" | "list";
  pageArg?: string;
}

export interface CommandSpec {
  /** conditions evaluated in order; the first one that matches throws */
  fail?: Array<{ when: { field: string; op: "lt" | "eq" | "missing"; value?: Tmpl; from?: string; where?: Record<string, Tmpl> }; type?: string; code?: string; data?: Record<string, Tmpl>; message?: string }>;
  insert?: { into: string; row: Record<string, Tmpl>; idPrefix?: string };
  /** `merge` copies the keys present in a template object (partial updates); `version` names a @version field to check and bump */
  update?: { table: string; where: Record<string, Tmpl>; set?: Record<string, Tmpl | { $add: Tmpl } | { $sub: Tmpl }>; merge?: Tmpl; version?: string };
  /** which row to return: "inserted" | "updated" */
  returns: "inserted" | "updated";
  patch?: PatchOp[];
  emit?: Array<{ event: string; payload: Record<string, Tmpl> }>;
}

export interface StreamSpec {
  /** yields these items in order, then ends */
  items: Array<Record<string, unknown>>;
}

export interface FixtureStore {
  tables: Record<string, Array<Record<string, unknown>>>;
  calls: Record<string, number>;
  nextId: number;
}

export function seedStore(f: Fixture): FixtureStore {
  return { tables: structuredClone(f.data), calls: {}, nextId: 1 };
}

function tmpl(v: Tmpl, env: { args?: unknown; viewer?: unknown; parent?: unknown; row?: unknown }): unknown {
  if (typeof v === "string" && v.startsWith("$")) {
    const [root, ...path] = v.slice(1).split(".");
    let cur: unknown = (env as Record<string, unknown>)[root!];
    for (const p of path) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
    return cur === undefined ? null : cur;
  }
  if (Array.isArray(v)) return v.map((x) => tmpl(x, env));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = tmpl(x, env);
    return o;
  }
  return v;
}

function matches(row: Record<string, unknown>, where: Record<string, Tmpl> | undefined, env: Parameters<typeof tmpl>[1]): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    const want = tmpl(v, env);
    return want === null ? true : String(row[k]) === String(want);
  });
}

function page(rows: Array<Record<string, unknown>>, p: { first: number; after: string | null } | undefined) {
  const first = p?.first ?? 20;
  let start = 0;
  if (p?.after) {
    const i = rows.findIndex((r) => String(r["id"]) === p.after);
    start = i < 0 ? rows.length : i + 1;
  }
  const items = rows.slice(start, start + first);
  return { items, cursor: items.length ? String(items[items.length - 1]!["id"]) : null, hasMore: start + first < rows.length, total: rows.length };
}

function count(store: FixtureStore, k: string): void {
  store.calls[k] = (store.calls[k] ?? 0) + 1;
}

export function fixtureResolvers(f: Fixture, store: FixtureStore): Resolvers {
  const r: Resolvers = { Query: {}, Command: {}, Stream: {} };
  const table = (name: string) => store.tables[name] ?? (store.tables[name] = []);

  for (const [name, spec] of Object.entries(f.resolvers.Query ?? {})) {
    r.Query![name] = (args: Record<string, unknown>, ctx: RayfoldContext<never>) => {
      count(store, `Query.${name}`);
      const env = { args, viewer: ctx.viewer };
      const rows = table(spec.from).filter((row) => matches(row, spec.where, env));
      if (spec.mode === "one") return rows[0] ?? null;
      if (spec.mode === "list") return rows;
      return page(rows, args[spec.pageArg ?? "page"] as never);
    };
  }
  for (const [type, fields] of Object.entries(f.resolvers.fields ?? {})) {
    r[type] = {};
    for (const [field, spec] of Object.entries(fields)) {
      r[type]![field] = ((parents: Array<Record<string, unknown>>, args: Record<string, unknown>) => {
        count(store, `${type}.${field}`);
        const rows = table(spec.from);
        return parents.map((p) => {
          const hits = rows.filter((row) => String(row[spec.match]) === String(p[spec.key]));
          if (spec.mode === "one") return hits[0] ?? null;
          if (spec.mode === "list") return hits;
          return page(hits, args[spec.pageArg ?? "page"] as never);
        });
      }) as never;
    }
  }
  for (const [name, spec] of Object.entries(f.resolvers.Command ?? {})) {
    r.Command![name] = (args: Record<string, unknown>, ctx: RayfoldContext<never>) => {
      count(store, `Command.${name}`);
      const env = { args, viewer: ctx.viewer };
      for (const fail of spec.fail ?? []) {
        const w = fail.when;
        let subject: Record<string, unknown> | undefined;
        if (w.from) subject = table(w.from).find((row) => matches(row, w.where, env));
        const actual = subject ? subject[w.field] : tmpl(`$args.${w.field}`, env);
        const want = tmpl(w.value, { ...env, row: subject });
        const hit = w.op === "missing" ? subject === undefined : w.op === "eq" ? String(actual) === String(want) : Number(actual) < Number(want);
        if (hit) {
          const data = tmpl(fail.data ?? {}, { ...env, row: subject }) as Record<string, unknown>;
          if (fail.type) throw RayfoldError.domain(fail.type, data, fail.message ?? fail.type);
          throw new RayfoldError((fail.code ?? "failed_precondition") as never, fail.message ?? fail.code ?? "failed");
        }
      }
      let inserted: Record<string, unknown> | undefined;
      let updated: Record<string, unknown> | undefined;
      if (spec.update) {
        updated = table(spec.update.table).find((row) => matches(row, spec.update!.where, env));
        if (!updated) throw new RayfoldError("not_found", "row not found");
        const vf = spec.update.version;
        if (vf) ctx.checkVersion(`${spec.update.table}:${String(updated["id"])}`, updated[vf], { ...updated });
        const target = ctx.simulate ? { ...updated } : updated;
        if (spec.update.merge !== undefined) {
          const src = tmpl(spec.update.merge, env);
          if (src && typeof src === "object" && !Array.isArray(src)) Object.assign(target, src);
        }
        if (vf) target[vf] = Number(target[vf]) + 1;
        for (const [k, v] of Object.entries(spec.update.set ?? {})) {
          if (v && typeof v === "object" && "$add" in (v as object)) target[k] = Number(target[k]) + Number(tmpl((v as { $add: Tmpl }).$add, env));
          else if (v && typeof v === "object" && "$sub" in (v as object)) target[k] = Number(target[k]) - Number(tmpl((v as { $sub: Tmpl }).$sub, env));
          else target[k] = tmpl(v, env);
        }
        updated = target;
      }
      if (spec.insert) {
        inserted = { id: `${spec.insert.idPrefix ?? "n"}${store.nextId++}`, ...(tmpl(spec.insert.row, env) as Record<string, unknown>) };
        if (!ctx.simulate) table(spec.insert.into).push(inserted);
      }
      const result = spec.returns === "inserted" ? inserted : updated;
      const rowEnv = { ...env, row: result };
      const extra: { patch?: PatchOp[]; emit?: Array<{ event: string; payload: Record<string, unknown> }> } = {};
      if (spec.patch) extra.patch = tmpl(spec.patch, rowEnv) as PatchOp[];
      if (spec.emit) extra.emit = spec.emit.map((e) => ({ event: e.event, payload: tmpl(e.payload, rowEnv) as Record<string, unknown> }));
      return ok(result, extra);
    };
  }
  for (const [name, spec] of Object.entries(f.resolvers.Stream ?? {})) {
    r.Stream![name] = () => {
      count(store, `Stream.${name}`);
      return (async function* () {
        for (const it of spec.items) yield it;
      })();
    };
  }
  return r;
}

/** Group frames by op id (batch-level frames under key "batch"), preserving per-op order. */
export function groupFrames(frames: Frame[]): Record<string, Frame[]> {
  const out: Record<string, Frame[]> = {};
  for (const f of frames) {
    const k = "id" in f ? String(f.id) : "batch";
    (out[k] ??= []).push(f);
  }
  return out;
}
