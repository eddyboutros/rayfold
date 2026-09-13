# JDBC

`dev.rayfold:rayfold-jdbc` puts a SQL database behind Kotlin resolvers the way the protocol wants: batch loads, one
query per nesting level, keyset pages, and read policies pushed into the `WHERE` clause. It is the JVM counterpart of
[`@rayfold/postgres`](postgres.md) and needs nothing but JDBC.

```kotlin
val store = JdbcStore({ dataSource.connection }, JdbcStoreOptions(
    ir = server.ir,
    naming = Naming.SNAKE,
    tables = mapOf(
        "Book" to JdbcTable("books", columns = mapOf("authorId" to "author_id")),
        "Author" to JdbcTable("authors"),
        "Order" to JdbcTable("orders"),
    ),
))

val resolvers = Resolvers(
    queries = mapOf(
        "books" to { args, ctx -> store.page("Book", first = 20, ctx = ctx) },
        "myOrders" to { _, ctx -> store.find("Order", ctx = ctx) },
    ),
    fields = mapOf(
        "Book" to mapOf("author" to { books, _, ctx -> store.byIds("Author", books.map { it["authorId"] }, ctx) }),
        "Author" to mapOf("books" to { authors, _, ctx -> store.pagesByField("Book", "authorId", authors.map { it["id"] }, 10, ctx) }),
    ),
)
```

The store asks for a connection per query and closes it again, which is what a pool expects: hand it
`dataSource::getConnection`, not one long-lived connection.

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
