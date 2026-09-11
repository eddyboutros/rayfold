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

Apache-2.0.
