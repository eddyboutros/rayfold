/**
 * Live queries (extension `live`, spec/08): the query is the subscription.
 * A live query records its read set (entity keys + op name). Every command's patch and every explicit
 * `changes.publish()` feeds a ChangeBus; when a change intersects a read set the query re-runs and the
 * client receives either a minimal `patch` frame (same result structure, changed fields) or a fresh
 * `data` frame (membership/order changed).
 */
import type { Frame, PatchOp } from "./protocol.ts";
import type { Relay } from "./relay.ts";

export interface Change {
  keys: Set<string>;
  ops: Set<string>;
}

export class ChangeBus {
  private readonly subs = new Set<(c: Change) => void>();

  constructor(
    private readonly relay?: Relay,
    /** Where a relay's refusal to carry a change goes; the change itself was already made. */
    private readonly onRelayError: (error: unknown) => void = () => {},
  ) {}

  /** A change this server made: its own live queries hear it now, and every other server's through the relay. */
  publish(c: Change): void {
    if (!c.keys.size && !c.ops.size) return;
    this.deliver(c);
    if (this.relay) this.relay.publish({ kind: "change", keys: [...c.keys], ops: [...c.ops] }).catch(this.onRelayError);
  }

  /** A change reaching this server, made here or elsewhere: only the live queries here hear it. */
  deliver(c: Change): void {
    for (const fn of this.subs) fn(c);
  }
  subscribe(fn: (c: Change) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  get size(): number {
    return this.subs.size;
  }
}

export function changeFromPatch(patch: PatchOp[]): Change {
  const keys = new Set<string>();
  const ops = new Set<string>();
  for (const p of patch) {
    if ("set" in p) keys.add(p.set);
    else if ("list" in p || "at" in p) continue; // result-scoped: names no entity and no operation
    else if ("del" in p) keys.add(p.del);
    else if ("inv" in p) p.inv.forEach((k) => keys.add(k));
    else if ("invOp" in p) p.invOp.forEach((o) => ops.add(o));
  }
  return { keys, ops };
}

/** Entities keyed by "$type:id" with nested entities replaced by refs; plus the skeleton. */
export function normalizeResult(data: unknown): { entities: Map<string, Record<string, unknown>>; skeleton: unknown } {
  const entities = new Map<string, Record<string, unknown>>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    const o = v as Record<string, unknown>;
    const tn = o["$type"];
    const id = o["id"];
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = walk(x);
    if (typeof tn === "string" && (typeof id === "string" || typeof id === "number")) {
      const key = `${tn}:${id}`;
      entities.set(key, { ...(entities.get(key) ?? {}), ...out });
      return { $ref: key };
    }
    return out;
  };
  const skeleton = walk(data);
  return { entities, skeleton };
}

export function readSetOf(data: unknown): Set<string> {
  return new Set(normalizeResult(data).entities.keys());
}

/** The key that gives a value its identity in a list: its entity key, or its own content. */
function identityOf(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const tn = o["$type"];
    const id = o["id"];
    if (typeof tn === "string" && (typeof id === "string" || typeof id === "number")) return `${tn}:${id}`;
  }
  return `#${JSON.stringify(v)}`;
}

const entityAt = (v: unknown): string | null => {
  const k = identityOf(v);
  return k.startsWith("#") ? null : k;
};
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const joinPath = (path: string, part: string | number): string => (path === "" ? String(part) : `${path}.${part}`);
const isLeaf = (v: unknown): boolean => v === null || typeof v !== "object";

type StructuralOp = { at: string; value: Record<string, unknown> } | { list: string; del?: number[]; ins?: Array<{ at: number; value: unknown }> };

/**
 * Describes how `b` differs from `a` as ops the client can apply to its stored result, or returns false when the
 * difference cannot be expressed (a reorder, a changed set of fields) and the whole result has to be sent.
 * Entities are not descended into: their fields travel as `set` ops. `carried` collects the entity keys whose
 * values travel inside an insertion, so the caller does not send them twice.
 */
function structuralDiff(a: unknown, b: unknown, path: string, ops: StructuralOp[], carried: Set<string>): boolean {
  if (sameJson(a, b)) return true;
  const ea = entityAt(a);
  const eb = entityAt(b);
  if (ea || eb) return ea !== null && ea === eb; // same entity: covered by `set`; a different one is structural
  if (Array.isArray(a) && Array.isArray(b)) return listDiff(a, b, path, ops, carried);
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = Object.keys(bo);
    if (keys.length !== Object.keys(ao).length || keys.some((k) => !(k in ao))) return false;
    const merge: Record<string, unknown> = {};
    for (const k of keys) {
      const av = ao[k];
      const bv = bo[k];
      if (sameJson(av, bv)) continue;
      if (isLeaf(av) && isLeaf(bv)) {
        merge[k] = bv;
        continue;
      }
      if (!structuralDiff(av, bv, joinPath(path, k), ops, carried)) return false;
    }
    if (Object.keys(merge).length) ops.push({ at: path, value: merge });
    return true;
  }
  return false;
}

/** Positions removed and elements inserted, verified by replaying them: anything else (a reorder) is refused. */
function listDiff(a: unknown[], b: unknown[], path: string, ops: StructuralOp[], carried: Set<string>): boolean {
  const identified = (xs: unknown[]) => xs.length > 0 && xs.every((x) => entityAt(x) !== null);
  const objects = (xs: unknown[]) => xs.every((x) => x !== null && typeof x === "object" && !Array.isArray(x));
  // Rows with an identity of their own are matched by it. Elements without one (plain objects, such as a board's
  // columns) are matched by position, so a change inside one of them is described in place rather than resent.
  if (!(identified(a) && identified(b)) && a.length === b.length && objects(a) && objects(b)) {
    for (let n = 0; n < b.length; n++) if (!structuralDiff(a[n], b[n], joinPath(path, n), ops, carried)) return false;
    return true;
  }
  const oldKeys = a.map(identityOf);
  const newKeys = b.map(identityOf);
  const del: number[] = [];
  const ins: Array<{ at: number; value: unknown }> = [];
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (oldKeys[i] === newKeys[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (!newKeys.includes(oldKeys[i]!, j)) {
      del.push(i);
      i++;
    } else {
      ins.push({ at: j, value: b[j] });
      j++;
    }
  }
  while (i < a.length) del.push(i++);
  while (j < b.length) {
    ins.push({ at: j, value: b[j] });
    j++;
  }
  // The client removes the old positions, then inserts at the new ones. Refuse anything that does not replay exactly.
  const replay = a.filter((_, n) => !del.includes(n));
  for (const x of ins) replay.splice(x.at, 0, x.value);
  if (!sameJson(replay.map(identityOf), newKeys)) return false;
  for (const [x, y] of pairs) if (!structuralDiff(a[x], b[y], joinPath(path, y), ops, carried)) return false;
  if (del.length || ins.length) {
    for (const x of ins) for (const k of normalizeResult(x.value).entities.keys()) carried.add(k);
    const op: { list: string; del?: number[]; ins?: Array<{ at: number; value: unknown }> } = { list: path };
    if (del.length) op.del = del;
    if (ins.length) op.ins = ins;
    ops.push(op);
  }
  return true;
}

/**
 * Compare two results. Returns a `patch` frame body when the difference can be described (changed entity fields,
 * changed fields of a plain object, rows added to or removed from a list), a full `data` replacement when it
 * cannot, or null when nothing changed. A patch that would cost more than the result itself is not worth sending.
 */
export function diffResults(prev: unknown, next: unknown): { patch: PatchOp[] } | { data: unknown } | null {
  const a = normalizeResult(prev);
  const b = normalizeResult(next);
  const structural: StructuralOp[] = [];
  const carried = new Set<string>();
  if (JSON.stringify(a.skeleton) !== JSON.stringify(b.skeleton) && !structuralDiff(prev, next, "", structural, carried)) {
    return { data: next };
  }
  const patch: PatchOp[] = [];
  for (const [key, fields] of b.entities) {
    if (carried.has(key)) continue; // its fields travel inside an insertion
    const before = a.entities.get(key);
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (!before || JSON.stringify(before[k]) !== JSON.stringify(v)) changed[k] = v;
    }
    if (Object.keys(changed).length) patch.push({ set: key, value: changed });
  }
  // Describing the structure costs more than resending it only when nearly every row changed; then send the result.
  if (structural.length && JSON.stringify(structural).length >= JSON.stringify(next).length) return { data: next };
  patch.push(...(structural as PatchOp[]));
  return patch.length ? { patch } : null;
}

/** Fold `at` frames into a data value so deferred parts take part in diffs. */
export function foldFrames(frames: Frame[]): unknown {
  let data: unknown;
  for (const f of frames) {
    if ("at" in f) {
      if (f.at === "") Object.assign(data as Record<string, unknown>, f.data as Record<string, unknown>);
      else {
        const target = getPath(data, f.at.split("."));
        if (target && typeof target === "object") Object.assign(target as Record<string, unknown>, f.data as Record<string, unknown>);
      }
    } else if ("data" in f) data = f.data;
  }
  return data;
}

function getPath(v: unknown, path: string[]): unknown {
  let cur = v;
  for (const p of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(p)] : (cur as Record<string, unknown>)[p];
  }
  return cur;
}
