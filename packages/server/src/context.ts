import type { Expr, Shape } from "@rayfold/schema";
import type { RequestMeta } from "./protocol.ts";

/** In-process event bus used for `emits` and for streams that subscribe to events. */
export class EventBus {
  private readonly subs = new Map<string, Set<(payload: unknown) => void>>();
  private seq = 0;

  publish(name: string, payload: Record<string, unknown>): void {
    this.seq++;
    const enriched = { ...payload, seq: this.seq };
    for (const fn of this.subs.get(name) ?? []) fn(enriched);
    for (const fn of this.subs.get("*") ?? []) fn({ event: name, ...enriched });
  }

  on(name: string, fn: (payload: unknown) => void): () => void {
    let set = this.subs.get(name);
    if (!set) this.subs.set(name, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Async iterator over an event; ends when `signal` aborts. Buffers between pulls. */
  subscribe<T = unknown>(name: string, signal?: AbortSignal): AsyncIterable<T> {
    const bus = this;
    return {
      [Symbol.asyncIterator]() {
        const queue: T[] = [];
        let waiting: ((r: IteratorResult<T>) => void) | null = null;
        let done = false;
        const off = bus.on(name, (p) => {
          if (done) return;
          if (waiting) {
            const w = waiting;
            waiting = null;
            w({ value: p as T, done: false });
          } else queue.push(p as T);
        });
        const finish = () => {
          if (done) return;
          done = true;
          off();
          if (waiting) {
            const w = waiting;
            waiting = null;
            w({ value: undefined as never, done: true });
          }
        };
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted) finish();
        return {
          next(): Promise<IteratorResult<T>> {
            if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
            if (done) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((res) => (waiting = res));
          },
          return(): Promise<IteratorResult<T>> {
            finish();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  }
}

export interface PolicyHint {
  /** Pushable read policy for the type being loaded, if any (spec 06 §4). */
  filter?: Expr;
}

/** What every resolver receives. `V` is the server's viewer type. */
export interface RayfoldContext<V = unknown> {
  viewer: V;
  signal: AbortSignal;
  simulate: boolean;
  /** Compact wire mode requested by the client (spec 04 section 1). */
  compact?: boolean;
  /** Expected version for a conditional command (spec 03 section 4a). */
  ifVersion?: string | number;
  /**
   * Conditional-write check: throws VersionConflict when the request carried `ifVersion` and it differs
   * from `actual`. `current` is the entity as stored; it is returned to the client in the op's shape.
   */
  checkVersion(key: string, actual: unknown, current: unknown): void;
  events: EventBus;
  meta: RequestMeta;
  opId: number;
  opName: string;
  policy: PolicyHint;
  /** The shape this op asked for, so an adapter can plan a whole screen at once (spec 02). */
  shape?: Shape;
  /** Values for `$name` references in the op's shape. */
  vars?: Record<string, unknown>;
  /** Per-request scratch space (e.g. per-request loader caches). */
  state: Map<string, unknown>;
  /**
   * Scratch space shared by every op of the batch. The executor keeps loaded field values here, so an entity one op
   * already loaded is not loaded again by another op of the same request (spec 03 section 2).
   */
  batch: Map<string, unknown>;
  /** Wall clock, injectable for tests. */
  now: () => number;
}

export interface IdempotencyRecord {
  argsHash: string;
  /** the full ok frame */
  frame: unknown;
  /** the same result in compact form, for retries that ask for compact frames */
  compactFrame?: unknown;
  at: number;
}

export interface IdempotencyStore {
  get(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  put(scope: string, key: string, record: IdempotencyRecord): Promise<void>;
}

/**
 * In-memory idempotency records. Records expire after `ttlMs`; expired ones are dropped on read and swept on every
 * write, and past `maxEntries` the oldest go first, so memory stays bounded however many commands arrive.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, IdempotencyRecord>();
  constructor(
    private readonly ttlMs = 24 * 3_600_000,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 100_000,
  ) {}
  async get(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
    const k = `${scope}\u0000${key}`;
    const r = this.map.get(k);
    if (r && this.now() - r.at > this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    return r;
  }
  async put(scope: string, key: string, record: IdempotencyRecord): Promise<void> {
    const k = `${scope}\u0000${key}`;
    this.map.delete(k); // re-inserted at the end, so the map stays ordered oldest first
    this.map.set(k, record);
    const t = this.now();
    for (const [old, r] of this.map) {
      if (this.map.size > this.maxEntries || t - r.at > this.ttlMs) this.map.delete(old);
      else break;
    }
  }
  get size(): number {
    return this.map.size;
  }
}
