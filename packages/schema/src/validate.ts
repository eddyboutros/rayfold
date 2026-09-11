/** IR validation. Spec: spec/01-schema.md §8. */
import {
  RESERVED_FIELD_NAMES,
  RESERVED_OP_NAMES,
  annotation,
  baseName,
  isPageRef,
  type Annotation,
  type ArgDef,
  type Expr,
  type FieldDef,
  type RayfoldSchemaIR,
  type Shape,
  type TypeDef,
  type TypeRef,
} from "./ir.ts";
import { exprPaths } from "./expr.ts";

export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  /** schema coordinate: Type, Type.field, op(), Type.view */
  at: string;
}

export class RayfoldSchemaError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(
      `Invalid schema:\n${diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `  ${d.at}: ${d.message} [${d.code}]`)
        .join("\n")}`,
    );
    this.name = "RayfoldSchemaError";
  }
}

const KNOWN_ANNOTATIONS: Record<string, Set<string>> = {
  cache: new Set(["entity", "query"]),
  allow: new Set(["entity", "object", "field", "query", "command", "stream"]),
  deny: new Set(["entity", "object", "field", "query", "command", "stream"]),
  load: new Set(["field"]),
  page: new Set(["field", "query"]),
  cost: new Set(["field", "query", "stream", "command"]),
  deprecated: new Set(["entity", "object", "input", "enum", "union", "scalar", "error", "event", "field", "arg", "enumValue", "query", "command", "stream"]),
  lazy: new Set(["field"]),
  partial: new Set(["field"]),
  live: new Set(["query"]),
  input: new Set(["stream"]),
  interface: new Set(["object"]),
  idempotent: new Set(["command"]),
  format: new Set(["scalar", "field", "arg"]),
  unit: new Set(["scalar", "field", "arg"]),
  range: new Set(["scalar", "field", "arg"]),
  example: new Set(["scalar", "field", "arg", "query", "command", "stream", "entity", "object", "input"]),
  ordinal: new Set(["field", "enumValue"]),
  version: new Set(["field"]),
  http: new Set(["query", "command"]),
  simulate: new Set(["command"]),
};

const INPUT_KINDS = new Set(["scalar", "enum", "input"]);
const OUTPUT_KINDS = new Set(["scalar", "enum", "entity", "object", "union"]);
const STREAM_KINDS = new Set([...OUTPUT_KINDS, "event"]);

export function validateIR(ir: RayfoldSchemaIR): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (code: string, at: string, message: string): void => {
    out.push({ severity: "error", code, at, message });
  };
  const warn = (code: string, at: string, message: string): void => {
    out.push({ severity: "warning", code, at, message });
  };

  const typeOf = (name: string): TypeDef | undefined => ir.types[name];

  const checkRef = (t: TypeRef, at: string, allowed: Set<string>, ctx: string): void => {
    if (t.kind === "list") return checkRef(t.of, at, allowed, ctx);
    if (t.name === "T") return; // generic parameter inside built-in Page
    const def = typeOf(t.name);
    if (!def) return err("unknown-type", at, `Unknown type ${t.name}`);
    if (def.kind === "object" && def.typeParams?.length) {
      if (!t.args || t.args.length !== def.typeParams.length) {
        return err("generic-arity", at, `${t.name} takes ${def.typeParams.length} type argument(s)`);
      }
      for (const a of t.args) checkRef(a, at, allowed, ctx);
      return;
    }
    if (t.args?.length) return err("not-generic", at, `${t.name} is not generic`);
    if (!allowed.has(def.kind)) err("bad-type-position", at, `${def.kind} ${t.name} cannot be used as ${ctx}`);
  };

  const checkAnnotations = (anns: Annotation[], on: string, at: string): void => {
    for (const a of anns) {
      if (a.name.includes(".")) continue; // namespaced extension
      const allowed = KNOWN_ANNOTATIONS[a.name];
      if (!allowed) {
        err("unknown-annotation", at, `Unknown annotation @${a.name} (namespace it as @vendor.${a.name} to keep it)`);
        continue;
      }
      if (!allowed.has(on)) err("annotation-position", at, `@${a.name} is not allowed on ${on}`);
      if (a.name === "allow" || a.name === "deny") {
        for (const [k, v] of Object.entries(a.args)) {
          if (k !== "read" && k !== "write") err("bad-policy-arg", at, `@${a.name} accepts read: and write:, not ${k}:`);
          if (!(v && typeof v === "object" && "$expr" in v)) continue;
          if (on !== "field" && on !== "entity" && on !== "object") {
            for (const p of exprPaths((v as { $expr: Expr }).$expr)) {
              if (p.root === "this") err("policy-this-on-op", at, `'this' is not available in operation-level policies`);
            }
          }
        }
      }
      if (a.name === "cache") {
        const scope = a.args["scope"];
        if (scope && !(typeof scope === "object" && "$ident" in scope && ["public", "private"].includes(String((scope as { $ident: string }).$ident)))) {
          err("bad-cache-scope", at, `@cache scope must be public or private`);
        }
        if (a.args["maxAge"] !== undefined && !(typeof a.args["maxAge"] === "object" && a.args["maxAge"] && "$duration" in a.args["maxAge"])) {
          err("bad-cache-maxage", at, `@cache maxAge must be a duration like 60s`);
        }
      }
      if (a.name === "load") {
        const v = a.args["value"];
        if (!(v && typeof v === "object" && "$ident" in v && ["batch", "single"].includes(String((v as { $ident: string }).$ident)))) {
          err("bad-load", at, `@load must be batch or single`);
        }
      }
    }
  };

  const checkFields = (fields: FieldDef[], owner: TypeDef, allowed: Set<string>, ctx: string): void => {
    for (const f of fields) {
      const at = `${owner.name}.${f.name}`;
      if (RESERVED_FIELD_NAMES.has(f.name) || f.name.startsWith("__") || f.name.startsWith("$")) {
        err("reserved-name", at, `Field name ${f.name} is reserved`);
      }
      checkRef(f.type, at, allowed, ctx);
      checkAnnotations(f.annotations, "field", at);
      for (const a of f.args) checkArg(a, `${at}(${a.name})`);
      if (owner.kind !== "entity" && owner.kind !== "object" && f.args.length) {
        err("args-not-allowed", at, `Only entity and object fields take arguments`);
      }
      if (f.annotations.some((a) => a.name === "version")) {
        const vt = f.type;
        if (vt.kind !== "named" || !["Int", "Long", "String", "Instant"].includes(vt.name) || vt.nullable) err("bad-version-field", at, `@version fields must be non-null Int, Long, String or Instant`);
      }
      const hasPage = f.annotations.some((a) => a.name === "page");
      if (hasPage && !isPageRef(f.type)) err("page-on-non-page", at, `@page requires a Page<T> field`);
      if (f.annotations.some((a) => a.name === "partial") && !f.type.nullable) {
        err("partial-non-null", at, `@partial fields must be nullable (they become null on failure)`);
      }
    }
  };

  const checkArg = (a: ArgDef, at: string): void => {
    checkRef(a.type, at, INPUT_KINDS, "an argument");
    checkAnnotations(a.annotations, "arg", at);
  };

  // --- types
  for (const t of Object.values(ir.types)) {
    if (t.builtin) continue;
    const at = t.name;
    if (t.name.startsWith("__") || t.name.startsWith("$")) err("reserved-name", at, `Type name ${t.name} is reserved`);
    checkAnnotations(t.annotations, t.kind, at);
    switch (t.kind) {
      case "entity": {
        const id = t.fields.find((f) => f.name === "id");
        if (!id || id.type.kind !== "named" || id.type.name !== "ID" || id.type.nullable) {
          err("entity-id", at, `entity ${t.name} must declare id: ID`);
        }
        for (const i of t.implements) {
          const iface = typeOf(i);
          if (!iface || iface.kind !== "object" || !iface.interface) {
            err("bad-interface", at, `${i} is not an @interface object`);
            continue;
          }
          for (const f of iface.fields) {
            if (!t.fields.some((x) => x.name === f.name)) err("missing-interface-field", at, `${t.name} must implement ${i}.${f.name}`);
          }
        }
        checkFields(t.fields, t, OUTPUT_KINDS, "a result field");
        break;
      }
      case "object":
      case "error":
      case "event":
        checkFields(t.fields, t, t.kind === "object" ? OUTPUT_KINDS : new Set(["scalar", "enum", "object"]), "a field");
        break;
      case "input":
        checkFields(t.fields, t, INPUT_KINDS, "an input field");
        break;
      case "union":
        for (const m of t.members) {
          const md = typeOf(m);
          if (!md) err("unknown-type", at, `Unknown union member ${m}`);
          else if (md.kind !== "entity" && md.kind !== "object") err("bad-union-member", at, `Union members must be entities or objects (${m} is ${md.kind})`);
        }
        break;
      case "enum":
        for (const v of t.values) checkAnnotations(v.annotations, "enumValue", `${at}.${v.name}`);
        break;
      default:
    }
  }

  // --- ops
  for (const op of Object.values(ir.ops)) {
    const at = `${op.name}()`;
    if (RESERVED_OP_NAMES.has(op.name) || op.name.startsWith("__") || op.name.startsWith("$")) {
      err("reserved-name", at, `Operation name ${op.name} is reserved`);
    }
    if (ir.types[op.name] && !ir.types[op.name]!.builtin) warn("shadowed-name", at, `Operation ${op.name} shares its name with a type`);
    for (const a of op.args) checkArg(a, `${at}.${a.name}`);
    checkRef(op.returns, at, op.kind === "stream" ? STREAM_KINDS : OUTPUT_KINDS, "a result");
    checkAnnotations(op.annotations, op.kind, at);
    for (const e of op.throws) {
      const d = typeOf(e);
      if (!d) err("unknown-type", at, `Unknown error ${e}`);
      else if (d.kind !== "error") err("bad-throws", at, `throws ${e}: not an error type`);
    }
    for (const e of op.emits) {
      const d = typeOf(e);
      if (!d) err("unknown-type", at, `Unknown event ${e}`);
      else if (d.kind !== "event") err("bad-emits", at, `emits ${e}: not an event type`);
    }
    if (op.kind !== "command" && op.emits.length) err("emits-on-non-command", at, `Only commands emit events`);
    const http = annotation(op, "http");
    if (http) {
      const m = http.args["method"];
      const method = m && typeof m === "object" && "$ident" in m ? String((m as { $ident: string }).$ident).toUpperCase() : typeof m === "string" ? m.toUpperCase() : "";
      const allowed = op.kind === "query" ? ["GET", "QUERY"] : op.kind === "command" ? ["POST", "PUT", "PATCH", "DELETE"] : [];
      if (!allowed.includes(method)) err("bad-http-method", at, `@http method must be one of ${allowed.join(", ") || "(none for streams)"}`);
      const path = http.args["path"];
      if (typeof path !== "string" || !path.startsWith("/")) err("bad-http-path", at, `@http path must be a string starting with "/"`);
      else for (const [, name] of path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        if (!op.args.some((a) => a.name === name)) err("bad-http-param", at, `@http path parameter {${name}} is not an argument`);
      }
      const body = http.args["body"];
      const bodyName = body && typeof body === "object" && "$ident" in body ? String((body as { $ident: string }).$ident) : typeof body === "string" ? body : undefined;
      if (bodyName !== undefined && bodyName !== "*" && !op.args.some((a) => a.name === bodyName)) err("bad-http-body", at, `@http body ${bodyName} is not an argument`);
      if (bodyName !== undefined && method === "GET") err("bad-http-body", at, `GET bindings cannot take a body`);
    }
    if (isPageRef(op.returns)) {
      const hasPageArg = op.args.some((a) => a.type.kind === "named" && a.type.name === "PageArgs") || op.args.some((a) => a.name === "first");
      if (!hasPageArg) err("page-args", at, `An operation returning Page<T> must accept page: PageArgs (or first/after)`);
    }
  }

  // --- views
  for (const v of Object.values(ir.views)) {
    const at = `${v.type}.${v.name}`;
    const t = typeOf(v.type);
    if (!t) {
      err("unknown-type", at, `View on unknown type ${v.type}`);
      continue;
    }
    if (t.kind !== "entity" && t.kind !== "object" && t.kind !== "union") {
      err("view-on-non-object", at, `Views apply to entities, objects and unions`);
      continue;
    }
    checkShapeAgainst(ir, v.shape, { kind: "named", name: t.name, nullable: false }, at, err, new Set([at]));
  }

  // --- reachability (warning)
  const reachable = new Set<string>();
  const visit = (t: TypeRef): void => {
    const n = baseName(t);
    if (reachable.has(n)) return;
    const d = typeOf(n);
    if (!d) return;
    reachable.add(n);
    if ("fields" in d) for (const f of d.fields) visit(f.type);
    if (d.kind === "union") for (const m of d.members) visit({ kind: "named", name: m, nullable: false });
    if (t.kind === "named" && t.args) t.args.forEach(visit);
  };
  for (const op of Object.values(ir.ops)) {
    visit(op.returns);
    for (const e of op.throws) reachable.add(e);
    for (const e of op.emits) visit({ kind: "named", name: e, nullable: false });
  }
  for (const t of Object.values(ir.types)) {
    if (t.builtin || reachable.has(t.name)) continue;
    if (t.kind === "entity" || t.kind === "object" || t.kind === "union") {
      warn("unreachable", t.name, `${t.kind} ${t.name} is not reachable from any operation`);
    }
  }

  return out;
}

export function assertValid(ir: RayfoldSchemaIR): void {
  const d = validateIR(ir);
  if (d.some((x) => x.severity === "error")) throw new RayfoldSchemaError(d);
}

/** Field lookup that understands entity/object/union/interface and Page<T>. */
export function fieldsOf(ir: RayfoldSchemaIR, t: TypeRef): FieldDef[] | null {
  if (t.kind === "list") return fieldsOf(ir, t.of);
  const d = ir.types[t.name];
  if (!d) return null;
  if (d.kind === "object" && d.typeParams?.length && t.args) {
    const bind = new Map(d.typeParams.map((p, i) => [p, t.args![i]!]));
    return d.fields.map((f) => ({ ...f, type: substitute(f.type, bind) }));
  }
  if ("fields" in d) return d.fields;
  return null;
}

function substitute(t: TypeRef, bind: Map<string, TypeRef>): TypeRef {
  if (t.kind === "list") return { kind: "list", of: substitute(t.of, bind), nullable: t.nullable };
  const b = bind.get(t.name);
  if (b) return { ...b, nullable: t.nullable || b.nullable };
  return t.args ? { ...t, args: t.args.map((a) => substitute(a, bind)) } : t;
}

function checkShapeAgainst(
  ir: RayfoldSchemaIR,
  shape: Shape,
  ref: TypeRef,
  at: string,
  err: (code: string, at: string, message: string) => void,
  seenViews: Set<string>,
): void {
  const typeName = ref.kind === "list" ? baseNameNoPage(ref) : ref.name;
  const t = ir.types[typeName];
  if (!t) return;
  const fields = t.kind === "union" ? [] : fieldsOf(ir, ref) ?? [];
  for (const item of shape.items) {
    switch (item.kind) {
      case "field": {
        const f = fields.find((x) => x.name === item.name);
        if (!f) {
          err("unknown-field", at, `${t.name} has no field ${item.name}`);
          break;
        }
        if (item.shape) {
          const subName = f.type.kind === "list" ? baseNameNoPage(f.type) : f.type.name;
          const sub = ir.types[subName];
          if (!sub || !("fields" in sub || sub.kind === "union")) err("shape-on-scalar", at, `${item.name} is scalar; it cannot have a sub-shape`);
          else checkShapeAgainst(ir, item.shape, f.type, at, err, seenViews);
        }
        break;
      }
      case "spread": {
        const key = `${item.type}.${item.view}`;
        if (!ir.views[key]) err("unknown-view", at, `Unknown view ${key}`);
        else if (seenViews.has(key)) err("view-cycle", at, `View spread cycle through ${key}`);
        else if (item.type !== t.name && t.kind !== "union") err("spread-type-mismatch", at, `Cannot spread ${key} into ${t.name}`);
        else checkShapeAgainst(ir, ir.views[key]!.shape, ref, at, err, new Set([...seenViews, key]));
        break;
      }
      case "on": {
        const sub = ir.types[item.type];
        if (!sub) err("unknown-type", at, `Unknown type ${item.type} in ...on`);
        else if (t.kind === "union" && !t.members.includes(item.type)) err("bad-type-condition", at, `${item.type} is not a member of ${t.name}`);
        else checkShapeAgainst(ir, item.shape, { kind: "named", name: item.type, nullable: false }, at, err, seenViews);
        break;
      }
      case "defer":
        checkShapeAgainst(ir, item.shape, ref, at, err, seenViews);
        break;
    }
  }
}

/** Innermost named type through lists only (Page stays Page). */
function baseNameNoPage(t: TypeRef): string {
  return t.kind === "list" ? baseNameNoPage(t.of) : t.name;
}
