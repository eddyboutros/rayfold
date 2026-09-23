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

const wide = `
object Node @interface { id: ID }
entity Book implements Node { id: ID title: String }
object Card { title: String }
input Draft { title: String = "untitled" note: String? = "none" count: Int }
enum Tone { WARM COOL }
union Result = Book | Card
error Gone { id: ID }
event BookRenamed { id: ID }
view Book.default = { id title }
view Book.card = { id }
query book(id: ID, lang: String?): Book
query cover(id: ID): Card?
query shelf(page: PageArgs = { first: 10 }): Page<Book>?
command draft(input: Draft): Book throws Gone @allow(write: viewer != null)
`;

// One row per change code; each breaking row sits next to its compatible sibling where one exists.
const rows: [string, string, string, string[]][] = [
  ["type-removed", "object Card { title: String }", "", ["breaking:type-removed@Card"]],
  ["kind-changed", "object Card {", "entity Card {", ["breaking:kind-changed@Card"]],
  ["union-member-removed", "= Book | Card", "= Book", ["breaking:union-member-removed@Result"]],
  ["union-member-added", "= Book | Card", "= Book | Card | Node", ["compatible:union-member-added@Result"]],
  ["interface-dropped", "entity Book implements Node {", "entity Book {", ["breaking:interface-dropped@Book"]],
  ["enum ordinal-changed", "{ WARM COOL }", "{ COOL WARM }", ["breaking:ordinal-changed@Tone.WARM", "breaking:ordinal-changed@Tone.COOL"]],
  ["op-removed", "query cover(id: ID): Card?", "", ["breaking:op-removed@cover()"]],
  ["op-kind-changed", "query cover(", "command cover(", ["breaking:op-kind-changed@cover()"]],
  ["result-nullable", "String?): Book", "String?): Book?", ["breaking:result-nullable@book()"]],
  ["result-non-null", "): Card?", "): Card", ["compatible:result-non-null@cover()"]],
  ["result-type-changed", "): Card?", "): Book?", ["breaking:result-type-changed@cover()"]],
  // a page of another type shares only the name Page; read as the same base, this passed as a compatible change
  ["page of another type", "Page<Book>?", "Page<Card>", ["breaking:result-type-changed@shelf()"]],
  ["page result non-null", "Page<Book>?", "Page<Book>", ["compatible:result-non-null@shelf()"]],
  ["arg-removed", "book(id: ID, lang: String?)", "book(id: ID)", ["breaking:arg-removed@book().lang"]],
  ["arg-type-changed", "book(id: ID,", "book(id: Int,", ["breaking:arg-type-changed@book().id"]],
  ["arg-optional", "book(id: ID,", "book(id: ID?,", ["compatible:arg-optional@book().id"]],
  ["throws-removed", "Book throws Gone @allow", "Book @allow", ["compatible:throws-removed@draft()"]],
  ["emits-added", "throws Gone @allow", "throws Gone emits BookRenamed @allow", ["compatible:emits-added@draft()"]],
  ["policy-removed", " @allow(write: viewer != null)", "", ["warning:policy-removed@draft()"]],
  ["named view-removed", "view Book.card = { id }", "", ["breaking:view-removed@Book.card"]],
  ["default view-removed", "view Book.default = { id title }", "", ["warning:view-removed@Book.default"]],
  ["input-field-optional", "count: Int }", "count: Int? }", ["compatible:input-field-optional@Draft.count"]],
  ["default-removed", `title: String = "untitled"`, "title: String", ["breaking:default-removed@Draft.title"]],
  ["default removed from a nullable input field", `note: String? = "none"`, "note: String?", []],
  ["input-field-added-required", "count: Int }", "count: Int tag: String }", ["breaking:input-field-added-required@Draft.tag"]],
  ["input field added with a default", "count: Int }", `count: Int tag: String = "x" }`, ["compatible:field-added@Draft.tag"]],
  ["nullable input field added", "count: Int }", "count: Int tag: String? }", ["compatible:field-added@Draft.tag"]],
  ["output field added", "object Card { title: String }", "object Card { title: String pages: Int }", ["compatible:field-added@Card.pages"]],
];

describe("schema diff: every change code", () => {
  it.each(rows)("%s", (_name, find, replace, expected) => {
    const to = wide.replace(find, replace);
    expect(to).not.toBe(wide);
    expect(codes(wide, to)).toEqual(expected);
  });

  it("a type removed after its sunset is compatible", () => {
    const from = wide.replace("object Card {", `object Card @deprecated(sunset: "2026-01-01") {`);
    expect(codes(from, wide.replace("object Card { title: String }", ""))).toEqual(["compatible:type-removed-after-sunset@Card"]);
  });

  it("an arg removed after its sunset is compatible, before it is breaking", () => {
    const from = wide.replace("lang: String?)", `lang: String? @deprecated(sunset: "2026-01-01"))`);
    const to = wide.replace(", lang: String?", "");
    expect(codes(from, to)).toEqual(["compatible:arg-removed-after-sunset@book().lang"]);
    expect(codes(from, to, new Date("2025-06-01"))).toEqual(["breaking:arg-removed@book().lang"]);
  });
});
