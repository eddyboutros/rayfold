/**
 * Normalized entity cache. Spec: spec/07-cache.md §3, spec/04 §2 (patches).
 * Entities live once, keyed by "$type:id". A stored result is a *skeleton*: entities are replaced by
 * `{ $ref, $sel }` where `$sel` records which fields that result selected, so reading a result back
 * yields exactly the requested shape while the field values always come from the shared entity.
 */
import { shapeLevel, type Shape, type ViewResolver } from "@rayfold/schema";
import type { PatchOp } from "@rayfold/server/protocol";

export type EntityKey = string;
/** Selection skeleton: `true` = scalar/leaf, object = nested selection (lists use the element selection). */
export type Sel = true | { [field: string]: Sel };
export interface Ref {
  $ref: EntityKey;
  $sel?: Sel;
  /**
   * Fields this result asked for that are not the entity's own under that name: an alias, or a field asked for with
   * arguments (spec 07 §3). They stay with the result, so two results selecting the same entity differently each
   * read back what they asked for.
   */
  $own?: Record<string, unknown>;
}

export interface CachedResult {
  /** skeleton: entities replaced by refs */
  data: unknown;
  op: string;
  /** entity keys contained in the result */
  keys: Set<EntityKey>;
  storedAt: number;
  stale: boolean;
}

export type CacheListener = (changed: { keys: Set<EntityKey>; ops: Set<string> }) => void;

/** How a field settles when a prediction and the server disagree (spec 08 section 5, `@merge`). */
export type MergePolicy = "serverWins" | "keepLocal" | "lww" | "crdtText" | "custom";

/** A predicted change to one entity's fields (sub-profile `sync`, spec 08 section 5). */
export interface OptimisticOp {
  set: EntityKey;
  value: Record<string, unknown>;
}

export function entityKey(obj: Record<string, unknown>): EntityKey | null {
  const t = obj["$type"];
  const id = obj["id"];
  return typeof t === "string" && (typeof id === "string" || typeof id === "number") ? `${t}:${id}` : null;
}

export function isRef(v: unknown): v is Ref {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o["$ref"] !== "string") return false;
  return Object.keys(o).every((k) => k === "$ref" || k === "$sel" || k === "$own");
}

export class RayfoldCache {
  private readonly entities = new Map<EntityKey, Record<string, unknown>>();
  private readonly results = new Map<string, CachedResult>();
  private readonly staleKeys = new Set<EntityKey>();
  private readonly listeners = new Set<CacheListener>();
  /** Optimistic predictions, oldest first. `entities` shows the server's values with these applied on top. */
  private readonly layers: Array<{ id: string; ops: OptimisticOp[] }> = [];
  /** The server's own values of the entities a prediction covers, for as long as one does. */
  private readonly shadow = new Map<EntityKey, Record<string, unknown> | undefined>();

  constructor(
    private readonly now: () => number = Date.now,
    /**
     * A field's conflict policy, read from the schema when the client was given one. Without a policy a prediction
     * stands until its command settles, which is what the sub-profile has always done.
     */
    private readonly mergeOf: (type: string, field: string) => MergePolicy | undefined = () => undefined,
  ) {}

  // ----------------------------------------------------------- entities

  get(key: EntityKey): Record<string, unknown> | undefined {
    return this.entities.get(key);
  }
  has(key: EntityKey): boolean {
    return this.entities.has(key);
  }
  isStale(key: EntityKey): boolean {
    return this.staleKeys.has(key);
  }
  get size(): number {
    return this.entities.size;
  }

  /** Merge fields into an entity (creating it), normalizing nested entities. Returns touched keys. */
  merge(key: EntityKey, fields: Record<string, unknown>, touched = new Set<EntityKey>()): Set<EntityKey> {
    const existing = this.baseOf(key) ?? {};
    const next: Record<string, unknown> = { ...existing };
    for (const [k, v] of Object.entries(fields)) next[k] = this.normalizeValue(v, touched).value;
    if (!("$type" in next)) next["$type"] = key.slice(0, key.indexOf(":"));
    if (!("id" in next)) next["id"] = key.slice(key.indexOf(":") + 1);
    this.setBase(key, next);
    this.staleKeys.delete(key);
    touched.add(key);
    // A field the server has just spoken for leaves any prediction that also set it, when the field's policy says so
    // (spec 08 section 5). `lww` settles the same way here: the server's write is the later one.
    const type = key.slice(0, key.indexOf(":"));
    let overruled = false;
    for (const layer of this.layers) {
      for (const op of layer.ops) {
        if (op.set !== key) continue;
        for (const field of Object.keys(fields)) {
          if (!(field in op.value)) continue;
          const policy = this.mergeOf(type, field);
          if (policy !== "serverWins" && policy !== "lww") continue;
          delete op.value[field];
          overruled = true;
        }
      }
    }
    if (overruled) this.rebuild(key);
    return touched;
  }

  /** Merge entities found anywhere in `data` and notify watchers (used for conflict repairs). */
  mergeEntities(data: unknown): void {
    const keys = new Set<EntityKey>();
    this.normalizeValue(data, keys);
    this.emit(keys, new Set());
  }

  /** Replace entity objects with `{ $ref, $sel }` skeleton refs, storing the entities. */
  normalize(data: unknown, touched = new Set<EntityKey>()): unknown {
    return this.normalizeValue(data, touched).value;
  }

  /**
   * [shape] is the selection that produced [v], when the client knows it: with it, the fields that belong to that
   * selection are kept on the result's ref rather than written to the shared entity.
   */
  private normalizeValue(v: unknown, touched: Set<EntityKey>, shape?: Shape, views?: ViewResolver): { value: unknown; sel: Sel } {
    if (v === null || typeof v !== "object") return { value: v, sel: true };
    if (Array.isArray(v)) {
      let sel: Sel = true;
      const value = v.map((x) => {
        const r = this.normalizeValue(x, touched, shape, views);
        if (r.sel !== true) sel = sel === true ? r.sel : mergeSel(sel, r.sel);
        return r.value;
      });
      return { value, sel };
    }
    if (isRef(v)) {
      touched.add(v.$ref);
      return { value: v, sel: v.$sel ?? true };
    }
    const o = v as Record<string, unknown>;
    const key = entityKey(o);
    const level = shapeLevel(shape, views);
    const sel: { [k: string]: Sel } = {};
    const out: Record<string, unknown> = {};
    const own: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      const r = this.normalizeValue(x, touched, level.child.get(k), views);
      if (key && level.bySelection.has(k)) own[k] = r.value;
      else out[k] = r.value;
      sel[k] = r.sel;
    }
    if (key) {
      this.storeEntity(key, out, touched);
      return { value: Object.keys(own).length ? { $ref: key, $sel: sel, $own: own } : { $ref: key, $sel: sel }, sel };
    }
    return { value: out, sel };
  }

  private storeEntity(key: EntityKey, normalizedFields: Record<string, unknown>, touched: Set<EntityKey>): void {
    const existing = this.baseOf(key) ?? {};
    this.setBase(key, { ...existing, ...normalizedFields });
    this.staleKeys.delete(key);
    touched.add(key);
  }

  /** Resolve refs back into plain objects, honouring each ref's selection. Cycles are cut at `maxDepth`. */
  denormalize(data: unknown, maxDepth = 16): unknown {
    const walk = (v: unknown, sel: Sel | undefined, depth: number): unknown => {
      if (v === null || typeof v !== "object") return v;
      // a deleted entity leaves a gap in the list it was in; the gap is the cache's business, not the caller's
      if (Array.isArray(v)) return v.filter((x) => !isGone(x)).map((x) => walk(x, sel, depth));
      if (isGone(v)) return null;
      if (isRef(v)) {
        const e = this.entities.get(v.$ref);
        if (!e) return { $ref: v.$ref };
        const s = v.$sel ?? sel;
        if (depth >= maxDepth) return { $type: e["$type"], id: e["id"] };
        if (s === undefined || s === true) return walk(e, undefined, depth + 1);
        const out: Record<string, unknown> = {};
        if ("$type" in e) out["$type"] = e["$type"];
        for (const [k, sub] of Object.entries(s)) {
          if (v.$own && k in v.$own) out[k] = walk(v.$own[k], sub, depth + 1);
          else if (k in e) out[k] = walk(e[k], sub, depth + 1);
        }
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const sub = sel && sel !== true ? sel[k] : undefined;
        out[k] = walk(x, sub, depth);
      }
      return out;
    };
    return walk(data, undefined, 0);
  }

  // ------------------------------------------------------------ results

  static resultKey(op: string, args: unknown, shape: string | undefined, vars: unknown): string {
    return JSON.stringify([op, canonical(args ?? {}), shape ?? "", canonical(vars ?? {})]);
  }

  putResult(key: string, op: string, data: unknown, shape?: Shape, views?: ViewResolver): CachedResult {
    const keys = new Set<EntityKey>();
    const normalized = this.normalizeValue(data, keys, shape, views).value;
    const r: CachedResult = { data: normalized, op, keys, storedAt: this.now(), stale: false };
    this.results.set(key, r);
    this.emit(keys, new Set([op]));
    return r;
  }

  getResult(key: string): CachedResult | undefined {
    return this.results.get(key);
  }

  /** Apply a deferred delta at a path inside a stored result (spec 04 §3). */
  mergeAt(key: string, path: string, delta: unknown, shape?: Shape, views?: ViewResolver): void {
    const r = this.results.get(key);
    if (!r || !delta || typeof delta !== "object") return;
    const touched = new Set<EntityKey>();
    // the selection at that path: the deferred block's fields are among its fields
    let at = shape;
    for (const seg of path === "" ? [] : path.split(".")) if (!/^\d+$/.test(seg)) at = shapeLevel(at, views).child.get(seg);
    const norm = this.normalizeValue(delta, touched, at, views);
    const target = path === "" ? r.data : this.getPath(r.data, path.split("."));
    if (isRef(target)) {
      const bySelection = shapeLevel(at, views).bySelection;
      const shared: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(norm.value as Record<string, unknown>)) {
        if (bySelection.has(k)) (target.$own ??= {})[k] = x;
        else shared[k] = x;
      }
      const e = this.baseOf(target.$ref);
      if (e) this.setBase(target.$ref, { ...e, ...shared });
      target.$sel = mergeSel(target.$sel ?? {}, norm.sel);
    } else if (target && typeof target === "object" && !Array.isArray(target)) {
      Object.assign(target as Record<string, unknown>, norm.value as Record<string, unknown>);
    }
    for (const k of touched) r.keys.add(k);
    // a new record for the same data, so a watcher comparing records sees that this result changed
    this.results.set(key, { ...r });
    this.emit(touched, new Set([r.op]));
  }

  // ------------------------------------------------------------ patches

  /**
   * `set`, `del`, `inv` and `invOp` act on the whole cache. `at` and `list` describe one stored result and are
   * applied only when the frame's result key is known (spec 04 section 2b).
   */
  applyPatch(ops: PatchOp[], resultKey?: string): void {
    const keys = new Set<EntityKey>();
    const opNames = new Set<string>();
    for (const p of ops) {
      if ("set" in p) this.merge(p.set, p.value, keys);
      else if ("list" in p) this.applyList(resultKey, p, keys, opNames);
      else if ("at" in p) this.applyAt(resultKey, p.at, p.value, keys, opNames);
      else if ("del" in p) {
        this.setBase(p.del, undefined);
        keys.add(p.del);
        for (const r of this.results.values()) if (r.keys.has(p.del)) r.data = dropRef(r.data, p.del);
        // Lists nested inside other entities (Book.reviews, Author.books) hold refs too.
        for (const k of new Set([...this.entities.keys(), ...this.shadow.keys()])) {
          const e = this.baseOf(k);
          if (!e || !containsRef(e, p.del)) continue;
          this.setBase(k, dropRef(e, p.del) as Record<string, unknown>);
          keys.add(k);
        }
      } else if ("inv" in p) {
        for (const k of p.inv) {
          this.staleKeys.add(k);
          keys.add(k);
        }
      } else if ("invOp" in p) {
        for (const op of p.invOp) {
          opNames.add(op);
          for (const r of this.results.values()) if (r.op === op) r.stale = true;
        }
      }
    }
    for (const r of this.results.values()) {
      for (const k of keys) if (r.keys.has(k)) opNames.add(r.op);
    }
    this.emit(keys, opNames);
  }

  /** Merge fields into the plain object at a path inside one stored result. */
  private applyAt(resultKey: string | undefined, path: string, value: Record<string, unknown>, touched: Set<EntityKey>, opNames: Set<string>): void {
    const r = resultKey === undefined ? undefined : this.results.get(resultKey);
    if (!r) return;
    const target = path === "" ? r.data : this.getPath(r.data, path.split("."));
    if (!target || typeof target !== "object" || Array.isArray(target)) return;
    const norm = this.normalizeValue(value, touched);
    Object.assign(target as Record<string, unknown>, norm.value as Record<string, unknown>);
    for (const k of touched) r.keys.add(k);
    opNames.add(r.op);
    this.results.set(resultKey!, { ...r });
  }

  /**
   * Remove the named old positions of a list inside one stored result, then insert the carried elements at their
   * new positions. Insertions carry the projected element, so normalizing them stores the entity and records
   * which fields this result selected.
   */
  private applyList(resultKey: string | undefined, op: { list: string; del?: number[]; ins?: Array<{ at: number; value: unknown }> }, touched: Set<EntityKey>, opNames: Set<string>): void {
    const r = resultKey === undefined ? undefined : this.results.get(resultKey);
    if (!r) return;
    const arr = op.list === "" ? r.data : this.getPath(r.data, op.list.split("."));
    if (!Array.isArray(arr)) return;
    for (const n of [...(op.del ?? [])].sort((a, b) => b - a)) arr.splice(n, 1);
    for (const x of op.ins ?? []) arr.splice(x.at, 0, this.normalizeValue(x.value, touched).value);
    for (const k of touched) r.keys.add(k);
    opNames.add(r.op);
    this.results.set(resultKey!, { ...r });
  }

  // --------------------------------------------------------- predictions

  /**
   * Shows a prediction (tagged by the command's idempotency key) on top of the server's values until
   * [removeLayer]. The server's patches keep landing underneath, so removing the prediction leaves exactly what the
   * server said: that is the rebase after success and the rollback after failure.
   */
  addLayer(id: string, ops: OptimisticOp[]): void {
    for (const op of ops) {
      const type = op.set.slice(0, op.set.indexOf(":"));
      for (const field of Object.keys(op.value)) {
        const policy = this.mergeOf(type, field);
        // Declared but not implemented: predicting such a field would need a merge this client cannot perform.
        if (policy === "crdtText" || policy === "custom") {
          throw new Error(`@merge(${policy}) is not implemented: ${type}.${field} cannot be predicted optimistically`);
        }
      }
    }
    const keys = new Set<EntityKey>();
    for (const op of ops) {
      if (!this.shadow.has(op.set)) this.shadow.set(op.set, this.entities.get(op.set));
      keys.add(op.set);
    }
    this.layers.push({ id, ops });
    for (const k of keys) this.rebuild(k);
    this.emit(keys, new Set());
  }

  removeLayer(id: string): void {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const [layer] = this.layers.splice(i, 1);
    const keys = new Set(layer!.ops.map((o) => o.set));
    for (const k of keys) {
      if (this.layers.some((l) => l.ops.some((o) => o.set === k))) {
        this.rebuild(k);
        continue;
      }
      const base = this.shadow.get(k);
      this.shadow.delete(k);
      if (base) this.entities.set(k, base);
      else this.entities.delete(k);
    }
    this.emit(keys, new Set());
  }

  /** Predictions not yet settled, by their command keys. */
  get predictions(): string[] {
    return this.layers.map((l) => l.id);
  }

  /** The server's value of an entity, below any prediction. */
  private baseOf(key: EntityKey): Record<string, unknown> | undefined {
    return this.shadow.has(key) ? this.shadow.get(key) : this.entities.get(key);
  }

  private setBase(key: EntityKey, value: Record<string, unknown> | undefined): void {
    if (this.shadow.has(key)) {
      this.shadow.set(key, value);
      this.rebuild(key);
    } else if (value) this.entities.set(key, value);
    else this.entities.delete(key);
  }

  private rebuild(key: EntityKey): void {
    const base = this.shadow.get(key);
    let e: Record<string, unknown> | undefined = base ? { ...base } : undefined;
    for (const l of this.layers) {
      for (const op of l.ops) {
        if (op.set === key) e = { ...(e ?? { $type: key.slice(0, key.indexOf(":")), id: key.slice(key.indexOf(":") + 1) }), ...op.value };
      }
    }
    if (e) this.entities.set(key, e);
    else this.entities.delete(key);
  }

  // ---------------------------------------------------------- listeners

  subscribe(fn: CacheListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private pending: { keys: Set<EntityKey>; ops: Set<string> } | null = null;

  /** Coalesce every notification produced inside `fn` into one. */
  transaction(fn: () => void): void {
    if (this.pending) return fn();
    this.pending = { keys: new Set(), ops: new Set() };
    try {
      fn();
    } finally {
      const p = this.pending;
      this.pending = null;
      this.emit(p.keys, p.ops);
    }
  }

  private emit(keys: Set<EntityKey>, ops: Set<string>): void {
    if (!keys.size && !ops.size) return;
    if (this.pending) {
      for (const k of keys) this.pending.keys.add(k);
      for (const o of ops) this.pending.ops.add(o);
      return;
    }
    for (const fn of this.listeners) fn({ keys, ops });
  }

  clear(): void {
    this.entities.clear();
    this.results.clear();
    this.staleKeys.clear();
    this.layers.length = 0;
    this.shadow.clear();
  }
}

function mergeSel(a: Sel, b: Sel): Sel {
  if (a === true) return b;
  if (b === true) return a;
  const out: { [k: string]: Sel } = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeSel(out[k]!, v) : v;
  return out;
}

function containsRef(data: unknown, key: EntityKey): boolean {
  if (data === null || typeof data !== "object") return false;
  if (Array.isArray(data)) return data.some((x) => containsRef(x, key));
  if (isRef(data)) return data.$ref === key || (data.$own !== undefined && containsRef(data.$own, key));
  return Object.values(data as Record<string, unknown>).some((x) => containsRef(x, key));
}

/**
 * What a deleted entity leaves behind in a list.
 *
 * Removing the element outright would be simpler and is wrong: a live query's `list` operations are positional and
 * are computed against the list the server last sent (spec 04 §2b). A `del` from a command's own patch reaches only
 * the client that ran the command, so if that client shortened its list, the `list del: [0]` that follows would take
 * out whatever moved into the slot — one removal, two rows gone. Holding the position keeps the client's list the
 * length the server believes it to be; `denormalize` hides the gap, so nothing observes it.
 */
interface Gone {
  $gone: EntityKey;
}
function isGone(v: unknown): v is Gone {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>)["$gone"] === "string";
}

function dropRef(data: unknown, key: EntityKey): unknown {
  if (data === null || typeof data !== "object") return data;
  // in a list the reference becomes a gap rather than going away, so later positions still line up
  if (Array.isArray(data)) return data.map((x) => (isRef(x) && x.$ref === key ? { $gone: key } : dropRef(x, key)));
  if (isRef(data)) return data.$ref === key ? null : data.$own ? { ...data, $own: dropRef(data.$own, key) as Record<string, unknown> } : data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) out[k] = dropRef(v, key);
  return out;
}

export interface RayfoldCache {
  /** @internal path lookup that follows refs into stored entities */
  getPath(v: unknown, path: string[]): unknown;
}
RayfoldCache.prototype.getPath = function (this: RayfoldCache, v: unknown, path: string[]): unknown {
  let cur = v;
  for (const p of path) {
    // a field the result keeps for itself is read there, not from the entity
    if (isRef(cur)) cur = cur.$own && p in cur.$own ? cur.$own : this.get(cur.$ref);
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(p)] : (cur as Record<string, unknown>)[p];
  }
  return cur;
};

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}
