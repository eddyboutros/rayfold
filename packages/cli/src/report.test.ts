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

    expect(renderFinding(FILE, text, unknown!, ir)).toBe(
      [
        "error    unknown-type  Book.price: Unknown type Money",
        ` --> ${FILE}:3:3`,
        "  |",
        "3 |   price: Money",
        "  |   ^^^^^",
        "  = no type named Money is defined; declare it, or import the document that has it",
      ].join("\n"),
    );
    // without the IR there is nothing to suggest from, and nothing is suggested
    expect(renderFinding(FILE, text, unknown!)).toBe(["error    unknown-type  Book.price: Unknown type Money", ` --> ${FILE}:3:3`, "  |", "3 |   price: Money", "  |   ^^^^^"].join("\n"));
  });

  it("reads a line that ends in a carriage return without it", () => {
    const text = "entity Book { id: ID }\r\nquery book(id: ID): Bok?\r\n";
    const { findings, ir } = check(text);
    expect(renderFinding(FILE, text, findings.find((f) => f.code === "unknown-type")!, ir)).toBe(
      ["error    unknown-type  book(): Unknown type Bok", ` --> ${FILE}:2:7`, "  |", "2 | query book(id: ID): Bok?", "  |       ^^^^", "  = did you mean Book?"].join("\n"),
    );
  });

  it("suggests the type the author probably meant", () => {
    const text = ["entity Book {", "  id: ID", "  title: Strng", "}", "query book(id: ID): Book?"].join("\n");
    const { findings, ir } = check(text);
    const rendered = renderFinding(FILE, text, findings.find((f) => f.code === "unknown-type")!, ir);
    expect(rendered.split("\n").at(-1)).toBe("  = did you mean String?");
  });

  it("suggests the type for a field argument and a union member too", () => {
    const fieldArg = check(["entity Book { id: ID reviews(sort: Strng): Int }", "query book(id: ID): Book?"].join("\n"));
    const unknown = fieldArg.findings.find((f) => f.code === "unknown-type")!;
    expect(unknown.at).toBe("Book.reviews(sort)");
    expect(renderFinding(FILE, fieldArg.text, unknown, fieldArg.ir)).toBe(
      ["error    unknown-type  Book.reviews(sort): Unknown type Strng", ` --> ${FILE}:1:30`, "  |", "1 | entity Book { id: ID reviews(sort: Strng): Int }", "  |                              ^^^^", "  = did you mean String?"].join("\n"),
    );
    const union = check(["entity Book { id: ID }", "entity Author { id: ID }", "union Hit = Book | Autor", "query hit: Hit"].join("\n"));
    expect(suggestionFor(union.findings.find((f) => f.code === "unknown-type")!, union.ir)).toBe("did you mean Author?");
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
    expect(suggestionFor(findings.find((f) => f.code === "unknown-type")!, ir)).toBe("no type named Zorblatt is defined; declare it, or import the document that has it");
  });

  it("suggests the annotation the author probably meant", () => {
    const text = ["entity Book @cach(maxAge: 60s) {", "  id: ID", "}", "query book(id: ID): Book?"].join("\n");
    const { findings, ir } = check(text);
    const unknown = findings.find((f) => f.code === "unknown-annotation");
    expect(unknown?.at).toBe("Book");
    expect(suggestionFor(unknown!, ir)).toBe("did you mean @cache?");
  });

  it("finds an unknown annotation on an enum value or an argument, and offers the vendor form when nothing is near", () => {
    const value = check(["enum Tone { WARM @shine COLD }", "entity Book { id: ID t: Tone }", "query book(id: ID): Book?"].join("\n"));
    const onValue = value.findings.find((f) => f.code === "unknown-annotation")!;
    expect([onValue.at, suggestionFor(onValue, value.ir)]).toEqual(["Tone.WARM", "write it as @vendor.shine to keep an annotation of your own"]);
    const arg = check(["entity Book { id: ID reviews(n: Int @cst(base: 1)): Int }", "query book(id: ID): Book?"].join("\n"));
    const onArg = arg.findings.find((f) => f.code === "unknown-annotation")!;
    expect([onArg.at, suggestionFor(onArg, arg.ir)]).toEqual(["Book.reviews(n)", "did you mean @cost?"]);
    const opArg = check(["entity Book { id: ID }", "query book(id: ID @cst(base: 1)): Book?"].join("\n"));
    const onOpArg = opArg.findings.find((f) => f.code === "unknown-annotation")!;
    expect([onOpArg.at, suggestionFor(onOpArg, opArg.ir)]).toEqual(["book().id", "did you mean @cost?"]);
  });

  it("says what a reserved name and a policy on `this` at an operation need instead", () => {
    const reserved = check(["entity Book { id: ID __meta: String }", "query book(id: ID): Book?"].join("\n"));
    expect(renderFinding(FILE, reserved.text, reserved.findings.find((f) => f.code === "reserved-name")!, reserved.ir)).toBe(
      [
        "error    reserved-name  Book.__meta: Field name __meta is reserved",
        ` --> ${FILE}:1:22`,
        "  |",
        "1 | entity Book { id: ID __meta: String }",
        "  |                      ^^^^^^",
        "  = the protocol owns that name on the wire; call the field something else",
      ].join("\n"),
    );
    const policy = check(["entity Book { id: ID owner: String }", "query book(id: ID): Book? @allow(read: this.owner == viewer.id)"].join("\n"));
    expect(suggestionFor(policy.findings.find((f) => f.code === "policy-this-on-op")!, policy.ir)).toBe(
      "`this` is a row; an operation has none. Put the policy on the type, or use `args` and `viewer`",
    );
    // guard: a code with no obvious fix gets no suggestion
    const unreachable = check(["entity Book { id: ID }", "entity Stray { id: ID }", "query book(id: ID): Book?"].join("\n"));
    expect(suggestionFor(unreachable.findings.find((f) => f.code === "unreachable")!, unreachable.ir)).toBeUndefined();
  });

  it("says what an entity is missing", () => {
    const text = ["entity Book {", "  title: String", "}", "query book(title: String): Book?"].join("\n");
    const { findings, ir } = check(text);
    const missing = findings.find((f) => f.code === "entity-id");
    expect(missing?.at).toBe("Book");
    expect(suggestionFor(missing!, ir)).toBe("an entity is addressed by identity: give it an `id: ID` field, or make it an `object`");
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
    expect(rendered).toBe(["error    syntax  Expected name but found end of input (3:1)", ` --> ${FILE}:3:1`, "  |", "3 | ", "  | ^"].join("\n"));
    // an error that knows no position is placed at the start, not before it
    expect(syntaxFinding({ message: "somewhere" }).range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 1 } });
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
