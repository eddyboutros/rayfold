import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSchema } from "./load.ts";
import { parseSchemaText } from "./parser.ts";
import { validateIR } from "./validate.ts";
import { tokenize } from "./lexer.ts";
import { evalExpr, parseExprText, isPushable, referencesViewer } from "./expr.ts";
import { canonicalShape, parseShapeText, shapeIdOf } from "./shape.ts";
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
    expect(errorsOf(`entity A { id: ID b: Nope }`)).toContain("unknown-type");
    expect(errorsOf(`entity A { name: String }`)).toContain("entity-id");
    expect(errorsOf(`entity A { id: ID @weird }`)).toContain("unknown-annotation");
    expect(errorsOf(`entity A { id: ID @vendor.weird }`)).toEqual([]);
  });

  it("flags type-position mistakes", () => {
    expect(errorsOf(`entity A { id: ID } input I { a: A }`)).toContain("bad-type-position");
    expect(errorsOf(`entity A { id: ID } query q(a: A): A`)).toContain("bad-type-position");
    expect(errorsOf(`input I { x: Int } query q: I`)).toContain("bad-type-position");
    // guard: the same positions holding allowed kinds are clean
    expect(errorsOf(`entity A { id: ID } input I { a: ID } query q(i: I): A`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID } query q(a: ID): A`)).toEqual([]);
    expect(errorsOf(`object O { x: Int } query q: O`)).toEqual([]);
  });

  it("enforces annotation rules", () => {
    expect(errorsOf(`entity A { id: ID x: Int @partial }`)).toContain("partial-non-null");
    expect(errorsOf(`entity A { id: ID x: Int? @partial }`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID x: [Int] @page(cursor) }`)).toContain("page-on-non-page");
    expect(errorsOf(`entity A { id: ID } query q: Page<A>`)).toContain("page-args");
    expect(errorsOf(`entity A { id: ID } query q(page: PageArgs): Page<A>`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID } query q: A @allow(read: this.x == 1)`)).toContain("policy-this-on-op");
    expect(errorsOf(`entity A { id: ID } query q: A @allow(read: viewer != null)`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID x: Int @allow(read: this.x == 1) }`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID } query q: A @cache(maxAge: 5, scope: public)`)).toContain("bad-cache-maxage");
    expect(errorsOf(`entity A { id: ID } query q: A @cache(maxAge: 5s, scope: public)`)).toEqual([]);
  });

  it("@version needs a non-null Int, Long, String or Instant field", () => {
    for (const bad of ["Int?", "Float", "[Int]", "Boolean"]) expect(errorsOf(`entity A { id: ID v: ${bad} @version }`)).toContain("bad-version-field");
    for (const ok of ["Int", "Long", "String", "Instant"]) expect(errorsOf(`entity A { id: ID v: ${ok} @version }`)).toEqual([]);
  });

  it("@http bindings are checked against the operation kind and its arguments", () => {
    const code = (op: string) => errorsOf(`entity A { id: ID } input P { x: Int? } ${op}`);
    expect(code(`query q(id: ID): A @http(method: POST, path: "/a/{id}")`)).toContain("bad-http-method");
    expect(code(`command c(id: ID): A @http(method: GET, path: "/a/{id}")`)).toContain("bad-http-method");
    expect(code(`stream s(id: ID): A @http(method: GET, path: "/a/{id}")`)).toContain("bad-http-method");
    for (const m of ["GET", "QUERY"]) expect(code(`query q(id: ID): A @http(method: ${m}, path: "/a/{id}")`)).toEqual([]);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(code(`command c(id: ID): A @http(method: ${m}, path: "/a/{id}")`)).toEqual([]);
    expect(code(`query q(id: ID): A @http(method: GET, path: "a/{id}")`)).toContain("bad-http-path");
    expect(code(`query q(id: ID): A @http(method: GET, path: "/a/{nope}")`)).toContain("bad-http-param");
    expect(code(`command c(id: ID, p: P): A @http(method: PATCH, path: "/a/{id}", body: nope)`)).toContain("bad-http-body");
    expect(code(`query q(id: ID): A @http(method: GET, path: "/a", body: "*")`)).toContain("bad-http-body");
    expect(code(`command c(id: ID, p: P): A @http(method: PATCH, path: "/a/{id}", body: p)`)).toEqual([]);
    expect(code(`query q(id: ID, p: P?): A @http(method: QUERY, path: "/a", body: "*")`)).toEqual([]);
  });

  it("validates views against fields", () => {
    expect(errorsOf(`entity A { id: ID } view A.default = { id nope }`)).toContain("unknown-field");
    expect(errorsOf(`entity A { id: ID } view A.default = { id }`)).toEqual([]);
    expect(errorsOf(`entity A { id: ID } view A.x = { ...A.y } view A.y = { ...A.x }`)).toContain("view-cycle");
  });

  it("warns on unreachable types", () => {
    const d = validateIR(parseSchemaText(`entity A { id: ID } entity B { id: ID } query a: A`));
    expect(d.map((x) => [x.severity, x.code, x.at])).toContainEqual(["warning", "unreachable", "B"]);
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
