/**
 * Idempotency records in Postgres, so several servers share them: a retry that lands on another server is answered
 * with the first attempt's result, and two servers never run the same command (spec 03 §4, spec 12 §4.4).
 *
 * `claim` is one statement, so of two servers asking at the same moment exactly one takes the key. The owner renews
 * its lease while the command runs; if that server stops, the lease runs out and the next retry takes the key over.
 *
 * Create the table once with `idempotencySchema()`, or run the same SQL in your migrations.
 */
import type { IdempotencyClaim, IdempotencyRecord, IdempotencyStore } from "@rayfold/server/core";
import { ensure } from "./ddl.ts";
import type { Queryable } from "./index.ts";

export interface PgIdempotencyOptions {
  /** Default `rayfold_idempotency`. Quoted as written, so keep it a plain identifier or schema-qualify it yourself. */
  table?: string;
  /** How long a record answers retries. Default 24 hours, the minimum the spec asks for. */
  ttlMs?: number;
  /** Most records kept; past it the oldest go first. Default 100000. */
  maxRecords?: number;
  /** Wall clock, injectable for tests. */
  now?: () => number;
}

/**
 * The table this store reads and writes. Times are milliseconds since the epoch, from the server's own clock.
 *
 * `JdbcIdempotencyStore` creates the same columns, so a fleet may hold servers of both runtimes: whichever starts
 * first creates the table and the other goes on using it. The frames are text rather than `jsonb` for that reason -
 * the JVM store binds them as strings, and one definition has to work on both.
 */
export function idempotencySchema(table = "rayfold_idempotency"): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    "  scope text NOT NULL,",
    "  key text NOT NULL,",
    "  args_hash text,",
    "  frame text,",
    "  compact_frame text,",
    "  token text,",
    "  held_until bigint,",
    "  at bigint NOT NULL,",
    "  PRIMARY KEY (scope, key)",
    ");",
    `CREATE INDEX IF NOT EXISTS ${table.replace(/[^A-Za-z0-9_]/g, "_")}_at ON ${table} (at) WHERE frame IS NOT NULL;`,
  ].join("\n");
}

interface Row {
  args_hash: string | null;
  frame: unknown;
  compact_frame: unknown;
  token: string | null;
  held_until: string | number | null;
  at: string | number;
}

const ms = (v: string | number | null): number => (v === null ? 0 : typeof v === "number" ? v : Number(v));

/** A frame as stored: text from this store and the JVM's, already parsed from a `jsonb` column made by an older one. */
const frameOf = (stored: unknown): unknown => (typeof stored === "string" ? JSON.parse(stored) : stored);

export class PgIdempotencyStore implements IdempotencyStore {
  private readonly table: string;
  private readonly ttlMs: number;
  private readonly maxRecords: number;
  private readonly now: () => number;
  private puts = 0;

  constructor(
    private readonly sql: Queryable,
    opts: PgIdempotencyOptions = {},
  ) {
    this.table = opts.table ?? "rayfold_idempotency";
    this.ttlMs = opts.ttlMs ?? 24 * 3_600_000;
    this.maxRecords = opts.maxRecords ?? 100_000;
    this.now = opts.now ?? Date.now;
  }

  /** Creates the table and index if they are not there yet. Safe to call from every server as it starts. */
  async migrate(): Promise<void> {
    for (const statement of idempotencySchema(this.table).split(";\n")) {
      const text = statement.trim().replace(/;$/, "");
      if (text) await ensure(this.sql, text);
    }
  }

  private record(row: Row): IdempotencyRecord {
    const record: IdempotencyRecord = { argsHash: row.args_hash ?? "", frame: frameOf(row.frame), at: ms(row.at) };
    if (row.compact_frame !== null && row.compact_frame !== undefined) record.compactFrame = frameOf(row.compact_frame);
    return record;
  }

  async get(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
    const fresh = this.now() - this.ttlMs;
    const { rows } = await this.sql.query<Row>(
      `SELECT args_hash, frame, compact_frame, token, held_until, at FROM ${this.table} WHERE scope = $1 AND key = $2 AND frame IS NOT NULL AND at >= $3`,
      [scope, key, fresh],
    );
    return rows[0] ? this.record(rows[0]) : undefined;
  }

  async claim(scope: string, key: string, leaseMs: number): Promise<IdempotencyClaim> {
    const t = this.now();
    const token = `${t.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    // One statement decides it: the row is inserted when the key is free, and taken over when the claim on it ran out
    // or its record is past the TTL. Anything else leaves the row alone and returns nothing.
    const taken = await this.sql.query<{ token: string }>(
      `INSERT INTO ${this.table} (scope, key, token, held_until, at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope, key) DO UPDATE SET args_hash = NULL, frame = NULL, compact_frame = NULL, token = EXCLUDED.token, held_until = EXCLUDED.held_until, at = EXCLUDED.at
       WHERE (${this.table}.frame IS NULL AND (${this.table}.held_until IS NULL OR ${this.table}.held_until <= $5))
          OR (${this.table}.frame IS NOT NULL AND ${this.table}.at < $6)
       RETURNING token`,
      [scope, key, token, t + leaseMs, t, t - this.ttlMs],
    );
    if (taken.rows[0]) return { state: "owned", token };
    const { rows } = await this.sql.query<Row>(
      `SELECT args_hash, frame, compact_frame, token, held_until, at FROM ${this.table} WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const row = rows[0];
    if (!row) return this.claim(scope, key, leaseMs); // it was swept between the two statements: ask again
    if (row.frame !== null && row.frame !== undefined) return { state: "done", record: this.record(row) };
    return { state: "inflight", heldUntil: ms(row.held_until) };
  }

  async renew(scope: string, key: string, token: string, leaseMs: number): Promise<boolean> {
    const { rows } = await this.sql.query<{ key: string }>(
      `UPDATE ${this.table} SET held_until = $4 WHERE scope = $1 AND key = $2 AND token = $3 RETURNING key`,
      [scope, key, token, this.now() + leaseMs],
    );
    return rows.length > 0;
  }

  async put(scope: string, key: string, record: IdempotencyRecord, token: string): Promise<void> {
    await this.sql.query(
      `UPDATE ${this.table} SET args_hash = $4, frame = $5, compact_frame = $6, token = NULL, held_until = NULL, at = $7 WHERE scope = $1 AND key = $2 AND token = $3`,
      [scope, key, token, record.argsHash, JSON.stringify(record.frame ?? null), record.compactFrame === undefined ? null : JSON.stringify(record.compactFrame), record.at],
    );
    await this.sweep();
  }

  async release(scope: string, key: string, token: string): Promise<void> {
    await this.sql.query(`DELETE FROM ${this.table} WHERE scope = $1 AND key = $2 AND token = $3`, [scope, key, token]);
  }

  /** Expired records go on every write; the cap is trimmed every hundredth one, since it costs a scan. */
  private async sweep(): Promise<void> {
    await this.sql.query(`DELETE FROM ${this.table} WHERE frame IS NOT NULL AND at < $1`, [this.now() - this.ttlMs]);
    if (++this.puts % 100 !== 0) return;
    await this.sql.query(
      `DELETE FROM ${this.table} WHERE (scope, key) IN (SELECT scope, key FROM ${this.table} WHERE frame IS NOT NULL ORDER BY at DESC OFFSET $1)`,
      [this.maxRecords],
    );
  }

  /** Records and claims held right now, for tests and for a health check. */
  async size(): Promise<number> {
    const { rows } = await this.sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${this.table}`);
    return Number(rows[0]?.n ?? 0);
  }
}
