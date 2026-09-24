import { describe, expect, expectTypeOf, it } from "vitest";
import { loadSchema, schemaHash } from "@rayfold/schema";
import { createRayfoldServer } from "@rayfold/server";
import { command, defineSchema, entity, enumType, error, event, input, object, query, scalar, stream, t, union, type Infer, type InferArgs, type InferResult } from "./index.ts";

const Format = enumType("Format", ["HARDCOVER", "PAPERBACK", "EBOOK"] as const);
const Author = entity("Author", { id: t.id(), name: t.string(), bio: t.string().nullable().lazy() }).cache(300_000, "public");
const Book = entity("Book", {
  id: t.id(),
  title: t.string(),
  format: t.ref("Format"),
  price: t.decimal().unit("USD").doc("Unit price in the store currency."),
  stock: t.int(),
  author: t.ref("Author"),
  costPrice: t.decimal().nullable().allow('viewer.role == "admin" || viewer.id == ownerId'),
  ownerId: t.id(),
})
  .cache(60_000, "public")
  .view("default", "{ id title format price stock author { id name } }");
const BookFilter = input("BookFilter", { titleContains: t.string().nullable(), format: t.ref("Format").nullable() });
const OutOfStock = error("OutOfStock", { bookId: t.id(), available: t.int() });
const StockChanged = event("StockChanged", { bookId: t.id(), stock: t.int() });
const Url = scalar("Url");
const Dimensions = object("Dimensions", { width: t.int(), height: t.int() });
const Review = entity("Review", { id: t.id(), authorId: t.id(), link: t.ref("Url").nullable(), dims: t.ref("Dimensions").nullable() })
  .allow("viewer != null", "viewer.id == authorId")
  .cache(30_000, "private", 10_000);
const SearchHit = union("SearchHit", ["Book", "Author"] as const);
const ReviewInput = input("ReviewInput", { rating: t.int().withDefault(5), body: t.string().nullable() });

const schema = defineSchema({
  types: [Format, Author, Book, BookFilter, OutOfStock, StockChanged, Url, Dimensions, Review, SearchHit, ReviewInput],
  ops: {
    books: query({ filter: t.ref("BookFilter").nullable(), page: t.pageArgs().withDefault({ first: 20 }) }, t.page("Book")).cost(5, 1).doc("List books."),
    book: query({ id: t.id() }, t.ref("Book").nullable()),
    restock: command({ bookId: t.id(), qty: t.int() }, t.ref("Book")).throws("OutOfStock").emits("StockChanged").allow('viewer.role == "admin"'),
    search: query({ q: t.string() }, t.ref("SearchHit").list()).cache(10_000, "private"),
    review: command({ input: t.ref("ReviewInput") }, t.ref("Review")),
    stockUpdates: stream({ bookIds: t.id().list() }, t.ref("StockChanged")),
  },
});

type BookT = Infer<typeof schema, "Book">;
type AuthorT = Infer<typeof schema, "Author">;
type FormatT = Infer<typeof schema, "Format">;

describe("code-first builder", () => {
  it("produces the same IR as the equivalent .rayfold text", () => {
    const text = `
      enum Format { HARDCOVER PAPERBACK EBOOK }
      entity Author @cache(maxAge: 5m, scope: public) { id: ID name: String bio: String? @lazy }
      entity Book @cache(maxAge: 60s, scope: public) {
        id: ID
        title: String
        format: Format
        """Unit price in the store currency."""
        price: Decimal @unit("USD")
        stock: Int
        author: Author
        costPrice: Decimal? @allow(read: viewer.role == "admin" || viewer.id == ownerId)
        ownerId: ID
      }
      input BookFilter { titleContains: String? format: Format? }
      error OutOfStock { bookId: ID available: Int }
      event StockChanged { bookId: ID stock: Int }
      scalar Url
      object Dimensions { width: Int height: Int }
      entity Review @allow(read: viewer != null, write: viewer.id == authorId) @cache(maxAge: 30s, scope: private, swr: 10s) {
        id: ID
        authorId: ID
        link: Url?
        dims: Dimensions?
      }
      union SearchHit = Book | Author
      input ReviewInput { rating: Int = 5 body: String? }
      view Book.default = { id title format price stock author { id name } }
      """List books."""
      query books(filter: BookFilter?, page: PageArgs = { first: 20 }): Page<Book> @cost(base: 5, perItem: 1)
      query book(id: ID): Book?
      command restock(bookId: ID, qty: Int): Book throws OutOfStock emits StockChanged @allow(write: viewer.role == "admin")
      query search(q: String): [SearchHit] @cache(maxAge: 10s, scope: private)
      command review(input: ReviewInput): Review
      stream stockUpdates(bookIds: [ID]): StockChanged
    `;
    const parsed = loadSchema(text);
    expect(schemaHash(schema.ir)).toBe(parsed.hash);
  });

  it("infers TypeScript types without codegen", () => {
    expectTypeOf<BookT>().toMatchTypeOf<{ $type: "Book"; id: string; title: string; format: "HARDCOVER" | "PAPERBACK" | "EBOOK"; price: string; stock: number; ownerId: string }>();
    expectTypeOf<BookT["author"]>().toMatchTypeOf<{ $type: "Author"; id: string; name: string }>();
    expectTypeOf<BookT["costPrice"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<AuthorT["bio"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<FormatT>().toEqualTypeOf<"HARDCOVER" | "PAPERBACK" | "EBOOK">();
    expectTypeOf<InferArgs<typeof schema, "restock">>().toEqualTypeOf<{ bookId: string; qty: number }>();
    expectTypeOf<InferResult<typeof schema, "books">["items"][number]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<InferResult<typeof schema, "book">>().toMatchTypeOf<{ $type: "Book" } | null>();
  });

  it("the built schema runs on the server", async () => {
    const server = createRayfoldServer({
      schema: schema.ir,
      resolvers: {
        Query: { book: (a: { id: string }) => (a.id === "b1" ? { id: "b1", title: "T", format: "EBOOK", price: "1.00", stock: 1, authorId: "a1", ownerId: "u1" } : null) },
        Book: { author: (parents: unknown[]) => parents.map(() => ({ id: "a1", name: "Ann" })) },
      },
    });
    expect(await server.collect({ ops: [{ id: 1, op: "book", args: { id: "b1" } }] })).toEqual([
      { id: 1, data: { $type: "Book", id: "b1", title: "T", format: "EBOOK", price: "1.00", stock: 1, author: { $type: "Author", id: "a1", name: "Ann" } }, meta: { cost: 2 }, fin: true },
    ]);
  });

  it("rejects invalid schemas at definition time", () => {
    expect(() => defineSchema({ types: [entity("A", { name: t.string() })], ops: {} })).toThrow(/must declare id/);
    expect(() => defineSchema({ types: [entity("A", { id: t.id(), b: t.ref("Nope") })], ops: {} })).toThrow(/Unknown type Nope/);
  });

  it("rejects a type defined twice or shadowing a built-in; distinct names pass (guard)", () => {
    expect(() => defineSchema({ types: [entity("A", { id: t.id() }), object("A", { n: t.int() })], ops: {} })).toThrow(/^Type A defined twice \(or shadows a built-in\)$/);
    expect(() => defineSchema({ types: [scalar("String")], ops: {} })).toThrow(/^Type String defined twice \(or shadows a built-in\)$/);
    expect(Object.keys(defineSchema({ types: [entity("A", { id: t.id() }), object("B", { n: t.int() })], ops: {} }).types)).toEqual(["A", "B"]);
  });

  it("an @interface object is an interface, with the hash of the same schema written as text", () => {
    const built = defineSchema({
      types: [object("Named", { name: t.string() }).annotate("interface"), object("Plain", { name: t.string() }).annotate("deprecated")],
      ops: { named: query({}, t.ref("Named")), plain: query({}, t.ref("Plain")) },
    });
    const text = loadSchema(`object Named @interface { name: String } object Plain @deprecated { name: String } query named: Named query plain: Plain`);
    expect(built.ir.types["Named"]).toMatchObject({ interface: true });
    // guard: another annotation does not make an object an interface
    expect(built.ir.types["Plain"]).not.toHaveProperty("interface");
    expect(schemaHash(built.ir)).toBe(text.hash);
  });

  it("declares implements and field arguments, with the IR and hash of the same schema written as text", () => {
    const built = defineSchema({
      types: [
        object("Node", { id: t.id() }).annotate("interface"),
        object("Priced", { price: t.decimal() }).annotate("interface"),
        entity("Author", {
          id: t.id(),
          name: t.string(),
          books: t.page("Book").args({ page: t.pageArgs().withDefault({ first: 10 }), format: t.string().nullable().doc("Only this format.") }),
          initials: t.string().args({ dots: t.boolean().withDefault(true) }),
        }).implements("Node"),
        entity("Book", { id: t.id(), title: t.string(), price: t.decimal() }).implements("Node", "Priced"),
      ],
      ops: { author: query({ id: t.id() }, t.ref("Author").nullable()), nodes: query({}, t.ref("Node").list()) },
    });
    const text = loadSchema(`
      object Node @interface { id: ID }
      object Priced @interface { price: Decimal }
      entity Author implements Node {
        id: ID
        name: String
        books(page: PageArgs = { first: 10 }, """Only this format.""" format: String?): Page<Book>
        initials(dots: Boolean = true): String
      }
      entity Book implements Node Priced { id: ID title: String price: Decimal }
      query author(id: ID): Author?
      query nodes: [Node]
    `);
    expect(built.ir).toEqual(text.ir);
    expect(schemaHash(built.ir)).toBe(text.hash);
    expect(built.ir.types["Book"]).toMatchObject({ implements: ["Node", "Priced"] });
    expect((built.ir.types["Author"] as { fields: Array<{ name: string; args: unknown[] }> }).fields.find((f) => f.name === "books")?.args).toHaveLength(2);
  });

  it("guard - a paged field without arguments still fails page-args, and only an entity implements an interface", () => {
    expect(() => defineSchema({ types: [entity("A", { id: t.id(), books: t.page("B") }), entity("B", { id: t.id() })], ops: {} })).toThrow(/page-args|must accept page: PageArgs/);
    expect(() => object("O", { id: t.id() }).implements("Node")).toThrow("O: only an entity implements an interface, and this is kind object");
  });

  it("a name no schema file could hold is refused at definition time (guard - a name is accepted)", () => {
    expect(() => defineSchema({ types: [entity("A", { id: t.id(), "first-name": t.string() })], ops: {} })).toThrow(/A\.first-name: Field name "first-name" is not a name/);
    expect(() => defineSchema({ types: [entity("A", { id: t.id(), first_name: t.string() })], ops: {} })).not.toThrow();
  });
});
