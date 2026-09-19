/**
 * Counts of what a server did, for an operator or a metrics system to read.
 *
 * This is the other half of {@link UsageSink}. Usage answers "does anyone still ask for this field"; counters answer
 * "what is this server doing right now" — how many requests arrived, how many were refused before anything ran, how
 * many commands replayed rather than executed, how many live queries are being re-run.
 *
 * Most of it cannot be had any other way. A request refused for its `Origin`, its media type or its size is answered
 * and gone before `execute` is called, so no {@link Instrumentation} hook ever sees it — a server could not tell you
 * that a fifth of its traffic was being turned away at the door.
 *
 * A server records nothing unless it is given a sink.
 */

/** A counter name and the labels that qualify it. Names are dotted and lower case; labels are few and low-cardinality. */
export interface Counters {
  /** Adds [n] to the count of [name] with these labels. Must not throw: a sink that fails must not fail a request. */
  add(name: string, n?: number, labels?: Record<string, string>): void;
}

export interface CounterEntry {
  name: string;
  labels: Record<string, string>;
  count: number;
}

/**
 * Counters in memory, for a single process — what `GET {base}/stats`, the tests and a small server use. Real
 * deployments hand the same calls to whatever they already run.
 *
 * Bounded, because a label taken from a request is a way to exhaust memory. Past the bound it keeps counting what it
 * already knows and counts what it had to drop, rather than going quiet: a sink that silently stops recording is
 * worse than one that says it is full, because the graph keeps drawing and stops being true.
 */
export class MemoryCounters implements Counters {
  private readonly counts = new Map<string, CounterEntry>();
  private droppedCount = 0;

  constructor(private readonly max = 10_000) {}

  add(name: string, n = 1, labels: Record<string, string> = {}): void {
    // sorted, so the same labels in another order are the same series
    const key = `${name}|${Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(",")}`;
    const seen = this.counts.get(key);
    if (seen) {
      seen.count += n;
      return;
    }
    if (this.counts.size >= this.max) {
      this.droppedCount++;
      return;
    }
    this.counts.set(key, { name, labels, count: n });
  }

  /** Everything counted, by name then labels, so two snapshots of one server read the same way. */
  snapshot(): CounterEntry[] {
    return [...this.counts.values()].sort((a, b) =>
      a.name === b.name ? JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)) : a.name.localeCompare(b.name),
    );
  }

  /** Series this sink refused because it was full. Anything above zero means the counts below are incomplete. */
  get dropped(): number {
    return this.droppedCount;
  }

  get size(): number {
    return this.counts.size;
  }
}
