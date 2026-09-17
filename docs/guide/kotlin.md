# Kotlin and Android

| Artifact | For |
|---|---|
| `dev.rayfold:rayfold-core` | A Rayfold server on the JVM (Java 21). It reads `.rayfold` schema files itself, with no Node.js step. |
| `dev.rayfold:rayfold-client` | A client for Kotlin on the JVM and for Android (Java 17 bytecode, no server code). |
| `dev.rayfold:rayfold-client-okhttp` | The WebSocket transport on OkHttp, for live queries on Android. |
| `dev.rayfold:rayfold-opentelemetry` | OpenTelemetry tracing for the server ([Tracing](tracing.md)). |
| `dev.rayfold:rayfold-jdbc` | A SQL database behind resolvers, with read policies pushed into the query ([JDBC](jdbc.md)). |

```kotlin
dependencies {
    implementation("dev.rayfold:rayfold-core:0.1.0")    // the server
    implementation("dev.rayfold:rayfold-client:0.1.0")  // the client
}
```

## A server

```kotlin
import dev.rayfold.core.*
import kotlinx.serialization.json.*
import java.io.File

val books = mutableMapOf("b1" to buildJsonObject { put("id", "b1"); put("title", "Dune"); put("stock", 3); put("authorId", "a1") })
val authors = mapOf("a1" to buildJsonObject { put("id", "a1"); put("name", "Frank Herbert") })

val server = RayfoldServer(
    SchemaText.load(File("schema.rayfold").readText()).ir,
    Resolvers(
        queries = mapOf("book" to { args, _ -> books[args["id"]?.jsonPrimitive?.content] }),
        commands = mapOf("restock" to { args, ctx -> restock(args, ctx) }),
        // batch loader: one call per level, one value per parent, in order
        fields = mapOf("Book" to mapOf("author" to { parents, _, _ -> parents.map { authors[it["authorId"]?.jsonPrimitive?.content] } })),
    ),
)

// HTTP on the JDK's own server, JSON or the binary RB encoding, live queries included; the viewer comes from your authentication
RayfoldHttp(server, HttpOptions(allowedOrigins = setOf("https://app.example"))) { exchange ->
    userOf(exchange.requestHeaders.getFirst("Authorization"))?.let { buildJsonObject { put("id", it.id); put("role", it.role) } } ?: JsonNull
}.start(8080)

// live queries and many batches over one socket: ws://host:8081/rayfold/ws
RayfoldWebSocket(server) { request -> userOf(request.header("authorization"))?.let { buildJsonObject { put("id", it.id) } } ?: JsonNull }.start(8081)
```

Resolvers are suspend functions over kotlinx.serialization JSON. A command returns the changed entity, or
`CommandResult(result, patch, emit)` for extra cache patches and events. Throw
`RayfoldException.domain("OutOfStock", data, message)` for an error the operation declares with `throws`.

If you prefer plain Java types and functional interfaces, use `rayfold-java` ([Java guide](java-spring.md)).

`HttpOptions(explorer = true)` serves the [explorer](explorer.md) at `/rayfold/explorer`, the same page
`@rayfold/explorer` serves; `RayfoldExplorer(endpoint, title).mount(http)` puts it on a server of its own. It is off
until it is turned on.

## A client

```kotlin
import dev.rayfold.client.*

val client = RayfoldClient(HttpTransport("https://api.example/rayfold", headers = { mapOf("Authorization" to "Bearer ${token()}") }))

val book = client.query("book", args("id" to "b1"), shape = "{ id title stock }")
client.command("restock", args("id" to "b1", "qty" to 5))
```

Everything the client reads goes into a normalized cache, and commands' patches keep it current:

```kotlin
// the result now, then again whenever this book changes in the cache, with no refetch
client.watch("book", args("id" to "b1"), "{ id title stock }").collect { render(it) }

// pushed by the server whenever anyone changes it, over HTTP or WebSocket
client.live("book", args("id" to "b1"), "{ id stock }").collect { render(it) }

// stream ops
client.stream("ticks", args("n" to 10)).collect { println(it) }
```

Batches with references run in one round trip:

```kotlin
val batch = client.batch()
val order = batch.command("placeOrder", args("input" to mapOf("lines" to listOf(mapOf("bookId" to "b1", "qty" to 1)))), "{ id }")
val shown = batch.query("order", args("id" to order.ref("id")), "{ id total }")
batch.run()
println(shown.await())
```

Errors the server reports arrive as `RayfoldClientException` with `code`, `type` and `data`:

```kotlin
try { client.command("buy", args("id" to "b2", "qty" to 9)) }
catch (e: RayfoldClientException) { if (e.isType("OutOfStock")) showOnlyLeft(e.data) }
```

### Typed results

Generate data classes from the schema and decode into them:

```sh
npx @rayfold/cli gen kotlin schema.rayfold --package com.example.api --out app/src/main/kotlin/com/example/api/Schema.kt
```

```kotlin
val book: Book = client.queryAs("book", args("id" to "b1"), shape = "{ id title stock }")
client.watchAs<Book>("book", args("id" to "b1")).collect { render(it) }
```

### Android

- `HttpTransport` uses `HttpURLConnection`, which Android has. Add `<uses-permission android:name="android.permission.INTERNET" />`.
- Collect flows in a lifecycle-aware scope. In Compose:
  `val book by client.watchAs<Book>("book", args("id" to id)).collectAsState(initial = null)`.
- For a WebSocket on Android, use `OkHttpWebSocketTransport("wss://api.example/rayfold/ws", headers)` from
  `rayfold-client-okhttp`; `JdkWebSocketTransport` needs `java.net.http`, which Android lacks. Pass your app's
  `OkHttpClient` to share its pool, TLS settings and interceptors.
- The build checks that `rayfold-client` and `rayfold-client-okhttp` call only APIs Android 8.0 (API level 26) has.
- Commands can show their effect before the server answers, and wait offline in a queue that survives the app being
  killed: see [Offline and optimistic updates](offline.md).
