import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSchema, schemaHash } from "./load.ts";
import { parseSchemaText } from "./parser.ts";
import { validateIR } from "./validate.ts";
import { RayfoldSyntaxError, tokenize } from "./lexer.ts";
import { evalExpr, parseExprText, isPushable, referencesViewer, type ExprEnv } from "./expr.ts";
import { canonicalShape, parseShapeText, shapeIdOf, shapeToString } from "./shape.ts";
import { typeRefToString } from "./ir.ts";

const bookstore = readFileSync(fileURLToPath(new URL("../../../examples/bookstore-ts/bookstore.rayfold", import.meta.url)), "utf8");

describe("lexer", () => {
  it("tokenizes durations, block strings and skips comments", () => {
    const toks = tokenize(`"""doc\n  indented"""\n// c\n/* b */ 60s 250ms 1.5 -3 name @allow(...)`);
    expect(toks.map((t) => t.kind)).toEqual([
      "blockstring", "duration", "duration", "float", "int", "name", "punct", "name", "punct", "punct", "punct", "eof",
    ]);
    expect(toks[0]!.value).toBe("doc\nindented");
    expect(toks[1]!.num).toBe(60_000);
    expect(toks[2]!.num).toBe(250);
    expect(toks[4]!.num).toBe(-3);
  });

  it("refuses a number that overflows to Infinity with its own syntax error, and still reads the largest finite one", () => {
    expect(() => tokenize(`1e999`)).toThrow(RayfoldSyntaxError);
    // through the whole reader: before, this got as far as hashing and failed there with a plain Error
    expect(() => loadSchema(`query q(a: Float = 1e999): Float`)).toThrow(/^Number out of range: 1e999 \(1:20\)$/);
    expect(() => loadSchema(`entity A { id: ID } query a: A @cost(base: -1e999)`)).toThrow(RayfoldSyntaxError);
    expect(() => loadSchema(`entity A @cache(maxAge: ${"9".repeat(310)}d) { id: ID }`)).toThrow(/Number out of range/);
    expect(tokenize(`1e308 -1e308 ${"9".repeat(300)}`).map((t) => t.num)).toEqual([1e308, -1e308, Number("9".repeat(300)), undefined]);
  });
});

describe("parser", () => {
  it("parses the bookstore schema with no errors and a stable hash", () => {
    const a = loadSchema(bookstore);
    const b = loadSchema(bookstore);
    expect(a.hash).toBe(b.hash);
    expect(a.warnings.filter((w) => w.severity === "error")).toEqual([]);
    expect(Object.keys(a.ir.ops).sort()).toEqual([
      "addReview", "author", "book", "books", "cancelOrder", "deleteReview", "editReview", "myOrders", "order", "payOrder", "placeOrder", "restock", "review", "stockUpdates", "updateBook",
    ]);
    expect(a.ir.types["NotCancellable"]?.kind).toBe("error"); // hoisted inline error
    expect(a.ir.ops["placeOrder"]!.throws).toEqual(["OutOfStock", "PaymentDeclined"]);
    expect(a.ir.ops["placeOrder"]!.emits).toEqual(["OrderPlaced", "StockChanged"]);
  });

  it("nullability is opt-in and generics parse", () => {
    const ir = parseSchemaText(`entity A { id: ID x: String? xs: [String?]? p: Page<A> }`);
    const f = Object.fromEntries((ir.types["A"] as { fields: { name: string; type: unknown }[] }).fields.map((x) => [x.name, x.type]));
    expect(typeRefToString(f["id"] as never)).toBe("ID");
    expect(typeRefToString(f["x"] as never)).toBe("String?");
    expect(typeRefToString(f["xs"] as never)).toBe("[String?]?");
    expect(typeRefToString(f["p"] as never)).toBe("Page<A>");
  });

  it("assigns ordinals in declaration order unless overridden", () => {
    const ir = parseSchemaText(`entity A { id: ID a: Int b: Int @ordinal(7) c: Int }`);
    const t = ir.types["A"] as { fields: { name: string; ordinal: number }[] };
    expect(t.fields.map((f) => [f.name, f.ordinal])).toEqual([["id", 1], ["a", 2], ["b", 7], ["c", 4]]);
  });

  it("keeps descriptions", () => {
    const ir = parseSchemaText(`"""An author""" entity A { id: ID """their name""" name: String }`);
    const t = ir.types["A"] as { description?: string; fields: { description?: string }[] };
    expect(t.description).toBe("An author");
    expect(t.fields[1]!.description).toBe("their name");
  });

  it("rejects duplicates and redefinition of built-ins", () => {
    expect(() => parseSchemaText(`entity A { id: ID } entity A { id: ID }`)).toThrow(/already defined/);
    expect(() => parseSchemaText(`scalar String`)).toThrow(/built-in/);
    expect(() => parseSchemaText(`entity A { id: ID id: ID }`)).toThrow(/Duplicate field/);
  });
});

describe("validation", () => {
  const errorsOf = (src: string) => validateIR(parseSchemaText(src)).filter((d) => d.severity === "error").map((d) => d.code);

  it("flags unknown types, missing ids, unknown annotations", () => {
    expect(errorsOf(`entity A { id: ID b: Nope }`)).toEqual(["unknown-type"]);
    expect(errorsOf(`entity A { name: String }`)).toEqual(["entity-id"]);
    expect(errorsOf(`entity A { id: ID @weird }`)).toEqual(["unknown-annotation"]);
    expect(errorsOf(`entity A { id: ID @vendor.weird }`)).toEqual([]);
  });

  it("flags type-position mistakes", () => {
    expect(errorsOf(`entity A { id: ID } input I { a: A }`)).toEqual(["bad-type-position"]);
    expect(errorsOf(`entity A { id: ID } query q(a: A): A`)).toEqual(["bad-type-position"]);
    expect(errorsOf(`input I { x: Int } query q: I`)).toEqual(["bad-type-position"]);
    // guard: the same positions holding allowed kinds are clean
    expect(errorsOf(`entity A { id: ID } input I { a: ID } query q(i: I): A`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID } query q(a: ID): A`)).toEqual([]);
    expect(errorsOf(`object O { x: Int } query q: O`)).toEqual([]);
  });

  it("checks type conditions at an interface position", () => {
    const base = `object Named @interface { id: ID name: String } entity Person implements Named { id: ID name: String email: String } entity Bot { id: ID name: String } entity Note { id: ID author: Named } query note(id: ID): Note?`;
    expect(errorsOf(`${base} view Note.card = { author { ...on Bot { name } } }`)).toEqual(["bad-type-condition"]);
    // guard: an implementor is accepted, so the rule is not a blanket refusal of ...on at an interface position
    expect(errorsOf(`${base} view Note.card = { author { ...on Person { email } } }`)).toEqual([]);
  });

  it("enforces annotation rules", () => {
    expect(errorsOf(`entity A { id: ID x: Int @partial }`)).toEqual(["partial-non-null"]);
    expect(errorsOf(`entity A { id: ID x: Int? @partial }`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID x: [Int] @page(cursor) }`)).toEqual(["page-on-non-page"]);
    expect(errorsOf(`entity A { id: ID } query q: Page<A>`)).toEqual(["page-args"]);
    expect(errorsOf(`entity A { id: ID } query q(page: PageArgs): Page<A>`)).toEqual([]);
    // spec 01 §9's paging rule is about a field *or* a query, and the field half went unchecked
    expect(errorsOf(`entity R { id: ID } entity A { id: ID rs: Page<R> } query a: A`)).toEqual(["page-args"]);
    expect(errorsOf(`entity R { id: ID } entity A { id: ID rs(page: PageArgs): Page<R> } query a: A`)).toEqual([]);
    expect(errorsOf(`entity R { id: ID } entity A { id: ID rs(first: Int): Page<R> } query a: A`)).toEqual([]);
    // rule 8 likewise covers both, and the operation half went unchecked
    expect(errorsOf(`entity A { id: ID } query q: A @page(cursor)`)).toEqual(["page-on-non-page"]);
    expect(errorsOf(`entity A { id: ID } query q(page: PageArgs): Page<A> @page(cursor)`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID } query q: A @allow(read: this.x == 1)`)).toEqual(["policy-this-on-op"]);
    expect(errorsOf(`entity A { id: ID } query q: A @allow(read: viewer != null)`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID x: Int @allow(read: this.x == 1) }`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID } query q: A @cache(maxAge: 5, scope: public)`)).toEqual(["bad-cache-maxage"]);
    // an unquoted date lexes as three numbers (sunset: 2027 and two positional values), and diff.ts can only read a
    // string, so the member could never be retired. docs/guide/from-rest.md taught the unquoted form.
    expect(errorsOf(`entity A { id: ID p: Int @deprecated(sunset: 2027-06-30) }`)).toEqual(["bad-sunset"]);
    expect(errorsOf(`entity A { id: ID p: Int @deprecated(sunset: "2027-06-30") }`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID p: Int @deprecated(reason: "old") }`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID } query q: A @cache(maxAge: 5s, scope: public)`)).toEqual([]);
  });

  it("@version needs a non-null Int, Long, String or Instant field", () => {
    for (const bad of ["Int?", "Float", "[Int]", "Boolean"]) expect(errorsOf(`entity A { id: ID v: ${bad} @version }`)).toEqual(["bad-version-field"]);
    for (const ok of ["Int", "Long", "String", "Instant"]) expect(errorsOf(`entity A { id: ID v: ${ok} @version }`)).toEqual([]);
  });

  it("@http bindings are checked against the operation kind and its arguments", () => {
    const code = (op: string) => errorsOf(`entity A { id: ID } input P { x: Int? } ${op}`);
    expect(code(`query q(id: ID): A @http(method: POST, path: "/a/{id}")`)).toEqual(["bad-http-method"]);
    expect(code(`command c(id: ID): A @http(method: GET, path: "/a/{id}")`)).toEqual(["bad-http-method"]);
    expect(code(`stream s(id: ID): A @http(method: GET, path: "/a/{id}")`)).toEqual(["annotation-position", "bad-http-method"]);
    for (const m of ["GET", "QUERY"]) expect(code(`query q(id: ID): A @http(method: ${m}, path: "/a/{id}")`)).toEqual([]);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(code(`command c(id: ID): A @http(method: ${m}, path: "/a/{id}")`)).toEqual([]);
    expect(code(`query q(id: ID): A @http(method: GET, path: "a/{id}")`)).toEqual(["bad-http-path"]);
    expect(code(`query q(id: ID): A @http(method: GET, path: "/a/{nope}")`)).toEqual(["bad-http-param"]);
    expect(code(`command c(id: ID, p: P): A @http(method: PATCH, path: "/a/{id}", body: nope)`)).toEqual(["bad-http-body"]);
    expect(code(`query q(id: ID): A @http(method: GET, path: "/a", body: "*")`)).toEqual(["bad-http-body"]);
    expect(code(`command c(id: ID, p: P): A @http(method: PATCH, path: "/a/{id}", body: p)`)).toEqual([]);
    expect(code(`query q(id: ID, p: P?): A @http(method: QUERY, path: "/a", body: "*")`)).toEqual([]);
  });

  describe("@http(name:) gives an argument or an input field its name in HTTP bindings", () => {
    const code = (text: string) => errorsOf(`entity A { id: ID } ${text}`);
    const detail = (text: string) => validateIR(parseSchemaText(`entity A { id: ID } ${text}`)).filter((d) => d.severity === "error").map((d) => [d.code, d.at, d.message]);

    it("on an operation argument and on an input field, with exactly one non-empty string name", () => {
      expect(code(`input I { firstName: String @http(name: "first-name") } query q(maxCount: Int @http(name: "max-count"), i: I?): A`)).toEqual([]);
      const bad = `@http on an argument or input field takes exactly one argument, name: "<wire name>", a non-empty string`;
      expect(detail(`query q(n: Int @http): A`)).toEqual([["bad-http-name", "q().n", bad]]);
      expect(detail(`query q(n: Int @http(name: 3)): A`)).toEqual([["bad-http-name", "q().n", bad]]);
      expect(detail(`query q(n: Int @http(name: "")): A`)).toEqual([["bad-http-name", "q().n", bad]]);
      expect(detail(`query q(n: Int @http(name: "n-1", method: GET)): A`)).toEqual([["bad-http-name", "q().n", bad]]);
      expect(detail(`query q(n: Int @http("n-1")): A`)).toEqual([["bad-http-name", "q().n", bad]]);
      expect(detail(`input I { n: Int @http(name: count) } query q(i: I): A`)).toEqual([["bad-http-name", "I.n", bad]]);
    });

    it("guard - @http on an operation keeps its own arguments, and is not held to the name form", () => {
      expect(code(`query q(id: ID @http(name: "the-id")): A @http(method: GET, path: "/a/{id}")`)).toEqual([]);
    });

    it("not on a result field, an error or event field, or a field argument", () => {
      expect(detail(`entity B { id: ID n: Int @http(name: "n-1") } query q: B`)).toEqual([
        ["annotation-position", "B.n", "@http is not allowed on a field of entity B; only input fields take a wire name"],
      ]);
      expect(code(`object O { n: Int @http(name: "n-1") } query q: O`)).toEqual(["annotation-position"]);
      expect(code(`event E { n: Int @http(name: "n-1") } command c: A emits E`)).toEqual(["annotation-position"]);
      expect(detail(`entity B { id: ID n(x: Int @http(name: "x-1")): Int } query q: B`)).toEqual([
        ["annotation-position", "B.n(x)", "@http is not allowed on a field argument; only operation arguments take a wire name"],
      ]);
    });

    it("a wire name stands for one member of its operation or input type", () => {
      expect(detail(`query q(a: Int @http(name: "x"), b: Int @http(name: "x")): A`)).toEqual([
        ["http-name-collision", "q().a", '@http name "x" of a is also the wire name of b'],
        ["http-name-collision", "q().b", '@http name "x" of b is also the wire name of a'],
      ]);
      expect(detail(`query q(a: Int @http(name: "b"), b: Int): A`)).toEqual([["http-name-collision", "q().a", '@http name "b" of a is also the name of b']]);
      // a swap is refused too: each wire name is the other member's schema name
      expect(code(`query q(a: Int @http(name: "b"), b: Int @http(name: "a")): A`)).toEqual(["http-name-collision", "http-name-collision"]);
      expect(detail(`input I { a: Int @http(name: "b") b: Int } query q(i: I): A`)).toEqual([["http-name-collision", "I.a", '@http name "b" of a is also the name of b']]);
    });

    it("guard - the same wire name in another operation or input type, or a member's own name as its wire name, is fine", () => {
      expect(code(`input I { a: Int @http(name: "x") } input J { a: Int @http(name: "x") } query q(a: Int @http(name: "x"), i: I?, j: J?): A query r(a: Int @http(name: "x")): A`)).toEqual([]);
      expect(code(`query q(a: Int @http(name: "a"), b: Int): A`)).toEqual([]);
    });
  });

  it("validates views against fields", () => {
    expect(errorsOf(`entity A { id: ID } view A.default = { id nope }`)).toEqual(["unknown-field"]);
    expect(errorsOf(`entity A { id: ID } view A.default = { id }`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID } view A.x = { ...A.y } view A.y = { ...A.x }`)).toEqual(["view-cycle", "view-cycle"]);
  });

  it("warns on unreachable types", () => {
    const d = validateIR(parseSchemaText(`entity A { id: ID } entity B { id: ID } query a: A`));
    expect(d.filter((x) => x.code === "unreachable").map((x) => [x.severity, x.code, x.at])).toEqual([["warning", "unreachable", "B"]]);
    // guard: a type reached through a field, an argument or a declared error is not reported
    const reached = validateIR(parseSchemaText(`entity A { id: ID b: B } entity B { id: ID } input F { q: String } error Gone { id: ID } query a(f: F): A command c: A throws Gone`));
    expect(reached.filter((x) => x.code === "unreachable")).toEqual([]);
    // rule 9 counts views, so a type reached only through one is reachable
    const viaView = validateIR(parseSchemaText(`entity A { id: ID } entity B { id: ID n: String } query a: A view B.card = { n }`));
    expect(viaView.filter((x) => x.code === "unreachable")).toEqual([]);
  });

  it("an object reached only through an error's payload is reachable (guard - one reached through nothing still warns)", () => {
    const warnings = (src: string) => validateIR(parseSchemaText(src)).filter((d) => d.code === "unreachable").map((d) => d.at);
    expect(warnings(`object Detail { x: Int } error E { d: Detail } command c: Int throws E`)).toEqual([]);
    expect(warnings(`object Detail { x: Int } object Stray { x: Int } error E { d: Detail } command c: Int throws E`)).toEqual(["Stray"]);
  });

  it("T means a type parameter only inside the generic that declares it (guard - Page's own T still reads)", () => {
    expect(validateIR(parseSchemaText(`entity A { id: ID x: T } query a: A`))).toEqual([{ severity: "error", code: "unknown-type", at: "A.x", message: "Unknown type T" }]);
    expect(errorsOf(`entity A { id: ID } query a(page: PageArgs): Page<A>`)).toEqual([]);
  });

  it("a generic is held to the position it is used in (guard - Page<T> as a result is fine)", () => {
    const d = validateIR(parseSchemaText(`input I { p: Page<Int> } query a(i: I, p: Page<String>): Int`)).filter((x) => x.severity === "error");
    expect(d.map((x) => `${x.code}@${x.at}: ${x.message}`)).toEqual([
      "bad-type-position@I.p: object Page cannot be used as an input field",
      "page-args@I.p: A field returning Page<T> must accept page: PageArgs (or first/after)",
      "bad-type-position@a().p: object Page cannot be used as an argument",
    ]);
    expect(errorsOf(`query a(page: PageArgs): Page<String>`)).toEqual([]);
  });

  it("@input names a type a client can send (guard - an input type is accepted)", () => {
    expect(validateIR(parseSchemaText(`stream s: Int @input(Nope)`)).map((x) => `${x.code}@${x.at}: ${x.message}`)).toEqual(["unknown-type@s(): Unknown type Nope"]);
    expect(errorsOf(`entity E { id: ID } stream s: E @input(E)`)).toEqual(["bad-type-position"]);
    expect(errorsOf(`input Msg { text: String } entity E { id: ID } stream s: E @input(Msg)`)).toEqual([]);
    const ir = parseSchemaText(`input Msg { text: String } stream s: Int @input(Msg)`);
    ir.ops["s"]!.annotations[0]!.args["value"] = "Msg";
    expect(validateIR(ir).map((x) => x.code)).toEqual(["bad-input"]);
  });

  it("names repeated where a schema file cannot repeat them are refused, from any IR (guard - distinct names pass)", () => {
    expect(errorsOf(`entity A { id: ID } entity B { id: ID } union U = A | B | A query u: U`)).toEqual(["duplicate-name"]);
    const ir = parseSchemaText(`enum E { X Y } entity A { id: ID n(a: Int, b: Int): Int } query q(a: Int, b: Int): A`);
    (ir.types["E"] as { values: Array<{ name: string }> }).values[1]!.name = "X";
    (ir.types["A"] as { fields: Array<{ name: string; args: Array<{ name: string }> }> }).fields[1]!.args[1]!.name = "a";
    ir.ops["q"]!.args[1]!.name = "a";
    (ir.types["A"] as { fields: Array<{ name: string }> }).fields[1]!.name = "id";
    expect(validateIR(ir).filter((x) => x.code === "duplicate-name").map((x) => `${x.at}: ${x.message}`)).toEqual([
      "E: Duplicate enum value X",
      "A: Duplicate field id",
      "A.id: Duplicate argument a",
      "q(): Duplicate argument a",
    ]);
    expect(errorsOf(`enum E { X Y } entity A { id: ID n(a: Int, b: Int): Int } query q(a: Int, b: Int, e: E): A`)).toEqual([]);
  });

  it("a name the parser could not have read is refused in an IR from elsewhere (guard - the same IR with names passes)", () => {
    const ir = parseSchemaText(`enum E { X } entity User { id: ID firstName: String } view User.card = { id } query user(sortBy: String, e: E): User`);
    expect(validateIR(ir).filter((x) => x.severity === "error")).toEqual([]);
    (ir.types["User"] as { fields: Array<{ name: string }> }).fields[1]!.name = "first-name";
    ir.ops["user"]!.args[0]!.name = "sort by";
    (ir.types["E"] as { values: Array<{ name: string }> }).values[0]!.name = "1st";
    ir.views["User.card"]!.name = "a.b";
    ir.types["Bad-Type"] = { kind: "scalar", name: "Bad-Type", annotations: [] };
    ir.ops["op-x"] = { kind: "query", name: "op-x", args: [], returns: { kind: "named", name: "Int", nullable: false }, throws: [], emits: [], annotations: [] };
    expect(validateIR(ir).filter((x) => x.code === "bad-name").map((x) => `${x.at}: ${x.message}`)).toEqual([
      'E.1st: Enum value "1st" is not a name ([A-Za-z_][A-Za-z0-9_]*)',
      'User.first-name: Field name "first-name" is not a name ([A-Za-z_][A-Za-z0-9_]*)',
      'Bad-Type: Type name "Bad-Type" is not a name ([A-Za-z_][A-Za-z0-9_]*)',
      'user().sort by: Argument name "sort by" is not a name ([A-Za-z_][A-Za-z0-9_]*)',
      'op-x(): Operation name "op-x" is not a name ([A-Za-z_][A-Za-z0-9_]*)',
      'User.a.b: View name "a.b" is not a name ([A-Za-z_][A-Za-z0-9_]*)',
    ]);
  });

  it("an argument or enum value named with __ is reserved, as a field is (guard - one leading underscore is a name)", () => {
    const ir = parseSchemaText(`enum E { __X Y } entity A { id: ID n(__proto__: Int): Int } query q(__proto__: String, e: E): A`);
    expect(validateIR(ir).filter((x) => x.code === "reserved-name").map((x) => `${x.at}: ${x.message}`)).toEqual([
      "E.__X: Enum value __X is reserved",
      "A.n(__proto__): Argument name __proto__ is reserved",
      "q().__proto__: Argument name __proto__ is reserved",
    ]);
    expect(errorsOf(`enum E { _X Y } entity A { id: ID n(_proto: Int): Int } query q(_proto: String, e: E): A`)).toEqual([]);
  });
});

describe("the schema hash", () => {
  const SCHEMA = `entity Book { id: ID title: String } query book(id: ID): Book?`;

  it("does not move when vendor data is added, because vendor data is not part of the conversation", () => {
    const { ir, hash } = loadSchema(SCHEMA);
    // spec 01 §9: `extensions` is the one member excluded from the hashed form. An implementation that does not know
    // a vendor's data ignores it, so an identity that moved with it would make two servers offering the same
    // conversation look different, and a gateway that strips vendor metadata look like a schema change.
    expect(schemaHash({ ...ir, extensions: { "vendor.build": "2026-09-17", "vendor.team": "platform" } })).toBe(hash);
    expect(schemaHash({ ...ir, extensions: {} })).toBe(hash);
  });

  it("guard: it does move when anything a client can see changes", () => {
    const { hash } = loadSchema(SCHEMA);
    expect(loadSchema(`entity Book { id: ID title: String pages: Int } query book(id: ID): Book?`).hash).not.toBe(hash);
    expect(loadSchema(`entity Book { id: ID title: String? } query book(id: ID): Book?`).hash).not.toBe(hash);
    expect(loadSchema(`entity Book { id: ID title: String } query book(id: ID): Book`).hash).not.toBe(hash);
  });
});

describe("policy expressions", () => {
  it("resolves bare names to this on entities", () => {
    const e = parseExprText(`viewer.role == "admin" || viewer.id == ownerId`, "this");
    expect(evalExpr(e, { viewer: { role: "user", id: "u1" }, args: {}, this: { ownerId: "u1" } })).toBe(true);
    expect(evalExpr(e, { viewer: { role: "user", id: "u2" }, args: {}, this: { ownerId: "u1" } })).toBe(false);
    expect(evalExpr(e, { viewer: null, args: {}, this: { ownerId: "u1" } })).toBe(false);
    expect(referencesViewer(e)).toBe(true);
    expect(isPushable(e)).toBe(true);
  });

  it("a path reads only an object's own members, as the JVM does: no array length, no prototype (guard - data members still read)", () => {
    const run = (text: string, env: Partial<ExprEnv>) => evalExpr(parseExprText(text, "this"), { viewer: null, args: {}, this: null, ...env });
    const row = { tags: ["a", "b"], owner: { id: "u1" } };
    expect(run(`this.tags.length != null`, { this: row })).toBe(false);
    expect(run(`tags.length > 1`, { this: row })).toBe(false);
    expect(run(`viewer.constructor != null`, { viewer: { id: "u1" } })).toBe(false);
    expect(run(`viewer.toString != null`, { viewer: { id: "u1" } })).toBe(false);
    expect(run(`viewer.__proto__ != null`, { viewer: { id: "u1" } })).toBe(false);
    expect(run(`len(tags) == 2 && owner.id == "u1" && viewer.id == "u1"`, { this: row, viewer: { id: "u1" } })).toBe(true);
    expect(run(`viewer.length == 3`, { viewer: { length: 3 } })).toBe(true);
  });

  it("is total: null comparisons are false, in/has work", () => {
    expect(evalExpr(parseExprText(`viewer != null`, "args"), { viewer: null, args: {}, this: null })).toBe(false);
    expect(evalExpr(parseExprText(`viewer != null`, "args"), { viewer: {}, args: {}, this: null })).toBe(true);
    expect(evalExpr(parseExprText(`viewer.age > 18`, "args"), { viewer: {}, args: {}, this: null })).toBe(false);
    expect(evalExpr(parseExprText(`"a" in ["a", "b"]`, "args"), { viewer: null, args: {}, this: null })).toBe(true);
    expect(evalExpr(parseExprText(`has(viewer.scopes, "books:write")`, "args"), { viewer: { scopes: ["books:write"] }, args: {}, this: null })).toBe(true);
    expect(evalExpr(parseExprText(`!(id == 1) && len(tags) >= 2`, "args"), { viewer: null, args: { id: 2, tags: ["x", "y"] }, this: null })).toBe(true);
  });

  it("rejects unknown functions", () => {
    expect(() => parseExprText(`magic(1)`, "args")).toThrow(/Unknown function/);
  });
});

describe("shapes", () => {
  const { ir } = loadSchema(bookstore);
  const views = (t: string, v: string) => ir.views[`${t}.${v}`];

  it("canonical form is order-insensitive and expands views", () => {
    const a = canonicalShape(parseShapeText(`{ title id author { name id } }`), views);
    const b = canonicalShape(parseShapeText(`{ id author { id name } title }`), views);
    expect(a).toBe(b);
    expect(a).toBe("{ author { id name } id title }");
    const c = canonicalShape(parseShapeText(`{ ...Book.default }`), views);
    expect(c).toBe("{ author { id name } format id price stock title }");
    expect(shapeIdOf(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(shapeIdOf(a)).not.toBe(shapeIdOf(c));
  });

  it("args, aliases, vars, defer and modifiers survive canonicalisation", () => {
    const s = parseShapeText(`{ top: reviews(page: { first: $n }) { items { id } } @defer(label: "x") { stock @partial } ...on Book { title @eager } }`);
    expect(canonicalShape(s, views)).toBe(
      `{ top: reviews(page: {"first":$n}) { items { id } } ...on Book { title @eager } @defer(label: "x") { stock @partial } }`,
    );
  });

  it("an empty argument list is the same selection as none at all", () => {
    // Found by the fuzz job: `field()` was parsed with an empty args map, printed back without the parentheses, and
    // so failed to survive its own round trip. It is the same selection either way, and both forms must agree.
    const empty = parseShapeText(`{ i() title }`);
    expect(empty).toEqual(parseShapeText(`{ i title }`));
    expect(shapeToString(empty)).toBe(`{ i title }`);
    expect(canonicalShape(empty, views)).toBe(canonicalShape(parseShapeText(`{ i title }`), views));

    // guard: a real argument is still recorded, and still prints
    const real = parseShapeText(`{ i(n: 1) }`);
    expect(real.items[0]).toMatchObject({ name: "i", args: { n: 1 } });
    expect(shapeToString(real)).toBe(`{ i(n: 1) }`);
  });

  it("rejects unknown views and bad directives", () => {
    expect(() => canonicalShape(parseShapeText(`{ ...Book.nope }`), views)).toThrow(/Unknown view/);
    expect(() => parseShapeText(`{ id @weird }`)).toThrow(/Unknown field modifier/);
  });
});

// ------------------------------------------------------------------ security (spec 12)
import { evalExpr as secEval, parseExprText as secParse, ExprError } from "./expr.ts";
import { parseShapeText as secParseShape } from "./shape.ts";

describe("security: parsing and comparing hostile input", () => {
  it("shape text nested deeper than 64 levels is refused while parsing, before any deep recursion", () => {
    const nest = (n: number) => "{ " + "a { ".repeat(n) + "id" + " }".repeat(n) + " }";
    expect(() => secParseShape(nest(5_000))).toThrow(/nested deeper than 64 levels/);
    expect(() => secParseShape(`{ a(x: ${"[".repeat(100)}1${"]".repeat(100)}) }`)).toThrow(/nested deeper than 64 levels/);
    expect(secParseShape(nest(30)).items).toHaveLength(1); // guard
    expect(() => secParseShape(nest(5_000))).toThrow(/nested deeper/); // the counter resets after a failure
    expect(secParseShape(nest(62)).items).toHaveLength(1);
  });

  it("numbers and numeric text compare exactly by value; text that is not numeric compares as text", () => {
    const ev = (src: string, args: Record<string, unknown>) => secEval(secParse(src, "args"), { viewer: null, args, this: null });
    expect(ev("args.a > 1000", { a: "5000" })).toBe(true);
    expect(ev("args.a > 1000", { a: "999.999" })).toBe(false);
    expect(ev("args.a == 5000", { a: "5000.00" })).toBe(true);
    expect(ev("args.a > args.b", { a: "10.5", b: "9.75" })).toBe(true); // numerically, not "10.5" < "9.75"
    expect(ev("args.a > 9007199254740992", { a: "9007199254740993" })).toBe(true);
    expect(ev("args.a < args.b", { a: "-0.5", b: "0" })).toBe(true);
    expect(ev("args.a < args.b", { a: "apple", b: "banana" })).toBe(true);
    expect(ev("args.a == args.b", { a: "01", b: "1" })).toBe(false); // ids stay distinct text
    expect(ev("args.a > 1", { a: null })).toBe(false); // null comparisons stay false
    expect(() => ev("args.a > 1", { a: true })).toThrow(ExprError);
  });
});
