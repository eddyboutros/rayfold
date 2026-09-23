/**
 * The IR back to `.rayfold` text: the parser's inverse.
 *
 * `loadSchema(printSchemaText(ir)).hash` is `schemaHash(ir)` for every schema, which is what makes it safe to build
 * an IR from somewhere else - an OpenAPI document, a GraphQL SDL - and hand the author a schema file to keep.
 */
import {
  typeRefToString,
  type Annotation,
  type AnnotValue,
  type ArgDef,
  type EnumValueDef,
  type FieldDef,
  type JsonValue,
  type OpDef,
  type RayfoldSchemaIR,
  type TypeDef,
} from "./ir.ts";
import { exprToString } from "./expr.ts";
import { shapeToString } from "./shape.ts";

export function printSchemaText(ir: RayfoldSchemaIR): string {
  const out: string[] = [];
  for (const type of Object.values(ir.types)) {
    if (type.builtin) continue;
    out.push(...printType(type), "");
  }
  for (const view of Object.values(ir.views)) {
    out.push(`view ${view.type}.${view.name} = ${shapeToString(view.shape)}`);
  }
  if (Object.keys(ir.views).length) out.push("");
  for (const op of Object.values(ir.ops)) {
    out.push(...printOp(op), "");
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function printType(type: TypeDef): string[] {
  const head = [type.kind, type.name];
  if (type.kind === "object" && type.typeParams?.length) head[1] = `${type.name}<${type.typeParams.join(", ")}>`;
  if (type.kind === "entity" && type.implements.length) head.push("implements", type.implements.join(" "));
  const declaration = [...head, ...type.annotations.map(printAnnotation)].join(" ");

  const lines = describe(type.description, "");
  if (type.kind === "scalar") return [...lines, declaration];
  if (type.kind === "union") return [...lines, `${declaration} = ${type.members.join(" | ")}`];
  if (type.kind === "enum") {
    const plain = type.values.every((v, i) => v.description === undefined && v.annotations.length === 0 && v.ordinal === i + 1);
    if (plain) return [...lines, `${declaration} { ${type.values.map((v) => v.name).join(" ")} }`];
    return [...lines, `${declaration} {`, ...type.values.flatMap((v, i) => printEnumValue(v, i)), "}"];
  }
  return [...lines, `${declaration} {`, ...type.fields.flatMap((f, i) => printField(f, i)), "}"];
}

function printEnumValue(value: EnumValueDef, index: number): string[] {
  const annotations = [...value.annotations.map(printAnnotation), ...ordinal(value.ordinal, index, value.annotations)];
  return [...describe(value.description, "  "), ["  " + value.name, ...annotations].join(" ")];
}

function printField(field: FieldDef, index: number): string[] {
  const args = field.args.length ? `(${field.args.map(printArg).join(", ")})` : "";
  const annotations = [...field.annotations.map(printAnnotation), ...ordinal(field.ordinal, index, field.annotations)];
  const fallback = field.default !== undefined ? ` = ${literal(field.default)}` : "";
  const body = `  ${field.name}${args}: ${typeRefToString(field.type)}${fallback}`;
  return [...describe(field.description, "  "), [body, ...annotations].join(" ")];
}

function printArg(arg: ArgDef): string {
  const doc = describe(arg.description, "");
  const parts = [...(doc.length ? [doc.join("\n")] : []), `${arg.name}: ${typeRefToString(arg.type)}`];
  if (arg.default !== undefined) parts.push(`= ${literal(arg.default)}`);
  return [...parts, ...arg.annotations.map(printAnnotation)].join(" ");
}

function printOp(op: OpDef): string[] {
  const args = op.args.length ? `(${op.args.map(printArg).join(", ")})` : "";
  const parts = [`${op.kind} ${op.name}${args}: ${typeRefToString(op.returns)}`];
  if (op.throws.length) parts.push(`throws ${op.throws.join(" | ")}`);
  if (op.emits.length) parts.push(`emits ${op.emits.join(" ")}`);
  return [...describe(op.description, ""), [...parts, ...op.annotations.map(printAnnotation)].join(" ")];
}

/**
 * `@ordinal` is only written when the field is not where its ordinal says it is, which is how the parser reads it -
 * and never when the schema already carries the annotation, which is printed with the rest.
 */
function ordinal(value: number, index: number, annotations: Annotation[]): string[] {
  if (annotations.some((a) => a.name === "ordinal")) return [];
  return value === index + 1 ? [] : [`@ordinal(${value})`];
}

function describe(text: string | undefined, indent: string): string[] {
  if (text === undefined) return [];
  if (text.includes('"""')) return [`${indent}${JSON.stringify(text)}`]; // a block string cannot hold its own fence
  if (!text.includes("\n")) return [`${indent}"""${text}"""`];
  return [`${indent}"""`, ...text.split("\n").map((line) => `${indent}${line}`), `${indent}"""`];
}

function printAnnotation(a: Annotation): string {
  const keys = Object.keys(a.args);
  if (!keys.length) return `@${a.name}`;
  const positional = keys.every((k) => k === "value" || /^value[0-9]+$/.test(k));
  if (positional) {
    const order = (k: string): number => (k === "value" ? 0 : Number(k.slice(5)));
    const values = keys.sort((x, y) => order(x) - order(y)).map((k) => annotationValue(a.args[k]!));
    return `@${a.name}(${values.join(", ")})`;
  }
  return `@${a.name}(${keys.map((k) => `${k}: ${annotationValue(a.args[k]!)}`).join(", ")})`;
}

function annotationValue(v: AnnotValue): string {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const tagged = v as Record<string, unknown>;
    if ("$expr" in tagged) return exprToString(tagged["$expr"] as Parameters<typeof exprToString>[0]);
    if ("$ident" in tagged) return String(tagged["$ident"]);
    if ("$duration" in tagged) return duration(Number(tagged["$duration"]));
    if ("$type" in tagged) return typeRefToString(tagged["$type"] as Parameters<typeof typeRefToString>[0]);
  }
  return literal(v as JsonValue);
}

const UNITS: Array<[number, string]> = [
  [86_400_000, "d"],
  [3_600_000, "h"],
  [60_000, "m"],
  [1000, "s"],
];

/** The largest unit that divides exactly, as the lexer reads it back. */
function duration(ms: number): string {
  for (const [size, suffix] of UNITS) if (ms % size === 0) return `${ms / size}${suffix}`;
  return `${ms}ms`;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function literal(v: JsonValue): string {
  if (v === null || typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(literal).join(", ")}]`;
  const entries = Object.entries(v).map(([k, x]) => `${NAME.test(k) ? k : JSON.stringify(k)}: ${literal(x)}`);
  return entries.length ? `{ ${entries.join(", ")} }` : "{}";
}
