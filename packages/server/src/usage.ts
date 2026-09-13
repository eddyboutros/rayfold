/**
 * Field-usage telemetry (spec 11 "Field usage telemetry"): which members each client still asks for, so removing one
 * is a fact rather than a guess. `rayfold check --unused` reads a snapshot of this and lists what no client has
 * touched.
 *
 * A server records nothing unless it is given a sink. A sink keeps only what the question needs: the operation, the
 * path of the member (`Book.author`, or empty for the operation itself), the client name from `Rayfold-Client`, when
 * it was last seen and how often. No arguments, no values, no viewer.
 */

export interface UsageEvent {
  /** the operation the request named */
  op: string;
  /** `Type.field`, or "" for the operation itself */
  path: string;
  /** the `Rayfold-Client` header, or "" when the caller did not name itself */
  client: string;
}

export interface UsageSink {
  record(event: UsageEvent, at: number): void;
}

export interface UsageEntry extends UsageEvent {
  /** RFC 3339, UTC */
  lastSeen: string;
  count: number;
}

/**
 * Usage in memory, for a single process. Real deployments hand the same events to whatever they already run for
 * metrics; this is what `rayfold dev`, the tests and a small server use.
 */
export class MemoryUsage implements UsageSink {
  private readonly seen = new Map<string, { event: UsageEvent; at: number; count: number }>();

  /** A full sink stops recording rather than growing without bound: telemetry must not be a way to exhaust memory. */
  constructor(private readonly max = 100_000) {}

  record(event: UsageEvent, at: number): void {
    const key = `${event.client}|${event.op}|${event.path}`;
    const seen = this.seen.get(key);
    if (seen) {
      if (at > seen.at) seen.at = at;
      seen.count++;
      return;
    }
    if (this.seen.size >= this.max) return;
    this.seen.set(key, { event, at, count: 1 });
  }

  /** Everything recorded, oldest member first within an operation: the file `rayfold check --unused` reads. */
  snapshot(): UsageEntry[] {
    return [...this.seen.values()]
      .map(({ event, at, count }) => ({ ...event, lastSeen: new Date(at).toISOString(), count }))
      .sort((a, b) => (a.op === b.op ? (a.path === b.path ? a.client.localeCompare(b.client) : a.path.localeCompare(b.path)) : a.op.localeCompare(b.op)));
  }

  get size(): number {
    return this.seen.size;
  }
}
