import { describe, expect, expectTypeOf, it } from "vitest";
import { loadSchema, schemaHash } from "@rayfold/schema";
import { createRayfoldServer } from "@rayfold/server";
import { command, defineSchema, entity, enumType, error, event, input, query, t, type Infer, type InferArgs, type InferResult } from "./index.ts";

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

const schema = defineSchema({
  types: [Format, Author, Book, BookFilter, OutOfStock, StockChanged],
  ops: {
    books: query({ filter: t.ref("BookFilter").nullable(), page: t.pageArgs().withDefault({ first: 20 }) }, t.page("Book")).cost(5, 1).doc("List books."),
    book: query({ id: t.id() }, t.ref("Book").nullable()),
    restock: command({ bookId: t.id(), qty: t.int() }, t.ref("Book")).throws("OutOfStock").emits("StockChanged").allow('viewer.role == "admin"'),
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
      view Book.default = { id title format price stock author { id name } }
      """List books."""
      query books(filter: BookFilter?, page: PageArgs = { first: 20 }): Page<Book> @cost(base: 5, perItem: 1)
      query book(id: ID): Book?
      command restock(bookId: ID, qty: Int): Book throws OutOfStock emits StockChanged @allow(write: viewer.role == "admin")
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
});
