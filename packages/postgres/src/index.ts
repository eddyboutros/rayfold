/**
 * Postgres for Rayfold resolvers: batch loads by id, keyset pages, one-to-many pages for a whole level in one query,
 * and read policies pushed into the SQL `WHERE` (spec 06 §4), so a list never fetches rows its viewer may not see.
 *
 * Works with any client that has `query(text, params)`: pg's `Pool` and `Client`, PGlite, or a wrapper of your own.
 * Every value travels as a bound parameter and every identifier is quoted.
 *
 * The pushed-down filter is a superset of the policy: it may let through a row the policy denies (the runtime's own
 * check then removes it), but it never drops a row the policy allows. Comparisons it cannot translate exactly, such as
 * ordering text or comparing across types, are left to the runtime.
 */
import { evalExpr, type Expr, type ExprEnv, type FieldDef, type RayfoldSchemaIR } from "@rayfold/schema";

/** Anything with pg's `query(text, params)`: `pg.Pool`, `pg.Client`, `PGlite`. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface TableMapping {
  /** The table, optionally schema-qualified (`"public.books"`). */
  table: string;
  /** The key column; default `"id"`. Pages are ordered by it. */
  id?: string;
  /** Field name to column name, for fields whose column is named otherwise (after `naming`). */
  columns?: Record<string, string>;
}

export interface PgStoreOptions {
  ir: RayfoldSchemaIR;
  /** One mapping per entity type the store serves. */
  tables: Record<string, TableMapping>;
  /** How field names become column names when `columns` does not say: as they are (default) or snake_case. */
  naming?: "same" | "snake";
}

/** What the store needs from a resolver's context: the viewer and the read policy the runtime pushed down (`ctx.policy`). */
export interface PolicyContext {
  viewer?: unknown;
  policy?: { filter?: Expr };
  now?: () => number;
}

export type Row = Record<string, unknown>;
export interface Page<T = Row> { items: T[]; cursor: string | null; hasMore: boolean; total: number }
export interface PageRequest { first: number; after?: string | null }

/** A SQL fragment with its parameters numbered from 1. */
export interface Fragment { sql: string; exact: boolean }

export function createPgStore(db: Queryable, opts: PgStoreOptions): PgStore {
  return new PgStore(db, opts);
}

interface Table { name: string; id: string; idField: string; column(field: string): string | undefined; field(column: string): string; def: { name: string; fields: FieldDef[] } }

export class PgStore {
  private readonly tables = new Map<string, Table>();

  constructor(private readonly db: Queryable, private readonly opts: PgStoreOptions) {
    for (const [type, m] of Object.entries(opts.tables)) {
      const def = opts.ir.types[type];
      if (!def || !("fields" in def)) throw new Error(`@rayfold/postgres: ${type} is not an entity or object of the schema`);
      const columns = new Map<string, string>();
      for (const f of def.fields) columns.set(f.name, m.columns?.[f.name] ?? (opts.naming === "snake" ? snake(f.name) : f.name));
      for (const [f, c] of Object.entries(m.columns ?? {})) columns.set(f, c);
      const id = m.id ?? "id";
      const idField = [...columns].find(([, c]) => c === id)?.[0] ?? "id";
      const fields = new Map([...columns].map(([f, c]) => [c, f]));
      this.tables.set(type, {
        name: m.table.split(".").map(quote).join("."),
        id: quote(id),
        idField,
        column: (f) => (columns.has(f) ? quote(columns.get(f)!) : undefined),
        field: (c) => fields.get(c) ?? c,
        def: { name: def.name, fields: def.fields },
      });
    }
  }

  /**
   * Rows of `type` for `ids`, in the order asked: `null` where a row is missing or hidden by the pushed-down read policy.
   * One query for any number of ids, which makes it the batch loader for a to-one field.
   */
  async byIds(type: string, ids: readonly unknown[], ctx: PolicyContext = {}, args: Record<string, unknown> = {}): Promise<Array<Row | null>> {
    if (!ids.length) return [];
    const t = this.table(type);
    const params: unknown[] = [[...new Set(ids.filter((x) => x !== null && x !== undefined).map(String))]];
    const where = [`${t.id}::text = ANY($1::text[])`, ...this.policyWhere(t, ctx, args, params)];
    const rows = await this.select(t, `SELECT * FROM ${t.name} WHERE ${where.join(" AND ")}`, params);
    const byId = new Map(rows.map((r) => [String(r[t.idField]), r]));
    return ids.map((id) => (id === null || id === undefined ? null : (byId.get(String(id)) ?? null)));
  }

  /** Rows of `type` whose fields equal `where` (a `null` value matches NULL), in key order. One query. */
  async find(type: string, where: Record<string, unknown> = {}, ctx: PolicyContext = {}, args: Record<string, unknown> = {}): Promise<Row[]> {
    const t = this.table(type);
    const params: unknown[] = [];
    const conds = [...this.equalities(t, where, params), ...this.policyWhere(t, ctx, args, params)];
    return this.select(t, `SELECT * FROM ${t.name}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""} ORDER BY ${t.id}`, params);
  }

  /**
   * One page of `type` in key order, after `page.after` (a key), with `total` counting every visible matching row.
   * One query; a second one counts only when the page comes back empty.
   */
  async page(type: string, page: PageRequest, where: Record<string, unknown> = {}, ctx: PolicyContext = {}, args: Record<string, unknown> = {}): Promise<Page> {
    const t = this.table(type);
    const params: unknown[] = [];
    const conds = [...this.equalities(t, where, params), ...this.policyWhere(t, ctx, args, params)];
    const filtered = `SELECT *, count(*) OVER () AS "__total" FROM ${t.name}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}`;
    let after = "";
    if (page.after) {
      params.push(page.after);
      after = ` WHERE "__s".${t.id}::text > $${params.length}::text`;
    }
    params.push(page.first + 1);
    const raw = (await this.db.query<Row>(`SELECT * FROM (${filtered}) AS "__s"${after} ORDER BY "__s".${t.id}::text LIMIT $${params.length}`, params)).rows;
    let total = raw.length ? Number(raw[0]!["__total"]) : 0;
    if (!raw.length && page.after) {
      const count = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t.name}${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}`, params.slice(0, params.length - 2));
      total = Number(count.rows[0]?.n ?? 0);
    }
    const rows = raw.map((r) => this.row(t, r));
    const items = rows.slice(0, page.first);
    return { items, cursor: items.length ? String(items[items.length - 1]![t.idField]) : null, hasMore: rows.length > page.first, total };
  }

  /**
   * For each parent key in `values`, the page of `type` rows whose `field` equals it: the batch loader for a paged
   * one-to-many field (an author's books). One query for the whole level, whatever the number of parents.
   */
  async pagesByField(type: string, field: string, values: readonly unknown[], page: PageRequest, ctx: PolicyContext = {}, args: Record<string, unknown> = {}): Promise<Page[]> {
    if (!values.length) return [];
    const t = this.table(type);
    const col = t.column(field);
    if (!col) throw new Error(`@rayfold/postgres: ${type} has no field ${field}`);
    const params: unknown[] = [[...new Set(values.map(String))]];
    const conds = [`${col}::text = ANY($1::text[])`, ...this.policyWhere(t, ctx, args, params)];
    let after = "";
    if (page.after) {
      params.push(page.after);
      after = ` AND "__s".${t.id}::text > $${params.length}::text`;
    }
    params.push(page.first + 1);
    const sql =
      `SELECT * FROM (SELECT *, count(*) OVER (PARTITION BY ${col}) AS "__total", ` +
      `row_number() OVER (PARTITION BY ${col} ORDER BY ${t.id}::text) AS "__n" FROM ${t.name} WHERE ${conds.join(" AND ")}) AS "__s" ` +
      `WHERE TRUE${after} ORDER BY "__s".${t.id}::text`;
    const raw = (await this.db.query<Row>(sql, params.slice(0, -1))).rows;
    const groups = new Map<string, { rows: Row[]; total: number }>();
    for (const r of raw) {
      const key = String(r[col.slice(1, -1).replace(/""/g, '"')]);
      const g = groups.get(key) ?? { rows: [], total: Number(r["__total"]) };
      g.rows.push(this.row(t, r));
      groups.set(key, g);
    }
    return values.map((v) => {
      const g = groups.get(String(v));
      if (!g) return { items: [], cursor: null, hasMore: false, total: 0 };
      const items = g.rows.slice(0, page.first);
      return { items, cursor: items.length ? String(items[items.length - 1]![t.idField]) : null, hasMore: g.rows.length > page.first, total: g.total };
    });
  }

  /** The WHERE fragment for the read policy the runtime pushed down, or nothing when there is none to push. */
  private policyWhere(t: Table, ctx: PolicyContext, args: Record<string, unknown>, params: unknown[]): string[] {
    const filter = ctx.policy?.filter;
    if (!filter) return [];
    const env: ExprEnv = { viewer: ctx.viewer ?? null, args, this: null, ...(ctx.now ? { now: ctx.now } : {}) };
    const f = compilePolicy(filter, env, (name) => {
      const col = t.column(name);
      const def = t.def.fields.find((x) => x.name === name);
      return col && def && def.type.kind === "named" ? { column: col, scalar: this.scalarOf(def.type.name) } : undefined;
    }, params);
    return f.sql === "TRUE" ? [] : [f.sql];
  }

  private equalities(t: Table, where: Record<string, unknown>, params: unknown[]): string[] {
    return Object.entries(where).map(([f, v]) => {
      const col = t.column(f);
      if (!col) throw new Error(`@rayfold/postgres: ${t.def.name} has no field ${f}`);
      if (v === null || v === undefined) return `${col} IS NULL`;
      params.push(v);
      return `${col} = $${params.length}`;
    });
  }

  private async select(t: Table, sql: string, params: unknown[]): Promise<Row[]> {
    return (await this.db.query<Row>(sql, params)).rows.map((r) => this.row(t, r));
  }

  private row(t: Table, r: Row): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) if (k !== "__total" && k !== "__n") out[t.field(k)] = v;
    return out;
  }

  private table(type: string): Table {
    const t = this.tables.get(type);
    if (!t) throw new Error(`@rayfold/postgres: no table mapped for ${type}`);
    return t;
  }

  private scalarOf(name: string): string {
    const def = this.opts.ir.types[name];
    return def?.kind === "enum" ? "String" : name;
  }
}

// ---------------------------------------------------------------- policies to SQL

/** A column a policy may read, with the Rayfold scalar type of its field. */
export interface PolicyColumn { column: string; scalar: string }

const LOOSE: Fragment = { sql: "TRUE", exact: false };
const constant = (b: boolean): Fragment => ({ sql: b ? "TRUE" : "FALSE", exact: true });
const TEXT = new Set(["String", "ID"]);
const NUMBER = new Set(["Int", "Float"]);
const DECIMAL = new Set(["Decimal", "Long"]);
const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * Translates a pushable read policy (spec 06 §4) into a WHERE fragment under `env` (the viewer and args), appending
 * its values to `params`. Parts that read no field of the row are evaluated here, as the runtime would. `exact` is true
 * when the fragment selects exactly the rows the policy allows; otherwise it selects more, never fewer.
 */
export function compilePolicy(e: Expr, env: ExprEnv, columnOf: (field: string) => PolicyColumn | undefined, params: unknown[]): Fragment {
  if (!readsRow(e)) {
    try {
      return constant(truthy(evalExpr(e, env)));
    } catch {
      return LOOSE; // an expression that cannot be evaluated denies, but maybe only where it is reached: leave it to the runtime
    }
  }
  switch (e.k) {
    case "path": {
      const c = e.path.length === 1 ? columnOf(e.path[0]!) : undefined;
      if (!c) return LOOSE;
      return { sql: c.scalar === "Boolean" ? `(${c.column} IS TRUE)` : `(${c.column} IS NOT NULL)`, exact: true };
    }
    case "not": {
      const f = compilePolicy(e.e, env, columnOf, params);
      // negating a superset would give a subset, so only an exact fragment can be negated
      return f.exact ? { sql: `(NOT ${f.sql})`, exact: true } : LOOSE;
    }
    case "bin": {
      if (e.op === "&&" || e.op === "||") {
        const l = compilePolicy(e.l, env, columnOf, params);
        const r = compilePolicy(e.r, env, columnOf, params);
        return { sql: `(${l.sql} ${e.op === "&&" ? "AND" : "OR"} ${r.sql})`, exact: l.exact && r.exact };
      }
      const left = rowField(e.l);
      const right = rowField(e.r);
      if ((left === undefined) === (right === undefined)) return LOOSE; // both sides read the row, or neither is a plain field
      const field = (left ?? right)!;
      const other = left !== undefined ? e.r : e.l;
      if (readsRow(other)) return LOOSE;
      const c = columnOf(field);
      if (!c) return LOOSE;
      let v: unknown;
      try {
        v = evalExpr(other, env);
      } catch {
        return LOOSE;
      }
      const op = left !== undefined ? e.op : flip(e.op);
      return compare(c, op, v, params);
    }
    default:
      return LOOSE;
  }
}

function compare(c: PolicyColumn, op: string, v: unknown, params: unknown[]): Fragment {
  const add = (x: unknown) => `$${params.push(x)}`;
  if (op === "in") {
    if (!Array.isArray(v)) return constant(false);
    if (!v.every((x) => kindMatches(c.scalar, x))) return LOOSE;
    if (TEXT.has(c.scalar)) return { sql: `COALESCE(${c.column}::text = ANY(${add(v.map(String))}::text[]), FALSE)`, exact: true };
    if (NUMBER.has(c.scalar)) return { sql: `COALESCE(${c.column} = ANY(${add(v)}::numeric[]), FALSE)`, exact: true };
    return LOOSE;
  }
  if (op === "==" || op === "!=") {
    if (v === null || v === undefined) return { sql: `(${c.column} IS ${op === "==" ? "" : "NOT "}NULL)`, exact: true };
    if (!kindMatches(c.scalar, v)) return LOOSE;
    const not = op === "==" ? "NOT " : "";
    if (TEXT.has(c.scalar)) return { sql: `(${c.column}::text IS ${not}DISTINCT FROM ${add(String(v))}::text)`, exact: true };
    if (NUMBER.has(c.scalar)) return { sql: `(${c.column} IS ${not}DISTINCT FROM ${add(v)}::numeric)`, exact: true };
    if (c.scalar === "Boolean") return { sql: `(${c.column} IS ${not}DISTINCT FROM ${add(v)}::boolean)`, exact: true };
    // Decimal and Long travel as text: SQL compares by value, the runtime may compare the text, so equality selects
    // more rows than the policy and inequality could select fewer; only equality is pushed
    if (DECIMAL.has(c.scalar) && op === "==") return { sql: `(${c.column} = ${add(String(v))}::numeric)`, exact: false };
    return LOOSE;
  }
  if (["<", "<=", ">", ">="].includes(op) && typeof v === "number" && NUMBER.has(c.scalar)) {
    return { sql: `COALESCE(${c.column} ${op} ${add(v)}::numeric, FALSE)`, exact: true };
  }
  return LOOSE;
}

/** Whether `v` is a value the runtime could find equal to a field of this scalar type. */
function kindMatches(scalar: string, v: unknown): boolean {
  if (TEXT.has(scalar)) return typeof v === "string";
  if (NUMBER.has(scalar)) return typeof v === "number" && Number.isFinite(v);
  if (scalar === "Boolean") return typeof v === "boolean";
  if (DECIMAL.has(scalar)) return (typeof v === "string" && DECIMAL_TEXT.test(v)) || (typeof v === "number" && Number.isFinite(v));
  return false;
}

function flip(op: string): string {
  return op === "<" ? ">" : op === ">" ? "<" : op === "<=" ? ">=" : op === ">=" ? "<=" : op;
}

/** The field name when `e` is `this.<field>`. */
function rowField(e: Expr): string | undefined {
  return e.k === "path" && e.root === "this" && e.path.length === 1 ? e.path[0] : undefined;
}

function readsRow(e: Expr): boolean {
  switch (e.k) {
    case "lit":
      return false;
    case "path":
      return e.root === "this";
    case "not":
      return readsRow(e.e);
    case "bin":
      return readsRow(e.l) || readsRow(e.r);
    case "list":
      return e.items.some(readsRow);
    case "call":
      return e.args.some(readsRow);
  }
}

function truthy(v: unknown): boolean {
  return v !== null && v !== undefined && v !== false;
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function snake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
