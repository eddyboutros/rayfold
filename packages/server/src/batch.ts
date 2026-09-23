/** Batch scheduling: dependency waves, serial commands, deadlines, idempotency. Spec: spec/03. */
import type { Instrumentation, Outcome } from "./instrumentation.ts";
import { annotation, baseName, hashJson, isShapeId, type OpDef, type RayfoldSchemaIR, type Shape, type TypeRef } from "@rayfold/schema";
import { coerceArgs, collectRefs, getPath, resolveRefs } from "./args.ts";
import { EventBus, MemoryIdempotencyStore, type IdempotencyClaim, type IdempotencyRecord, type IdempotencyStore, type RayfoldContext } from "./context.ts";
import { estimateCost } from "./cost.ts";
import { compactQueryFrame, type Executor } from "./executor.ts";
import { RayfoldError, VersionConflict, toWireError, type Frame, type RequestEnvelope, type RequestMeta, type RequestOp, type WireError } from "./protocol.ts";
import { resolveRequestShape, type ShapeRegistry } from "./views.ts";
import type { UsageSink } from "./usage.ts";
import type { Counters } from "./counters.ts";
import { capabilityAllows } from "./capability-scope.ts";
import type { Change } from "./live.ts";
import { ChangeBus, changeFromPatch, diffResults, foldFrames, readSetOf } from "./live.ts";

export interface BatchOptions {
  trustedShapes: boolean;
  budget: number;
  maxOps: number;
  maxDepth: number;
  maxFields: number;
  /** Items one stream op may yield before it fails with `resource_exhausted` (spec 04 §5). */
  maxStreamItems: number;
  timing: boolean;
  now: () => number;
}

export interface BatchRuntime {
  ir: RayfoldSchemaIR;
  executor: Executor;
  registry: ShapeRegistry;
  idempotency: IdempotencyStore;
  events: EventBus;
  changes: ChangeBus;
  options: BatchOptions;
  instrumentation?: Instrumentation;
  /** Records which operations each client called (spec 11). */
  usage?: UsageSink;
  /** Counts what the server did, for an operator. */
  counters?: Counters;
  /** How long a command holds its idempotency key before another server may take it over (spec 03 section 4). */
  leaseMs: number;
  /** Aborts when the server is shutting down: live queries and streams end on it, with its reason. */
  draining: AbortSignal;
}

export interface ExecuteOptions {
  viewer?: unknown;
  signal?: AbortSignal;
  /**
   * Set by transports whose HTTP method is itself idempotent (PUT, PATCH, DELETE bindings): commands may run
   * without an idempotency key. Never settable from the wire envelope.
   */
  keyOptional?: boolean;
  /** @internal Set by the batch itself: the memo every op of this request shares. Never read from the wire. */
  batchState?: Map<string, unknown>;
}

/** Unbounded async queue of frames; `close()` ends iteration once drained. */
export class FrameSink implements AsyncIterable<Frame> {
  private readonly queue: Frame[] = [];
  private waiting: ((r: IteratorResult<Frame>) => void) | null = null;
  private closed = false;
  private readonly ended = new Set<number>();
  readonly frames: Frame[] = [];

  push(f: Frame): void {
    if (this.closed) return;
    // spec 04 §2: one terminal frame per op. A command that emitted `ok` with `fin` and then failed while recording
    // its idempotency record or publishing its change reached the failure path and pushed a second one for the same
    // id, so the guard belongs here rather than at each of those call sites.
    const id = (f as { id?: unknown }).id;
    if (typeof id === "number") {
      if (this.ended.has(id)) return;
      if ((f as { fin?: unknown }).fin === true) this.ended.add(id);
    }
    this.frames.push(f);
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: f, done: false });
    } else this.queue.push(f);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined as never, done: true });
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<Frame> {
    return {
      next: (): Promise<IteratorResult<Frame>> => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => (this.waiting = res));
      },
      return: (): Promise<IteratorResult<Frame>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

interface Planned {
  req: RequestOp;
  op: OpDef;
  shape: Shape;
  explicit: boolean;
  deps: number[];
  cost: number;
  /** pre-execution failure, reported when the op's turn comes */
  failure?: RayfoldError;
}

export function executeBatch(rt: BatchRuntime, envelope: RequestEnvelope, opts: ExecuteOptions = {}): AsyncIterable<Frame> {
  const sink = new FrameSink();
  void run(rt, envelope, opts, sink).catch((e) => {
    sink.push({ error: toWireError(e), fin: true });
    sink.close();
  });
  return sink;
}

async function run(rt: BatchRuntime, envelope: RequestEnvelope, opts: ExecuteOptions, sink: FrameSink): Promise<void> {
  const hook = rt.instrumentation?.batch;
  if (!hook) {
    await runBatch(rt, envelope, opts, sink);
    return;
  }
  const meta = envelope && typeof envelope === "object" && envelope.meta && typeof envelope.meta === "object" ? envelope.meta : {};
  await hook({ ops: Array.isArray(envelope?.ops) ? envelope.ops.length : 0, meta }, () => runBatch(rt, envelope, opts, sink));
}

async function runBatch(rt: BatchRuntime, envelope: RequestEnvelope, opts: ExecuteOptions, sink: FrameSink): Promise<Outcome> {
  const batchError = (e: WireError): Outcome => {
    sink.push({ error: e, fin: true });
    sink.close();
    return { error: e };
  };

  // ---- envelope validation (batch-level failures, spec 05 §6)
  const v = validateEnvelope(rt, envelope);
  if (v) return batchError(v);

  // ---- plan every op up front: shape, cost, deps
  const planned: Planned[] = [];
  let total = 0;
  for (const req of envelope.ops) {
    const op = rt.ir.ops[req.op]!;
    const deps = [...collectRefs(req.args ?? {})].filter((d) => Number.isFinite(d));
    const p: Planned = { req, op, shape: { items: [] }, explicit: req.shape !== undefined, deps, cost: 0 };
    try {
      p.shape = resolveRequestShape(rt.ir, req.shape, op.returns, rt.registry, rt.options.trustedShapes);
      // Estimate on the arguments the op would run with. Arguments that fail validation mean the op never runs, so it
      // costs nothing (and reports its error when its turn comes). Only args with $ref, known after earlier ops, are
      // estimated from the raw request, where any page size the model cannot trust counts as the largest page.
      const raw = (req.args ?? {}) as Record<string, unknown>;
      const planArgs = deps.length ? raw : coerceArgs(rt.ir, op.args, raw, `${op.name}()`);
      const est = estimateCost(rt.ir, op, planArgs, p.shape, req.vars ?? {});
      if (est.depth > rt.options.maxDepth) throw new RayfoldError("resource_exhausted", `Shape depth ${est.depth} exceeds ${rt.options.maxDepth}`);
      if (est.fields > rt.options.maxFields) throw new RayfoldError("resource_exhausted", `Shape selects ${est.fields} fields, max ${rt.options.maxFields}`);
      p.cost = est.cost;
      total += est.cost;
      // Only a shape that passed every check is remembered, so rejected shapes cannot fill the registry.
      if (req.shape !== undefined && !isShapeId(req.shape)) rt.registry.register(p.shape);
    } catch (e) {
      p.failure = e instanceof RayfoldError ? e : new RayfoldError("internal", "Planning failed");
    }
    planned.push(p);
  }
  if (total > rt.options.budget) {
    return batchError({ code: "resource_exhausted", message: `Batch cost ${total} exceeds budget ${rt.options.budget}`, data: { cost: total, budget: rt.options.budget } });
  }

  // ---- deadline / cancellation
  const batchAbort = new AbortController();
  const onOuterAbort = () => batchAbort.abort(new RayfoldError("canceled", "Canceled"));
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (opts.signal?.aborted) onOuterAbort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (envelope.meta?.deadline !== undefined) {
    timer = setTimeout(() => batchAbort.abort(new RayfoldError("deadline_exceeded", "Batch deadline exceeded")), envelope.meta.deadline);
  }

  // One memo for the whole batch: a field loaded for an entity by one op is not loaded again by another.
  const scoped: ExecuteOptions = { ...opts, batchState: new Map<string, unknown>() };
  const results = new Map<number, unknown>();
  const status = new Map<number, "ok" | "failed">();
  const done = new Map<number, Promise<void>>();
  const resolvers = new Map<number, () => void>();
  for (const p of planned) done.set(p.req.id, new Promise<void>((res) => resolvers.set(p.req.id, res)));

  // Commands run one at a time in ascending id order (spec 03 §3); everything else runs as soon as its refs resolve.
  let prevCommand: Promise<void> = Promise.resolve();
  const viewerScope = hashJson(opts.viewer ?? null);

  const tasks = [...planned]
    .sort((a, b) => a.req.id - b.req.id)
    .map((p) => {
      const gate = p.op.kind === "command" ? prevCommand : Promise.resolve();
      const task = (async () => {
        await Promise.all(p.deps.map((d) => done.get(d) ?? Promise.resolve()));
        await gate;
        await runOne(rt, p, envelope.meta ?? {}, scoped, batchAbort.signal, viewerScope, results, status, sink);
        resolvers.get(p.req.id)!();
      })();
      if (p.op.kind === "command") prevCommand = task;
      return task;
    });
  await Promise.all(tasks);
  if (timer) clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onOuterAbort);
  sink.close();
  return {};
}

function validateEnvelope(rt: BatchRuntime, envelope: RequestEnvelope): WireError | null {
  const bad = (message: string): WireError => ({ code: "invalid_argument", message });
  if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.ops)) return bad("Body must be { ops: [...] }");
  if (envelope.ops.length === 0) return bad("ops must not be empty");
  if (envelope.ops.length > rt.options.maxOps) return { code: "resource_exhausted", message: `At most ${rt.options.maxOps} ops per batch` };
  if (envelope.meta?.deadline !== undefined && !validDeadline(envelope.meta.deadline)) return bad(`meta.deadline: expected whole milliseconds from 0 to ${MAX_DEADLINE_MS}`);
  const ids = new Set<number>();
  for (const [i, req] of envelope.ops.entries()) {
    if (!req || typeof req !== "object") return bad(`ops[${i}]: expected an object`);
    if (!Number.isInteger(req.id) || req.id <= 0) return bad(`ops[${i}].id: expected a positive integer`);
    if (ids.has(req.id)) return bad(`ops[${i}].id: duplicate id ${req.id}`);
    ids.add(req.id);
    if (typeof req.op !== "string" || !rt.ir.ops[req.op]) return bad(`ops[${i}].op: unknown operation ${JSON.stringify(req.op)}`);
    if (req.args !== undefined && (req.args === null || typeof req.args !== "object" || Array.isArray(req.args))) return bad(`ops[${i}].args: expected an object`);
    if (req.shape !== undefined && typeof req.shape !== "string") return bad(`ops[${i}].shape: expected a string`);
    // Checked before anything walks the values recursively.
    if (tooDeep(req.args, MAX_NESTING)) return bad(`ops[${i}].args: nested deeper than ${MAX_NESTING} levels`);
    if (tooDeep(req.vars, MAX_NESTING)) return bad(`ops[${i}].vars: nested deeper than ${MAX_NESTING} levels`);
    for (const d of collectRefs(req.args ?? {})) {
      if (!Number.isInteger(d) || d <= 0) return bad(`ops[${i}].args: bad $ref`);
      if (d >= req.id) return bad(`ops[${i}].args: $ref to op ${d} must point to an earlier op`);
      if (!ids.has(d)) return bad(`ops[${i}].args: $ref to unknown op ${d}`);
    }
    if (req.live && rt.ir.ops[req.op]!.kind !== "query") return bad(`ops[${i}].live: only queries can be live`);
    // `@live(false)` opts a query out: a search whose every keystroke would re-run it, say. Declared in the schema
    // and enforced nowhere, so the runtime opened it live anyway.
    if (req.live && annotation(rt.ir.ops[req.op]!, "live")?.args["value"] === false) {
      return bad(`ops[${i}].live: ${req.op} is declared @live(false)`);
    }
  }
  return null;
}

async function runOne(
  rt: BatchRuntime,
  p: Planned,
  meta: RequestMeta,
  opts: ExecuteOptions,
  batchSignal: AbortSignal,
  viewerScope: string,
  results: Map<number, unknown>,
  status: Map<number, "ok" | "failed">,
  sink: FrameSink,
): Promise<void> {
  const hook = rt.instrumentation?.op;
  // Counted whether or not an Instrumentation hook was configured: an operator asking "what is this server doing"
  // should not first have to wire up tracing.
  const counted = async (): Promise<WireError | undefined> => {
    const error = await runOp(rt, p, meta, opts, batchSignal, viewerScope, results, status, sink);
    rt.counters?.add("rayfold.ops", 1, { kind: p.op.kind, outcome: error ? error.code : "ok" });
    // A declared error is `domain` on the wire and its name lives in `type`, so counting the code alone would put
    // every one of a schema's declared errors in the same bucket. Both labels come from the schema, so the series
    // stay bounded by it.
    if (error) rt.counters?.add("rayfold.errors", 1, { op: p.op.name, code: error.code, type: error.type ?? "" });
    return error;
  };
  if (!hook) {
    await counted();
    return;
  }
  await hook({ id: p.req.id, name: p.op.name, kind: p.op.kind, cost: p.cost }, async () => {
    const error = await counted();
    return error ? { error } : {};
  });
}

/** Takes the key for this command, waiting for whoever holds it, and giving up when the op is cancelled. */
async function claimKey(rt: BatchRuntime, scope: string, key: string, signal: AbortSignal): Promise<Extract<IdempotencyClaim, { state: "owned" } | { state: "done" }>> {
  const backoff = [50, 100, 200, 400, 500];
  for (let attempt = 0; ; attempt++) {
    const claim = await rt.idempotency.claim(scope, key, rt.leaseMs);
    if (claim.state !== "inflight") return claim;
    if (signal.aborted) throw signal.reason;
    // Whoever holds it may be another server, so waiting means asking again; a store in this process wakes us sooner.
    const woken = rt.idempotency instanceof MemoryIdempotencyStore ? rt.idempotency.settled(scope, key) : undefined;
    // The wait ends on the backoff, when the holder settles (a store in this process), or the moment the op is cancelled.
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, backoff[Math.min(attempt, backoff.length - 1)]);
      signal.addEventListener("abort", done, { once: true });
      void woken?.then(done);
    });
    if (signal.aborted) throw signal.reason;
  }
}

/** Runs one op and sends its frames; resolves to the error it failed with, if it failed. */
async function runOp(
  rt: BatchRuntime,
  p: Planned,
  meta: RequestMeta,
  opts: ExecuteOptions,
  batchSignal: AbortSignal,
  viewerScope: string,
  results: Map<number, unknown>,
  status: Map<number, "ok" | "failed">,
  sink: FrameSink,
): Promise<WireError | undefined> {
  const id = p.req.id;
  const started = rt.options.now();
  const fail = (e: unknown): WireError => {
    let w = toWireError(e);
    if (batchSignal.aborted && batchSignal.reason instanceof RayfoldError) w = batchSignal.reason.toWire();
    sink.push({ id, error: w, fin: true });
    status.set(id, "failed");
    return w;
  };
  if (p.failure) return fail(p.failure);
  for (const d of p.deps) {
    if (status.get(d) !== "ok") {
      return fail(new RayfoldError("failed_precondition", `Depends on op ${d}, which failed`, { type: "DependencyFailed", data: { op: d } }));
    }
  }
  if (batchSignal.aborted) return fail(batchSignal.reason);
  if (p.req.deadline !== undefined && !validDeadline(p.req.deadline)) return fail(new RayfoldError("invalid_argument", `deadline: expected whole milliseconds from 0 to ${MAX_DEADLINE_MS}`));

  const opAbort = new AbortController();
  const relay = () => opAbort.abort(batchSignal.reason);
  batchSignal.addEventListener("abort", relay, { once: true });
  let opTimer: ReturnType<typeof setTimeout> | undefined;
  if (p.req.deadline !== undefined) opTimer = setTimeout(() => opAbort.abort(new RayfoldError("deadline_exceeded", "Deadline exceeded")), p.req.deadline);
  // A live query or a stream ends only when its caller goes away, so a server shutting down ends it here, with a
  // retryable error that sends the client to another server. Anything shorter is left to finish.
  const longLived = p.op.kind === "stream" || p.req.live === true;
  const onDrain = () => opAbort.abort(rt.draining.reason);
  if (longLived) {
    if (rt.draining.aborted) onDrain();
    else rt.draining.addEventListener("abort", onDrain, { once: true });
  }

  const stamp = (f: Frame): Frame => {
    if (rt.options.timing && "meta" in f && f.meta) f.meta.ms = rt.options.now() - started;
    return f;
  };

  try {
    const rawArgs = resolveRefs(p.req.args ?? {}, (opId, path) => getPath(results.get(opId), path), `ops.${id}.args`);
    const args = coerceArgs(rt.ir, p.op.args, rawArgs, `${p.op.name}()`);
    const ctx: RayfoldContext = {
      viewer: opts.viewer ?? null,
      signal: opAbort.signal,
      simulate: !!p.req.simulate,
      events: rt.events,
      meta,
      opId: id,
      opName: p.op.name,
      policy: {},
      shape: p.shape,
      state: new Map(),
      batch: opts.batchState ?? new Map(),
      now: rt.options.now,
      checkVersion(key, actual, current) {
        const want = ctx.ifVersion;
        if (want === undefined) return;
        if (String(actual) !== String(want)) throw new VersionConflict(key, want, actual, current);
      },
    };
    // A capability token may call only the operations it names (spec 06 section 6); any other viewer is left to
    // the schema's own policies.
    if (!capabilityAllows(opts.viewer, p.op.name)) {
      throw new RayfoldError("permission_denied", `This capability does not allow ${p.op.name}()`);
    }
    rt.usage?.record({ op: p.op.name, path: "", client: String(meta.client ?? "") }, rt.options.now());
    if (p.req.ifVersion !== undefined) ctx.ifVersion = p.req.ifVersion;
    if (p.req.vars) ctx.vars = p.req.vars;
    if (p.req.compact) ctx.compact = true;

    switch (p.op.kind) {
      case "query": {
        if (p.req.live) {
          await runLive(rt, p, args, ctx, sink, stamp, results);
          break;
        }
        const data = await rt.executor.runQuery(p.op, args, p.shape, p.explicit, p.cost, ctx, (f) => sink.push(stamp(f)));
        results.set(id, data);
        break;
      }
      case "stream":
        await rt.executor.runStream(p.op, args, p.shape, p.explicit, ctx, (f) => sink.push(stamp(f)), rt.options.maxStreamItems);
        break;
      case "command": {
        const idem = annotation(p.op, "idempotent");
        const optedOut = idem !== undefined && idem.args["value"] === false;
        const key = p.req.key;
        if (!optedOut && !(opts.keyOptional && key === undefined) && (typeof key !== "string" || key.length < 16 || key.length > 128)) {
          throw new RayfoldError("invalid_argument", `${p.op.name}(): commands require an idempotency key of 16-128 characters`);
        }
        rt.executor.authorize(p.op, args, ctx); // the write policy holds before anything is replayed
        if (ctx.simulate && !annotation(p.op, "simulate")) throw new RayfoldError("failed_precondition", `${p.op.name}() does not support dry runs`);
        if (key && !ctx.simulate && (opts.viewer === null || opts.viewer === undefined)) {
          // Anonymous callers cannot be told apart, so they would share one replay scope (spec 12 section 4).
          throw new RayfoldError("unauthenticated", `${p.op.name}(): idempotency keys need an identified caller`);
        }
        // Bound to the operation as well as the arguments: a key can never replay another command's result.
        const argsHash = hashJson({ op: p.op.name, args });
        const keyed = key !== undefined && !ctx.simulate;
        const replayed = (record: IdempotencyRecord): WireError | undefined => {
          if (record.argsHash !== argsHash) throw new RayfoldError("already_exists", `Idempotency key ${key} was used for another operation or other arguments`);
          const stored = p.req.compact && record.compactFrame !== undefined ? record.compactFrame : record.frame;
          const replay = structuredClone(stored) as Frame & { meta?: Record<string, unknown> };
          replay.meta = { ...(replay.meta ?? {}), replay: true };
          (replay as { id: number }).id = id; // a retry may use another op id; the answer belongs to this op
          sink.push(stamp(replay));
          // A command that failed after committing records its failure (spec 12 section 4.4), so that failure is what
          // the retry gets: it ends this op the way the first run ended, rather than passing as a success whose
          // dependants then read nothing.
          const failure = (replay as { error?: WireError }).error;
          if (failure) {
            status.set(id, "failed");
            return failure;
          }
          results.set(id, (replay as { ok?: unknown }).ok);
          return undefined;
        };

        // One execution per key, however many servers share the store: one caller owns the key and the others wait
        // for it, then replay its result (spec 03 section 4, spec 12 section 4.4).
        let token: string | undefined;
        if (keyed) {
          const held = await claimKey(rt, viewerScope, key as string, ctx.signal);
          rt.counters?.add("rayfold.idempotency", 1, { claim: held.state });
          if (held.state === "done") {
            const failure = replayed(held.record);
            if (failure) return failure; // its error frame is already sent, so this is not `fail()`'s to send again
            break;
          }
          token = held.token;
        }
        const renewal = token === undefined ? undefined : setInterval(() => void rt.idempotency.renew(viewerScope, key as string, token as string, rt.leaseMs), Math.max(1, Math.floor(rt.leaseMs / 3)));
        let committed = false;
        try {
          const { result, full, compact, patch } = await rt.executor.runCommand(p.op, args, p.shape, p.explicit, p.cost, ctx, (f) => sink.push(stamp(f)), () => (committed = true));
          results.set(id, result);
          if (token !== undefined) await rt.idempotency.put(viewerScope, key as string, { argsHash, frame: structuredClone(full), compactFrame: structuredClone(compact), at: rt.options.now() }, token);
          if (!ctx.simulate) rt.changes.publish(changeFromPatch(patch));
        } catch (e) {
          // A command that failed before it changed anything leaves no record, so a retry runs it. One that failed
          // after its effect records the failure, so a retry is answered with it instead of running the command again.
          if (token !== undefined) {
            if (committed) {
              // The op ended after the effect happened. Recording its `deadline_exceeded` would tell the retry that
              // nothing happened, and that code is retryable, so the client would run the effect again under a fresh
              // key. The record says the command committed instead (spec 12 section 4.4).
              const ended = ctx.signal.aborted
                ? new RayfoldError("canceled", `${p.op.name}() committed, then the op ended before its result was delivered`)
                : e;
              const failure: Frame = { id, error: toWireError(ended), fin: true };
              await rt.idempotency.put(viewerScope, key as string, { argsHash, frame: failure, compactFrame: failure, at: rt.options.now() }, token);
            } else await rt.idempotency.release(viewerScope, key as string, token);
          }
          throw e;
        } finally {
          if (renewal) clearInterval(renewal);
        }
        break;
      }
    }
    status.set(id, "ok");
  } catch (e) {
    return fail(e);
  } finally {
    if (opTimer) clearTimeout(opTimer);
    batchSignal.removeEventListener("abort", relay);
    rt.draining.removeEventListener("abort", onDrain);
  }
  return undefined;
}


/**
 * Live query loop: first result, then re-run on intersecting changes until the op is aborted.
 * Frames: data (no fin) -> [patch | data]* -> error(canceled)/fin.
 */
async function runLive(
  rt: BatchRuntime,
  p: Planned,
  args: Record<string, unknown>,
  ctx: RayfoldContext,
  sink: FrameSink,
  stamp: (f: Frame) => Frame,
  results: Map<number, unknown>,
): Promise<void> {
  const id = p.req.id;
  // Read sets and diffs need `$type`, so the query always runs in full form; compaction happens on the way out.
  const runCtx: RayfoldContext = ctx.compact ? { ...ctx, compact: false } : ctx;
  const wire = (f: Frame): Frame => (ctx.compact ? compactQueryFrame(f) : f);
  // The first run shares the batch's loader memo like any op; a re-run gets a fresh one. The memo remembers a field's
  // load per entity, and a re-run exists to read what changed: with the memo kept, a loaded field would come back as
  // it was on the first run for as long as the query stayed open.
  let first = true;
  const collect = async (): Promise<{ frames: Frame[]; data: unknown }> => {
    const frames: Frame[] = [];
    const runIn = first ? runCtx : { ...runCtx, batch: new Map<string, unknown>() };
    first = false;
    await rt.executor.runQuery(p.op, args, p.shape, p.explicit, p.cost, runIn, (f) => frames.push(f));
    return { frames, data: foldFrames(frames) };
  };
  // Entity types reachable from the result type: a new entity of such a type may change membership.
  const typeSet = reachableEntityTypes(rt.ir, p.op.returns);
  let readSet = new Set<string>();
  let dirty = false;
  let running = false;
  let wake: (() => void) | null = null;
  const hits = (c: Change): boolean =>
    c.ops.has(p.op.name) || [...c.keys].some((k) => readSet.has(k) || typeSet.has(k.slice(0, k.indexOf(":"))));
  // Subscribing after the first read would drop anything committed while it ran: the result the client gets is
  // already stale, and no later change is obliged to touch the same rows again, so the screen stays wrong
  // indefinitely. There is no read set to judge those changes against yet, so hold them until there is.
  let held: Change[] | null = [];
  const off = rt.changes.subscribe((c) => {
    if (held) {
      held.push(c);
      return;
    }
    if (!hits(c)) return;
    dirty = true;
    wake?.();
  });
  const onAbort = () => wake?.();
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const first = await collect();
    let current = first.data;
    readSet = readSetOf(current);
    const duringFirst = held;
    held = null;
    if (duringFirst.some(hits)) dirty = true;
    for (const f0 of first.frames) {
      const f = wire(f0);
      if ("fin" in f && f.fin && !("data" in f) && !("error" in f)) continue; // keep the op open
      if ("data" in f && !("at" in f)) {
        const { fin: _fin, ...rest } = f as { fin?: boolean } & Record<string, unknown>;
        sink.push(stamp(rest as Frame));
      } else sink.push(stamp(f));
    }
    results.set(id, current);
    rt.counters?.add("rayfold.live.opened", 1, { op: p.op.name });

    while (!ctx.signal.aborted) {
      if (!dirty) await new Promise<void>((res) => (wake = res));
      wake = null;
      if (ctx.signal.aborted) break;
      if (!dirty || running) continue;
      dirty = false;
      running = true;
      rt.counters?.add("rayfold.live.reran", 1, { op: p.op.name });
      try {
        const next = await collect();
        const d = diffResults(current, next.data);
        current = next.data;
        readSet = readSetOf(current);
        results.set(id, current);
        if (d && "patch" in d) sink.push(stamp({ id, patch: d.patch }));
        else if (d) sink.push(stamp(wire({ id, data: d.data, meta: { cost: p.cost } })));
      } finally {
        running = false;
      }
    }
  } finally {
    off();
    ctx.signal.removeEventListener("abort", onAbort);
    rt.counters?.add("rayfold.live.closed", 1, { op: p.op.name });
  }
  throw ctx.signal.reason instanceof RayfoldError ? ctx.signal.reason : new RayfoldError("canceled", "Canceled");
}

function reachableEntityTypes(ir: RayfoldSchemaIR, root: TypeRef, maxDepth = 4): Set<string> {
  const out = new Set<string>();
  const visit = (t: TypeRef, depth: number): void => {
    const name = baseName(t);
    const def = ir.types[name];
    if (!def || depth > maxDepth) return;
    if (def.kind === "entity") {
      if (out.has(name)) return;
      out.add(name);
    }
    if ("fields" in def) for (const f of def.fields) visit(f.type, depth + 1);
    if (def.kind === "union") for (const m of def.members) visit({ kind: "named", name: m, nullable: false }, depth + 1);
    if (t.kind === "named" && t.args) for (const a of t.args) visit(a, depth);
  };
  visit(root, 0);
  return out;
}

/** Nesting limit for args and vars, checked before anything walks them recursively. */
const MAX_NESTING = 64;
/** Longest deadline a client may ask for. */
const MAX_DEADLINE_MS = 600_000;

function validDeadline(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_DEADLINE_MS;
}

/** Iterative, so hostile nesting cannot overflow the stack while it is being measured. */
function tooDeep(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (d >= max) return true;
    for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) stack.push([x, d + 1]);
  }
  return false;
}
