import { describe, expect, expectTypeOf, it } from "vitest";
import { command, defineSchema, entity, query, t, type Infer, type InferResult } from "./index.ts";
import { typedClient, type Select, type SelectResult, type ShapedClient } from "./select.ts";
import { createRayfoldServer } from "@rayfold/server";
import { RayfoldClient, createLocalTransport } from "@rayfold/client";

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

describe("a field selected with no sub-shape is typed as its default view", () => {
  const shop = defineSchema({
    types: [
      entity("Publisher", { id: t.id(), name: t.string() }),
      entity("Writer", {
        id: t.id(),
        name: t.string(),
        tags: t.string().list(),
        extra: t.json().nullable(),
        publisher: t.ref("Publisher"),
        novels: t.page("Novel").args({ page: t.pageArgs().withDefault({ first: 5 }) }),
      }),
      entity("Novel", { id: t.id(), title: t.string(), writer: t.ref("Writer") }),
    ],
    ops: { novel: query({ id: t.id() }, t.ref("Novel").nullable()), writer: query({ id: t.id() }, t.ref("Writer").nullable()) },
  });
  type NovelT = Infer<typeof shop, "Novel">;
  type WriterT = Infer<typeof shop, "Writer">;
  type Bare = Select<NovelT, "{ id writer }">;

  it("keeps the scalars, enums, lists of them and JSON, and leaves nested entities out, as the derived view does", () => {
    expectTypeOf<Bare["writer"]>().toEqualTypeOf<{ $type: "Writer"; id: string; name: string; tags: string[]; extra?: unknown }>();
    // @ts-expect-error the default view leaves the publisher out, so the server never sends it
    expectTypeOf<Bare["writer"]["publisher"]>().toBeObject();
  });

  it("guard - a sub-shape still reaches as deep as it asks", () => {
    expectTypeOf<Select<NovelT, "{ writer { publisher { name } } }">["writer"]["publisher"]>().toEqualTypeOf<{ $type: "Publisher"; name: string }>();
  });

  it("a bare page keeps its rows, each through its own default view", () => {
    type Novels = Select<WriterT, "{ novels }">["novels"];
    expectTypeOf<Novels["items"]>().toEqualTypeOf<Array<{ $type: "Novel"; id: string; title: string }>>();
    expectTypeOf<Novels["hasMore"]>().toBeBoolean();
  });

  it("the server sends exactly what the type says, for a bare entity and a bare page", async () => {
    const server = createRayfoldServer({
      schema: shop.ir,
      resolvers: {
        Query: {
          novel: () => ({ id: "n1", title: "Dune", writerId: "w1" }),
          writer: () => ({ id: "w1", name: "Frank", tags: ["sf"], extra: null, publisherId: "p1" }),
        },
        Novel: { writer: (parents: unknown[]) => parents.map(() => ({ id: "w1", name: "Frank", tags: ["sf"], extra: null, publisherId: "p1" })) },
        Writer: {
          publisher: (parents: unknown[]) => parents.map(() => ({ id: "p1", name: "Chilton" })),
          novels: (parents: unknown[]) => parents.map(() => ({ items: [{ id: "n1", title: "Dune", writerId: "w1" }], cursor: null, hasMore: false, total: 1 })),
        },
      },
    });
    const bare: Select<NovelT, "{ id writer }"> = { $type: "Novel", id: "n1", writer: { $type: "Writer", id: "w1", name: "Frank", tags: ["sf"], extra: null } };
    const paged: Select<WriterT, "{ novels }"> = { $type: "Writer", novels: { items: [{ $type: "Novel", id: "n1", title: "Dune" }], cursor: null, hasMore: false, total: 1 } };
    const frames = await server.collect({ ops: [{ id: 1, op: "novel", args: { id: "n1" }, shape: "{ id writer }" }, { id: 2, op: "writer", args: { id: "w1" }, shape: "{ novels }" }] });
    expect((frames as Array<{ id: number; data: unknown }>).sort((a, b) => a.id - b.id).map((f) => f.data)).toEqual([bare, paged]);
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

    const bare = await api.query("book", { id: "b1" });
    expectTypeOf(bare).toEqualTypeOf<{ $type: "Book"; id: string; title: string; stock: number; costPrice?: string | null } | null>();
    // @ts-expect-error with no shape the server sends the default view, which leaves the author out
    void bare?.author;

    const page = await api.query("books", { page: { first: 20 } });
    expectTypeOf(page.items).toEqualTypeOf<Array<{ $type: "Book"; id: string; title: string; stock: number; costPrice?: string | null }>>();

    const restocked = await api.command("restock", { bookId: "b1", qty: 1 });
    expectTypeOf(restocked).toEqualTypeOf<{ $type: "Book"; id: string; title: string; stock: number; costPrice?: string | null }>();

    // @ts-expect-error restock takes bookId and qty
    await api.command("restock", { bookId: "b1" });

    // @ts-expect-error there is no such operation
    await api.query("nonsense", {});
  });

  it("with no shape, the typed value is what a real server sends: the default view, for an entity, a page and a command", async () => {
    const book = { id: "b1", title: "Dune", stock: 3, costPrice: "4.50", authorId: "a1" };
    const server = createRayfoldServer({
      schema: schema.ir,
      resolvers: {
        Query: {
          book: () => ({ ...book }),
          books: () => ({ items: [{ ...book }], cursor: null, hasMore: false, total: 1 }),
        },
        Command: { restock: ({ qty }: { qty: number }) => ({ ...book, stock: book.stock + qty }) },
        Book: { author: (parents: unknown[]) => parents.map(() => ({ id: "a1", name: "Frank", bio: null })) },
      },
    });
    const api = typedClient<typeof schema>(new RayfoldClient({ transport: createLocalTransport(server, () => ({ id: "u1" })) }));
    const view = { $type: "Book", id: "b1", title: "Dune", stock: 3, costPrice: "4.50" } as const;

    const one: { $type: "Book"; id: string; title: string; stock: number; costPrice?: string | null } | null = await api.query("book", { id: "b1" });
    expect(one).toEqual(view);
    const page = await api.query("books", { page: { first: 20 } });
    expect(page).toEqual({ items: [view], hasMore: false, cursor: null, total: 1 });
    expect(await api.command("restock", { bookId: "b1", qty: 2 }, { key: "restock-typed-01" })).toEqual({ ...view, stock: 5 });
  });

  it("guard - with a shape, the typed value reaches the nested author the server sends", async () => {
    const server = createRayfoldServer({
      schema: schema.ir,
      resolvers: {
        Query: { book: () => ({ id: "b1", title: "Dune", stock: 3, costPrice: null, authorId: "a1" }) },
        Book: { author: (parents: unknown[]) => parents.map(() => ({ id: "a1", name: "Frank", bio: null })) },
      },
    });
    const api = typedClient<typeof schema>(new RayfoldClient({ transport: createLocalTransport(server, () => ({ id: "u1" })) }));
    const book = await api.query("book", { id: "b1" }, { shape: "{ id author { name } }" });
    expect(book?.author.name).toBe("Frank");
    expect(book).toEqual({ $type: "Book", id: "b1", author: { $type: "Author", name: "Frank" } });
  });
});
