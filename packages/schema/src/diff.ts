/** Breaking-change detection between two IRs. Spec: spec/11-evolution.md. */
import { annotation, typeRefToString, type ArgDef, type FieldDef, type RayfoldSchemaIR, type TypeDef, type TypeRef } from "./ir.ts";

export type ChangeLevel = "breaking" | "warning" | "compatible";

export interface Change {
  level: ChangeLevel;
  code: string;
  at: string;
  message: string;
}

export interface DiffOptions {
  /** "now" for sunset evaluation (ISO date or Date). Defaults to today. */
  now?: Date;
  /**
   * The old IR is a lockfile's: its ordinals are the ones assigned at publication (spec 01 §9.6), and a member of the
   * new schema keeps its ordinal by name. Only an `@ordinal` that says otherwise changes one. Without a lock, both
   * sides number by position, so a member that moved is a warning and only a written `@ordinal` that changed breaks.
   */
  lockedOrdinals?: boolean;
}

/** Members whose `@deprecated(sunset:)` date has passed may be removed. */
function sunsetPassed(x: { annotations: { name: string; args: Record<string, unknown> }[] }, now: Date): boolean {
  const d = annotation(x as never, "deprecated");
  const s = d?.args["sunset"];
  if (typeof s !== "string") return false;
  const date = new Date(s);
  return !Number.isNaN(date.getTime()) && date.getTime() <= now.getTime();
}

/** The ordinal an `@ordinal(n)` annotation writes down, if there is one. */
function declaredOrdinal(x: { annotations: { name: string; args: Record<string, unknown> }[] }): number | undefined {
  const v = x.annotations.find((a) => a.name === "ordinal")?.args["value"];
  return typeof v === "number" ? v : undefined;
}

/**
 * Ordinal changes of the members two versions share, and ordinals a new member takes from another: [o] and [n] are
 * the old and new members in order, [at] names one.
 */
function diffOrdinals<M extends { name: string; ordinal: number; annotations: { name: string; args: Record<string, unknown> }[] }>(
  o: M[],
  n: M[],
  at: (m: M) => string,
  locked: boolean,
  push: Push,
): void {
  for (const nm of n) {
    const om = o.find((x) => x.name === nm.name);
    const declared = declaredOrdinal(nm);
    if (!om) {
      const holder = declared === undefined ? undefined : o.find((x) => x.ordinal === declared && x.name !== nm.name);
      if (holder) push("breaking", "ordinal-reused", at(nm), `ordinal ${declared} belonged to ${holder.name}`);
      continue;
    }
    if (locked) {
      if (declared !== undefined && declared !== om.ordinal) push("breaking", "ordinal-changed", at(nm), `ordinal changed ${om.ordinal} -> ${declared}`);
    } else if (om.ordinal !== nm.ordinal) {
      if (declared !== undefined || declaredOrdinal(om) !== undefined) push("breaking", "ordinal-changed", at(nm), `ordinal changed ${om.ordinal} -> ${nm.ordinal}`);
      else push("warning", "ordinal-shifted", at(nm), `moved from position ${om.ordinal} to ${nm.ordinal}; against a lockfile it keeps its ordinal by name`);
    }
  }
}

export function diffSchemas(oldIR: RayfoldSchemaIR, newIR: RayfoldSchemaIR, opts: DiffOptions = {}): Change[] {
  const now = opts.now ?? new Date();
  const locked = opts.lockedOrdinals ?? false;
  const out: Change[] = [];
  const push = (level: ChangeLevel, code: string, at: string, message: string) => out.push({ level, code, at, message });
  const removed = (x: { annotations: never[] } | { annotations: unknown[] }, code: string, at: string, what: string) => {
    if (sunsetPassed(x as never, now)) push("compatible", `${code}-after-sunset`, at, `${what} removed after its sunset date`);
    else push("breaking", code, at, `${what} removed (deprecate with a sunset date first)`);
  };

  // ---- types
  for (const [name, o] of Object.entries(oldIR.types)) {
    if (o.builtin) continue;
    const n = newIR.types[name];
    if (!n) {
      removed(o, "type-removed", name, `${o.kind} ${name}`);
      continue;
    }
    if (n.kind !== o.kind) {
      push("breaking", "kind-changed", name, `${name} changed from ${o.kind} to ${n.kind}`);
      continue;
    }
    if ("fields" in o && "fields" in n) {
      diffFields(o, n, o.kind === "input", push, removed, now);
      diffOrdinals(o.fields, n.fields, (f) => `${name}.${f.name}`, locked, push);
    }
    if (o.kind === "enum" && n.kind === "enum") {
      for (const v of o.values) {
        if (!n.values.some((x) => x.name === v.name)) removed(v, "enum-value-removed", `${name}.${v.name}`, `enum value ${name}.${v.name}`);
      }
      diffOrdinals(o.values, n.values, (v) => `${name}.${v.name}`, locked, push);
      for (const v of n.values) if (!o.values.some((x) => x.name === v.name)) push("compatible", "enum-value-added", `${name}.${v.name}`, `enum value added`);
    }
    if (o.kind === "union" && n.kind === "union") {
      for (const m of o.members) if (!n.members.includes(m)) push("breaking", "union-member-removed", name, `union member ${m} removed`);
      for (const m of n.members) if (!o.members.includes(m)) push("compatible", "union-member-added", name, `union member ${m} added`);
    }
    if (o.kind === "entity" && n.kind === "entity") {
      for (const i of o.implements) if (!n.implements.includes(i)) push("breaking", "interface-dropped", name, `${name} no longer implements ${i}`);
    }
    diffPolicies(o.annotations, n.annotations, name, push);
  }
  for (const [name, n] of Object.entries(newIR.types)) if (!n.builtin && !oldIR.types[name]) push("compatible", "type-added", name, `${n.kind} ${name} added`);

  // ---- ops
  for (const [name, o] of Object.entries(oldIR.ops)) {
    const n = newIR.ops[name];
    const at = `${name}()`;
    if (!n) {
      removed(o, "op-removed", at, `${o.kind} ${name}`);
      continue;
    }
    if (n.kind !== o.kind) push("breaking", "op-kind-changed", at, `${name} changed from ${o.kind} to ${n.kind}`);
    if (typeRefToString(n.returns) !== typeRefToString(o.returns)) {
      const d = nullability(o.returns, n.returns);
      if (d === "looser") push("breaking", "result-nullable", at, `result became nullable`);
      else if (d === "tighter") push("compatible", "result-non-null", at, `result became non-null`);
      else push("breaking", "result-type-changed", at, `result type changed ${typeRefToString(o.returns)} -> ${typeRefToString(n.returns)}`);
    }
    diffArgs(o.args, n.args, at, push, removed, now);
    for (const e of o.throws) if (!n.throws.includes(e)) push("compatible", "throws-removed", at, `no longer throws ${e}`);
    for (const e of n.throws) if (!o.throws.includes(e)) push("warning", "throws-added", at, `now throws ${e}; clients with exhaustive handling must be updated`);
    for (const e of n.emits) if (!o.emits.includes(e)) push("compatible", "emits-added", at, `now emits ${e}`);
    diffPolicies(o.annotations, n.annotations, at, push);
  }
  for (const [name, n] of Object.entries(newIR.ops)) if (!oldIR.ops[name]) push("compatible", "op-added", `${name}()`, `${n.kind} ${name} added`);

  // ---- views
  for (const [key, o] of Object.entries(oldIR.views)) {
    if (!newIR.views[key]) push(o.name === "default" ? "warning" : "breaking", "view-removed", key, `view ${key} removed`);
  }
  return out;
}

/**
 * How [b] differs from [a] when only nullability differs, at any level (a list, its items, a Page's items): "looser"
 * when some levels became nullable and none non-null, "tighter" the other way round, "mixed" when both happened.
 * Undefined when the types differ in more than nullability: `Page<Book>` and `Page<Author>` share a name and nothing else.
 */
function nullability(a: TypeRef, b: TypeRef): "same" | "looser" | "tighter" | "mixed" | undefined {
  let looser = false;
  let tighter = false;
  const walk = (x: TypeRef, y: TypeRef): boolean => {
    if (x.nullable !== y.nullable) {
      if (y.nullable) looser = true;
      else tighter = true;
    }
    if (x.kind === "list" || y.kind === "list") return x.kind === "list" && y.kind === "list" && walk(x.of, y.of);
    const xs = x.args ?? [];
    const ys = y.args ?? [];
    return x.name === y.name && xs.length === ys.length && xs.every((t, i) => walk(t, ys[i]!));
  };
  if (!walk(a, b)) return undefined;
  return looser && tighter ? "mixed" : looser ? "looser" : tighter ? "tighter" : "same";
}

/** [t] with its own nullability set aside, so what is left is how its items or arguments changed. */
const inner = (t: TypeRef): TypeRef => ({ ...t, nullable: false });

type Push = (level: ChangeLevel, code: string, at: string, message: string) => void;
type Removed = (x: { annotations: unknown[] }, code: string, at: string, what: string) => void;

function diffFields(o: Extract<TypeDef, { fields: FieldDef[] }>, n: Extract<TypeDef, { fields: FieldDef[] }>, isInput: boolean, push: Push, removed: Removed, now: Date): void {
  for (const f of o.fields) {
    const at = `${o.name}.${f.name}`;
    const nf = n.fields.find((x) => x.name === f.name);
    if (!nf) {
      removed(f, "field-removed", at, `field ${at}`);
      continue;
    }
    const ot = typeRefToString(f.type);
    const nt = typeRefToString(nf.type);
    const d = nullability(f.type, nf.type);
    if (ot !== nt) {
      // what a server returns may only become non-null, and what a caller sends may only become nullable
      if (d === "looser" || d === "tighter") {
        const becameNullable = d === "looser";
        if (isInput) push(becameNullable ? "compatible" : "breaking", becameNullable ? "input-field-optional" : "input-field-required", at, `${ot} -> ${nt}`);
        else push(becameNullable ? "breaking" : "compatible", becameNullable ? "field-nullable" : "field-non-null", at, `${ot} -> ${nt}`);
      } else push("breaking", "field-type-changed", at, `type changed ${ot} -> ${nt}`);
    }
    diffArgs(f.args, nf.args, at, push, removed, now);
    diffPolicies(f.annotations, nf.annotations, at, push);
    if (isInput && f.default !== undefined && nf.default === undefined && !nf.type.nullable) push("breaking", "default-removed", at, `default removed from a required input field`);
  }
  for (const f of n.fields) {
    if (o.fields.some((x) => x.name === f.name)) continue;
    const at = `${n.name}.${f.name}`;
    if (isInput && !f.type.nullable && f.default === undefined) push("breaking", "input-field-added-required", at, `required input field added without a default`);
    else push("compatible", "field-added", at, `field added`);
  }
}

function diffArgs(o: ArgDef[], n: ArgDef[], at: string, push: Push, removed: Removed, now: Date): void {
  void now;
  for (const a of o) {
    const na = n.find((x) => x.name === a.name);
    const aat = `${at}.${a.name}`;
    if (!na) {
      removed(a, "arg-removed", aat, `argument ${aat}`);
      continue;
    }
    const wasOptional = a.type.nullable || a.default !== undefined;
    const isOptional = na.type.nullable || na.default !== undefined;
    const ot = typeRefToString(a.type);
    const nt = typeRefToString(na.type);
    // the argument's own nullability is whether it is optional; below that, a caller's items may only become nullable
    const d = ot === nt ? "same" : nullability(inner(a.type), inner(na.type));
    if (d === undefined || d === "mixed" || d === "tighter") push("breaking", "arg-type-changed", aat, `type changed ${ot} -> ${nt}`);
    else if (wasOptional && !isOptional) push("breaking", "arg-required", aat, `argument became required`);
    else if (!wasOptional && isOptional) push("compatible", "arg-optional", aat, `argument became optional`);
    else if (d === "looser") push("compatible", "arg-type-widened", aat, `${ot} -> ${nt}`);
  }
  for (const a of n) {
    if (o.some((x) => x.name === a.name)) continue;
    const aat = `${at}.${a.name}`;
    if (!a.type.nullable && a.default === undefined) push("breaking", "arg-added-required", aat, `required argument added without a default`);
    else push("compatible", "arg-added", aat, `optional argument added`);
  }
}

function diffPolicies(o: { name: string }[], n: { name: string }[], at: string, push: Push): void {
  const had = o.some((a) => a.name === "allow" || a.name === "deny");
  const has = n.some((a) => a.name === "allow" || a.name === "deny");
  if (!had && has) push("warning", "policy-added", at, `a policy was added where none existed; some callers may now be denied`);
  if (had && !has) push("warning", "policy-removed", at, `a policy was removed; data may become more widely readable`);
}

export function isBreaking(changes: Change[]): boolean {
  return changes.some((c) => c.level === "breaking");
}
