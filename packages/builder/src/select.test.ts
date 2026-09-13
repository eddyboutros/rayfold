import { describe, expect, expectTypeOf, it } from "vitest";
import { command, defineSchema, entity, query, t, type Infer, type InferResult } from "./index.ts";
import { typedClient, type Select, type SelectResult, type ShapedClient } from "./select.ts";

const Author = entity("Author", { id: t.id(), name: t.string(), bio: t.string().nullable() });
const Book = entity("Book", {
  id: t.id(),
  title: t.string(),
  stock: t.int(),
  costPrice: t.decimal().nullable(),
  author: t.ref("Author"),
});

const schema = defineSchema({
  types: [Author, Book],
  ops: {
    books: query({ page: t.pageArgs().withDefault({ first: 20 }) }, t.page("Book")),
    book: query({ id: t.id() }, t.ref("Book").nullable()),
    restock: command({ bookId: t.id(), qty: t.int() }, t.ref("Book")),
  },
});

type BookT = Infer<typeof schema, "Book">;

describe("a shape narrows the result type", () => {
  it("keeps what was asked for, and the entity's own marker", () => {
    expectTypeOf<Select<BookT, "{ id title }">>().toEqualTypeOf<{ $type: "Book"; id: string; title: string }>();
  });

  it("reads a nested shape, through a reference", () => {
    type Selected = Select<BookT, "{ id author { name } }">;
    expectTypeOf<Selected["author"]>().toEqualTypeOf<{ $type: "Author"; name: string }>();
    // @ts-expect-error the shape did not ask for the author's id
    expectTypeOf<Selected["author"]["id"]>().toBeString();
  });

  it("renames a field to its alias", () => {
    expectTypeOf<Select<BookT, "{ heading: title }">>().toEqualTypeOf<{ $type: "Book"; heading: string }>();
  });

  it("ignores arguments and delivery modifiers, which do not change the type", () => {
    expectTypeOf<Select<BookT, "{ id title @partial author(first: 2) { name } }">>().toEqualTypeOf<{
      $type: "Book";
      id: string;
      title: string;
      author: { $type: "Author"; name: string };
    }>();
  });

  it("keeps a field optional when the schema says it may be missing", () => {
    expectTypeOf<Select<BookT, "{ costPrice }">["costPrice"]>().toEqualTypeOf<string | null | undefined>();
  });

  it("makes a deferred field optional: it need not be in the first frame", () => {
    type Deferred = Select<BookT, '{ id @defer(label: "later") { stock } }'>;
    expectTypeOf<Deferred>().toEqualTypeOf<{ $type: "Book"; id: string; stock?: number }>();
  });

  it("applies through a list and through a page, and keeps null where null is possible", () => {
    expectTypeOf<Select<BookT[], "{ id }">>().toEqualTypeOf<Array<{ $type: "Book"; id: string }>>();

    type Page = Select<InferResult<typeof schema, "books">, "{ items { title } hasMore }">;
    expectTypeOf<Page["items"]>().toEqualTypeOf<Array<{ $type: "Book"; title: string }>>();
    expectTypeOf<Page["hasMore"]>().toBeBoolean();

    expectTypeOf<SelectResult<typeof schema, "book", "{ id }">>().toEqualTypeOf<{ $type: "Book"; id: string } | null>();
  });

  it("falls back to the whole type when the shape spreads a named view", () => {
    // the view's text lives in the schema, not in the call: wider than the truth, never narrower
    expectTypeOf<Select<BookT, "{ ...Book.default id }">>().toEqualTypeOf<BookT>();
  });

  it("merges a type-condition spread as fields that may or may not be there", () => {
    type Selected = Select<BookT, "{ id ...on Book { stock } }">;
    expectTypeOf<Selected>().toEqualTypeOf<{ $type: "Book"; id: string; stock?: number }>();
  });

  it("says nothing it does not know: a field the schema has not got is unknown, not an error", () => {
    expectTypeOf<Select<BookT, "{ id nope }">["nope"]>().toBeUnknown();
  });
});

describe("a client typed by the schema", () => {
  /** A client that records what it was asked, standing in for the real one. */
  function recorder(): { client: ShapedClient; calls: Array<{ method: string; op: string; args: unknown; options: unknown }> } {
    const calls: Array<{ method: string; op: string; args: unknown; options: unknown }> = [];
    const answer = { $type: "Book", id: "b1", title: "Dune" };
    return {
      calls,
      client: {
        query: async (op, args, options) => {
          calls.push({ method: "query", op, args, options });
          return answer as never;
        },
        command: async (op, args, options) => {
          calls.push({ method: "command", op, args, options });
          return answer as never;
        },
      },
    };
  }

  it("passes the call through, shape and all", async () => {
    const { client, calls } = recorder();
    const api = typedClient<typeof schema>(client);

    const book = await api.query("book", { id: "b1" }, { shape: "{ id title }" });
    expect(calls).toEqual([{ method: "query", op: "book", args: { id: "b1" }, options: { shape: "{ id title }" } }]);
    expect(book?.title).toBe("Dune");

    await api.command("restock", { bookId: "b1", qty: 2 }, { key: "restock-0001" });
    expect(calls[1]).toEqual({ method: "command", op: "restock", args: { bookId: "b1", qty: 2 }, options: { key: "restock-0001" } });
  });

  it("types the result from the shape, and the arguments from the schema", async () => {
    const { client } = recorder();
    const api = typedClient<typeof schema>(client);

    const book = await api.query("book", { id: "b1" }, { shape: "{ id title author { name } }" });
    expectTypeOf(book).toEqualTypeOf<{ $type: "Book"; id: string; title: string; author: { $type: "Author"; name: string } } | null>();

    const whole = await api.query("book", { id: "b1" });
    expectTypeOf(whole).toEqualTypeOf<InferResult<typeof schema, "book">>();

    // @ts-expect-error restock takes bookId and qty
    await api.command("restock", { bookId: "b1" });

    // @ts-expect-error there is no such operation
    await api.query("nonsense", {});
  });
});
