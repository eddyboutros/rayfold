/**
 * A Rayfold type as JSON Schema: what the MCP bridge gives an assistant for a tool's arguments (spec 10) and what the
 * OpenAPI document gives a reader for a route's body (spec 04 §8). Pure, so describing an API needs no transport.
 */
import { annotation, baseName, type ArgDef, type FieldDef, type RayfoldSchemaIR, type TypeRef } from "@rayfold/schema";

export function jsonSchemaFor(ir: RayfoldSchemaIR, t: TypeRef, defs: Record<string, unknown>, forInput: boolean): Record<string, unknown> {
  const nullable = (s: Record<string, unknown>): Record<string, unknown> => (t.nullable ? { anyOf: [s, { type: "null" }] } : s);
  if (t.kind === "list") return nullable({ type: "array", items: jsonSchemaFor(ir, t.of, defs, forInput) });
  const def = ir.types[t.name];
  if (!def) return {};
  switch (def.kind) {
    case "scalar": {
      const map: Record<string, Record<string, unknown>> = {
        ID: { type: "string" },
        String: { type: "string" },
        Int: { type: "integer" },
        Long: { type: ["integer", "string"] },
        Float: { type: "number" },
        Boolean: { type: "boolean" },
        Decimal: { type: "string", pattern: "^-?\\d+(\\.\\d+)?$" },
        Instant: { type: "string", format: "date-time" },
        Date: { type: "string", format: "date" },
        Duration: { type: ["string", "integer"] },
        Bytes: { type: "string", contentEncoding: "base64url" },
        JSON: {},
      };
      return nullable(map[t.name] ?? { type: ["string", "number"] });
    }
    case "enum":
      return nullable({ type: "string", enum: def.values.map((v) => v.name) });
    case "union":
      return nullable({ anyOf: def.members.map((m) => jsonSchemaFor(ir, { kind: "named", name: m, nullable: false }, defs, forInput)) });
    default: {
      const key = t.name === "Page" && t.args?.[0] ? `Page_${baseName(t.args[0])}` : t.name;
      if (!(key in defs)) {
        defs[key] = {}; // placeholder for recursion
        const fields = def.kind === "object" && def.typeParams?.length && t.args ? substituteFields(ir, def.fields, def.typeParams, t.args) : def.fields;
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        if (def.kind === "entity") properties["$type"] = { const: def.name };
        for (const f of fields) {
          if (forInput && f.args.length) continue;
          const s = withRange(jsonSchemaFor(ir, f.type, defs, forInput), f.annotations, baseName(f.type));
          properties[f.name] = f.description ? { ...s, description: f.description } : s;
          if (!f.type.nullable && f.default === undefined) required.push(f.name);
        }
        const schema: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
        if (required.length) schema["required"] = required;
        if (def.description) schema["description"] = def.description;
        defs[key] = schema;
      }
      return nullable({ $ref: `#/$defs/${key}` });
    }
  }
}

function substituteFields(ir: RayfoldSchemaIR, fields: FieldDef[], params: string[], args: TypeRef[]): FieldDef[] {
  void ir;
  const bind = new Map(params.map((p, i) => [p, args[i]!]));
  const sub = (t: TypeRef): TypeRef => {
    if (t.kind === "list") return { kind: "list", of: sub(t.of), nullable: t.nullable };
    const b = bind.get(t.name);
    return b ? { ...b, nullable: t.nullable || b.nullable } : t;
  };
  return fields.map((f) => ({ ...f, type: sub(f.type) }));
}

/**
 * @range becomes JSON Schema keywords the validator understands (minimum/maximum on numbers, minLength/maxLength
 * on strings) plus `x-rayfold-range`, which also covers Decimal (a string on the wire).
 */
export function withRange(s: Record<string, unknown>, annotations: { name: string; args: Record<string, unknown> }[], typeName: string): Record<string, unknown> {
  const r = annotations.find((a) => a.name === "range");
  if (!r) return s;
  const min = typeof r.args["min"] === "number" ? r.args["min"] : undefined;
  const max = typeof r.args["max"] === "number" ? r.args["max"] : undefined;
  const out: Record<string, unknown> = { ...s, "x-rayfold-range": { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } };
  const numeric = ["Int", "Long", "Float"].includes(typeName);
  const text = typeName === "String";
  if (numeric || text) {
    if (min !== undefined) out[numeric ? "minimum" : "minLength"] = min;
    if (max !== undefined) out[numeric ? "maximum" : "maxLength"] = max;
  }
  return out;
}
