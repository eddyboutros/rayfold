/**
 * Generates the TypeScript oracles the Kotlin tests compare against (OpenAPI, MCP tools and resources, and the
 * schema reader: IR, diagnostics, hash and error message for every schema case).
 * Run from the repo root: npx tsx scripts/kotlin-oracle.ts [output dir]
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSchema, parseSchemaText, schemaHash, validateIR, type RayfoldSchemaIR } from "../packages/schema/src/index.ts";
import { openApiFor } from "../packages/server/src/openapi.ts";
import { mcpTools, mcpResources } from "../packages/server/src/mcp.ts";
import { createRayfoldServer } from "../packages/server/src/server.ts";
import { bookstoreSchemaText, createBookstore } from "../examples/bookstore-ts/src/index.ts";
import { RbCodec } from "../packages/rb/src/index.ts";

const out = process.argv[2] ?? fileURLToPath(new URL("../kotlin/rayfold-core/src/test/resources/oracle", import.meta.url));
mkdirSync(out, { recursive: true });
const write = (name: string, v: unknown) => writeFileSync(`${out}/${name}`, JSON.stringify(v, null, 1) + "\n");

// the same schemas the TS tests use, verbatim
const OPENAPI_CUSTOM = `
entity Item { id: ID n: Int }
entity Secret @allow(read: viewer != null) { id: ID }
enum Format { A B }
query items(limit: Int, flag: Boolean = false, format: Format?, q: String @range(min: 2, max: 8), top: Int @range(min: 1, max: 50)): [Item] @http(method: GET, path: "/items")
query item(n: Int, id: ID?): Item? @http(method: GET, path: "/items/{n}/{id}")
query secret(id: ID): Secret? @http(method: GET, path: "/secrets/{id}")
command free(n: Int): Item @idempotent(false) @http(method: POST, path: "/free", body: "*")
command keyed(n: Int): Item @http(method: POST, path: "/keyed", body: "*")
entity Note { id: ID v: Int @version }
command makeNote(n: Int): Note @http(method: POST, path: "/notes", body: "*")
query secrets(page: Int = 1): [Secret] @http(method: GET, path: "/secrets")
entity Priced { id: ID cost: Int? @allow(read: viewer != null) }
query priced(id: ID): Priced? @http(method: GET, path: "/priced/{id}")
query prices(cap: Decimal? @range(min: 0, max: 100), qn: String? @range(min: 1, max: 10)): [Item] @http(method: GET, path: "/prices")
`;

const ITEMS_SCHEMA = `
entity Item { id: ID n: Int }
entity Note { id: ID title: String body: String @lazy parent: Note? }
enum Format { A B }
input ItemFilter { min: Int? }
query items(limit: Int, flag: Boolean, format: Format?, where: ItemFilter?): [Item] @http(method: GET, path: "/items")
query item(n: Int): Item? @http(method: GET, path: "/items/{n}")
query file(name: String): Item? @http(method: GET, path: "/files/{name}.json")
query note(id: ID): Note? @http(method: GET, path: "/notes/{id}")
command free(n: Int): Item @idempotent(false) @http(method: POST, path: "/free", body: "*")
command keyed(n: Int): Item @http(method: POST, path: "/keyed", body: "*")
command drop(id: ID): Item? @http(method: "delete", path: "/items/{id}")
`;

const OPENAPI_WIRE = `
entity Hit { id: ID first: String? }
input Near { maxKm: Int @http(name: "max-km") }
input Where { zipCode: String? @http(name: "zip-code") near: Near @http(name: "near-by") }
query find(firstName: String? @http(name: "first-name"), maxCount: Int @http(name: "max-count") @range(min: 1, max: 9)): [Hit] @http(method: GET, path: "/find")
query hit(hitId: ID @http(name: "hit-id")): Hit? @http(method: GET, path: "/hits/{hitId}")
query search(firstName: String? @http(name: "first-name"), where: Where): [Hit] @http(method: QUERY, path: "/search", body: "*")
command tag(hitId: ID @http(name: "hit-id"), where: Where): Hit @http(method: PUT, path: "/hits/{hitId}", body: where)
`;

const MCP_RANGE =`entity A { id: ID } command set(qty: Int @range(min: 1, max: 5), name: String @range(min: 2, max: 3), price: Decimal @range(min: 0), free: Int): A @idempotent(false)`;

const bs = createBookstore();
write("bookstore.ir.json", bs.server.ir);
write("bookstore.openapi.json", openApiFor(bs.server.ir));
write("bookstore.openapi.prefixed.json", openApiFor(bs.server.ir, { title: "Bookstore", version: "2.1", prefix: "/api" }));
write("bookstore.mcp-tools.json", mcpTools(bs.server));
write("bookstore.mcp-resources.json", mcpResources(bs.server));

const custom = loadSchema(OPENAPI_CUSTOM).ir;
write("openapi-custom.ir.json", custom);
write("openapi-custom.openapi.json", openApiFor(custom));

const wire = loadSchema(OPENAPI_WIRE).ir;
write("openapi-wire.ir.json", wire);
write("openapi-wire.openapi.json", openApiFor(wire));

write("items.ir.json", loadSchema(ITEMS_SCHEMA).ir);

const range = createRayfoldServer({ schema: MCP_RANGE, resolvers: { Command: { set: () => ({ id: "a" }) } } });
write("mcp-range.ir.json", range.ir);
write("mcp-range.tools.json", mcpTools(range));

// ------------------------------------------------------------------ schema reader (SchemaTextTest.kt)
// Every schema text in the repository, plus cases aimed at each branch of the lexer, parser and validator. The
// oracle records what @rayfold/schema does with each; the Kotlin reader must do exactly the same.

const SCHEMA_CASES: Record<string, string> = {
  // ---- valid schemas (their warnings and findings are recorded too)
  lexical: String.raw`
// a line comment
/* a block
   comment spanning lines */
"""
    A described entity.
      This line keeps two extra spaces.

"""
entity Doc @cache(maxAge: 90s, scope: private) @vendor.flag(on: true) {
  id: ID
  """Title with "quotes"."""
  title: String @example("A \"quoted\" \\ title\n\té \/ \b\f\r")
  tags: [String]? @range(min: 0, max: 10)
  score: Float @range(min: -1.5, max: 1e3)
  big: Long @example(12345678901234567890)
  tiny: Float @example(0.0000001)
  small: Float @example(0.000001)
  neg: Int @example(-0)
  huge: Float @example(1e21)
  wait: Duration @example(250ms) @unit("ms")
  day: Duration @example(2d)
  mins: Duration @example(5m)
  hours: Duration @example(1h)
  secs: Duration @example(30s)
  notDuration: Int @example(5)
}
query doc(id: ID): Doc?
`,
  "generics-and-pages": `
entity Doc { id: ID tags(first: Int = 3, order: [String] = ["a", "b"], where: DocWhere = { title: "x", nested: { deep: [1, 2.5, null, true] } }): [String] }
input DocWhere { title: String? = null nested: Nested? }
input Nested { deep: [JSON]? }
query docs(page: PageArgs = { first: 5, after: null }): Page<Doc> @page
query grid: [[Int]]
query maybe: [Doc?]?
`,
  "interfaces-unions": `
object Node @interface { id: ID }
entity A implements Node { id: ID a: Int }
entity B implements Node Other { id: ID b: String }
object Other @interface { b: String }
union AB @deprecated(reason: "use nodes") = A | B
query ab: [AB]
view AB.default = { ...on A { a } ...on B { b } }
`,
  "interface-type-conditions": `
object Named @interface { id: ID name: String }
entity Person implements Named { id: ID name: String email: String }
entity Bot { id: ID name: String }
entity Note { id: ID author: Named }
query note(id: ID): Note?
view Note.ok = { author { ...on Person { email } } }
view Note.bad = { author { ...on Bot { name } } }
`,
  "merge-policies": `
entity Doc { id: ID title: String @merge(serverWins) body: String @merge(crdtText) muddled: String @merge(whenever) }
query doc(id: ID): Doc?
`,
  "throws-emits": `
error Denied { reason: String }
event Changed { id: ID at: Instant }
entity A { id: ID }
command change(id: ID): A throws Denied | Busy { retryAfter: Duration } emits Changed @idempotent(true)
command change2(id: ID): A throws Busy { retryAfter: Duration } emits Changed Changed2
event Changed2 { id: ID }
query a(id: ID): A?
`,
  annotations: `
enum Color @example("RED") { RED @ordinal(3) GREEN @deprecated(sunset: "2027-01-01", replacement: "RED") """Blue.""" BLUE }
scalar Email @format(pattern: "^[^@]+@[^@]+$") @example("a@b.c") @unit(value: "email")
entity A { id: ID color: Color @ordinal(9) email: Email? @example(1, 2.5, "three", null, true, [1], { k: v }) n: Int @cost(base: 2, perItem: 1) @load(single) other: A? @load(batch) @lazy }
input I @example({ a: 1 }) { x: Int = 1 @range(min: 1) }
stream feed(n: Int = 10): Tick @input(I) @cost(base: 1)
event Tick { at: Instant }
query a(id: ID, i: I?): A? @live @example("q")
`,
  expressions: `
entity Doc @allow(read: viewer.role == "admin" || (viewer.id == ownerId && !deleted), write: has(viewer.roles, "editor") && len(tags) > 2) {
  id: ID
  ownerId: ID
  deleted: Boolean
  tags: [String]
  secret: String? @deny(read: 1.5 >= viewer.level || this.ownerId != viewer.id) @allow(read: viewer.id in [ownerId, "root"])
}
query doc(id: ID, limit: Int = 10): Doc? @allow(read: limit <= 100 && viewer != null && args.id != "x" && now() > 0 && 5m < 1h)
command purge(ids: [ID]): Boolean @allow(write: len(ids) < 50 && !(viewer.role == "guest"))
`,
  "views-and-shapes": `
entity Author { id: ID name: String bio: String? @lazy books(page: PageArgs = { first: 10 }): Page<Book> }
entity Book { id: ID title: String author: Author note: String? }
view Book.default = { id title author { id name } }
view Book.card = { ...Book.default heading: title note @partial @eager }
view Author.default = { id name books(page: { first: $n, after: $cur }) { items { ...Book.card } cursor } @defer(label: "slow") { bio } @defer { name } }
query book(id: ID): Book?
query author(id: ID): Author?
`,
  http: `
entity Doc { id: ID title: String }
input DocInput { title: String }
query doc(id: ID): Doc? @http(method: GET, path: "/docs/{id}")
query docs(q: String): [Doc] @http(method: QUERY, path: "/docs", body: "*")
command makeDoc(input: DocInput): Doc @http(method: POST, path: "/docs", body: input)
command editDoc(id: ID, input: DocInput): Doc @http(method: "patch", path: "/docs/{id}", body: input)
`,
  "crlf-and-commas": 'entity A {\r\n  """\r\n  Windows line endings.\r\n  """\r\n  id: ID,\r\n  n: Int,\r\n}\r\nquery a: A\r\n',
  "block-string escapes and quoted keys": String.raw`
"""Holds \""" and more \"""" quotes"""
entity A {
  """Ends in a quote "x" """
  id: ID
  """one` + "\r\r\n" + String.raw`two \\""" three"""
  n: Int
}
query a(o: JSON = { "content-type": "text/plain", "a b": [1], plain: true }): A
`,

  // ---- syntax errors
  "error: unterminated block comment": "entity A { id: ID }\n/* never closed",
  "error: unterminated block string": 'entity A { id: ID }\n"""open',
  "error: unterminated string": 'scalar S @example("abc',
  "error: newline in string": 'scalar S @example("ab\ncd")',
  "error: bad unicode escape": String.raw`scalar S @example("\u12G4")`,
  "error: bad escape": String.raw`scalar S @example("\q")`,
  "error: escape at the end": 'scalar S @example("\\',
  "error: unexpected character": "entity A { id: ID } #",
  "error: unexpected emoji": "entity \u{1F600} { id: ID }",
  "error: control character": "entity A { id: ID }",
  "error: not a definition keyword": "thing A { id: ID }",
  "error: description with nothing after it": '"""dangling doc"""',
  "error: duplicate field": "entity A { id: ID id: ID }",
  "error: duplicate argument": "query q(a: Int, a: Int): Int",
  "error: duplicate enum value": "enum E { A B A }",
  "error: duplicate annotation": "entity A @cache(maxAge: 1s) @cache(maxAge: 2s) { id: ID }",
  "error: default on an entity field": "entity A { id: ID n: Int = 1 }",
  "error: type defined twice": "entity A { id: ID } object A { x: Int }",
  "error: built-in redefined": "scalar String",
  "error: view defined twice": "entity A { id: ID } view A.v = { id } view A.v = { id }",
  "error: operation defined twice": "query q: Int query q: Int",
  "error: inline error conflicts": "entity A { id: ID } command c: A throws E { x: Int } command d: A throws E { y: Int }",
  "error: inline error names a non-error": "entity X { id: ID } command c: X throws X { a: Int }",
  "error: end of input": "entity A {",
  "error: unknown function": "entity A @allow(read: magic(1)) { id: ID }",
  "error: empty expression": "entity A @allow(read: ) { id: ID }",
  "error: unexpected token in expression": "entity A @allow(read: ]) { id: ID }",
  "error: unknown shape directive": "entity A { id: ID } view A.v = { @skip { id } }",
  "error: defer with a bad argument": 'entity A { id: ID } view A.v = { @defer(when: "x") { id } }',
  "error: unknown field modifier": "entity A { id: ID } view A.v = { id @weird }",
  "error: shape nested too deep": `entity A { id: ID } view A.v = ${"{ a ".repeat(70)}${"}".repeat(70)}`,
  "error: shape argument nested too deep": `entity A { id: ID } view A.v = { a(x: ${"[".repeat(70)}1${"]".repeat(70)}) }`,
  "error: unexpected token in literal": "input I { x: Int = ) }",
  "error: not a literal": 'input I { x: String = """doc""" }',
  "error: unterminated shape": "entity A { id: ID } view A.v = { id",
  "error: number out of range": "query q(a: Float = 1e999): Float",
  "error: duration out of range": `entity A @cache(maxAge: ${"9".repeat(310)}d) { id: ID }`,

  // ---- validation findings
  "findings: generics, stream inputs, repeated members, error payloads": `
entity A { id: ID x: T }
input I { p: Page<Int> }
input Msg { text: String }
entity B { id: ID }
union U = A | B | A
object Detail { x: Int }
error E { d: Detail }
query a(i: I, p: Page<String>): A
query u: U
stream s1: Int @input(Nope)
stream s2: B @input(B)
stream s3: B @input(Msg)
command c: Int throws E
`,
  "findings: reserved argument and enum value names": `
enum E { __X Y }
entity A { id: ID n(__proto__: Int): Int }
query q(__proto__: String, e: E): A
`,
  "findings: types": `
entity NoId { name: String }
entity NullableId { id: ID? }
object O { x: Page }
object P { x: String<Int> }
input In { e: NoId }
input In2 { f(a: Int): Int }
error Err { x: NoId }
union U = String | Missing
entity Reserved { id: ID __secret: String }
entity __Hidden { id: ID }
object Uses { a: NoId b: NullableId c: O d: P e: U f: Reserved g: __Hidden }
query q(i: In, i2: In2): Uses throws Err
`,
  "findings: annotations": `
entity A @weird @lazy @cache(scope: global, maxAge: 5) { id: ID n: Int @load(parallel) v: String? @version s: String @page p: Int @partial q: Int @allow(read: true, bad: false) @acme.custom(x: 1) }
query a(id: ID): A? @allow(read: this.n == 1) @cache(scope: false)
query b: A @cache(maxAge: "soon")
`,
  "findings: interfaces": `
object Shape @interface { id: ID area: Float }
object Plain { id: ID }
entity Square implements Shape { id: ID side: Float }
entity Circle implements Plain Missing { id: ID }
query s: [Square]
query c: [Circle]
`,
  "findings: operations": `
entity A { id: ID }
error E { m: String }
event Ev { id: ID }
query subscribe: A
query A: A
query throwsEntity: A throws A
command emitsError: A emits E
query emitsOnQuery: A emits Ev
command unknownThrows: A throws Nope emits Nope2
command getCommand(id: ID): A @http(method: GET, path: "/a/{id}")
query noSlash(id: ID): A @http(method: GET, path: "a")
query missingParam: A @http(method: GET, path: "/a/{id}")
command badBody(id: ID): A @http(method: POST, path: "/a", body: nope)
query getBody(id: ID): A @http(method: GET, path: "/a/{id}", body: "*")
query paged: Page<A>
query pagedFirst(first: Int): Page<A>
stream s: Ev @http(method: GET, path: "/s")
query __hidden: A
`,
  "findings: http wire names": `
entity A { id: ID }
input I { a: Int @http(name: "x") b: Int @http(name: "x") c: Int @http(name: 3) d: Int @http(name: "b") }
entity B { id: ID n: Int @http(name: "n-1") m(x: Int @http(name: "x-1")): Int }
event E { n: Int @http(name: "n-2") }
query q1(n: Int @http): A
query q2(n: Int @http(name: "")): A
query q3(n: Int @http(name: "n-1", method: GET)): A
query q4(n: Int @http("n-1")): A
query q5(a: Int @http(name: "b"), b: Int): A
query q6(a: Int @http(name: "b"), b: Int @http(name: "a")): A
query q7(i: I, a: Int @http(name: "a"), c: Int @http(name: "c-1")): B
command c: A emits E
`,
  "findings: views": `
entity A { id: ID n: Int b: B? }
entity B { id: ID }
entity Lonely { id: ID }
enum E { X }
view Missing.v = { id }
view E.v = { id }
view A.v1 = { nope n { x } }
view A.v2 = { ...A.nope ...B.default }
view A.c1 = { ...A.c2 }
view A.c2 = { ...A.c1 }
view B.default = { id }
union U = A | B
view U.v = { ...on A { n } ...on Lonely { id } ...on Nope { id } }
view A.d = { @defer { n b { id nope } } }
query a: A
query u: U
`,
};

const schemaCases: Array<{ name: string; text: string }> = [];
const fixtureDir = fileURLToPath(new URL("../conformance/fixtures/core", import.meta.url));
for (const f of readdirSync(fixtureDir).sort()) schemaCases.push({ name: `fixture ${f}`, text: (JSON.parse(readFileSync(`${fixtureDir}/${f}`, "utf8")) as { schema: string }).schema });
schemaCases.push({ name: "bookstore", text: bookstoreSchemaText() }, { name: "openapi-custom", text: OPENAPI_CUSTOM }, { name: "items", text: ITEMS_SCHEMA }, { name: "mcp-range", text: MCP_RANGE }, { name: "openapi-wire", text: OPENAPI_WIRE });
for (const [name, text] of Object.entries(SCHEMA_CASES)) schemaCases.push({ name, text });

// Seeded mutations of the fixture schemas: whatever the TypeScript reader makes of each (an IR, diagnostics, a hash,
// or an error message), the Kotlin reader must make exactly the same. The seed is fixed, so the file changes only
// when a reader does.
{
  let seed = 0x2f6b1d3;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pieces = ["{", "}", "(", ")", "[", "]", ":", ",", "=", "?", "@", '"', "\\", "entity", "query", "command", "view", "...", "//", "/*", "1e999", "-", "$", "\u00e9", " ", "\n", ""];
  const fixtureTexts = schemaCases.filter((c) => c.name.startsWith("fixture ")).map((c) => c.text);
  for (let i = 0; i < 150; i++) {
    let t = fixtureTexts[Math.floor(random() * fixtureTexts.length)]!;
    for (let e = 0, n = 1 + Math.floor(random() * 3); e < n; e++) {
      const at = Math.floor(random() * (t.length + 1));
      t = t.slice(0, at) + pieces[Math.floor(random() * pieces.length)] + t.slice(at + Math.floor(random() * 8));
    }
    schemaCases.push({ name: `fuzz ${i}`, text: t });
  }
}

write(
  "schema-cases.json",
  schemaCases.map(({ name, text }) => {
    const c: Record<string, unknown> = { name, text };
    try {
      const ir = parseSchemaText(text);
      c["ir"] = ir;
      c["diagnostics"] = validateIR(ir);
      c["hash"] = schemaHash(ir);
      try {
        loadSchema(text);
      } catch (e) {
        c["loadError"] = (e as Error).message;
      }
    } catch (e) {
      c["error"] = (e as Error).message;
    }
    return c;
  }),
);
// IR the text parser cannot produce, as importers, the builder and lock files can: names that are not names, members
// named twice, an @input that is not a type. Both validators must find the same things in it.
{
  const irCase = (name: string, text: string, mutate: (ir: RayfoldSchemaIR) => void) => {
    const ir = parseSchemaText(text);
    mutate(ir);
    return { name, ir, diagnostics: validateIR(ir) };
  };
  type Fielded = { fields: Array<{ name: string; args: Array<{ name: string }> }> };
  write("schema-ir-cases.json", [
    irCase("names that are not names", `enum E { X } entity User { id: ID firstName: String } view User.card = { id } query user(sortBy: String, e: E): User`, (ir) => {
      (ir.types["User"] as unknown as Fielded).fields[1]!.name = "first-name";
      ir.ops["user"]!.args[0]!.name = "sort by";
      (ir.types["E"] as { values: Array<{ name: string }> }).values[0]!.name = "1st";
      ir.views["User.card"]!.name = "a.b";
      ir.types["Bad-Type"] = { kind: "scalar", name: "Bad-Type", annotations: [] };
      ir.ops["op-x"] = { kind: "query", name: "op-x", args: [], returns: { kind: "named", name: "Int", nullable: false }, throws: [], emits: [], annotations: [] };
    }),
    irCase("members named twice", `enum E { X Y } entity A { id: ID n(a: Int, b: Int): Int } query q(a: Int, b: Int): A`, (ir) => {
      (ir.types["E"] as { values: Array<{ name: string }> }).values[1]!.name = "X";
      (ir.types["A"] as unknown as Fielded).fields[1]!.args[1]!.name = "a";
      ir.ops["q"]!.args[1]!.name = "a";
      (ir.types["A"] as unknown as Fielded).fields[1]!.name = "id";
    }),
    irCase("an @input that is not a type", `input Msg { text: String } stream s: Int @input(Msg)`, (ir) => {
      ir.ops["s"]!.annotations[0]!.args["value"] = "Msg";
    }),
    irCase("a generic object of its own", `entity A { id: ID } query a: A`, (ir) => {
      ir.types["Box"] = { kind: "object", name: "Box", annotations: [], typeParams: ["V"], fields: [{ name: "v", type: { kind: "named", name: "V", nullable: false }, args: [], annotations: [], ordinal: 1 }, { name: "w", type: { kind: "named", name: "T", nullable: false }, args: [], annotations: [], ordinal: 2 }] };
      (ir.types["A"] as unknown as { fields: unknown[] }).fields.push({ name: "box", type: { kind: "named", name: "Box", nullable: false, args: [{ kind: "named", name: "Int", nullable: false }] }, args: [], annotations: [], ordinal: 2 });
    }),
  ]);
}

// ------------------------------------------------------------------ RB (RbTest.kt)
// Values the Kotlin codec must encode to exactly these bytes, and byte strings it must decode to exactly these values
// or refuse with exactly these messages. The corpus is seeded, so the file only changes when the codec does.

const rb = new RbCodec(bs.server.ir);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const nested = (n: number): unknown => (n === 0 ? 1 : [nested(n - 1)]);
const RB_VALUES: Record<string, unknown> = {
  "an envelope": { ops: [{ id: 1, op: "book", args: { id: "b1" }, shape: "{ id title author { name } }", compact: true }, { id: 2, op: "placeOrder", args: { input: { lines: [{ bookId: { $ref: "1.id" }, qty: 2 }] } }, key: "k-0123456789abcdef" }], meta: { client: "web", deadline: 5000 } },
  "a data frame": { id: 1, data: { $type: "Book", id: "b1", title: "The Dispossessed", price: "12.99", stock: 5, author: { $type: "Author", id: "a1", name: "Ursula K. Le Guin" } }, meta: { cost: 2 }, fin: true },
  "a command frame with patches": { id: 1, ok: { $type: "Order", id: "o1", status: "PLACED" }, patch: [{ set: "Order:o1", value: { $type: "Order", id: "o1" } }, { inv: "Book:b1" }, { invOp: ["books"] }], fin: true },
  "an error frame": { id: 3, error: { code: "domain", type: "OutOfStock", message: "Only 2 left", data: { bookId: "b1", available: 2 }, path: "items.0", retryable: false }, fin: true },
  "a page with repeated strings": { items: [{ $type: "Book", format: "EBOOK" }, { $type: "Book", format: "EBOOK" }, { $type: "Book", format: "PAPERBACK" }], total: 3, hasMore: false, cursor: null },
  "small, negative and large integers": [0, 1, 127, 128, 255, 16383, 16384, -1, -64, -65, -128, 2147483647, -2147483648, 4294967296, 9007199254740991, -9007199254740991],
  "non-integers and unsafe integers": [0.5, -0.25, 1.5, 3.14159, 123456789.125, 1e300, -1e-300, 5e-324, 9007199254740992, -9007199254740993, 1e21],
  "strings": ["", "a", "ascii text", "\u00e9t\u00e9", "\u65e5\u672c\u8a9e", "\u{1F600} emoji", "\ud800 lone surrogate", "tab\tnewline\n", "a".repeat(200)],
  "the same strings twice": ["repeat", "other", "repeat", "repeat", "other"],
  "keys outside the dictionary": { "not-a-schema-name": 1, "\u00e9": 2, __proto__x: 3, "": 4, "10": 5, "2": 6 },
  "booleans, null, empty containers": [true, false, null, {}, [], [[]], { a: {} }],
  "64 levels deep": nested(63),
};
const rbValues = Object.entries(RB_VALUES).map(([name, value]) => {
  const bytes = rb.encode(JSON.parse(JSON.stringify(value)));
  // what decoding gives back: the value itself, except that a lone surrogate comes back as U+FFFD
  return { name, json: JSON.stringify(value), hex: hex(bytes), decoded: JSON.stringify(rb.decode(bytes)) };
});

// decode results as JSON, or the error message; values holding bytes are marked, since JSON has no bytes
const decodeResult = (bytes: Uint8Array, frames = false): Record<string, unknown> => {
  try {
    let bytesSeen = false;
    const v = frames ? rb.decodeFrames(bytes) : rb.decode(bytes);
    const json = JSON.stringify(v, (_k, x: unknown) => {
      if (x instanceof Uint8Array) {
        bytesSeen = true;
        return Buffer.from(x).toString("base64url");
      }
      return x;
    });
    return bytesSeen ? { json, bytes: true } : { json };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

let seed = 0x5eed1234;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (n: number) => Math.floor(random() * n);
const HOSTILE: Record<string, number[]> = {
  "empty input": [],
  "an unknown tag": [0x0a],
  "a truncated double": [0x04, 1, 2, 3],
  "a varint that never ends": [0x03, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01],
  "a list claiming more items than bytes": [0x07, 0x05, 0x80],
  "an object claiming more pairs than bytes": [0x08, 0x7f, 0x00, 0x80],
  "a string reference before any string": [0x06, 0x00],
  "an unknown key id": [0x08, 0x01, 0xfe, 0x7f, 0x80],
  "trailing bytes": [0x80, 0x80],
  "65 levels deep": [...Array(65).fill([0x07, 0x01]).flat(), 0x80],
  "a string longer than the input": [0x05, 0x10, 0x61],
  "a lone continuation byte in a string": [0x05, 0x02, 0xc3, 0x28],
  "bytes": [0x09, 0x03, 0x01, 0x02, 0xff],
  "a double holding NaN": [0x04, 0, 0, 0, 0, 0, 0, 0xf8, 0x7f],
  "a double holding negative zero": [0x04, 0, 0, 0, 0, 0, 0, 0, 0x80],
  "an integer beyond 2^53": [0x03, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01],
};
const rbDecode = Object.entries(HOSTILE).map(([name, bytes]) => ({ name, hex: hex(Uint8Array.from(bytes)), ...decodeResult(Uint8Array.from(bytes)) }));
// mutations of valid encodings: one byte changed, cut short, or extended
const valid = rbValues.map((v) => Buffer.from(v.hex, "hex"));
for (let i = 0; i < 400; i++) {
  const base = Buffer.from(valid[int(valid.length)]!);
  const kind = int(4);
  let b: Buffer;
  if (kind === 0) {
    b = Buffer.from(base);
    b[int(b.length)] = int(256);
  } else if (kind === 1) b = base.subarray(0, int(base.length));
  else if (kind === 2) b = Buffer.concat([base, Buffer.from([int(256)])]);
  else b = Buffer.from(Array.from({ length: int(24) }, () => int(256)));
  rbDecode.push({ name: `fuzz ${i}`, hex: hex(b), ...decodeResult(b) });
}
const framed = rb.encodeFrames([RB_VALUES["a data frame"], { id: 1, fin: true }]);
const withKeepAlives = Buffer.concat([rb.encodeFrames([RB_VALUES["a data frame"]]), Uint8Array.of(0), rb.encodeFrames([{ id: 1, fin: true }]), Uint8Array.of(0)]);
const rbFrames = [
  { name: "two frames", hex: hex(framed), ...decodeResult(framed, true) },
  { name: "zero-length keep-alives between and after frames", hex: hex(withKeepAlives), ...decodeResult(withKeepAlives, true) },
  { name: "a truncated frame", hex: hex(framed.subarray(0, framed.length - 1)), ...decodeResult(framed.subarray(0, framed.length - 1), true) },
];
write("rb-cases.json", { keys: rb.dict.names, values: rbValues, decode: rbDecode, frames: rbFrames });

console.log("wrote oracles to", out);
