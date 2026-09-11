/**
 * Live queries (extension `live`, spec/08): the query is the subscription.
 * A live query records its read set (entity keys + op name). Every command's patch and every explicit
 * `changes.publish()` feeds a ChangeBus; when a change intersects a read set the query re-runs and the
 * client receives either a minimal `patch` frame (same result structure, changed fields) or a fresh
 * `data` frame (membership/order changed).
 */
import type { Frame, PatchOp } from "./protocol.ts";

export interface Change {
  keys: Set<string>;
  ops: Set<string>;
}

export class ChangeBus {
  private readonly subs = new Set<(c: Change) => void>();
  publish(c: Change): void {
    if (!c.keys.size && !c.ops.size) return;
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

/**
 * Compare two results. Returns a `patch` frame body when only entity fields changed,
 * a full `data` replacement when the skeleton differs, or null when nothing changed.
 */
export function diffResults(prev: unknown, next: unknown): { patch: PatchOp[] } | { data: unknown } | null {
  const a = normalizeResult(prev);
  const b = normalizeResult(next);
  if (JSON.stringify(a.skeleton) !== JSON.stringify(b.skeleton)) return { data: next };
  const patch: PatchOp[] = [];
  for (const [key, fields] of b.entities) {
    const before = a.entities.get(key);
    const changed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (!before || JSON.stringify(before[k]) !== JSON.stringify(v)) changed[k] = v;
    }
    if (Object.keys(changed).length) patch.push({ set: key, value: changed });
  }
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
