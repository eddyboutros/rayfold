import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import fc from "fast-check";
import { RayfoldSyntaxError } from "./lexer.ts";
import { loadSchema } from "./load.ts";
import { printSchemaText } from "./print.ts";

const fixtures = new URL("../../../conformance/fixtures/core/", import.meta.url);
const schemaTexts: Array<{ name: string; text: string }> = [
  ...readdirSync(fixtures)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ name: f, fixture: JSON.parse(readFileSync(new URL(f, fixtures), "utf8")) as { schema?: string } }))
    .filter((f) => typeof f.fixture.schema === "string")
    .map((f) => ({ name: f.name, text: f.fixture.schema as string })),
  ...["examples/bookstore-ts/bookstore.rayfold", "examples/workspace-ts/workspace.rayfold"].map((path) => ({
    name: path,
    text: readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"),
  })),
];

describe("printing the IR back to .rayfold text", () => {
  it("has a schema from every fixture to work on", () => {
    expect(schemaTexts.length).toBeGreaterThan(10);
  });

  it.each(schemaTexts)("$name parses back to the same schema", ({ text }) => {
    const original = loadSchema(text);
    const printed = printSchemaText(original.ir);
    const reparsed = loadSchema(printed);
    expect(reparsed.hash).toBe(original.hash);
    expect(reparsed.ir).toEqual(original.ir);
  });

  it("writes what an author would write", () => {
    const text = `
      """A book on the shelf."""
      entity Book @cache(maxAge: 5m, scope: public) {
        id: ID
        title: String
        """What it costs."""
        price: Decimal @unit("USD")
        secret: String? @allow(read: viewer.role == "admin")
        reviews(page: PageArgs = { first: 10 }): Page<Review>
      }
      entity Review { id: ID rating: Int }
      enum Format { HARDCOVER PAPERBACK }
      view Book.card = { id title }
      """List them."""
      query books(page: PageArgs = { first: 20 }): Page<Book> @cost(base: 5, perItem: 1)
      command buy(bookId: ID, qty: Int = 1): Review throws OutOfStock emits Bought @simulate
      error OutOfStock { bookId: ID }
      event Bought { orderId: ID }
    `;
    const printed = printSchemaText(loadSchema(text).ir);

    expect(printed).toContain('"""A book on the shelf."""');
    expect(printed).toContain("entity Book @cache(maxAge: 5m, scope: public) {");
    expect(printed).toContain('  price: Decimal @unit("USD")');
    expect(printed).toContain('  secret: String? @allow(read: viewer.role == "admin")');
    expect(printed).toContain("  reviews(page: PageArgs = { first: 10 }): Page<Review>");
    expect(printed).toContain("enum Format { HARDCOVER PAPERBACK }");
    expect(printed).toContain("view Book.card = { id title }");
    expect(printed).toContain("query books(page: PageArgs = { first: 20 }): Page<Book> @cost(base: 5, perItem: 1)");
    expect(printed).toContain("command buy(bookId: ID, qty: Int = 1): Review throws OutOfStock emits Bought @simulate");
  });

  it("keeps an argument's description, on one line or several", () => {
    const text = `entity Book { id: ID reviews("""newest first""" page: PageArgs = { first: 10 }): Page<Review> }
entity Review { id: ID }
query book("""
the id
or a slug
""" id: ID, lang: String?): Book?`;
    const original = loadSchema(text);
    const printed = printSchemaText(original.ir);
    expect(printed).toBe(
      [
        "entity Book {",
        "  id: ID",
        '  reviews("""newest first""" page: PageArgs = { first: 10 }): Page<Review>',
        "}",
        "",
        "entity Review {",
        "  id: ID",
        "}",
        "",
        'query book("""',
        "the id",
        "or a slug",
        '""" id: ID, lang: String?): Book?',
        "",
      ].join("\n"),
    );
    expect(loadSchema(printed).ir).toEqual(original.ir);
  });

  it("writes an ordinal only where the field is not where its ordinal says", () => {
    const natural = printSchemaText(loadSchema("entity Book { id: ID title: String }\nquery book(id: ID): Book?").ir);
    expect(natural).not.toContain("@ordinal");

    const moved = printSchemaText(loadSchema("entity Book { id: ID title: String @ordinal(7) }\nquery book(id: ID): Book?").ir);
    expect(moved).toContain("title: String @ordinal(7)");
    // guard: the ordinal survives the round trip, which is what keeps the binary encoding stable
    expect(loadSchema(moved).ir.types["Book"]).toMatchObject({ fields: [{ name: "id", ordinal: 1 }, { name: "title", ordinal: 7 }] });
  });

  it("keeps a default an input field declares", () => {
    const text = [
      "enum Priority { LOW MEDIUM }",
      "input IssueInput { title: String priority: Priority = MEDIUM labels: [String] = [] weight: Int = 1 }",
      "entity Issue { id: ID title: String }",
      "command open(input: IssueInput): Issue",
    ].join("\n");
    const original = loadSchema(text);
    const printed = printSchemaText(original.ir);
    expect(printed).toContain("weight: Int = 1");
    expect(printed).toContain("labels: [String] = []");
    expect(loadSchema(printed).ir.types["IssueInput"]).toEqual(original.ir.types["IssueInput"]);
    expect(loadSchema(printed).hash).toBe(original.hash);
  });

  it("keeps every interface an entity implements", () => {
    const text = [
      "object Node @interface { id: ID }",
      "object Timed @interface { at: Instant }",
      "entity Happening implements Node Timed { id: ID at: Instant }",
      "query happening(id: ID): Happening?",
    ].join("\n");
    const original = loadSchema(text);
    const printed = printSchemaText(original.ir);
    expect(printed).toContain("entity Happening implements Node Timed {");
    expect(loadSchema(printed).hash).toBe(original.hash);
  });

  it("keeps a description that ends in a quote, holds its own fence or a carriage return, exactly", () => {
    const text = [
      '"""Call it "x" """',
      "entity A {",
      '  """Holds \\""" and ends in a backslash\\',
      '  """',
      "  id: ID",
      '  """one\r\r\ntwo"""',
      "  n: Int",
      "}",
      "query a: A",
    ].join("\n");
    const original = loadSchema(text);
    expect(original.ir.types["A"]?.description).toBe('Call it "x"');
    const fields = (original.ir.types["A"] as { fields: Array<{ description?: string }> }).fields;
    expect(fields.map((f) => f.description)).toEqual(['Holds """ and ends in a backslash\\', "one\r\ntwo"]);
    const printed = printSchemaText(original.ir);
    const reparsed = loadSchema(printed);
    expect(reparsed.ir).toEqual(original.ir);
    expect(reparsed.hash).toBe(original.hash);
    expect(printed.split("\n").slice(0, 3)).toEqual(['"""', 'Call it "x"', '"""']);
  });

  it("guard - a one-line description with nothing to escape stays on one line", () => {
    const printed = printSchemaText(loadSchema('"""A "quoted" word inside."""\nentity A { id: ID }\nquery a: A').ir);
    expect(printed.split("\n")[0]).toBe('"""A "quoted" word inside."""');
  });

  it("any description the lexer reads prints back to exactly that description", () => {
    const body = fc.stringMatching(/^[ab \t\r\n"\\ ]{0,24}$/);
    fc.assert(
      fc.property(body, (raw) => {
        let original: ReturnType<typeof loadSchema>;
        try {
          original = loadSchema(`"""${raw}"""\nentity A { id: ID }\nquery a: A`);
        } catch (e) {
          if (e instanceof RayfoldSyntaxError) return; // a fence the body closes early, say
          throw e;
        }
        const reparsed = loadSchema(printSchemaText(original.ir));
        expect(reparsed.ir.types["A"]?.description).toBe(original.ir.types["A"]?.description);
        expect(reparsed.hash).toBe(original.hash);
      }),
      { numRuns: 2000, seed: 20260924 },
    );
  });

  it("a default object whose keys are not names is written with quoted keys, which parse back", () => {
    const original = loadSchema('query q(o: JSON = { "content-type": "text/plain", "a b": [1], plain: true }): Int');
    expect(original.ir.ops["q"]?.args[0]?.default).toEqual({ "content-type": "text/plain", "a b": [1], plain: true });
    const printed = printSchemaText(original.ir);
    expect(printed).toBe('query q(o: JSON = { "content-type": "text/plain", "a b": [1], plain: true }): Int\n');
    expect(loadSchema(printed).hash).toBe(original.hash);
  });

  it("keeps a duration in the unit it divides into", () => {
    const printed = printSchemaText(loadSchema("entity A @cache(maxAge: 90s) { id: ID }\nquery a(id: ID): A?").ir);
    expect(printed).toContain("@cache(maxAge: 90s)");
    expect(printSchemaText(loadSchema("entity A @cache(maxAge: 2h) { id: ID }\nquery a(id: ID): A?").ir)).toContain("@cache(maxAge: 2h)");
    expect(printSchemaText(loadSchema("entity A @cache(maxAge: 1500ms) { id: ID }\nquery a(id: ID): A?").ir)).toContain("@cache(maxAge: 1500ms)");
  });
});
