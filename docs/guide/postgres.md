# Postgres

`@rayfold/postgres` turns a Postgres table into Rayfold resolvers that behave the way the protocol wants: batch loads,
one SQL query per nesting level, keyset pages, and read policies pushed into the `WHERE` clause.

```sh
npm install @rayfold/postgres pg
```

```ts
import pg from "pg";
import { createPgStore } from "@rayfold/postgres";

const store = createPgStore(new pg.Pool(), {
  ir: server.ir,
  naming: "snake",
  tables: { Book: { table: "books", columns: { authorId: "author_id" } }, Author: { table: "authors" }, Order: { table: "orders" } },
});

const resolvers = {
  Query: {
    books: (args, ctx) => store.page("Book", args.page, {}, ctx),
    myOrders: (_args, ctx) => store.find("Order", {}, ctx),
  },
  Book: { author: (books, _args, ctx) => store.byIds("Author", books.map((b) => b.authorId), ctx) },
  Author: { books: (authors, args, ctx) => store.pagesByField("Book", "authorId", authors.map((a) => a.id), args.page, ctx) },
};
```

## Why pass `ctx`

When a resolver loads an entity whose read policy can run in SQL (it reads only the viewer, the arguments, literals and
the row's own fields), the runtime hands the policy to the resolver as `ctx.policy.filter`
([spec 06 §4](../../spec/06-auth.md)). The store turns it into part of the query: `@allow(read: viewer.id == customerId)`
becomes `customer_id = $viewer`. A customer's list then holds exactly their rows and a page's `total` counts only what
they may see.

Without it, the runtime still checks every row, but a list that contains a row the viewer may not see is refused as a
whole ([spec 06 §3](../../spec/06-auth.md)), and the database reads rows nobody can use.

The translation never drops a row the policy allows. Where SQL cannot match the runtime exactly (ordering text,
comparisons across types, `Decimal` inequality) it lets the row through and the runtime's check removes it. A property
test runs every translation against a real Postgres for many policies, viewers and rows to hold it to that.

The [package README](../../packages/postgres/README.md) lists every call and the SQL it sends.

On the JVM, the same pushdown hint is not wired yet: resolvers get no `ctx.policy`, and the runtime's own check does the
filtering.
