import { describe, expect, it } from "vitest";
import { parseSchemaText, validateIR, RayfoldSyntaxError } from "@rayfold/schema";
import { findingsFor, nearest, renderFinding, suggestionFor, syntaxFinding } from "./report.ts";

const FILE = "schema.rayfold";

/** A schema and its findings, the way `rayfold check` gets them. */
function check(text: string): { text: string; findings: ReturnType<typeof findingsFor>; ir: ReturnType<typeof parseSchemaText> } {
  const ir = parseSchemaText(text);
  return { text, findings: findingsFor(text, validateIR(ir)), ir };
}

describe("a finding in the text it is about", () => {
  it("points at the member, with the line and a caret under it", () => {
    const text = ["entity Book {", "  id: ID", "  price: Money", "}", "query book(id: ID): Book?"].join("\n");
    const { findings, ir } = check(text);
    const unknown = findings.find((f) => f.code === "unknown-type");
    expect(unknown?.at).toBe("Book.price");

    const rendered = renderFinding(FILE, text, unknown!, ir);
    expect(rendered).toContain("error    unknown-type  Book.price:");
    expect(rendered).toContain(`--> ${FILE}:3:3`);
    expect(rendered).toContain("3 |   price: Money");
    expect(rendered).toContain("  ^^^^^"); // under `price`
  });

  it("suggests the type the author probably meant", () => {
    const text = ["entity Book {", "  id: ID", "  title: Strng", "}", "query book(id: ID): Book?"].join("\n");
    const { findings, ir } = check(text);
    const rendered = renderFinding(FILE, text, findings.find((f) => f.code === "unknown-type")!, ir);
    expect(rendered).toContain("= did you mean String?");
  });

  it("points at an operation's argument and suggests the type it probably meant", () => {
    const text = ["entity Book { id: ID }", "", "query book(", "  id: ID,", "  lang: Strng", "): Book?"].join("\n");
    const { findings, ir } = check(text);
    const unknown = findings.find((f) => f.code === "unknown-type");
    expect(unknown?.at).toBe("book().lang");
    const rendered = renderFinding(FILE, text, unknown!, ir);
    expect(rendered).toBe(
      ["error    unknown-type  book().lang: Unknown type Strng", ` --> ${FILE}:5:3`, "  |", "5 |   lang: Strng", "  |   ^^^^", "  = did you mean String?"].join("\n"),
    );
  });

  it("says so plainly when the name is nothing like anything defined", () => {
    const text = ["entity Book {", "  id: ID", "  price: Zorblatt", "}", "query book(id: ID): Book?"].join("\n");
    const { findings, ir } = check(text);
    expect(suggestionFor(findings.find((f) => f.code === "unknown-type")!, ir)).toContain("no type named Zorblatt is defined");
  });

  it("suggests the annotation the author probably meant", () => {
    const text = ["entity Book @cach(maxAge: 60s) {", "  id: ID", "}", "query book(id: ID): Book?"].join("\n");
    const { findings, ir } = check(text);
    const unknown = findings.find((f) => f.code === "unknown-annotation");
    expect(unknown).toBeDefined();
    expect(suggestionFor(unknown!, ir)).toBe("did you mean @cache?");
  });

  it("says what an entity is missing", () => {
    const text = ["entity Book {", "  title: String", "}", "query book(title: String): Book?"].join("\n");
    const { findings, ir } = check(text);
    const missing = findings.find((f) => f.code === "entity-id");
    expect(missing).toBeDefined();
    expect(suggestionFor(missing!, ir)).toContain("id: ID");
  });

  it("places a syntax error where the text breaks", () => {
    let error: RayfoldSyntaxError | undefined;
    try {
      parseSchemaText(["entity Book {", "  id: ID", ""].join("\n"));
    } catch (e) {
      error = e as RayfoldSyntaxError;
    }
    expect(error).toBeInstanceOf(RayfoldSyntaxError);
    const rendered = renderFinding(FILE, ["entity Book {", "  id: ID", ""].join("\n"), syntaxFinding(error!));
    expect(rendered).toContain("error    syntax");
    expect(rendered).toContain(`--> ${FILE}:3:1`);
  });

  it("guard - points at nothing rather than at the wrong line", () => {
    const text = "entity Book { id: ID }\nquery book(id: ID): Book?";
    const rendered = renderFinding(FILE, text, {
      severity: "warning",
      code: "invented",
      at: "Nowhere.atAll",
      message: "a coordinate the text does not have",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    });
    expect(rendered).toBe("warning  invented  Nowhere.atAll: a coordinate the text does not have");
    expect(rendered).not.toContain("-->");
  });
});

describe("the nearest name", () => {
  it("takes a typo", () => {
    expect(nearest("Strng", ["String", "Int", "Decimal"])).toBe("String");
    expect(nearest("cach", Object.keys({ cache: 1, allow: 1, cost: 1 }))).toBe("cache");
  });

  it("guard - does not take a different word for a typo", () => {
    expect(nearest("Money", ["String", "Int", "Boolean"])).toBeUndefined();
    expect(nearest("Zorblatt", ["String", "Decimal"])).toBeUndefined();
  });
});
