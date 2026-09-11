import { describe, expect, it } from "vitest";
import { diffSchemas, isBreaking } from "./diff.ts";
import { parseSchemaText } from "./parser.ts";

const base = `
entity Book { id: ID title: String pages: Int? }
input Filter { q: String? }
enum Format { A B }
query books(filter: Filter?, page: PageArgs = { first: 20 }): Page<Book>
command rename(id: ID, title: String): Book throws NotFound { id: ID }
`;

const codes = (from: string, to: string, now = new Date("2026-09-09")) =>
  diffSchemas(parseSchemaText(from), parseSchemaText(to), { now }).map((c) => `${c.level}:${c.code}@${c.at}`);

describe("schema diff", () => {
  it("additive changes are compatible", () => {
    const c = codes(base, base + ` entity Author { id: ID } query author(id: ID): Author?` + ``);
    expect(c).toEqual(["compatible:type-added@Author", "compatible:op-added@author()"]);
    expect(isBreaking(diffSchemas(parseSchemaText(base), parseSchemaText(base)))).toBe(false);
  });

  it("removals are breaking unless the sunset has passed", () => {
    expect(codes(base, base.replace("pages: Int?", ""))).toEqual(["breaking:field-removed@Book.pages"]);
    const deprecated = base.replace("pages: Int?", `pages: Int? @deprecated(sunset: "2026-01-01")`);
    expect(codes(deprecated, base.replace("pages: Int?", ""))).toEqual(["compatible:field-removed-after-sunset@Book.pages"]);
    expect(codes(deprecated, base.replace("pages: Int?", ""), new Date("2025-06-01"))).toEqual(["breaking:field-removed@Book.pages"]);
  });

  it("nullability moves in the restrictive direction are breaking", () => {
    expect(codes(base, base.replace("title: String", "title: String?"))).toEqual(["breaking:field-nullable@Book.title"]);
    expect(codes(base, base.replace("pages: Int?", "pages: Int"))).toEqual(["compatible:field-non-null@Book.pages"]);
    expect(codes(base, base.replace("q: String?", "q: String"))).toEqual(["breaking:input-field-required@Filter.q"]);
    expect(codes(base, base.replace("filter: Filter?", "filter: Filter"))).toEqual(["breaking:arg-required@books().filter"]);
  });

  it("argument additions depend on defaults; type changes and ordinals are breaking", () => {
    expect(codes(base, base.replace("title: String):", "title: String, force: Boolean):"))).toEqual(["breaking:arg-added-required@rename().force"]);
    expect(codes(base, base.replace("title: String):", "title: String, force: Boolean = false):"))).toEqual(["compatible:arg-added@rename().force"]);
    expect(codes(base, base.replace("pages: Int?", "pages: Long?"))).toEqual(["breaking:field-type-changed@Book.pages"]);
    expect(codes(base, base.replace("id: ID title: String pages: Int?", "id: ID pages: Int? title: String"))).toEqual([
      "breaking:ordinal-changed@Book.title",
      "breaking:ordinal-changed@Book.pages",
    ]);
  });

  it("enum/union members, throws and policies", () => {
    expect(codes(base, base.replace("{ A B }", "{ A }"))).toEqual(["breaking:enum-value-removed@Format.B"]);
    expect(codes(base, base.replace("{ A B }", "{ A B C }"))).toEqual(["compatible:enum-value-added@Format.C"]);
    expect(codes(base, base.replace("throws NotFound { id: ID }", "throws NotFound { id: ID } | Locked { by: ID }"))).toEqual(["compatible:type-added@Locked", "warning:throws-added@rename()"]);
    expect(codes(base, base.replace("): Book throws", "): Book @allow(write: viewer != null) throws"))).toEqual(["warning:policy-added@rename()"]);
  });
});
