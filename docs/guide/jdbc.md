# JDBC

`dev.rayfold:rayfold-jdbc` puts a SQL database behind Kotlin resolvers the way the protocol wants: batch loads, one
query per nesting level, keyset pages, and read policies pushed into the `WHERE` clause. It is the JVM counterpart of
[`@rayfold/postgres`](postgres.md) and needs nothing but JDBC. One thing has not crossed over yet: the Node store's
`screen()`, which compiles a whole nested screen into a single statement. Here a screen is one query per level, which
is still one round trip per level rather than per row.

```kotlin
val ir = SchemaText.load(schemaText).ir
val store = JdbcStore(dataSource::getConnection, JdbcStoreOptions(
    ir = ir,
    naming = Naming.SNAKE,
    tables = mapOf(
        "Book" to JdbcTable("books", columns = mapOf("authorId" to "author_id")),
        "Author" to JdbcTable("authors"),
        "Order" to JdbcTable("orders"),
    ),
))

// a page as the runtime's Page<T> reads it
fun JdbcPage.json(): JsonElement = buildJsonObject {
    put("items", JsonArray(items)); put("cursor", cursor); put("hasMore", hasMore); put("total", total)
}

val resolvers = Resolvers(
    queries = mapOf(
        "books" to { _, ctx -> store.page("Book", first = 20, ctx = ctx).json() },
        "myOrders" to { _, ctx -> JsonArray(store.find("Order", ctx = ctx)) },
    ),
    fields = mapOf(
        "Book" to mapOf("author" to { books, _, ctx -> store.byIds("Author", books.map { it["authorId"] }, ctx) }),
        "Author" to mapOf("books" to { authors, _, ctx -> store.pagesByField("Book", "authorId", authors.map { it["id"] }, 10, ctx).map { it.json() } }),
    ),
)
val server = RayfoldServer(ir, resolvers)
```

The store asks for a connection per query and closes it again, which is what a pool expects: hand it
`dataSource::getConnection`, not one long-lived connection. A `date` column comes back as `YYYY-MM-DD` text and a
timestamp as RFC 3339 in UTC, whatever the JVM's time zone.

## Idempotency records for more than one server

A command's result is kept so that a retry is answered with the first attempt's result instead of running the command
again. Kept in memory, that only holds for one process: a retry that lands on another one runs the command a second
time. `JdbcIdempotencyStore` keeps the records in the database, so every process shares them.

```kotlin
val idempotency = JdbcIdempotencyStore(dataSource::getConnection)
idempotency.migrate() // the table and its index; run schema() and index() yourself if you keep your own migrations

val server = RayfoldServer(ir, resolvers, idempotency = idempotency)
```

Taking a key is one insert, so of two processes starting the same retry at the same moment exactly one runs the command
and the other waits and then replays its answer. The process that owns a key renews a lease while the command runs; if
it stops, the lease runs out and the next retry takes the key over. `BatchOptions(idempotencyLeaseMs = ...)` sets the
lease (default 30 seconds), and `JdbcIdempotencyOptions` the table name, how long a record answers retries (24 hours)
and how many are kept (100,000).

Only JDBC is needed: the SQL is plain enough for Postgres, H2 and their relatives, with no upsert syntax and no locking
hints. Under Spring Boot, declare the store as a bean and the starter wires it in ([Java and Spring](java-spring.md)).

## Live updates across servers

A command's patches reach the live queries and streams open on the process that ran it, and no other: each process
hears only itself. `PgRelay` carries changes and events between processes over Postgres `LISTEN`/`NOTIFY`, in the
same format the TypeScript server uses, so a mixed fleet shares one channel.

```kotlin
val listener = dataSource.connection // LISTEN belongs to one connection: keep it out of the pool
val relay = PgRelay(PgNotifications(listener), dataSource::getConnection)
relay.migrate() // or run relay.schema() in your migrations

val server = RayfoldServer(ir, resolvers, idempotency = idempotency, relay = relay)
runBlocking { server.ready() } // suspends until it is listening to the other servers
```

`PgNotifications` needs the Postgres driver on the classpath, and only then: `rayfold-jdbc` does not depend on it. The
driver serialises everything on one connection, so a `notify` sent on the listening connection waits for the current
poll to end; give `PgNotifications` a second connection for sending to avoid that. A message too large for one
notification goes through the `rayfold_relay` table. A server never hears its own message back; a refused message is
reported through `onRelayError` and `relayFailure`, and the command that made the change still succeeds.

## Uploads a fleet shares

An upload kept in memory belongs to the process that received it, which is wrong as soon as the command naming it may
run somewhere else. `JdbcUploadStore` keeps the bytes in the database, in the same table and columns
[`PgUploadStore`](uploads.md) creates, so a fleet of both runtimes shares one:

```kotlin
val uploads = JdbcUploadStore(dataSource::getConnection)
uploads.migrate() // safe from every server at once

val http = RayfoldHttp(server, HttpOptions(uploads = UploadOptions(uploads))) { viewerFrom(it) }.start(4000)
```

Expired uploads go on every write and the table is bounded, oldest first ([Uploads](uploads.md)).

## Why pass `ctx`

When a resolver loads an entity whose read policy can run in SQL (it reads only the viewer, the arguments, literals
and the row's own columns), the runtime hands that policy to the resolver as `ctx.policy`
([spec 06 section 4](../../spec/06-auth.md)). The store turns it into part of the query, so a viewer's list holds
exactly their rows and a page's `total` counts only what they may see.

The translation never drops a row the policy allows. Comparisons it cannot match exactly in SQL, such as ordering
across types, become `TRUE` and the runtime's own check removes the extra rows. A `!=` names null columns explicitly,
because SQL would otherwise drop rows the policy allows.

Identifiers are quoted exactly as the mapping gives them, so a table named `books` is `"books"`: on a database that
folds unquoted names to upper case, create the tables with quoted names too.
