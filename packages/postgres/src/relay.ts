/**
 * A relay over Postgres `LISTEN`/`NOTIFY`, so servers in different processes hear each other's changes and events
 * through the database they already share: a command run on one server reaches the live queries and streams open on
 * every other.
 *
 * One NOTIFY payload carries one message, as JSON:
 *
 *   {"from":"<relay id>","change":{"keys":["Book:b1"],"ops":["books"]}}
 *   {"from":"<relay id>","event":{"name":"StockChanged","payload":{"bookId":"b1","stock":4}}}
 *   {"from":"<relay id>","ref":12}
 *
 * `from` is the publishing relay's id, so a server drops what it published itself. Postgres limits a payload to 8000
 * bytes; a message that would not fit is written to the relay table and `ref` names its row, which the receivers read.
 * Those rows are swept as new ones are written. Any Rayfold server that speaks this format can share the relay, in
 * either runtime.
 *
 * `LISTEN` belongs to one connection, so give the relay a dedicated client, never a pool.
 */
import type { Relay, RelayMessage } from "@rayfold/server/core";
import { ensure } from "./ddl.ts";
import type { Queryable } from "./index.ts";

/** What the relay needs from a Postgres client: `pgNotifications` and `pgliteNotifications` provide it. */
export interface Notifications {
  /**
   * Delivers every payload sent on `channel`, by this process or any other, until the function returned is called.
   * `onLost` is called if the connection listening ends first.
   */
  listen(channel: string, onPayload: (payload: string) => void, onLost?: (error: unknown) => void): Promise<() => Promise<void>>;
  notify(channel: string, payload: string): Promise<void>;
}

export interface PgRelayOptions {
  /** The NOTIFY channel. Default `rayfold`. */
  channel?: string;
  /** The table for messages too large for a payload. Default `rayfold_relay`. */
  table?: string;
  /** Largest payload sent inline, in bytes. Default 7900, under Postgres's limit of 8000. */
  maxInline?: number;
  /** How long a row in the table is kept. Default 5 minutes: long enough for every server to have read it. */
  ttlMs?: number;
  /** Identifies this relay in what it publishes. Default: random. */
  origin?: string;
  /** Where a message this relay could not read or fetch goes. Default: dropped. */
  onError?: (error: unknown) => void;
  /** Wall clock, injectable for tests. */
  now?: () => number;
}

/** The DDL for the relay table. */
export function relaySchema(table = "rayfold_relay"): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (id bigserial PRIMARY KEY, message jsonb NOT NULL, at bigint NOT NULL)`;
}

type Body = { change: { keys: string[]; ops: string[] } } | { event: { name: string; payload: Record<string, unknown> } } | { ref: number };
type Wire = { from: string } & Body;

export class PgRelay implements Relay {
  private readonly channel: string;
  private readonly table: string;
  private readonly maxInline: number;
  private readonly ttlMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly now: () => number;
  readonly origin: string;

  constructor(
    private readonly notifications: Notifications,
    private readonly sql: Queryable,
    opts: PgRelayOptions = {},
  ) {
    this.channel = opts.channel ?? "rayfold";
    this.table = opts.table ?? "rayfold_relay";
    this.maxInline = opts.maxInline ?? 7900;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.origin = opts.origin ?? crypto.randomUUID();
    this.onError = opts.onError ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** Creates the table for oversized messages if it is not there yet. Safe to call from every server as it starts. */
  async migrate(): Promise<void> {
    await ensure(this.sql, relaySchema(this.table));
  }

  async publish(message: RelayMessage): Promise<void> {
    const body = message.kind === "change" ? { change: { keys: message.keys, ops: message.ops } } : { event: { name: message.name, payload: message.payload } };
    const inline = JSON.stringify({ from: this.origin, ...body });
    if (new TextEncoder().encode(inline).length <= this.maxInline) return this.notifications.notify(this.channel, inline);
    const t = this.now();
    const { rows } = await this.sql.query<{ id: string | number }>(`INSERT INTO ${this.table} (message, at) VALUES ($1::jsonb, $2) RETURNING id`, [JSON.stringify(body), t]);
    await this.sql.query(`DELETE FROM ${this.table} WHERE at < $1`, [t - this.ttlMs]);
    await this.notifications.notify(this.channel, JSON.stringify({ from: this.origin, ref: Number(rows[0]?.id) }));
  }

  async subscribe(onMessage: (message: RelayMessage) => void, onLost?: (error: unknown) => void): Promise<() => Promise<void>> {
    return this.notifications.listen(
      this.channel,
      (payload) => {
        this.receive(payload, onMessage).catch(this.onError);
      },
      onLost,
    );
  }

  private async receive(payload: string, onMessage: (message: RelayMessage) => void): Promise<void> {
    const wire = JSON.parse(payload) as Wire;
    if (wire.from === this.origin) return;
    if ("ref" in wire) {
      const { rows } = await this.sql.query<{ message: unknown }>(`SELECT message FROM ${this.table} WHERE id = $1`, [wire.ref]);
      const row = rows[0];
      if (!row) throw new Error(`rayfold relay: message ${wire.ref} is gone from ${this.table}`);
      const stored = (typeof row.message === "string" ? JSON.parse(row.message) : row.message) as Body;
      return deliver(stored, onMessage);
    }
    deliver(wire, onMessage);
  }
}

function deliver(body: Body, onMessage: (message: RelayMessage) => void): void {
  if ("change" in body) onMessage({ kind: "change", keys: body.change.keys, ops: body.change.ops });
  else if ("event" in body) onMessage({ kind: "event", name: body.event.name, payload: body.event.payload });
}

const quoteIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`;

interface PgNotification {
  channel: string;
  payload?: string | undefined;
}

interface NotificationClient {
  query(text: string, params?: unknown[]): Promise<unknown>;
  on(event: "notification", listener: (message: PgNotification) => void): unknown;
  on(event: "end" | "error", listener: (error?: unknown) => void): unknown;
  off(event: "notification", listener: (message: PgNotification) => void): unknown;
  off(event: "end" | "error", listener: (error?: unknown) => void): unknown;
}

/** LISTEN/NOTIFY through a `pg` `Client`. A dedicated one: LISTEN ties the subscription to that connection. */
export function pgNotifications(client: NotificationClient): Notifications {
  return {
    async listen(channel, onPayload, onLost) {
      const listener = (message: PgNotification) => {
        if (message.channel === channel) onPayload(message.payload ?? "");
      };
      // LISTEN lives and dies with this connection, and pg says so only through these events: without them a server
      // whose connection dropped would go on publishing, and look ready, while hearing nobody
      let gone = false;
      const ended = (error?: unknown) => {
        if (gone) return;
        gone = true;
        onLost?.(error instanceof Error ? error : new Error("rayfold relay: the listening connection ended"));
      };
      client.on("notification", listener);
      client.on("error", ended);
      client.on("end", ended);
      await client.query(`LISTEN ${quoteIdentifier(channel)}`);
      return async () => {
        gone = true;
        client.off("notification", listener);
        client.off("error", ended);
        client.off("end", ended);
        await client.query(`UNLISTEN ${quoteIdentifier(channel)}`);
      };
    },
    async notify(channel, payload) {
      await client.query("SELECT pg_notify($1, $2)", [channel, payload]);
    },
  };
}

/** LISTEN/NOTIFY through a PGlite instance, whose `listen` already has the shape the relay needs. */
export function pgliteNotifications(db: { listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>; query(text: string, params?: unknown[]): Promise<unknown> }): Notifications {
  return {
    listen: (channel, onPayload) => db.listen(channel, onPayload),
    async notify(channel, payload) {
      await db.query("SELECT pg_notify($1, $2)", [channel, payload]);
    },
  };
}
