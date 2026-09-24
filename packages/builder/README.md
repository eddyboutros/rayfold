# @rayfold/builder

Write a Rayfold schema in TypeScript instead of a `.rayfold` file. It produces the same IR, and the TypeScript
types come from the definitions, so there is no code generation step.

```sh
npm install @rayfold/builder
```

```ts
import { defineSchema, entity, query, command, t, type Infer, type InferArgs } from "@rayfold/builder";

const Book = entity("Book", {
  id: t.id(),
  title: t.string(),
  stock: t.int(),
  price: t.decimal().unit("USD"),
});

export const schema = defineSchema({
  types: [Book],
  ops: {
    book: query({ id: t.id() }, t.ref("Book").nullable()),
    restock: command({ id: t.id(), qty: t.int().range(1, 100) }, t.ref("Book")),
  },
});

type BookT = Infer<typeof schema, "Book">;        // { $type: "Book"; id: string; title: string; stock: number; price: string }
type RestockArgs = InferArgs<typeof schema, "restock">; // { id: string; qty: number }

// Hand `schema.ir` to createRayfoldServer({ schema: schema.ir, resolvers }) from @rayfold/server.
```

Interfaces, `implements` and field arguments are written as the text writes them:

```ts
const Node = object("Node", { id: t.id() }).annotate("interface");      // object Node @interface { id: ID }
const Author = entity("Author", {
  id: t.id(),
  books: t.page("Book").args({ page: t.pageArgs().withDefault({ first: 10 }) }), // books(page: PageArgs = { first: 10 }): Page<Book>
}).implements("Node");                                                    // entity Author implements Node
```

## Types from the shape

A shape is a string at the call site, so the types can follow it:

```ts
import { typedClient, type Select } from "@rayfold/builder";

type Card = Select<BookT, "{ id title }">;   // { $type: "Book"; id: string; title: string }

const api = typedClient<typeof schema>(client);   // any Rayfold client
const book = await api.query("book", { id: "b1" }, { shape: "{ id title }" });
book?.title;   // string
book?.stock;   // a type error: the shape did not ask for it
```

A call with no shape is typed as the result's default view (scalar fields, no nested entities), which is what the
server sends. Lists, pages and nulls are followed through, and a shape that spreads a named view falls back to the whole type,
since the view's text lives in the schema rather than in the call. The
[TypeScript guide](../../docs/guide/typescript.md) has the rest.

Apache-2.0.
