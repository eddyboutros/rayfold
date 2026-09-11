/** Breaking-change detection between two IRs. Spec: spec/11-evolution.md. */
import { annotation, typeRefToString, type ArgDef, type FieldDef, type RayfoldSchemaIR, type TypeDef } from "./ir.ts";

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
}

/** Members whose `@deprecated(sunset:)` date has passed may be removed. */
function sunsetPassed(x: { annotations: { name: string; args: Record<string, unknown> }[] }, now: Date): boolean {
  const d = annotation(x as never, "deprecated");
  const s = d?.args["sunset"];
  if (typeof s !== "string") return false;
  const date = new Date(s);
  return !Number.isNaN(date.getTime()) && date.getTime() <= now.getTime();
}

export function diffSchemas(oldIR: RayfoldSchemaIR, newIR: RayfoldSchemaIR, opts: DiffOptions = {}): Change[] {
  const now = opts.now ?? new Date();
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
    if ("fields" in o && "fields" in n) diffFields(o, n, o.kind === "input", push, removed, now);
    if (o.kind === "enum" && n.kind === "enum") {
      for (const v of o.values) {
        const nv = n.values.find((x) => x.name === v.name);
        if (!nv) removed(v, "enum-value-removed", `${name}.${v.name}`, `enum value ${name}.${v.name}`);
        else if (nv.ordinal !== v.ordinal) push("breaking", "ordinal-changed", `${name}.${v.name}`, `ordinal changed ${v.ordinal} -> ${nv.ordinal}`);
      }
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
      if (!o.returns.nullable && n.returns.nullable && sameBase(o.returns, n.returns)) push("breaking", "result-nullable", at, `result became nullable`);
      else if (o.returns.nullable && !n.returns.nullable && sameBase(o.returns, n.returns)) push("compatible", "result-non-null", at, `result became non-null`);
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

function sameBase(a: { kind: string; name?: string }, b: { kind: string; name?: string }): boolean {
  return a.kind === "named" && b.kind === "named" && a.name === b.name;
}

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
    if (nf.ordinal !== f.ordinal) push("breaking", "ordinal-changed", at, `ordinal changed ${f.ordinal} -> ${nf.ordinal}`);
    const ot = typeRefToString(f.type);
    const nt = typeRefToString(nf.type);
    if (ot !== nt) {
      if (sameBase(f.type, nf.type) && f.type.kind === "named" && nf.type.kind === "named" && !f.type.args && !nf.type.args) {
        const becameNullable = !f.type.nullable && nf.type.nullable;
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
    if (ot !== nt && !(sameBase(a.type, na.type) && a.type.kind === "named" && !a.type.args)) push("breaking", "arg-type-changed", aat, `type changed ${ot} -> ${nt}`);
    else if (wasOptional && !isOptional) push("breaking", "arg-required", aat, `argument became required`);
    else if (!wasOptional && isOptional) push("compatible", "arg-optional", aat, `argument became optional`);
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
