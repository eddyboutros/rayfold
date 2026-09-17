# TypeScript types

A schema written with the builder needs no code generation step. The schema is a value, and every type a caller
needs is read from it - the entities, the arguments of an operation, what it returns, and, because a shape is a
string at the call site, exactly the fields a shape asks for. (`rayfold gen ts` exists for a schema written as text;
see [the quickstart](quickstart.md).)

## From the schema

```ts
import { defineSchema, entity, query, t, type Infer, type InferArgs, type InferResult } from "@rayfold/builder";

const Author = entity("Author", { id: t.id(), name: t.string() });
const Book = entity("Book", { id: t.id(), title: t.string(), stock: t.int(), author: t.ref("Author") });
const schema = defineSchema({ types: [Author, Book], ops: { book: query({ id: t.id() }, t.ref("Book").nullable()) } });

type Book = Infer<typeof schema, "Book">;              // { $type: "Book"; id: string; title: string; ... }
type Args = InferArgs<typeof schema, "book">;          // { id: string }
type Result = InferResult<typeof schema, "book">;      // Book | null
```

## From the shape

A shape says which fields come back, so it should say which fields the type has. `Select` reads the shape text itself:

```ts
import { type Select } from "@rayfold/builder";

type Card = Select<Book, "{ id title author { name } }">;
// { $type: "Book"; id: string; title: string; author: { $type: "Author"; name: string } }
```

`typedClient` puts that on a client: operation names, their arguments, and a result narrowed to the shape.

```ts
import { typedClient } from "@rayfold/builder";

const api = typedClient<typeof schema>(client);

const book = await api.query("book", { id: "b1" }, { shape: "{ id title author { name } }" });
book?.author.name;   // string
book?.stock;         // a type error: the shape did not ask for it
```

It is the same client underneath, so caching, patches, live queries and everything else are unchanged; only the types
are sharper. Lists and pages are followed through (`{ items { title } hasMore }` narrows the items), nulls are kept,
and a field the schema does not have is `unknown` rather than an error.

## What the types say about delivery

| In the shape | In the type |
| --- | --- |
| `alias: field` | the field under its alias |
| `field(first: 2)` | arguments do not change the type, so they are ignored |
| `@partial`, `@eager` | how a field is delivered, not what it is: ignored |
| `@defer { ... }` | optional, because those fields need not be in the first frame |
| `...on Type { ... }` | optional, because the member may not be the one that came back |
| `...Book.card` | the view's text lives in the schema, not in the call, so the whole type stands |

That last row is the one limit: a shape that spreads a named view types as the full entity. It is wider than the
truth, never narrower, so nothing a caller reads is a lie.

## In React

The hooks take the result type as a parameter, so a shape narrows there too:

```ts
import { type Infer, type Select } from "@rayfold/builder";
import { useQuery } from "@rayfold/react";

type Book = Infer<typeof schema, "Book">;
const { data } = useQuery<Select<Book, "{ id title }">>("book", { id }, { shape: "{ id title }" });
```

Write the shape once and pass it to both, and the two cannot drift:

```ts
const CARD = "{ id title author { name } }";
const { data } = useQuery<Select<Book, typeof CARD>>("book", { id }, { shape: CARD });
```
