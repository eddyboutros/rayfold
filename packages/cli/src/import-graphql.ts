/**
 * A GraphQL SDL as a Rayfold schema.
 *
 * `Query` fields become queries, `Mutation` fields commands, `Subscription` fields streams, and the type system maps
 * across almost whole. The one change that touches every line is nullability: GraphQL is nullable by default and marks
 * the exceptions with `!`, Rayfold is the other way round and marks them with `?`.
 *
 * Reading the SDL needs the `graphql` package, which the CLI declares as an optional peer: it is only loaded when this
 * command runs. What cannot be mapped is reported in `notes` rather than guessed at - a mutation says nothing about
 * which errors it throws or what it emits, and a Relay connection is not a `Page`.
 */
import { RESERVED_OP_NAMES, assertValid, builtinTypes, list, named, type ArgDef, type FieldDef, type JsonValue, type RayfoldSchemaIR, type TypeDef, type TypeRef } from "@rayfold/schema";
import type {
  DocumentNode,
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
  InputObjectTypeDefinitionNode,
  InputValueDefinitionNode,
  InterfaceTypeDefinitionNode,
  ObjectTypeDefinitionNode,
  TypeNode,
  ValueNode,
} from "graphql";
import type { Imported } from "./import-openapi.ts";

type Fielded = ObjectTypeDefinitionNode | InterfaceTypeDefinitionNode | InputObjectTypeDefinitionNode;

const ROOTS: Record<string, "query" | "command" | "stream"> = { Query: "query", Mutation: "command", Subscription: "stream" };

export async function irFromGraphql(sdl: string): Promise<Imported> {
  let parse: (text: string) => DocumentNode;
  try {
    ({ parse } = await import("graphql"));
  } catch {
    throw new Error("Reading a GraphQL schema needs the graphql package in this project: npm install graphql");
  }

  const notes: string[] = [];
  const ir: RayfoldSchemaIR = { rayfold: "0.1", types: builtinTypes(), ops: {}, views: {} };
  const document = parse(sdl);

  // `schema { query: Root }` renames the roots; without one they are the usual names
  const roots: Record<string, "query" | "command" | "stream"> = { ...ROOTS };
  for (const definition of document.definitions) {
    if (definition.kind !== "SchemaDefinition") continue;
    for (const operation of definition.operationTypes) {
      const kind = operation.operation === "query" ? "query" : operation.operation === "mutation" ? "command" : "stream";
      roots[operation.type.name.value] = kind;
    }
  }

  const rootNodes: Array<{ node: ObjectTypeDefinitionNode; kind: "query" | "command" | "stream" }> = [];
  for (const definition of document.definitions) {
    switch (definition.kind) {
      case "ObjectTypeDefinition": {
        const kind = roots[definition.name.value];
        if (kind) {
          rootNodes.push({ node: definition, kind });
          break;
        }
        const fields = fieldsOf(definition, notes);
        const identified = fields.find((f) => f.name === "id" && !f.type.nullable);
        const implemented = (definition.interfaces ?? []).map((i) => i.name.value);
        if (identified) {
          ir.types[definition.name.value] = { kind: "entity", name: definition.name.value, ...describe(definition), annotations: [], fields, implements: implemented };
        } else {
          if (implemented.length) notes.push(`${definition.name.value}: implements ${implemented.join(", ")}, but only an entity can, so the interface was dropped.`);
          ir.types[definition.name.value] = { kind: "object", name: definition.name.value, ...describe(definition), annotations: [], fields };
        }
        if (definition.name.value.endsWith("Connection")) {
          notes.push(`${definition.name.value}: a connection is not a page. Rayfold pages are Page<T> with @page(cursor) on the field.`);
        }
        break;
      }
      case "InterfaceTypeDefinition":
        ir.types[definition.name.value] = {
          kind: "object",
          name: definition.name.value,
          ...describe(definition),
          interface: true, // the flag the runtime reads; the annotation is how the schema text says it
          annotations: [{ name: "interface", args: {} }],
          fields: fieldsOf(definition, notes),
        };
        break;
      case "InputObjectTypeDefinition":
        ir.types[definition.name.value] = { kind: "input", name: definition.name.value, ...describe(definition), annotations: [], fields: fieldsOf(definition, notes) };
        break;
      case "EnumTypeDefinition":
        ir.types[definition.name.value] = enumType(definition);
        break;
      case "UnionTypeDefinition":
        ir.types[definition.name.value] = {
          kind: "union",
          name: definition.name.value,
          ...describe(definition),
          annotations: [],
          members: (definition.types ?? []).map((t) => t.name.value),
        };
        break;
      case "ScalarTypeDefinition":
        if (!ir.types[definition.name.value]) {
          ir.types[definition.name.value] = { kind: "scalar", name: definition.name.value, ...describe(definition), annotations: [] };
        }
        break;
      case "SchemaDefinition":
      case "DirectiveDefinition":
        break;
      default:
        notes.push(`${definition.kind} was not read; extensions and executable documents are not part of a schema.`);
    }
  }

  for (const { node, kind } of rootNodes) {
    for (const field of node.fields ?? []) {
      const name = opName(field.name.value, ir, notes);
      ir.ops[name] = {
        kind,
        name,
        ...describe(field),
        args: (field.arguments ?? []).map((a) => argOf(a, notes)),
        returns: typeRef(field.type),
        throws: [],
        emits: [],
        annotations: deprecations(field),
      };
      if (kind === "command") {
        notes.push(`${name}: a mutation says nothing about what it can fail with; add "throws" once you know.`);
      }
    }
  }

  if (!Object.keys(ir.ops).length) notes.push("No Query, Mutation or Subscription type was found, so the schema has no operations.");
  assertValid(ir);
  return { ir, notes };
}

function enumType(node: EnumTypeDefinitionNode): TypeDef {
  return {
    kind: "enum",
    name: node.name.value,
    ...describe(node),
    annotations: [],
    values: (node.values ?? []).map((v, i) => ({ name: v.name.value, ...describe(v), annotations: deprecations(v), ordinal: i + 1 })),
  };
}

function fieldsOf(node: Fielded, notes: string[]): FieldDef[] {
  const nodes = node.kind === "InputObjectTypeDefinition" ? (node.fields ?? []) : (node.fields ?? []);
  return nodes.map((f, i) => {
    const field: FieldDef = {
      name: f.name.value,
      ...describe(f),
      type: typeRef(f.type),
      args: f.kind === "FieldDefinition" ? (f.arguments ?? []).map((a) => argOf(a, notes)) : [],
      annotations: deprecations(f),
      ordinal: i + 1,
    };
    if (f.kind === "InputValueDefinition") {
      const fallback = valueOf(f.defaultValue, notes);
      if (fallback !== undefined) field.default = fallback;
    }
    return field;
  });
}

function argOf(node: InputValueDefinitionNode, notes: string[]): ArgDef {
  const arg: ArgDef = { name: node.name.value, ...describe(node), type: typeRef(node.type), annotations: deprecations(node) };
  const fallback = valueOf(node.defaultValue, notes);
  if (fallback !== undefined) arg.default = fallback;
  return arg;
}

/** GraphQL is nullable until `!` says otherwise; Rayfold is the other way round. */
function typeRef(node: TypeNode, nullable = true): TypeRef {
  if (node.kind === "NonNullType") return typeRef(node.type, false);
  if (node.kind === "ListType") return list(typeRef(node.type), nullable);
  return named(node.name.value, nullable);
}

function valueOf(node: ValueNode | undefined, notes: string[]): JsonValue | undefined {
  if (!node) return undefined;
  switch (node.kind) {
    case "IntValue":
    case "FloatValue":
      return Number(node.value);
    case "StringValue":
    case "EnumValue":
      return node.value;
    case "BooleanValue":
      return node.value;
    case "NullValue":
      return null;
    case "ListValue":
      return node.values.map((v) => valueOf(v, notes) ?? null);
    case "ObjectValue":
      return Object.fromEntries(node.fields.map((f) => [f.name.value, valueOf(f.value, notes) ?? null]));
    default:
      notes.push("A variable was used as a default value; it was left out.");
      return undefined;
  }
}

function deprecations(node: { directives?: readonly { name: { value: string } }[] | undefined }): Array<{ name: string; args: Record<string, never> }> {
  return (node.directives ?? []).some((d) => d.name.value === "deprecated") ? [{ name: "deprecated", args: {} }] : [];
}

function describe(node: { description?: { value: string } | undefined }): { description?: string } {
  const text = node.description?.value?.trim();
  return text ? { description: text } : {};
}

function opName(name: string, ir: RayfoldSchemaIR, notes: string[]): string {
  let unique = RESERVED_OP_NAMES.has(name) ? `${name}Op` : name;
  if (unique !== name) notes.push(`${name}: the name is reserved by the protocol, so the operation is ${unique}.`);
  for (let n = 2; ir.ops[unique]; n++) unique = `${name}${n}`;
  return unique;
}
