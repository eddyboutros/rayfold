# @rayfold/postgres

Postgres for [Rayfold](https://github.com/eddyboutros/rayfold) resolvers: batch loads by id, keyset pages, one query
per level of a nested shape, and read policies pushed into the SQL `WHERE`, so a list never fetches rows its viewer
may not see.

```sh
npm install @rayfold/postgres pg
```

```ts
import pg from "pg";
import { createRayfoldServer } from "@rayfold/server";
import { createPgStore } from "@rayfold/postgres";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const schema = `
  entity Author { id: ID name: String books(page: PageArgs = { first: 10 }): Page<Book> }
  entity Book { id: ID title: String author: Author }
  entity Order @allow(read: viewer.id == customerId) { id: ID customerId: ID total: Decimal }
  query books(page: PageArgs = { first: 20 }): Page<Book>
  query myOrders: [Order]
`;
const server = createRayfoldServer({ schema, resolvers: {} }); // for its IR; see below
const store = createPgStore(db, {
  ir: server.ir,
  naming: "snake", // authorId -> author_id
  tables: { Author: { table: "authors" }, Book: { table: "books", columns: { authorId: "author_id" } }, Order: { table: "orders" } },
});

export const resolvers = {
  Query: {
    books: (args, ctx) => store.page("Book", args.page, {}, ctx),
    myOrders: (_args, ctx) => store.find("Order", {}, ctx), // the policy becomes WHERE customer_id = $viewer
  },
  Book: { author: (books, _args, ctx) => store.byIds("Author", books.map((b) => b.authorId), ctx) },
  Author: { books: (authors, args, ctx) => store.pagesByField("Book", "authorId", authors.map((a) => a.id), args.page, ctx) },
};
```

Any client with `query(text, params)` works: `pg.Pool`, `pg.Client`, [PGlite](https://pglite.dev), or your own
wrapper (for logging or transactions).

## What each call does

| Call | SQL | Use it for |
|---|---|---|
| `byIds(type, ids, ctx)` | one `SELECT ... WHERE id = ANY($1)` | a to-one field's batch loader; returns rows in the order asked, `null` for a missing or hidden row |
| `find(type, where, ctx)` | one `SELECT ... WHERE field = $n ... ORDER BY id` | a short list |
| `page(type, { first, after }, where, ctx)` | one query with `count(*) OVER ()` | a `Page<T>` in key order: `items`, `cursor`, `hasMore`, `total` |
| `pagesByField(type, field, parents, { first, after }, ctx)` | one query with window functions | a paged one-to-many field for a whole level of parents at once |

## Read policies in SQL

When a resolver loads an entity whose read policy is pushable (it reads only the viewer, the arguments, literals and
the row's own scalar fields; spec 06 §4), the runtime hands it to the resolver as `ctx.policy.filter`. Pass `ctx` to the
store and the policy becomes part of the `WHERE` clause: a customer's list query reads only their rows, and a page's
`total` counts only what they may see.

The translation never drops a row the policy allows. Where SQL cannot match the runtime exactly (ordering text,
comparing values of different types, `Decimal` inequality) it lets the row through and the runtime's own check, which
always runs, removes it. Without the pushdown, a list that returns rows the viewer may not see is refused as a whole
(spec 06 §3); with it, the list holds exactly the permitted rows.

## License

Apache-2.0
