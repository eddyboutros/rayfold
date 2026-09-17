/**
 * Uploads in Postgres, so several servers share them: a file sent to one server is there for the command that runs on
 * another (spec 04 §9). Kept in memory, an upload belongs to the process that received it, which is right for one
 * server and wrong for a fleet.
 *
 * `JdbcUploadStore` creates the same columns, so a fleet may hold servers of both runtimes and either may create the
 * table. Bytes live in a `bytea` column: at the sizes this extension is for (25 MiB by default) a row is the simplest
 * thing that works everywhere. For files measured in hundreds of megabytes, hand the client a URL from object storage
 * instead - `docs/guide/uploads.md` says when not to use this.
 */
import { ensure } from "./ddl.ts";
import type { Queryable } from "./index.ts";

/** What the store keeps beside the bytes. Mirrors `Upload` in `@rayfold/server`. */
export interface PgUpload {
  id: string;
  size: number;
  at: number;
  name?: string;
  type?: string;
  viewer?: unknown;
}

export interface PgUploadOptions {
  /** Default `rayfold_uploads`. Quoted as written, so keep it a plain identifier or schema-qualify it yourself. */
  table?: string;
  /** How long an upload waits to be used. Default 1 hour. */
  ttlMs?: number;
  /** Most bytes held at once; past it the oldest go first. Default 1 GiB. */
  maxBytes?: number;
  /** Wall clock, injectable for tests. */
  now?: () => number;
  /** Ids, injectable for tests. Must be unguessable: an id is what lets a command read those bytes. */
  id?: () => string;
}

/** The table this store reads and writes. `JdbcUploadStore` creates the same columns. */
export function uploadSchema(table = "rayfold_uploads"): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    "  id text NOT NULL,",
    "  name text,",
    "  type text,",
    "  viewer text,",
    "  size bigint NOT NULL,",
    "  at bigint NOT NULL,",
    "  bytes bytea NOT NULL,",
    "  PRIMARY KEY (id)",
    ");",
    `CREATE INDEX IF NOT EXISTS ${table.replace(/[^A-Za-z0-9_]/g, "_")}_at ON ${table} (at);`,
  ].join("\n");
}

interface Row {
  id: string;
  name: string | null;
  type: string | null;
  viewer: string | null;
  size: string | number;
  at: string | number;
  bytes?: Uint8Array;
}

const ms = (v: string | number): number => (typeof v === "number" ? v : Number(v));

/**
 * What the driver wants for a `bytea` parameter. node-postgres serialises a `Buffer` to bytes and anything else
 * through `JSON.stringify`, so the bytes have to arrive as one; PGlite takes the array as it is. This package never
 * imports a driver and is built without Node's types, so `Buffer` is reached for only where it exists.
 */
const bytea = (b: Uint8Array): Uint8Array => {
  const buf = (globalThis as { Buffer?: { from(b: Uint8Array): Uint8Array } }).Buffer;
  return buf ? buf.from(b) : b;
};

export class PgUploadStore {
  private readonly table: string;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly nextId: () => string;

  constructor(
    private readonly sql: Queryable,
    opts: PgUploadOptions = {},
  ) {
    this.table = opts.table ?? "rayfold_uploads";
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.maxBytes = opts.maxBytes ?? 1024 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
    this.nextId = opts.id ?? (() => crypto.randomUUID());
  }

  /** Creates the table and index if they are not there yet. Safe to call from every server as it starts. */
  async migrate(): Promise<void> {
    for (const statement of uploadSchema(this.table).split(";\n")) {
      const text = statement.trim().replace(/;$/, "");
      if (text) await ensure(this.sql, text);
    }
  }

  private upload(row: Row): PgUpload {
    const out: PgUpload = { id: row.id, size: ms(row.size), at: ms(row.at) };
    if (row.name !== null) out.name = row.name;
    if (row.type !== null) out.type = row.type;
    if (row.viewer !== null) out.viewer = JSON.parse(row.viewer);
    return out;
  }

  async put(body: ReadableStream<Uint8Array>, meta: { name?: string | undefined; type?: string | undefined; viewer?: unknown }): Promise<PgUpload> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      size += value.length;
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    const t = this.now();
    const id = this.nextId();
    await this.sql.query(`INSERT INTO ${this.table} (id, name, type, viewer, size, at, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      id,
      meta.name ?? null,
      meta.type ?? null,
      meta.viewer === undefined || meta.viewer === null ? null : JSON.stringify(meta.viewer),
      size,
      t,
      bytea(bytes),
    ]);
    await this.sweep(t);
    const upload: PgUpload = { id, size, at: t };
    if (meta.name !== undefined) upload.name = meta.name;
    if (meta.type !== undefined) upload.type = meta.type;
    if (meta.viewer !== undefined) upload.viewer = meta.viewer;
    return upload;
  }

  async open(id: string): Promise<{ upload: PgUpload; body: ReadableStream<Uint8Array> } | undefined> {
    const { rows } = await this.sql.query<Row>(`SELECT id, name, type, viewer, size, at, bytes FROM ${this.table} WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) return undefined;
    if (this.now() - ms(row.at) >= this.ttlMs) {
      await this.delete(id);
      return undefined;
    }
    const bytes = new Uint8Array(row.bytes ?? []);
    return {
      upload: this.upload(row),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }

  async delete(id: string): Promise<void> {
    await this.sql.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }

  /** Expired uploads go on every write, then the oldest while the store is over its bound. */
  private async sweep(t: number): Promise<void> {
    await this.sql.query(`DELETE FROM ${this.table} WHERE at < $1`, [t - this.ttlMs]);
    const { rows } = await this.sql.query<{ total: string | number | null }>(`SELECT COALESCE(SUM(size), 0) AS total FROM ${this.table}`);
    let total = ms(rows[0]?.total ?? 0);
    if (total <= this.maxBytes) return;
    const { rows: oldest } = await this.sql.query<{ id: string; size: string | number }>(`SELECT id, size FROM ${this.table} ORDER BY at ASC`);
    for (const row of oldest) {
      if (total <= this.maxBytes) break;
      await this.delete(row.id);
      total -= ms(row.size);
    }
  }

  /** Uploads held right now, for tests and for a health check. */
  async count(): Promise<number> {
    const { rows } = await this.sql.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${this.table}`);
    return ms(rows[0]?.n ?? 0);
  }

  /** Bytes held right now. */
  async bytes(): Promise<number> {
    const { rows } = await this.sql.query<{ total: string | number | null }>(`SELECT COALESCE(SUM(size), 0) AS total FROM ${this.table}`);
    return ms(rows[0]?.total ?? 0);
  }
}
