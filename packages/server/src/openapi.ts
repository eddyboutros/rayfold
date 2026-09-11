/**
 * OpenAPI 3.2 generated from the schema and its HTTP bindings. The document is derived from the same IR that
 * the runtime enforces, so the published contract and the validation rules cannot drift apart.
 * 3.2 is required for the QUERY operation.
 */
import { annotation, baseName, type Annotation, type ArgDef, type OpDef, type RayfoldSchemaIR, type TypeRef } from "@rayfold/schema";
import { bindingsOf } from "./bindings.ts";
import { jsonSchemaFor, withRange } from "./mcp.ts";

export function openApiFor(ir: RayfoldSchemaIR, opts: { title?: string; version?: string; prefix?: string } = {}): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  const schema = (t: TypeRef, input: boolean) => jsonSchemaFor(ir, t, defs, input);
  const paths: Record<string, Record<string, unknown>> = {};

  for (const b of bindingsOf(ir)) {
    const op = b.op;
    const p = (opts.prefix ?? "") + b.path;
    const parameters: unknown[] = b.params.map((name) => param(ir, op, name, "path", true, defs));
    if (b.method === "GET") {
      for (const a of op.args) if (!b.params.includes(a.name)) parameters.push(param(ir, op, a.name, "query", !a.type.nullable && a.default === undefined, defs));
      parameters.push({ name: "shape", in: "query", required: false, description: "Rayfold shape text or sha256: shape id; default view when absent", schema: { type: "string" } });
    }
    const versioned = returnsVersionedEntity(ir, op);
    if (op.kind === "command" && b.method === "POST") {
      const optOut = annotation(op, "idempotent")?.args["value"] === false;
      parameters.push({ name: "Idempotency-Key", in: "header", required: !optOut, description: "Replays the original response on retry", schema: { type: "string", minLength: 16, maxLength: 128 } });
    }
    // The binding honours If-Match on every method, so every versioned command offers it (and lists 412).
    if (op.kind === "command" && versioned) {
      parameters.push({ name: "If-Match", in: "header", required: false, description: "Entity version from a previous response; 412 with the current entity when stale", schema: { type: "string" } });
    }
    const operation: Record<string, unknown> = { operationId: op.name, parameters };
    if (op.description) operation["summary"] = op.description;
    if (b.body) {
      const bodySchema = b.body === "*" ? argsObject(ir, op.args.filter((a) => !b.params.includes(a.name)), defs) : schema(op.args.find((a) => a.name === b.body)!.type, true);
      const types = b.method === "PATCH" ? ["application/merge-patch+json", "application/json"] : ["application/json"];
      const bodyArgs = b.body === "*" ? op.args.filter((a) => !b.params.includes(a.name)) : op.args.filter((a) => a.name === b.body);
      const required = bodyArgs.some((a) => !a.type.nullable && a.default === undefined);
      operation["requestBody"] = { required, content: Object.fromEntries(types.map((t) => [t, { schema: bodySchema }])) };
    }
    const ok = { description: "Result in the requested shape (default view when no shape is given)", content: { "application/json": { schema: schema(op.returns, false) } } };
    const responses: Record<string, unknown> = {};
    responses[b.method === "POST" && b.location ? "201" : "200"] = ok;
    if (op.kind === "query") responses["304"] = { description: "Not modified (ETag revalidation)" };
    responses["400"] = problemRef("Invalid argument, including schema constraints such as @range");
    if (hasPolicy(op) || typeHasPolicy(ir, op.returns)) {
      responses["401"] = problemRef("Sign-in required by a policy");
      responses["403"] = problemRef("Denied by a policy");
    }
    if (op.kind === "command" && versioned) responses["412"] = problemRef("VersionConflict: data.current carries the entity as stored");
    if (op.throws.length) {
      responses["422"] = { description: `Declared domain errors: ${op.throws.join(", ")}`, content: { "application/problem+json": { schema: { oneOf: op.throws.map((t) => domainProblem(t, schema({ kind: "named", name: t, nullable: false }, false))) } } } };
    }
    operation["responses"] = responses;
    (paths[p] ??= {})[b.method.toLowerCase()] = operation;
  }

  const components = JSON.parse(JSON.stringify({ schemas: { ...defs, Problem: PROBLEM } }).replace(/"#\/\$defs\//g, '"#/components/schemas/'));
  const doc = { openapi: "3.2.0", info: { title: opts.title ?? "Rayfold API", version: opts.version ?? "0.1" }, paths, components };
  return JSON.parse(JSON.stringify(doc).replace(/"#\/\$defs\//g, '"#/components/schemas/'));
}

const PROBLEM = {
  type: "object",
  description: "RFC 9457 problem details; Rayfold errors keep code, type and data",
  properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "integer" }, detail: { type: "string" }, code: { type: "string" }, path: { type: "string" }, data: {} },
  required: ["type", "title", "status", "code"],
};

function problemRef(description: string): unknown {
  return { description, content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } };
}

function domainProblem(type: string, dataSchema: unknown): unknown {
  return { allOf: [{ $ref: "#/components/schemas/Problem" }, { properties: { title: { const: type }, data: dataSchema } }] };
}

function param(ir: RayfoldSchemaIR, op: OpDef, name: string, where: "path" | "query", required: boolean, defs: Record<string, unknown>): unknown {
  const a = op.args.find((x) => x.name === name);
  const s = a ? jsonSchemaFor(ir, a.type, defs, true) : { type: "string" };
  const out: Record<string, unknown> = { name, in: where, required: where === "path" ? true : required, schema: a ? withRange(s, a.annotations, baseName(a.type)) : s };
  if (a?.description) out["description"] = a.description;
  return out;
}

function argsObject(ir: RayfoldSchemaIR, args: ArgDef[], defs: Record<string, unknown>): unknown {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of args) {
    properties[a.name] = withRange(jsonSchemaFor(ir, a.type, defs, true), a.annotations, baseName(a.type));
    if (!a.type.nullable && a.default === undefined) required.push(a.name);
  }
  return required.length ? { type: "object", properties, required } : { type: "object", properties };
}

function hasPolicy(op: OpDef): boolean {
  return op.annotations.some((a) => a.name === "allow" || a.name === "deny");
}

/** A policy on any type the result can reach (list elements, Page<T>, nested fields), or on one of their fields, can refuse a caller. */
function typeHasPolicy(ir: RayfoldSchemaIR, t: TypeRef, seen = new Set<string>()): boolean {
  if (t.kind === "list") return typeHasPolicy(ir, t.of, seen);
  if (t.args?.some((a) => typeHasPolicy(ir, a, seen))) return true;
  if (seen.has(t.name)) return false;
  seen.add(t.name);
  const def = ir.types[t.name];
  if (!def) return false;
  if (guarded(def.annotations)) return true;
  if (def.kind === "union") return def.members.some((m) => typeHasPolicy(ir, { kind: "named", name: m, nullable: false }, seen));
  return "fields" in def && def.fields.some((f) => guarded(f.annotations) || typeHasPolicy(ir, f.type, seen));
}

function guarded(annotations: Annotation[]): boolean {
  return annotations.some((a) => a.name === "allow" || a.name === "deny");
}

function returnsVersionedEntity(ir: RayfoldSchemaIR, op: OpDef): boolean {
  if (op.returns.kind !== "named") return false;
  const def = ir.types[op.returns.name];
  return !!def && def.kind === "entity" && def.fields.some((f) => annotation(f, "version"));
}
