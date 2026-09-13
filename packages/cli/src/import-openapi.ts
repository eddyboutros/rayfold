/**
 * An OpenAPI document as a Rayfold schema.
 *
 * The mapping is the inverse of the one `GET /rayfold/openapi.json` publishes: a `GET` or a `QUERY` is a query, anything that
 * changes data is a command, `components.schemas` are types, and every operation keeps the URL it already has with
 * `@http`, so existing clients go on working while new ones move to batches and shapes.
 *
 * It is a starting point, not a finished schema: an OpenAPI document says nothing about which fields belong to an
 * entity's identity, what may be cached, or who may read what. Whatever cannot be mapped is reported in `notes`
 * rather than guessed at.
 */
import { RESERVED_FIELD_NAMES, assertValid, named, list, type Annotation, type ArgDef, type FieldDef, type JsonValue, type OpDef, type RayfoldSchemaIR, type TypeDef, type TypeRef, builtinTypes } from "@rayfold/schema";

type Json = Record<string, unknown>;

export interface Imported {
  ir: RayfoldSchemaIR;
  /** What the document said that the schema cannot say, and what was assumed instead. */
  notes: string[];
}

// `query` is OpenAPI 3.2's read-with-a-body, which is what a shaped read is bound to
const METHODS = ["get", "query", "put", "post", "patch", "delete"] as const;

export function irFromOpenApi(doc: Json): Imported {
  const notes: string[] = [];
  const ir: RayfoldSchemaIR = { rayfold: "0.1", types: builtinTypes(), ops: {}, views: {} };
  const components = ((doc["components"] as Json | undefined)?.["schemas"] as Json | undefined) ?? {};

  for (const [name, schema] of Object.entries(components)) {
    // a document that describes Page or PageArgs is describing the protocol's own types back to us
    if (ir.types[name]?.builtin) {
      notes.push(`${name}: the protocol defines it, so the document's version was left out and references point at the built-in.`);
      continue;
    }
    const def = typeFrom(name, schema as Json, ir, notes);
    if (def) ir.types[name] = def;
  }

  const paths = (doc["paths"] as Json | undefined) ?? {};
  const used = new Set<string>();
  for (const [path, item] of Object.entries(paths)) {
    for (const method of METHODS) {
      const operation = (item as Json)[method] as Json | undefined;
      if (!operation) continue;
      const op = opFrom(method, path, operation, ir, notes, used);
      if (op) ir.ops[op.name] = op;
    }
  }

  if (!Object.keys(ir.ops).length) notes.push("No operations were found: the document has no paths this importer could read.");
  toInputs(ir, notes);
  assertValid(ir);
  return { ir, notes };
}

/**
 * What a caller sends is an input type, what it gets back is an entity or an object: OpenAPI draws no such line, so
 * anything reachable from an argument becomes an input here. A schema used in both directions is copied, since the
 * two sides drift apart as soon as either changes.
 */
function toInputs(ir: RayfoldSchemaIR, notes: string[]): void {
  const reach = (t: TypeRef, into: Set<string>): void => {
    if (t.kind === "list") return reach(t.of, into);
    for (const arg of t.args ?? []) reach(arg, into);
    const def = ir.types[t.name];
    if (!def || def.builtin || into.has(t.name)) return;
    into.add(t.name);
    if ("fields" in def) for (const f of def.fields) reach(f.type, into);
    if (def.kind === "union") for (const m of def.members) reach(named(m), into);
  };

  const sent = new Set<string>();
  const returned = new Set<string>();
  for (const op of Object.values(ir.ops)) {
    for (const a of op.args) reach(a.type, sent);
    reach(op.returns, returned);
  }

  const renamed = new Map<string, string>();
  for (const name of sent) {
    const def = ir.types[name];
    if (!def || def.builtin || !("fields" in def) || def.kind === "input") continue;
    const fields = def.fields.map((f) => ({ ...f }));
    const described = def.description !== undefined ? { description: def.description } : {};
    if (returned.has(name)) {
      const copy = uniqueName(`${name}Input`, ir);
      ir.types[copy] = { kind: "input", name: copy, annotations: [], ...described, fields };
      renamed.set(name, copy);
      notes.push(`${name}: it is both sent and returned, so ${copy} carries the sending side.`);
    } else {
      ir.types[name] = { kind: "input", name, annotations: [], ...described, fields };
    }
  }

  if (!renamed.size) return;
  for (const op of Object.values(ir.ops)) for (const a of op.args) a.type = renameRef(a.type, renamed);
  for (const def of Object.values(ir.types)) {
    if (def.kind !== "input") continue;
    for (const f of def.fields) f.type = renameRef(f.type, renamed);
  }
}

function renameRef(t: TypeRef, renamed: Map<string, string>): TypeRef {
  if (t.kind === "list") return list(renameRef(t.of, renamed), t.nullable);
  const name = renamed.get(t.name) ?? t.name;
  return t.args ? named(name, t.nullable, t.args.map((a) => renameRef(a, renamed))) : named(name, t.nullable);
}

// ------------------------------------------------------------------ types

function typeFrom(name: string, schema: Json, ir: RayfoldSchemaIR, notes: string[]): TypeDef | undefined {
  const values = schema["enum"];
  if (Array.isArray(values) && values.every((v) => typeof v === "string")) {
    return {
      kind: "enum",
      name,
      annotations: [],
      ...describe(schema),
      values: (values as string[]).map((v, i) => ({ name: enumValueName(v), annotations: [], ordinal: i + 1 })),
    };
  }

  const composed = schema["oneOf"] ?? schema["anyOf"];
  if (Array.isArray(composed)) {
    const members = composed.map((s) => refName(s as Json)).filter((n): n is string => n !== undefined);
    if (members.length === composed.length && members.length > 1) {
      return { kind: "union", name, annotations: [], ...describe(schema), members };
    }
    notes.push(`${name}: a oneOf/anyOf of inline schemas became an object with the fields they share.`);
  }

  const properties = (schema["properties"] as Json | undefined) ?? {};
  if (!Object.keys(properties).length && schema["type"] !== "object") {
    notes.push(`${name}: a schema with no properties became a scalar; give it a format if it needs one.`);
    return { kind: "scalar", name, annotations: [], ...describe(schema) };
  }

  const required = new Set((schema["required"] as string[] | undefined) ?? []);
  // `$type` is how the wire says what a value is; the schema owns it, so a document that carries it is not copied
  const declared = Object.entries(properties).filter(([field]) => {
    if (!RESERVED_FIELD_NAMES.has(field)) return true;
    notes.push(`${name}.${field}: the protocol owns that name, so the field was left out.`);
    return false;
  });
  const fields: FieldDef[] = declared.map(([field, sub], i) => ({
    name: field,
    ...describe(sub as Json),
    type: typeRefFrom(sub as Json, !required.has(field), ir, `${name}_${field}`, notes),
    args: [],
    annotations: [],
    ordinal: i + 1,
  }));

  // an object with a string id is an entity: it has an identity the cache and patches can address
  const id = fields.find((f) => f.name === "id");
  if (id && !id.type.nullable) {
    id.type = named("ID");
    return { kind: "entity", name, annotations: [], ...describe(schema), fields, implements: [] };
  }
  return { kind: "object", name, annotations: [], ...describe(schema), fields };
}

const FORMATS: Record<string, string> = {
  "date-time": "Instant",
  date: "Date",
  duration: "Duration",
  byte: "Bytes",
  binary: "Bytes",
  decimal: "Decimal",
  int64: "Long",
};

function typeRefFrom(schema: Json, nullable: boolean, ir: RayfoldSchemaIR, hoistAs: string, notes: string[]): TypeRef {
  const ref = refName(schema);
  if (ref) return named(ref, nullable);

  const declared = schema["type"];
  const types = Array.isArray(declared) ? declared.filter((t) => t !== "null") : declared === undefined ? [] : [declared];
  const nullFromType = Array.isArray(declared) && declared.includes("null");
  const isNullable = nullable || nullFromType || schema["nullable"] === true;
  const type = types[0];

  if (type === "array") {
    const items = (schema["items"] as Json | undefined) ?? {};
    return list(typeRefFrom(items, false, ir, hoistAs, notes), isNullable);
  }
  if (type === "object" || (schema["properties"] !== undefined && type === undefined)) {
    // an inline object needs a name of its own to be referred to
    const name = uniqueName(pascal(hoistAs), ir);
    const def = typeFrom(name, schema, ir, notes);
    if (def) ir.types[name] = def;
    notes.push(`${name}: an inline object was given a name of its own.`);
    return named(name, isNullable);
  }
  if (type === "string") {
    const format = String(schema["format"] ?? "");
    return named(FORMATS[format] ?? "String", isNullable);
  }
  if (type === "integer") return named(FORMATS[String(schema["format"] ?? "")] ?? "Int", isNullable);
  if (type === "number") return named(String(schema["format"] ?? "") === "decimal" ? "Decimal" : "Float", isNullable);
  if (type === "boolean") return named("Boolean", isNullable);
  return named("JSON", isNullable);
}

function refName(schema: Json): string | undefined {
  const ref = schema["$ref"];
  return typeof ref === "string" ? ref.slice(ref.lastIndexOf("/") + 1) : undefined;
}

// ------------------------------------------------------------------ operations

function opFrom(method: string, path: string, operation: Json, ir: RayfoldSchemaIR, notes: string[], used: Set<string>): OpDef | undefined {
  const kind = method === "get" || method === "query" ? "query" : "command";
  const name = uniqueOpName(operationName(method, path, operation), used);
  const args: ArgDef[] = [];

  for (const parameter of (operation["parameters"] as Json[] | undefined) ?? []) {
    const where = parameter["in"];
    if (where !== "path" && where !== "query") continue; // headers and cookies are transport, not arguments
    const schema = (parameter["schema"] as Json | undefined) ?? { type: "string" };
    args.push({
      name: String(parameter["name"]),
      ...describe(parameter),
      type: typeRefFrom(schema, parameter["required"] !== true, ir, `${name}_${String(parameter["name"])}`, notes),
      annotations: [],
    });
  }

  const body = bodySchema(operation);
  if (body) {
    const ref = refName(body);
    if (ref) {
      args.push({ name: "input", type: named(ref), annotations: [] });
    } else {
      const properties = (body["properties"] as Json | undefined) ?? {};
      const required = new Set((body["required"] as string[] | undefined) ?? []);
      for (const [field, sub] of Object.entries(properties)) {
        args.push({ name: field, type: typeRefFrom(sub as Json, !required.has(field), ir, `${name}_${field}`, notes), annotations: [] });
      }
      if (!Object.keys(properties).length) notes.push(`${name}: the request body had no properties to read, so it takes none.`);
    }
  }

  const returns = resultType(operation, ir, name, notes);
  const annotations: Annotation[] = [{ name: "http", args: { method: { $ident: method.toUpperCase() }, path: path as JsonValue } }];
  if (operation["deprecated"] === true) annotations.push({ name: "deprecated", args: {} });

  return { kind, name, ...describe(operation), args, returns, throws: [], emits: [], annotations };
}

function bodySchema(operation: Json): Json | undefined {
  const content = (operation["requestBody"] as Json | undefined)?.["content"] as Json | undefined;
  if (!content) return undefined;
  const json = (content["application/json"] ?? content["application/merge-patch+json"]) as Json | undefined;
  return (json?.["schema"] as Json | undefined) ?? undefined;
}

function resultType(operation: Json, ir: RayfoldSchemaIR, name: string, notes: string[]): TypeRef {
  const responses = (operation["responses"] as Json | undefined) ?? {};
  for (const status of ["200", "201", "202", "default"]) {
    const response = responses[status] as Json | undefined;
    const schema = ((response?.["content"] as Json | undefined)?.["application/json"] as Json | undefined)?.["schema"] as Json | undefined;
    if (schema) return typeRefFrom(schema, false, ir, `${name}_result`, notes);
  }
  notes.push(`${name}: no JSON response was described, so it returns JSON.`);
  return named("JSON");
}

/** `operationId` when the document has one; otherwise the method and the path's own words. */
function operationName(method: string, path: string, operation: Json): string {
  const id = operation["operationId"];
  if (typeof id === "string" && id.trim()) return camel(id);
  const words = path.split("/").filter((s) => s && !s.startsWith("{"));
  return camel([method, ...words].join("_"));
}

function uniqueOpName(name: string, used: Set<string>): string {
  let unique = name;
  for (let n = 2; used.has(unique); n++) unique = `${name}${n}`;
  used.add(unique);
  return unique;
}

function uniqueName(name: string, ir: RayfoldSchemaIR): string {
  let unique = name;
  for (let n = 2; ir.types[unique]; n++) unique = `${name}${n}`;
  return unique;
}

function describe(schema: Json): { description?: string } {
  const text = schema["description"] ?? schema["summary"];
  return typeof text === "string" && text.trim() ? { description: text.trim() } : {};
}

const words = (s: string): string[] => s.split(/[^A-Za-z0-9]+/).filter(Boolean);

function camel(s: string): string {
  const parts = words(s);
  return parts.map((p, i) => (i === 0 ? p[0]!.toLowerCase() + p.slice(1) : p[0]!.toUpperCase() + p.slice(1))).join("");
}

function pascal(s: string): string {
  const c = camel(s);
  return c ? c[0]!.toUpperCase() + c.slice(1) : c;
}

function enumValueName(value: string): string {
  const name = words(value).join("_").toUpperCase();
  return /^[A-Za-z_]/.test(name) ? name : `V_${name}`;
}
