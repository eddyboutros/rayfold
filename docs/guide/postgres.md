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

## One statement for a whole screen

The resolvers above send one query per nesting level, which is already the shape of the problem GraphQL solves with
DataLoader. `store.screen()` goes further: it compiles the shape the op asked for into a **single** statement, gathering
related rows with correlated JSON subqueries, pushing each level's read policy into its own `WHERE`, and giving every
nested page its own `total`. Depth costs no extra round trip to the database.

Declare the relations a shape may follow, then hand the store the shape the runtime gives the resolver as `ctx.shape`:

```ts
const store = createPgStore(new pg.Pool(), {
  ir: server.ir,
  naming: "snake",
  tables: {
    Book: { table: "books", columns: { authorId: "author_id" }, relations: { author: { type: "Author", kind: "one", key: "authorId" } } },
    Author: { table: "authors", relations: { books: { type: "Book", kind: "page", key: "authorId" } } },
  },
});

const resolvers = {
  Query: { books: (args, ctx) => store.screen("Book", ctx.shape, args.page, {}, ctx) },
};
```

`kind: "one"` names the field on *this* type holding the other row's key; `kind: "page"` names the field on the *other*
type holding this row's key. Nested pages are first pages, which is what a screen shows; the root page still takes a
cursor. A field the shape selects must be a mapped column or a declared relation, so a shape that reaches past the
mapping is refused rather than quietly served wrong. For the same reason a field selected twice under two aliases must
be selected the same way both times.

A relation that takes arguments, such as `Author.books(page:)`, needs no loader here: the runtime serves the page
`screen` already gathered. `checkWiring` cannot see that from the resolvers alone and still reports it as
`missing-loader`, so filter that finding for the fields your screens gather.

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

On the JVM the hint reaches resolvers the same way, as `ctx.policy`: the pushable part of the type's read policy, or
null when nothing can be pushed. The rule for what is pushable is the same in both runtimes, and both are held to it by
tests. [`dev.rayfold:rayfold-jdbc`](jdbc.md) is the JVM counterpart of this package and uses that hint the same way.
