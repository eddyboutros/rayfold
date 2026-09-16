import { readFileSync, readdirSync } from "node:fs";
import { generateGraphql, loadSchema, typeRefToString, type FieldDef, type TypeRef } from "@rayfold/schema";
import { describe, expect, it } from "vitest";
import { bookstoreSchemaText } from "../../../examples/bookstore-ts/src/index.ts";
import { irFromGraphql } from "./import-graphql.ts";

const fixtures = new URL("../../../conformance/fixtures/core/", import.meta.url);
const SCHEMAS: Array<[string, string]> = [
  ["bookshop", readFileSync(new URL("../../../examples/typescript/src/bookshop.rayfold", import.meta.url), "utf8")],
  ["bookstore", bookstoreSchemaText()],
  ...readdirSync(fixtures)
    .sort()
    .map((f): [string, string] => [f, (JSON.parse(readFileSync(new URL(f, fixtures), "utf8")) as { schema: string }).schema]),
];

/** What a Rayfold type reads as after a trip through GraphQL: Page<T> named after T, and a root result nullable. */
function throughGraphql(t: TypeRef, root = false): string {
  const inner = t.kind === "list" ? `[${throughGraphql(t.of)}]` : t.name === "Page" && t.args?.[0]?.kind === "named" ? `${t.args[0].name}Page` : t.name;
  return t.nullable || root ? `${inner}?` : inner;
}

describe("a Rayfold schema through GraphQL and back", () => {
  it("returns every operation with its kind and arguments, and every type with its fields, nullability included", async () => {
    for (const [name, text] of SCHEMAS) {
      const { ir } = loadSchema(text);
      const back = (await irFromGraphql(generateGraphql(ir).sdl)).ir;
      for (const op of Object.values(ir.ops)) {
        const returned = back.ops[op.name];
        expect(returned, `${name}: ${op.name}`).toBeDefined();
        expect([returned!.kind, typeRefToString(returned!.returns), returned!.args.map((a) => `${a.name}: ${typeRefToString(a.type)}`)], `${name}: ${op.name}`).toEqual([
          op.kind,
          throughGraphql(op.returns, true),
          op.args.map((a) => `${a.name}: ${throughGraphql(a.type)}`),
        ]);
      }
      for (const t of Object.values(ir.types)) {
        if (t.builtin) continue;
        const returned = back.types[t.name];
        expect(returned, `${name}: ${t.name}`).toBeDefined();
        if (t.kind === "enum") expect(returned, `${name}: ${t.name}`).toMatchObject({ kind: "enum", values: t.values.map((v) => expect.objectContaining({ name: v.name })) });
        if (t.kind === "union") expect(returned, `${name}: ${t.name}`).toMatchObject({ kind: "union", members: t.members });
        if ("fields" in t) {
          const fields = (returned as { fields: FieldDef[] }).fields;
          expect(fields.map((f) => `${f.name}: ${typeRefToString(f.type)}`), `${name}: ${t.name}`).toEqual(t.fields.map((f) => `${f.name}: ${throughGraphql(f.type)}`));
        }
      }
    }
  });
});
