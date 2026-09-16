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

/**
 * The answer to `claim`: run the command, replay a stored result, or wait for whoever holds the key.
 * `heldUntil` is when that holder's lease runs out, after which another server may take the key over.
 */
export type IdempotencyClaim =
  | { state: "owned"; token: string }
  | { state: "done"; record: IdempotencyRecord }
  | { state: "inflight"; heldUntil: number };

/**
 * Where a command's result is kept so a retry is answered with the first attempt's result (spec 03 section 4).
 *
 * A store shared by several servers is what makes "runs once" hold across all of them: `claim` must be atomic, so that
 * of two servers asking at the same moment exactly one owns the key and the other waits. The owner renews its lease
 * while the command runs; if that server dies, the lease runs out and the next retry takes the key over.
 */
export interface IdempotencyStore {
  get(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  /** Take the key for `leaseMs`, or report that it is finished or held by someone else. */
  claim(scope: string, key: string, leaseMs: number): Promise<IdempotencyClaim>;
  /** Extend the lease while the command runs. False when the claim was lost, so the caller must stop. */
  renew(scope: string, key: string, token: string, leaseMs: number): Promise<boolean>;
  /** Record the result and end the claim. */
  put(scope: string, key: string, record: IdempotencyRecord, token: string): Promise<void>;
  /** Let the key go with no record, so the next retry runs the command. */
  release(scope: string, key: string, token: string): Promise<void>;
}

/** A key is either finished (a record) or claimed (a token, a lease and a promise that ends with the claim). */
interface Entry {
  record?: IdempotencyRecord;
  token?: string;
  heldUntil?: number;
  settled?: Promise<void>;
  wake?: () => void;
  at: number;
}

const SEP = String.fromCharCode(0);

/**
 * In-memory idempotency records, for one server. Records expire after `ttlMs`; expired ones are dropped on read and
 * swept on every write, and past `maxEntries` the oldest go first, so memory stays bounded however many commands
 * arrive. A claimed key is never swept: a command is still running behind it.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly map = new Map<string, Entry>();
  private tokens = 0;
  constructor(
    private readonly ttlMs = 24 * 3_600_000,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 100_000,
  ) {}

  private live(k: string): Entry | undefined {
    const e = this.map.get(k);
    if (e?.record && this.now() - e.at > this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    return e;
  }

  async get(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
    return this.live(scope + SEP + key)?.record;
  }

  async claim(scope: string, key: string, leaseMs: number): Promise<IdempotencyClaim> {
    const k = scope + SEP + key;
    const held = this.live(k);
    const t = this.now();
    if (held?.record) return { state: "done", record: held.record };
    if (held?.heldUntil !== undefined && held.heldUntil > t) return { state: "inflight", heldUntil: held.heldUntil };
    const token = `m${++this.tokens}`;
    const entry: Entry = { token, heldUntil: t + leaseMs, at: t };
    entry.settled = new Promise<void>((r) => (entry.wake = r));
    this.map.set(k, entry);
    held?.wake?.(); // a lease that ran out: anyone waiting on it looks again and finds this claim
    return { state: "owned", token };
  }

  async renew(scope: string, key: string, token: string, leaseMs: number): Promise<boolean> {
    const e = this.map.get(scope + SEP + key);
    if (e?.token !== token) return false;
    e.heldUntil = this.now() + leaseMs;
    return true;
  }

  async put(scope: string, key: string, record: IdempotencyRecord, token: string): Promise<void> {
    const k = scope + SEP + key;
    const held = this.map.get(k);
    if (held?.token !== undefined && held.token !== token) return; // the lease was lost; the new owner speaks for this key
    this.map.delete(k); // re-inserted at the end, so the map stays ordered oldest first
    this.map.set(k, { record, at: record.at });
    held?.wake?.();
    const t = this.now();
    for (const [old, e] of this.map) {
      if (!e.record) break; // a claim in flight is never swept
      if (this.map.size > this.maxEntries || t - e.at > this.ttlMs) this.map.delete(old);
      else break;
    }
  }

  async release(scope: string, key: string, token: string): Promise<void> {
    const k = scope + SEP + key;
    const e = this.map.get(k);
    if (e?.token !== token) return;
    this.map.delete(k);
    e.wake?.();
  }

  /** In this process a waiter can be woken the moment the claim ends; across servers only `claim` can say. */
  settled(scope: string, key: string): Promise<void> | undefined {
    return this.map.get(scope + SEP + key)?.settled;
  }

  get size(): number {
    return this.map.size;
  }
}
