# @rayfold/postgres

Postgres for [Rayfold](https://github.com/eddyboutros/rayfold) resolvers: batch loads by id, keyset pages, one query
per level of a nested shape, and read policies pushed into the SQL `WHERE`, so a list never fetches rows its viewer
may not see.

```sh
npm install @rayfold/postgres pg
```

```ts
import pg from "pg";
import { createRayfoldServer, listen } from "@rayfold/server";
import { createPgStore } from "@rayfold/postgres";

const connectionString = process.env.DATABASE_URL;
const db = new pg.Pool({ connectionString });
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
  tables: {
    // `relations` is what `screen` follows; the batch loaders below do not need it
    Author: { table: "authors", relations: { books: { type: "Book", kind: "page", key: "authorId" } } },
    Book: { table: "books", columns: { authorId: "author_id" }, relations: { author: { type: "Author", kind: "one", key: "authorId" } } },
    Order: { table: "orders" },
  },
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
| `screen(type, shape, { first, after }, where, ctx)` | one query, nested levels by correlated subquery | a whole nested screen at once; depth costs no extra round trip and each level's policy is pushed into its own `WHERE`. Every selected field must be a mapped column or a declared `relation` |

## Read policies in SQL

When a resolver loads an entity whose read policy is pushable (it reads only the viewer, the arguments, literals and
the row's own scalar fields; spec 06 §4), the runtime hands it to the resolver as `ctx.policy.filter`. Pass `ctx` to the
store and the policy becomes part of the `WHERE` clause: a customer's list query reads only their rows, and a page's
`total` counts only what they may see.

The translation never drops a row the policy allows. Where SQL cannot match the runtime exactly (ordering text,
comparing values of different types, `Decimal` inequality) it lets the row through and the runtime's own check, which
always runs, removes it. Without the pushdown, a list that returns rows the viewer may not see is refused as a whole
(spec 06 §3); with it, the list holds exactly the permitted rows.

## Idempotency records shared by every server

A command's result is kept so a retry is answered with the first attempt's result instead of running the command
again. In memory that holds for one server only: a retry that lands on another one runs the command a second time.
`PgIdempotencyStore` keeps the records in Postgres, so every server shares them.

```ts
import { PgIdempotencyStore } from "@rayfold/postgres";

const idempotency = new PgIdempotencyStore(db);
await idempotency.migrate(); // once, or run idempotencySchema() in your own migrations

const server = createRayfoldServer({ schema, resolvers, idempotency });
```

Taking a key is one statement, so of two servers starting the same retry at the same moment exactly one runs the
command and the other waits, then replays its answer. The running server renews a lease while the command runs; if it
stops, the lease runs out and the next retry takes the key over. Records last 24 hours and the table is bounded
(`ttlMs`, `maxRecords`, `table`).

## Uploads a fleet shares

`PgUploadStore` keeps uploaded files in Postgres, so a file sent to one server is there for the command that runs on
another (extension `upload`). Kept in memory, an upload belongs to the process that received it.

```ts
import { PgUploadStore } from "@rayfold/postgres";

const uploads = new PgUploadStore(db);
await uploads.migrate();

await listen(server, 4000, { viewer, uploads: { store: uploads } });
```

Expired uploads go on every write and the table is bounded (`ttlMs`, `maxBytes`, `table`). The JVM's
`JdbcUploadStore` creates the same columns, so servers of both runtimes can share one table.

## Live updates across servers

Each server hears only the commands it ran itself, so a live query or a stream open on another server stays stale.
`PgRelay` carries changes and events between servers over `LISTEN`/`NOTIFY`:

```ts
import { PgRelay, pgNotifications } from "@rayfold/postgres";

const listener = new pg.Client({ connectionString }); // LISTEN belongs to one connection: not the pool
await listener.connect();
const relay = new PgRelay(pgNotifications(listener), db);
await relay.migrate();

const server = createRayfoldServer({ schema, resolvers, idempotency, relay });
await server.ready();
```

A message too large for one notification goes through the `rayfold_relay` table. A server never hears its own message
back. A refused message is reported through `onRelayError` and `server.relayFailure`; the command that made the change
still succeeds.

## License

Apache-2.0
