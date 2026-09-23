/**
 * Operation execution and shape projection.
 * Level-wise batching: every field of every object at one nesting level is resolved with one loader
 * call, across lists and pages, so N+1 cannot occur (spec 01 §4 @load, spec 02).
 */
import type { Instrumentation } from "./instrumentation.ts";
import {
  annotation,
  base64urlBytes,
  baseName,
  fieldsOf,
  type Annotation,
  type FieldDef,
  type OpDef,
  type RayfoldSchemaIR,
  type Shape,
  type ShapeItem,
  type ShapeValue,
  type TypeDef,
  type TypeRef,
} from "@rayfold/schema";
import { coerceArgs } from "./args.ts";
import type { RayfoldContext , PolicyHint } from "./context.ts";
import { decide, decisionError, pushableFilter } from "./policy.ts";
import { RayfoldError, VersionConflict, toWireError, type Frame, type PatchOp, type WireError } from "./protocol.ts";
import type { UsageSink } from "./usage.ts";
import { defaultShape, isScalarLike } from "./views.ts";

/** Where the loads of a batch are remembered in `ctx.batch`, beside anything resolvers keep there. */
const LOADS = "rayfold.loads";

export type FieldResolver<P = unknown, A = Record<string, unknown>, R = unknown> = (
  parents: P[],
  args: A,
  ctx: RayfoldContext<never>,
) => R[] | Promise<R[]>;
export type SingleFieldResolver<P = unknown, A = Record<string, unknown>, R = unknown> = (
  parent: P,
  args: A,
  ctx: RayfoldContext<never>,
) => R | Promise<R>;
export type RootResolver<A = Record<string, unknown>, R = unknown> = (args: A, ctx: RayfoldContext<never>) => R | Promise<R>;
export type StreamResolver<A = Record<string, unknown>, R = unknown> = (args: A, ctx: RayfoldContext<never>) => AsyncIterable<R>;

export interface Resolvers {
  Query?: Record<string, RootResolver<never, unknown>>;
  Command?: Record<string, RootResolver<never, unknown>>;
  Stream?: Record<string, StreamResolver<never, unknown>>;
  /** Entity/object field loaders, batch by default: (parents[], args, ctx) => results[] */
  [typeName: string]: Record<string, FieldResolver<never, never, unknown> | SingleFieldResolver<never, never, unknown> | RootResolver<never, unknown> | StreamResolver<never, unknown>> | undefined;
}

const COMMAND_RESULT = Symbol.for("rayfold.commandResult");
export interface CommandResult<R = unknown> {
  [COMMAND_RESULT]: true;
  result: R;
  patch?: PatchOp[];
  emit?: Array<{ event: string; payload: Record<string, unknown> }>;
}
/** Wrap a command's return value to attach extra patches or events. */
export function ok<R>(result: R, extra: { patch?: PatchOp[]; emit?: Array<{ event: string; payload: Record<string, unknown> }> } = {}): CommandResult<R> {
  return { [COMMAND_RESULT]: true, result, ...extra };
}
function isCommandResult(v: unknown): v is CommandResult {
  return !!v && typeof v === "object" && (v as Record<symbol, unknown>)[COMMAND_RESULT] === true;
}

export interface ExecutorOptions {
  maxDepth: number;
  maxFields: number;
  instrumentation?: Instrumentation;
  /** Records which members each client asked for (spec 11). Nothing is recorded without one. */
  usage?: UsageSink;
}

interface Slot {
  value: Record<string, unknown>;
  out: Record<string, unknown>;
  path: string;
  /** Replaces this slot's output in its parent (used when a type-level policy denies it). */
  assign?: (v: unknown) => void;
}

interface DeferredJob {
  slots: Slot[];
  type: TypeRef;
  shape: Shape;
  explicit: boolean;
}

interface ProjectState {
  ctx: RayfoldContext;
  errors: WireError[];
  deferred: DeferredJob[];
  /** true when the caller sent a shape; default views never fail on policy */
  explicit: boolean;
}

type Emit = (frame: Frame) => void;

/** Marks output objects whose `$type` is the only way to know their type (union members). */
const UNION_MEMBER = Symbol.for("rayfold.unionMember");

/** Compact mode: drop `$type` except on union members; keep everything else identical. */
/** Compact form of a query frame (`data` or `at`): `$type` stripped where the schema fixes it, `meta` dropped. */
export function compactQueryFrame(f: Frame): Frame {
  if (!("data" in f)) return f;
  const { meta: _meta, ...rest } = f as Frame & { meta?: unknown };
  return { ...rest, data: stripTypes(f.data) } as Frame;
}

export function stripTypes(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stripTypes);
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    if (k === "$type" && !(o as Record<symbol, unknown>)[UNION_MEMBER]) continue;
    out[k] = stripTypes(x);
  }
  return out;
}

export class Executor {
  constructor(
    private readonly ir: RayfoldSchemaIR,
    private readonly resolvers: Resolvers,
    private readonly opts: ExecutorOptions,
  ) {}

  // ---------------------------------------------------------------- queries

  async runQuery(op: OpDef, args: Record<string, unknown>, shape: Shape, explicit: boolean, cost: number, ctx: RayfoldContext, emit: Emit): Promise<unknown> {
    this.checkOpPolicy(op, "read", args, ctx);
    ctx.policy = this.policyHint(op.returns);
    const fn = this.resolvers.Query?.[op.name];
    if (!fn) throw new RayfoldError("unimplemented", `No resolver for query ${op.name}`);
    const raw = await fn(args as never, ctx as RayfoldContext<never>);
    const st: ProjectState = { ctx, errors: [], deferred: [], explicit };
    const data = await this.projectValue(raw, op.returns, shape, "", st);
    const frame: Frame = ctx.compact ? { id: ctx.opId, data: stripTypes(data) } : { id: ctx.opId, data, meta: { cost } };
    if (st.errors.length) frame.errors = st.errors;
    if (st.deferred.length === 0) frame.fin = true;
    emit(frame);
    await this.flushDeferred(st, emit);
    return data;
  }

  // --------------------------------------------------------------- commands

  async runCommand(
    op: OpDef,
    args: Record<string, unknown>,
    shape: Shape,
    explicit: boolean,
    cost: number,
    ctx: RayfoldContext,
    emit: Emit,
    /** Called once the resolver has returned: from here the command has changed things, whatever happens next. */
    onCommitted?: () => void,
  ): Promise<{ result: unknown; frame: Frame; full: Frame; compact: Frame; patch: PatchOp[] }> {
    this.checkOpPolicy(op, "write", args, ctx);
    const fn = this.resolvers.Command?.[op.name];
    if (!fn) throw new RayfoldError("unimplemented", `No resolver for command ${op.name}`);
    let raw: unknown;
    try {
      raw = await fn(args as never, ctx as RayfoldContext<never>);
    } catch (e) {
      if (e instanceof VersionConflict) throw await this.conflictWithCurrent(op, shape, ctx, e);
      throw this.checkDeclaredError(op, e);
    }
    onCommitted?.();
    // What was loaded before the command ran may be what it just changed: its own result, and every op after it, load
    // again. A dry run changed nothing, so it keeps them.
    if (!ctx.simulate) ctx.batch.delete(LOADS);
    const cr: CommandResult = isCommandResult(raw) ? raw : ok(raw);
    const st: ProjectState = { ctx, errors: [], deferred: [], explicit };
    const data = await this.projectValue(cr.result, op.returns, shape, "", st);
    // Deferred blocks make no sense on a command result: resolve them inline.
    while (st.deferred.length) {
      const job = st.deferred.shift()!;
      await this.projectMany(job.slots, job.type, job.shape, st);
    }
    const extra = cr.patch ?? [];
    const patch = derivePatches(data).concat(extra);
    if (!ctx.simulate) {
      for (const ev of cr.emit ?? []) {
        if (!op.emits.includes(ev.event)) throw new RayfoldError("internal", `${op.name} emitted undeclared event ${ev.event}`);
        ctx.events.publish(ev.event, ev.payload);
      }
    }
    // Compact frames omit `set` patches that restate entities already in `ok`: the client derives them by normalizing `ok`.
    const full: Frame = { id: ctx.opId, ok: data, patch, meta: { cost }, fin: true };
    const compact: Frame = { id: ctx.opId, ok: stripTypes(data), patch: extra, fin: true };
    if (st.errors.length) full.errors = compact.errors = st.errors;
    const frame = ctx.compact ? compact : full;
    emit(frame);
    // Both forms are returned so an idempotent replay can answer in the form the retry asks for.
    return { result: data, frame, full, compact, patch };
  }

  /** VersionConflict -> failed_precondition carrying the current entity in the op's shape. */
  private async conflictWithCurrent(op: OpDef, shape: Shape, ctx: RayfoldContext, e: VersionConflict): Promise<RayfoldError> {
    let current: unknown = null;
    if (e.current !== null && e.current !== undefined) {
      const st: ProjectState = { ctx: { ...ctx, compact: false }, errors: [], deferred: [], explicit: false };
      current = await this.projectValue(e.current, { ...op.returns, nullable: true }, shape, "", st);
      while (st.deferred.length) {
        const job = st.deferred.shift()!;
        await this.projectMany(job.slots, job.type, job.shape, st);
      }
    }
    return new RayfoldError("failed_precondition", e.message, { type: "VersionConflict", data: { key: e.key, expected: e.expected, actual: e.actual, current } });
  }

  private checkDeclaredError(op: OpDef, e: unknown): unknown {
    if (e instanceof RayfoldError && e.code === "domain") {
      if (!e.type || !op.throws.includes(e.type)) {
        return new RayfoldError("internal", `${op.name} raised undeclared error ${e.type ?? "?"}`);
      }
    }
    return e;
  }

  // ---------------------------------------------------------------- streams

  async runStream(op: OpDef, args: Record<string, unknown>, shape: Shape, explicit: boolean, ctx: RayfoldContext, emit: Emit, maxItems = 10_000): Promise<void> {
    this.checkOpPolicy(op, "read", args, ctx);
    ctx.policy = this.policyHint(op.returns);
    const fn = this.resolvers.Stream?.[op.name];
    if (!fn) throw new RayfoldError("unimplemented", `No resolver for stream ${op.name}`);
    const iterable = fn(args as never, ctx as RayfoldContext<never>);
    const iterator = iterable[Symbol.asyncIterator]();
    let items = 0;
    try {
      for (;;) {
        if (ctx.signal.aborted) break;
        const next = await raceAbort(iterator.next(), ctx.signal);
        if (next.done) break;
        // spec 04 §5: until flow control is a requirement, a server emits items as its resolver yields them,
        // bounded by its own per-stream item limit. A resolver that never stops is otherwise unbounded memory.
        if (++items > maxItems) throw new RayfoldError("resource_exhausted", `${op.name}() yielded more than ${maxItems} items`);
        const st: ProjectState = { ctx, errors: [], deferred: [], explicit };
        const item = await this.projectValue(next.value, op.returns, shape, "", st);
        while (st.deferred.length) {
          const job = st.deferred.shift()!;
          await this.projectMany(job.slots, job.type, job.shape, st);
        }
        const frame: Frame = { id: ctx.opId, item: ctx.compact ? stripTypes(item) : item };
        // spec 04 §2: an `item` frame carries `errors` of its own, not tucked inside `meta`
        if (st.errors.length) (frame as { errors?: unknown }).errors = st.errors;
        emit(frame);
      }
    } finally {
      // A resolver that ignores ctx.signal may be suspended at an await that never settles, and return() waits behind
      // it: awaited, the op would never end and never say why. Once aborted it is asked to finish, not waited for.
      if (ctx.signal.aborted) void Promise.resolve(iterator.return?.()).catch(() => {});
      else await iterator.return?.();
    }
    if (ctx.signal.aborted) throw ctx.signal.reason instanceof RayfoldError ? ctx.signal.reason : new RayfoldError("canceled", "Canceled");
    emit({ id: ctx.opId, fin: true });
  }

  // ------------------------------------------------------------- projection

  /** The command's write policy, checked before an idempotent replay is served. */
  authorize(op: OpDef, args: Record<string, unknown>, ctx: RayfoldContext): void {
    this.checkOpPolicy(op, "write", args, ctx);
  }

  private checkOpPolicy(op: OpDef, mode: "read" | "write", args: Record<string, unknown>, ctx: RayfoldContext): void {
    const d = decide(op.annotations, mode, { viewer: ctx.viewer, args, this: null, now: ctx.now });
    if (d !== "allow") throw decisionError(d, `${op.name}()`);
  }

  private async flushDeferred(st: ProjectState, emit: Emit): Promise<void> {
    if (!st.deferred.length) return;
    while (st.deferred.length) {
      const job = st.deferred.shift()!;
      const fresh = job.slots.map((s) => ({ value: s.value, out: {}, path: s.path }));
      const sub: ProjectState = { ctx: st.ctx, errors: [], deferred: st.deferred, explicit: job.explicit };
      await this.projectMany(fresh, job.type, job.shape, sub);
      for (const s of fresh) {
        delete (s.out as Record<string, unknown>)["$type"]; // the parent frame carried it; a delta never repeats it
        const f: Frame = { id: st.ctx.opId, at: s.path, data: st.ctx.compact ? stripTypes(s.out) : s.out };
        const errs = sub.errors.filter((e) => e.path?.startsWith(s.path));
        if (errs.length) f.errors = errs;
        emit(f);
      }
    }
    emit({ id: st.ctx.opId, fin: true });
  }

  /** Project one value (object, list, or null) of static type `t`. */
  private async projectValue(value: unknown, t: TypeRef, shape: Shape, path: string, st: ProjectState): Promise<unknown> {
    if (value === null || value === undefined) {
      if (!t.nullable) throw new RayfoldError("internal", `Non-null ${path || "result"} resolved to null`, { path });
      return null;
    }
    if (t.kind === "list") {
      if (!Array.isArray(value)) throw new RayfoldError("internal", `${path || "result"} should be a list`, { path });
      const outs: unknown[] = new Array(value.length);
      const slots: Slot[] = [];
      value.forEach((v, i) => {
        const p = path ? `${path}.${i}` : String(i);
        if (v === null || v === undefined) {
          if (!t.of.nullable) throw new RayfoldError("internal", `Non-null ${p} resolved to null`, { path: p });
          outs[i] = null;
        } else if (t.of.kind === "list") {
          // nested lists: recurse per element (rare)
          slots.push({ value: { __nested: v }, out: {}, path: p });
        } else {
          const s: Slot = { value: v as Record<string, unknown>, out: {}, path: p, assign: (x) => (outs[i] = x) };
          slots.push(s);
          outs[i] = s.out;
        }
      });
      if (t.of.kind === "list") {
        for (const s of slots) outs[Number(s.path.split(".").pop())] = await this.projectValue(s.value["__nested"], t.of, shape, s.path, st);
      } else if (isScalarLike(this.ir, t.of)) {
        return value.map((v) => (v === null ? null : serializeScalar(this.ir, t.of, v)));
      } else {
        // A denied entity in a list fails the operation whatever the element type says (spec 06 §3): an element is a
        // non-null position for this purpose, because a list is read as "these are all of them" and nulling one
        // silently changes an answer the caller is counting. An element that is genuinely null is already handled
        // above, against the real element type, so this affects only the denial decision.
        await this.projectMany(slots, { ...t.of, nullable: false }, shape, st);
      }
      return outs;
    }
    if (isScalarLike(this.ir, t)) return serializeScalar(this.ir, t, value);
    if (typeof value !== "object") throw new RayfoldError("internal", `${path || "result"} should be an object`, { path });
    const holder: { v: unknown } = { v: undefined };
    const slot: Slot = { value: value as Record<string, unknown>, out: {}, path, assign: (v) => (holder.v = v) };
    holder.v = slot.out;
    await this.projectMany([slot], t, shape, st);
    return holder.v;
  }

  /** Project all `slots` (objects of static type `t`) through `shape`, batching each field once. */
  private async projectMany(slots: Slot[], t: TypeRef, shape: Shape, st: ProjectState): Promise<void> {
    if (!slots.length) return;
    const def = this.ir.types[t.kind === "named" ? t.name : baseName(t)];
    if (!def) throw new RayfoldError("internal", `Unknown type ${baseName(t)}`);

    if (def.kind === "union") {
      const groups = new Map<string, Slot[]>();
      for (const s of slots) {
        const tn = s.value["$type"];
        if (typeof tn !== "string" || !def.members.includes(tn)) {
          throw new RayfoldError("internal", `Union ${def.name} value at ${s.path} lacks a valid $type`, { path: s.path });
        }
        s.out["$type"] = tn;
        Object.defineProperty(s.out, UNION_MEMBER, { value: true, enumerable: false });
        (groups.get(tn) ?? groups.set(tn, []).get(tn)!).push(s);
      }
      for (const [tn, group] of groups) {
        const memberShape: Shape = { items: [] };
        for (const it of shape.items) {
          if (it.kind === "on" && it.type === tn) memberShape.items.push(...it.shape.items);
          else if (it.kind === "spread") memberShape.items.push(it);
          else if (it.kind === "field") memberShape.items.push(it);
        }
        const ref: TypeRef = { kind: "named", name: tn, nullable: false };
        await this.projectMany(group, ref, memberShape.items.length ? memberShape : defaultShape(this.ir, ref), st);
      }
      return;
    }

    // An interface position (spec 01 §2.1): like a union, the concrete type is known only from the value's `$type`,
    // so the slots are grouped by it and projected as that entity. `...on Concrete` then selects fields the interface
    // does not declare, and `$type` survives compact mode because the schema does not fix it here.
    if (def.kind === "object" && def.interface) {
      const members = implementorsOf(this.ir, def.name);
      const groups = new Map<string, Slot[]>();
      for (const s of slots) {
        const tn = s.value["$type"];
        if (typeof tn !== "string" || !members.has(tn)) {
          throw new RayfoldError("internal", `Interface ${def.name} value at ${s.path} lacks a valid $type`, { path: s.path });
        }
        s.out["$type"] = tn;
        Object.defineProperty(s.out, UNION_MEMBER, { value: true, enumerable: false });
        (groups.get(tn) ?? groups.set(tn, []).get(tn)!).push(s);
      }
      for (const [tn, group] of groups) await this.projectMany(group, { kind: "named", name: tn, nullable: false }, shape, st);
      return;
    }
    if (!("fields" in def)) throw new RayfoldError("internal", `Cannot project ${def.kind} ${def.name}`);

    // Type-level read policy (spec 06 §2 step 2).
    let allowed = slots;
    if (def.annotations.length) {
      allowed = [];
      for (const s of slots) {
        const d = decide(def.annotations, "read", { viewer: st.ctx.viewer, args: {}, this: s.value, now: st.ctx.now });
        if (d === "allow") allowed.push(s);
        // At a nullable position a denied entity reads as null even for an explicit shape, so the answer never tells
        // "exists but forbidden" apart from "does not exist" (spec 06 section 2, spec 12).
        else if (st.explicit && !t.nullable) throw decisionError(d, `${def.name} at ${s.path || "result"}`).withPath(s.path);
        else markNull(s);
      }
    }
    if (def.kind === "entity") for (const s of allowed) s.out["$type"] = def.name;

    const fields = fieldsOf(this.ir, t) ?? def.fields;
    const { groups, defers } = this.flatten(shape, def, fields, st);
    // What this client asked for, for `rayfold check --unused` (spec 11). Only the member's path is kept.
    if (this.opts.usage) {
      const client = String(st.ctx.meta.client ?? "");
      const at = st.ctx.now();
      for (const g of groups) this.opts.usage.record({ op: st.ctx.opName, path: `${def.name}.${g.field.name}`, client }, at);
    }

    // Phase 1: resolve every field group at this level (batched), collecting children.
    const children: Array<{ slots: Slot[]; type: TypeRef; shape: Shape; explicit: boolean }> = [];
    for (const g of groups) {
      const field = g.field;
      const lazy = annotation(field, "lazy") !== undefined && !g.eager;
      if (lazy) {
        st.deferred.push({ slots: allowed, type: t, shape: { items: [{ ...g.item, eager: true }] }, explicit: st.explicit });
        continue;
      }
      let targets = allowed;
      if (field.annotations.length) {
        targets = [];
        for (const s of allowed) {
          const d = decide(field.annotations, "read", { viewer: st.ctx.viewer, args: g.args, this: s.value, now: st.ctx.now });
          if (d === "allow") targets.push(s);
          else if (st.explicit && !g.partial) throw decisionError(d, `${def.name}.${field.name}`).withPath(join(s.path, g.alias));
          else if (st.explicit) {
            st.errors.push({ ...decisionError(d, `${def.name}.${field.name}`).toWire(), path: join(s.path, g.alias) });
            s.out[g.alias] = null;
          }
        }
      }
      if (!targets.length) continue;
      let values: unknown[];
      try {
        values = await this.loadField(def, field, targets, g.args, st.ctx);
      } catch (e) {
        if (g.partial) {
          const w = toWireError(e);
          for (const s of targets) {
            st.errors.push({ ...w, path: join(s.path, g.alias) });
            s.out[g.alias] = null;
          }
          continue;
        }
        throw e instanceof RayfoldError ? e.withPath(join(targets[0]!.path, g.alias)) : e;
      }
      if (!Array.isArray(values) || values.length !== targets.length) {
        throw new RayfoldError("internal", `Loader for ${def.name}.${field.name} returned ${Array.isArray(values) ? values.length : "non-array"} for ${targets.length} parents`);
      }
      const scalar = isScalarLike(this.ir, field.type);
      const childSlots: Slot[] = [];
      targets.forEach((s, i) => {
        const v = values[i];
        const p = join(s.path, g.alias);
        if (v === null || v === undefined) {
          if (!field.type.nullable) {
            const err = new RayfoldError("internal", `Non-null field ${def.name}.${field.name} resolved to null`, { path: p });
            if (!g.partial) throw err;
            st.errors.push(err.toWire());
          }
          s.out[g.alias] = null;
          return;
        }
        if (scalar) {
          s.out[g.alias] = field.type.kind === "list" ? (v as unknown[]).map((x) => (x === null ? null : serializeScalar(this.ir, field.type, x))) : serializeScalar(this.ir, field.type, v);
          return;
        }
        if (field.type.kind === "list") {
          if (!Array.isArray(v)) throw new RayfoldError("internal", `${p} should be a list`, { path: p });
          const arr: unknown[] = new Array(v.length);
          v.forEach((el, j) => {
            if (el === null || el === undefined) {
              if (!(field.type as { of: TypeRef }).of.nullable) throw new RayfoldError("internal", `Non-null ${p}.${j} resolved to null`, { path: `${p}.${j}` });
              arr[j] = null;
            } else {
              const cs: Slot = { value: el as Record<string, unknown>, out: {}, path: `${p}.${j}`, assign: (x) => (arr[j] = x) };
              childSlots.push(cs);
              arr[j] = cs.out;
            }
          });
          s.out[g.alias] = arr;
        } else {
          const cs: Slot = { value: v as Record<string, unknown>, out: {}, path: p, assign: (x) => (s.out[g.alias] = x) };
          childSlots.push(cs);
          s.out[g.alias] = cs.out;
        }
      });
      if (childSlots.length) {
        // A list element is a non-null position as far as a denial is concerned (spec 06 §3), whatever the element
        // type says: nulling one silently changes a list the caller reads as "these are all of them". An element
        // that is genuinely null was handled above against the real type, so this moves only the denial decision.
        const childType: TypeRef = field.type.kind === "list" ? { ...field.type.of, nullable: false } : field.type;
        const sub = g.shape ?? defaultShape(this.ir, childType);
        children.push({ slots: childSlots, type: childType, shape: sub, explicit: g.shape ? st.explicit : false });
      }
    }

    // Phase 2: recurse one level deeper, one call per field group (keeps batching across parents).
    for (const c of children) {
      if (c.explicit === st.explicit) await this.projectMany(c.slots, c.type, c.shape, st);
      else await this.projectMany(c.slots, c.type, c.shape, { ...st, explicit: c.explicit });
    }

    // Deferred blocks run after the enclosing frame is emitted.
    for (const d of defers) st.deferred.push({ slots: allowed, type: t, shape: d.shape, explicit: st.explicit });
  }

  /** Resolve field values for all targets with one loader call (or property access). */
  private async loadField(def: TypeDef, field: FieldDef, targets: Slot[], args: Record<string, unknown>, ctx: RayfoldContext): Promise<unknown[]> {
    const resolver = this.resolvers[def.name]?.[field.name];
    if (!resolver) {
      // A field with arguments needs a loader, unless the parent already carries its value: a resolver that planned the
      // whole shape from ctx.shape, such as @rayfold/postgres screen(), returns nested pages with their rows.
      if (field.args.length && !targets.every((s) => Object.hasOwn(s.value, field.name))) throw new RayfoldError("unimplemented", `No loader for ${def.name}.${field.name}`);
      return targets.map((s) => s.value[field.name]);
    }
    // the loader gets the read policy of what it loads, so it can filter at the source (spec 06 section 4)
    const hinted: RayfoldContext = { ...ctx, policy: this.policyHint(field.type) };
    const load = annotation(field, "load");
    const single = load && typeof load.args["value"] === "object" && load.args["value"] && "$ident" in load.args["value"] && (load.args["value"] as { $ident: string }).$ident === "single";
    // One load per (field, arguments, entity) for the whole batch: an entity another op already loaded, or is
    // loading right now, or that appears twice at this level, is not loaded again. What is remembered is the load
    // in flight, not its result, so ops running at the same time share it. Only entities take part: they have identity.
    let memo = ctx.batch.get(LOADS) as Map<string, Promise<unknown>> | undefined;
    if (!memo) ctx.batch.set(LOADS, (memo = new Map()));
    const prefix = `${def.name}.${field.name}|${JSON.stringify(args)}`;
    const keys = targets.map((s): string | null => {
      if (def.kind !== "entity") return null;
      const id = s.value["id"];
      return typeof id === "string" || typeof id === "number" ? `${prefix}|${id}` : null;
    });
    const waiting: Array<Promise<unknown>> = [];
    const need: Slot[] = [];
    const settlers: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const mine = new Map<string, number>();
    targets.forEach((s, i) => {
      const k = keys[i]!;
      const already = k === null ? undefined : memo.get(k);
      if (already) {
        waiting.push(already);
        return;
      }
      if (k !== null && mine.has(k)) {
        waiting.push(waiting[mine.get(k)!]!);
        return;
      }
      let settle!: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
      const pending = new Promise<unknown>((resolve, reject) => (settle = { resolve, reject }));
      // The group's failure is reported by the throw below; this keeps a shared load that nobody awaited quiet.
      pending.catch(() => {});
      waiting.push(pending);
      settlers.push(settle);
      if (k !== null) {
        memo.set(k, pending);
        mine.set(k, i);
      }
      need.push(s);
    });

    if (need.length) {
      const call = async (): Promise<unknown[]> => {
        if (single) {
          const fn = resolver as SingleFieldResolver<never, never, unknown>;
          return Promise.all(need.map((s) => fn(s.value as never, args as never, hinted as RayfoldContext<never>)));
        }
        const fn = resolver as FieldResolver<never, never, unknown>;
        return fn(need.map((s) => s.value) as never[], args as never, hinted as RayfoldContext<never>);
      };
      const hook = this.opts.instrumentation?.loader;
      try {
        const loaded = await (hook ? hook({ type: def.name, field: field.name, parents: need.length }, call) : call());
        if (!Array.isArray(loaded) || loaded.length !== need.length) {
          throw new RayfoldError("internal", `Loader for ${def.name}.${field.name} returned ${Array.isArray(loaded) ? loaded.length : "a non-list"} for ${need.length} parents`);
        }
        loaded.forEach((v, n) => settlers[n]!.resolve(v));
      } catch (e) {
        for (const k of mine.keys()) memo.delete(k); // a load that failed is not remembered
        for (const s of settlers) s.reject(e);
        throw e;
      }
    }
    return Promise.all(waiting);
  }

  /** The pushable read policy of the entity a resolver loads, handed to it as ctx.policy.filter (spec 06 section 4). */
  private policyHint(t: TypeRef): PolicyHint {
    const def = this.ir.types[baseName(t)];
    const filter = def && "fields" in def ? pushableFilter(def.annotations) : undefined;
    return filter ? { filter } : {};
  }

  /** Expand spreads/type conditions and group field selections by (name, args). */
  private flatten(
    shape: Shape,
    def: TypeDef,
    fields: FieldDef[],
    st: ProjectState,
  ): { groups: FieldGroup[]; defers: Array<{ shape: Shape }> } {
    const groups: FieldGroup[] = [];
    const defers: Array<{ shape: Shape }> = [];
    const byAlias = new Map<string, FieldGroup>();
    const visit = (items: ShapeItem[], seen: Set<string>): void => {
      for (const it of items) {
        switch (it.kind) {
          case "field": {
            const f = fields.find((x) => x.name === it.name);
            if (!f) throw new RayfoldError("invalid_argument", `${def.name} has no field ${it.name}`);
            const alias = it.alias ?? it.name;
            const args = f.args.length ? coerceArgs(this.ir, f.args, substituteVars(it.args ?? {}, st.ctx), `${def.name}.${it.name}`, f.type) : {};
            const existing = byAlias.get(alias);
            if (existing) {
              if (existing.field !== f || JSON.stringify(existing.args) !== JSON.stringify(args)) {
                throw new RayfoldError("invalid_argument", `Conflicting selections for ${alias} on ${def.name}`);
              }
              if (it.shape) existing.shape = existing.shape ? mergeShapes(existing.shape, it.shape) : it.shape;
              if (it.eager) existing.eager = true;
              if (it.partial) existing.partial = true;
              continue;
            }
            const g: FieldGroup = { field: f, alias, args, item: it, eager: !!it.eager, partial: !!it.partial || annotation(f, "partial") !== undefined };
            if (it.shape) g.shape = it.shape;
            byAlias.set(alias, g);
            groups.push(g);
            break;
          }
          case "spread": {
            const key = `${it.type}.${it.view}`;
            const v = this.ir.views[key];
            if (!v) throw new RayfoldError("invalid_argument", `Unknown view ${key}`);
            if (seen.has(key)) throw new RayfoldError("invalid_argument", `View cycle at ${key}`);
            visit(v.shape.items, new Set([...seen, key]));
            break;
          }
          case "on":
            if (it.type === def.name || (def.kind === "entity" && def.implements.includes(it.type))) visit(it.shape.items, seen);
            break;
          case "defer":
            defers.push({ shape: it.shape });
            break;
        }
      }
    };
    visit(shape.items, new Set());
    return { groups, defers };
  }
}

interface FieldGroup {
  field: FieldDef;
  alias: string;
  args: Record<string, unknown>;
  item: Extract<ShapeItem, { kind: "field" }>;
  shape?: Shape;
  eager: boolean;
  partial: boolean;
}

function mergeShapes(a: Shape, b: Shape): Shape {
  return { items: [...a.items, ...b.items] };
}

function join(path: string, name: string): string {
  return path ? `${path}.${name}` : name;
}

/** Entities that implement an interface, memoised per schema. */
function implementorsOf(ir: RayfoldSchemaIR, iface: string): Set<string> {
  let memo = implementors.get(ir);
  if (!memo) implementors.set(ir, (memo = new Map()));
  let set = memo.get(iface);
  if (!set) {
    set = new Set(Object.values(ir.types).filter((t) => t.kind === "entity" && t.implements.includes(iface)).map((t) => t.name));
    memo.set(iface, set);
  }
  return set;
}
const implementors = new WeakMap<RayfoldSchemaIR, Map<string, Set<string>>>();

function markNull(s: Slot): void {
  // A denied entity inside a default view becomes null in its parent (spec 06 §3).
  for (const k of Object.keys(s.out)) delete s.out[k];
  s.assign?.(null);
}

function substituteVars(args: Record<string, ShapeValue>, ctx: RayfoldContext): Record<string, unknown> {
  const vars = ctx.vars ?? {};
  const walk = (v: ShapeValue): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x as ShapeValue));
    if ("$var" in v && typeof v["$var"] === "string") {
      const name = v["$var"];
      if (!(name in vars)) throw new RayfoldError("invalid_argument", `Missing shape variable $${name}`);
      return vars[name];
    }
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x as ShapeValue);
    return o;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = walk(v);
  return out;
}

function serializeScalar(ir: RayfoldSchemaIR, t: TypeRef, v: unknown): unknown {
  const name = baseName(t);
  const def = ir.types[name];
  if (def?.kind === "enum") return v;
  switch (name) {
    case "Instant":
      return v instanceof Date ? v.toISOString() : v;
    case "Date":
      return v instanceof Date ? v.toISOString().slice(0, 10) : v;
    case "Long":
      return typeof v === "bigint" ? v.toString() : typeof v === "number" && Math.abs(v) > Number.MAX_SAFE_INTEGER ? String(v) : v;
    case "Decimal":
      return typeof v === "number" ? String(v) : v;
    case "Bytes":
      return v instanceof Uint8Array ? base64urlBytes(v) : v;
    default:
      return v;
  }
}

/** Every entity object in a projected result becomes a `set` patch (spec 04 §2). */
export function derivePatches(data: unknown): PatchOp[] {
  const out = new Map<string, Record<string, unknown>>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    const o = v as Record<string, unknown>;
    const tn = o["$type"];
    if (typeof tn === "string" && (typeof o["id"] === "string" || typeof o["id"] === "number")) {
      const key = `${tn}:${o["id"]}`;
      const shallow: Record<string, unknown> = out.get(key) ?? {};
      for (const [k, x] of Object.entries(o)) shallow[k] = toRef(x);
      out.set(key, shallow);
    }
    for (const x of Object.values(o)) walk(x);
  };
  walk(data);
  return [...out.entries()].map(([key, value]) => ({ set: key, value }));
}

function toRef(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(toRef);
  const o = v as Record<string, unknown>;
  if (typeof o["$type"] === "string" && o["id"] !== undefined) return { $ref: `${o["$type"]}:${o["id"]}` };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = toRef(x);
  return out;
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  // the reason travels: a server shutting down ends a stream with `unavailable`, so the client goes elsewhere
  const reason = () => (signal.reason instanceof RayfoldError ? signal.reason : new RayfoldError("canceled", "Canceled"));
  if (signal.aborted) return Promise.reject(reason());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function annotationsOf(x: { annotations: Annotation[] }): Annotation[] {
  return x.annotations;
}
