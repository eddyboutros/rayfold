/** RayfoldClient: batches with refs, cache-coherent commands, live-updating watches. */
import type { Frame, PatchOp, RequestEnvelope, RequestOp, WireError } from "@rayfold/server/protocol";
import type { RayfoldSchemaIR } from "@rayfold/schema";
import { annotation } from "@rayfold/schema";
import { RayfoldCache, type CacheListener, type CachedResult, type MergePolicy, type OptimisticOp } from "./cache.ts";
import { OfflineQueue, isUnreachable, memoryQueue, type QueueEvent, type QueueStorage, type QueuedCommand } from "./offline.ts";
import type { Transport, UploadBody, UploadHandle } from "./transport.ts";
import { restoreTypes, typeAtPath } from "./types.ts";

export class RayfoldClientError extends Error {
  readonly code: string;
  readonly type: string | undefined;
  readonly data: unknown;
  readonly path: string | undefined;
  readonly retryable: boolean;
  constructor(w: WireError) {
    super(w.message);
    this.name = "RayfoldClientError";
    this.code = w.code;
    this.type = w.type;
    this.data = w.data;
    this.path = w.path;
    this.retryable = w.retryable ?? ["unavailable", "deadline_exceeded", "aborted"].includes(w.code);
  }
  /** Narrow on a declared domain error: `if (e.is("OutOfStock")) e.data.available` */
  is(type: string): boolean {
    return this.code === "domain" && this.type === type;
  }
}

export interface OpOptions {
  shape?: string;
  vars?: Record<string, unknown>;
  key?: string;
  deadline?: number;
  simulate?: boolean;
  live?: boolean;
  /** Conditional write: the entity version last seen; a stale value fails with VersionConflict carrying the current entity. */
  ifVersion?: string | number;
}

export interface CommandOptions extends OpOptions {
  /**
   * The change the command is expected to make (sub-profile `sync`, spec 08 section 5), shown in the cache at once. The
   * server's own patch replaces it when the command succeeds; it is rolled back when the command fails. A function
   * gets the cache, to compute the prediction from current values.
   */
  optimistic?: OptimisticOp[] | ((cache: RayfoldCache) => OptimisticOp[]);
}

export interface QueryOptions extends OpOptions {
  /** "network" (default) always fetches; "cache" serves a fresh cached result when present. */
  policy?: "network" | "cache";
}

export interface ClientOptions {
  transport: Transport;
  cache?: RayfoldCache;
  /** Sent as meta.client, e.g. "web/1.2.0". */
  client?: string;
  /** Batch deadline in ms. */
  deadline?: number;
  /** Idempotency key generator for commands without an explicit key. */
  keyGen?: () => string;
  now?: () => number;
  /** Schema IR (from /rayfold/manifest). Enables compact frames: the server omits redundant `$type`/`meta`, the client restores types. */
  schema?: RayfoldSchemaIR;
  /**
   * Queue commands made while the server cannot be reached (sub-profile `sync`) and send them later, in order and with
   * their idempotency keys: on `drain()`, and when the browser comes back online. Their predictions stay shown meanwhile.
   */
  offline?: { storage?: QueueStorage; drainOnReconnect?: boolean };
}

/** A handle to an op inside a batch. `ref("id")` produces a `$ref` usable in later ops' args. */
export class OpHandle<T = unknown> {
  readonly promise: Promise<T>;
  private resolveFn!: (v: T) => void;
  private rejectFn!: (e: unknown) => void;
  readonly frames: Frame[] = [];
  constructor(
    readonly id: number,
    readonly req: RequestOp,
  ) {
    this.promise = new Promise<T>((res, rej) => {
      this.resolveFn = res;
      this.rejectFn = rej;
    });
    this.promise.catch(() => {}); // avoid unhandled rejections when the caller ignores this handle
  }
  ref(path: string): { $ref: string } {
    return { $ref: `${this.id}.${path}` };
  }
  /** @internal */
  _resolve(v: T): void {
    this.resolveFn(v);
  }
  /** @internal */
  _reject(e: unknown): void {
    this.rejectFn(e);
  }
}

export interface BatchResult {
  frames: Frame[];
}

export class Batch {
  private readonly ops: OpHandle[] = [];
  private nextId = 1;
  constructor(private readonly client: RayfoldClient) {}

  query<T = unknown>(op: string, args: Record<string, unknown> = {}, o: OpOptions = {}): OpHandle<T> {
    return this.add<T>({ id: this.nextId++, op, args, ...pick(o) });
  }
  command<T = unknown>(op: string, args: Record<string, unknown> = {}, o: OpOptions = {}): OpHandle<T> {
    const req: RequestOp = { id: this.nextId++, op, args, ...pick(o) };
    if (req.key === undefined) req.key = this.client.newKey();
    return this.add<T>(req);
  }
  private add<T>(req: RequestOp): OpHandle<T> {
    const h = new OpHandle<T>(req.id, this.client.prepare(req));
    this.ops.push(h as unknown as OpHandle);
    return h;
  }
  /** Send the batch; every handle's promise settles as its frames arrive. */
  async run(opts: { signal?: AbortSignal; onFrame?: (f: Frame) => void } = {}): Promise<BatchResult> {
    return this.client.runBatch(this.ops, opts);
  }
}

export class RayfoldClient {
  readonly cache: RayfoldCache;
  private readonly keyGen: () => string;
  private readonly now: () => number;

  constructor(private readonly opts: ClientOptions) {
    this.now = opts.now ?? Date.now;
    this.cache = opts.cache ?? new RayfoldCache(this.now, mergePolicyOf(opts.schema));
    this.keyGen = opts.keyGen ?? (() => (globalThis.crypto?.randomUUID?.() ?? `${this.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/-/g, ""));
    this.schema = opts.schema;
    if (this.schema) for (const op of Object.values(this.schema.ops)) if (op.kind === "query") this.opKinds.set(op.name, "query");
    if (opts.offline) {
      const queue = new OfflineQueue(
        opts.offline.storage ?? memoryQueue(),
        (c) => this.sendCommand(c).then((r) => this.settled(c, r)),
        (c) => this.cache.removeLayer(c.key),
        (c) => {
          if (c.optimistic?.length) this.cache.addLayer(c.key, c.optimistic);
        },
      );
      this.queue = queue;
      const target = globalThis as { addEventListener?: (type: string, fn: () => void) => void };
      if (opts.offline.drainOnReconnect !== false && typeof target.addEventListener === "function") target.addEventListener("online", () => void queue.drain());
    }
  }

  private readonly queue: OfflineQueue | undefined;

  /** With a schema, every op is sent compact and types are restored on arrival. */
  /** @internal */
  prepare(req: RequestOp): RequestOp {
    return this.schema ? { ...req, compact: true } : req;
  }
  private typed(op: string, data: unknown, at?: string): unknown {
    if (!this.schema) return data;
    const def = this.schema.ops[op];
    if (!def) return data;
    const t = at ? typeAtPath(this.schema, def.returns, at) : def.returns;
    return t ? restoreTypes(this.schema, t, data) : data;
  }

  newKey(): string {
    return this.keyGen();
  }

  batch(): Batch {
    return new Batch(this);
  }

  /** One query; returns the denormalized result. Subsequent reads of the same entities stay coherent via the cache. */
  async query<T = unknown>(op: string, args: Record<string, unknown> = {}, o: QueryOptions = {}): Promise<T> {
    const rk = RayfoldCache.resultKey(op, args, o.shape, o.vars);
    if (o.policy === "cache") {
      const cached = this.cache.getResult(rk);
      if (cached && !cached.stale && ![...cached.keys].some((k) => this.cache.isStale(k))) return this.cache.denormalize(cached.data) as T;
    }
    const b = this.batch();
    const h = b.query<T>(op, args, o);
    await b.run();
    return h.promise;
  }

  async command<T = unknown>(op: string, args: Record<string, unknown> = {}, o: CommandOptions = {}): Promise<T> {
    const { optimistic, ...options } = o;
    const predicted = typeof optimistic === "function" ? optimistic(this.cache) : optimistic;
    const command: QueuedCommand = { key: o.key ?? this.newKey(), op, args, options, queuedAt: this.now(), seq: this.nextSeq++, ...(predicted?.length ? { optimistic: predicted } : {}) };
    if (predicted?.length) this.cache.addLayer(command.key, predicted);
    if (this.queue) {
      await this.queue.restored;
      // behind the commands still waiting, so the server sees them in the order they were made
      if (this.queue.size) return this.queue.add<T>(command);
    }
    try {
      return this.settled(command, await this.sendCommand<T>(command));
    } catch (e) {
      if (this.queue && isUnreachable(e)) return this.queue.add<T>(command); // its prediction stays until it is sent
      this.cache.removeLayer(command.key);
      throw e;
    }
  }

  /** Drops the command's prediction and returns its result as the server left it, not as it was predicted. */
  private settled<T>(c: QueuedCommand, result: T): T {
    if (!c.optimistic?.length) return result;
    this.cache.removeLayer(c.key);
    const stored = this.cache.getResult(RayfoldCache.resultKey(c.op, c.args, c.options.shape, c.options.vars));
    return stored ? (this.cache.denormalize(stored.data) as T) : result;
  }

  /** Orders commands by when they were made, across reloads too: it starts from the clock. */
  private nextSeq = Date.now();

  private async sendCommand<T>(c: QueuedCommand): Promise<T> {
    const b = this.batch();
    const h = b.command<T>(c.op, c.args, { ...c.options, key: c.key });
    await b.run();
    return h.promise;
  }

  /** Commands waiting for the server (option `offline`), oldest first. */
  get queued(): readonly QueuedCommand[] {
    return this.queue?.commands ?? [];
  }

  /** Sends the waiting commands in order; resolves to how many still wait because the server is still unreachable. */
  drain(): Promise<number> {
    return this.queue ? this.queue.drain() : Promise.resolve(0);
  }

  /** Follows the queue: a command queued, sent, or refused by the server when it finally went out. */
  onQueue(fn: (e: QueueEvent) => void): () => void {
    return this.queue ? this.queue.subscribe(fn) : () => {};
  }

  /** Stream items; ends when the server sends fin or the signal aborts. */
  stream<T = unknown>(op: string, args: Record<string, unknown> = {}, o: OpOptions & { signal?: AbortSignal } = {}): AsyncIterable<T> {
    const client = this;
    return (async function* () {
      const req: RequestOp = client.prepare({ id: 1, op, args, ...pick(o) });
      const sendOpts: { signal?: AbortSignal } = {};
      if (o.signal) sendOpts.signal = o.signal;
      for await (const f of client.opts.transport.send(client.envelope([req]), sendOpts)) {
        if ("item" in f) yield client.cache.denormalize(client.cache.normalize(client.typed(op, f.item))) as T;
        else if ("error" in f) {
          if (f.error.code === "canceled" && o.signal?.aborted) return;
          throw new RayfoldClientError(f.error);
        } else if ("fin" in f && f.fin) return;
      }
    })();
  }

  /**
   * Sends bytes to the server's upload route (extension `upload`) and answers with the handle a command then names:
   *
   *     const kept = await client.upload(file);
   *     await client.command("setAvatar", { userId, upload: kept.id });
   *
   * A `File` says what it is called and what type it is, so those travel unless you say otherwise. Nothing is cached:
   * an upload is bytes going one way, and the command that uses them is what changes anything.
   */
  async upload(body: UploadBody, meta: { name?: string; type?: string } = {}, opts: { signal?: AbortSignal } = {}): Promise<UploadHandle> {
    if (!this.opts.transport.upload) {
      throw new RayfoldClientError({ code: "unimplemented", message: "This transport cannot upload; use a fetch transport, or send the bytes yourself" });
    }
    const named = body as { name?: unknown; type?: unknown };
    const describe = {
      ...(typeof named.name === "string" && named.name ? { name: named.name } : {}),
      ...(typeof named.type === "string" && named.type ? { type: named.type } : {}),
      ...meta,
    };
    return this.opts.transport.upload(body, describe, opts);
  }

  /**
   * Watch a query: `fn` receives the current denormalized data now and again whenever a later command's
   * patch (or another query) changes any entity the result contains. No refetch involved. `onError` gets the
   * initial fetch's failure; without it the failure is dropped.
   */
  watch<T = unknown>(op: string, args: Record<string, unknown>, o: QueryOptions, fn: (data: T) => void, onError?: (e: unknown) => void): () => void {
    const rk = RayfoldCache.resultKey(op, args, o.shape, o.vars);
    let active = true;
    let ready = false; // ignore the cache events produced by the initial fetch itself
    let seen: CachedResult | undefined; // the stored result `fn` last reported
    // This result changed when it was replaced (a refetch), when an entity it holds changed, or when its op was
    // invalidated. Another result of the same op changing is not a reason: the event's `ops` alone would say so.
    const listener: CacheListener = ({ keys, ops }) => {
      const r = this.cache.getResult(rk);
      if (!r || !active || !ready) return;
      const hit = r !== seen || [...keys].some((k) => r.keys.has(k)) || (ops.has(op) && r.stale);
      if (!hit) return;
      seen = r;
      fn(this.cache.denormalize(r.data) as T);
    };
    const off = this.cache.subscribe(listener);
    void this.query<T>(op, args, o).then(
      (d) => {
        ready = true;
        seen = this.cache.getResult(rk);
        if (active) fn(d);
      },
      (e: unknown) => {
        if (active) onError?.(e);
      },
    );
    return () => {
      active = false;
      off();
    };
  }

  /**
   * Live query (extension `live`): the server keeps the query open and pushes patches. `fn` receives the
   * current data now and after every server-side change. `onError` gets an error frame or a failed connection
   * (not the abort from unsubscribing), with `retrying` saying whether the query is being opened again: a server
   * going away or a connection dropping ends it with a retryable error, and it is reopened after a short wait
   * (half a second, doubling to thirty) through whatever is in front of the servers, so the subscription outlives a
   * deploy. Only an error that would recur ends it. Returns an unsubscribe function.
   */
  live<T = unknown>(op: string, args: Record<string, unknown>, o: OpOptions, fn: (data: T, meta: { initial: boolean }) => void, onError?: (e: unknown, meta: { retrying: boolean }) => void): () => void {
    const ac = new AbortController();
    const rk = RayfoldCache.resultKey(op, args, o.shape, o.vars);
    let initial = true;
    let failures = 0;
    const open = () => {
      if (ac.signal.aborted) return;
      let ended = false;
      const failed = (e: unknown) => {
        if (ended || ac.signal.aborted) return;
        ended = true;
        const retrying = !(e instanceof RayfoldClientError) || e.retryable;
        onError?.(e, { retrying });
        if (!retrying) return;
        const timer = setTimeout(open, Math.min(30_000, 500 * 2 ** failures++));
        ac.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      };
      const b = this.batch();
      const h = b.query<T>(op, args, { ...o, live: true });
      void b
        .run({
          signal: ac.signal,
          onFrame: (f) => {
            if (!("id" in f) || f.id !== h.id) return;
            if ("error" in f) {
              // after unsubscribing, the stream ends with a "canceled" frame: that is the stop, not a failure
              failed(new RayfoldClientError(f.error));
              return;
            }
            if (("data" in f && !("at" in f)) || "patch" in f || "fin" in f) {
              failures = 0; // the connection is good again
              const r = this.cache.getResult(rk);
              if (!r) return;
              fn(this.cache.denormalize(r.data) as T, { initial });
              initial = false;
            }
          },
        })
        .catch(failed);
    };
    open();
    return () => ac.abort();
  }

  /** @internal */
  envelope(ops: RequestOp[]): RequestEnvelope {
    const env: RequestEnvelope = { rayfold: "0.1", ops };
    const meta: RequestEnvelope["meta"] = {};
    if (this.opts.client) meta.client = this.opts.client;
    if (this.opts.deadline !== undefined) meta.deadline = this.opts.deadline;
    if (Object.keys(meta).length) env.meta = meta;
    return env;
  }

  /** @internal */
  async runBatch(handles: OpHandle[], opts: { signal?: AbortSignal; onFrame?: (f: Frame) => void }): Promise<BatchResult> {
    const byId = new Map(handles.map((h) => [h.id, h]));
    // a live query never goes out as a safe read: servers up to 0.2.1 buffer a safe request whole, and one never ends
    const safe = handles.every((h) => this.isQuery(h.req.op) && h.req.live !== true);
    const sendOpts: { signal?: AbortSignal; safe?: boolean } = { safe };
    if (opts.signal) sendOpts.signal = opts.signal;
    const frames: Frame[] = [];
    const settled = new Set<number>();
    const resultKeys = new Map<number, string>();
    for (const h of handles) resultKeys.set(h.id, RayfoldCache.resultKey(h.req.op, h.req.args, h.req.shape, h.req.vars));
    const resolve = (h: OpHandle, v: unknown) => {
      settled.add(h.id);
      h._resolve(v);
    };
    const reject = (h: OpHandle, e: unknown) => {
      settled.add(h.id);
      h._reject(e);
    };
    try {
      for await (const f of this.opts.transport.send(this.envelope(handles.map((h) => h.req)), sendOpts)) {
        frames.push(f);
        if (!("id" in f)) {
          const err = new RayfoldClientError(f.error);
          for (const h of handles) if (!settled.has(h.id)) reject(h, err);
          opts.onFrame?.(f);
          continue;
        }
        const h = byId.get(f.id);
        if (!h) continue;
        h.frames.push(f);
        if ("error" in f) {
          const current = f.error.type === "VersionConflict" ? (f.error.data as { current?: unknown } | undefined)?.current : undefined;
          if (current) this.cache.mergeEntities(current);
          reject(h, new RayfoldClientError(f.error));
        } else if ("ok" in f) {
          let r!: ReturnType<RayfoldCache["putResult"]>;
          this.cache.transaction(() => {
            r = this.cache.putResult(resultKeys.get(h.id)!, h.req.op, this.typed(h.req.op, f.ok));
            if (f.patch) this.cache.applyPatch(f.patch as PatchOp[]);
          });
          resolve(h, this.cache.denormalize(r.data));
        } else if ("data" in f && !("at" in f)) {
          const r = this.cache.putResult(resultKeys.get(h.id)!, h.req.op, this.typed(h.req.op, f.data));
          if (f.fin) resolve(h, this.cache.denormalize(r.data));
        } else if ("at" in f) {
          this.cache.mergeAt(resultKeys.get(h.id)!, f.at, this.typed(h.req.op, f.data, f.at));
        } else if ("patch" in f) {
          // a live update: `at` and `list` ops describe this op's own stored result
          this.cache.applyPatch(f.patch as PatchOp[], resultKeys.get(h.id)!);
        } else if ("fin" in f && f.fin && !settled.has(h.id)) {
          const r = this.cache.getResult(resultKeys.get(h.id)!);
          resolve(h, r ? this.cache.denormalize(r.data) : undefined);
        }
        opts.onFrame?.(f); // after the cache has absorbed the frame
      }
    } catch (e) {
      for (const h of handles) if (!settled.has(h.id)) reject(h, e);
      throw e;
    }
    for (const h of handles) if (!settled.has(h.id)) reject(h, new RayfoldClientError({ code: "unavailable", message: "Batch ended without a result for this op" }));
    return { frames };
  }

  private readonly opKinds = new Map<string, "query" | "other">();
  private readonly schema: RayfoldSchemaIR | undefined;
  /** Ops are assumed safe when the transport is used with a schema-aware hint; default: name-based heuristic overridden by `markQueries`. */
  private isQuery(op: string): boolean {
    return this.opKinds.get(op) === "query";
  }
  /** Tell the client which op names are queries so all-query batches go over the safe method. */
  markQueries(names: string[]): void {
    for (const n of names) this.opKinds.set(n, "query");
  }
}

function pick(o: OpOptions): Partial<RequestOp> {
  const out: Partial<RequestOp> = {};
  if (o.shape !== undefined) out.shape = o.shape;
  if (o.vars !== undefined) out.vars = o.vars as never;
  if (o.key !== undefined) out.key = o.key;
  if (o.deadline !== undefined) out.deadline = o.deadline;
  if (o.simulate !== undefined) out.simulate = o.simulate;
  if (o.live !== undefined) out.live = o.live;
  if (o.ifVersion !== undefined) out.ifVersion = o.ifVersion;
  return out;
}

/** A field's `@merge` policy from the schema, memoised; without a schema there is no policy to read. */
function mergePolicyOf(schema: RayfoldSchemaIR | undefined): (type: string, field: string) => MergePolicy | undefined {
  if (!schema) return () => undefined;
  const seen = new Map<string, MergePolicy | undefined>();
  return (type, field) => {
    const key = `${type}.${field}`;
    if (seen.has(key)) return seen.get(key);
    const def = schema.types[type];
    const f = def && "fields" in def ? def.fields.find((x) => x.name === field) : undefined;
    const value = f ? annotation(f, "merge")?.args["value"] : undefined;
    const policy = value && typeof value === "object" && "$ident" in value ? (String((value as { $ident: string }).$ident) as MergePolicy) : undefined;
    seen.set(key, policy);
    return policy;
  };
}
