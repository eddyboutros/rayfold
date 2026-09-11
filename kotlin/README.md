# Rayfold on the JVM

Six modules, all tested against the same conformance fixtures as the TypeScript reference
(`../conformance/fixtures`):

| Module | What | Guide |
|---|---|---|
| `rayfold-core` | The server runtime. Reads `.rayfold` schema files itself (`SchemaText`), runs batches, serves HTTP and WebSocket, live queries, MCP and REST bindings. kotlinx.serialization and kotlinx.coroutines, no framework. Java 21. | [Kotlin](../docs/guide/kotlin.md) |
| `rayfold-java` | The server with a Java API: `Rayfold.server(schema).query(...)`, functional resolver interfaces, records and maps as results. | [Java](../docs/guide/java-spring.md) |
| `rayfold-spring-boot-starter` | Spring Boot 4: annotated resolver methods on beans, Spring MVC endpoint, the viewer from Spring Security. | [Spring Boot](../docs/guide/java-spring.md#spring-boot) |
| `rayfold-client` | The client for Kotlin and Android: normalized cache kept current by patches, batches, `watch`/`live`/`stream` flows, typed results, optimistic commands and an offline queue. Java 17 bytecode, no server code; checked against Android API level 26. | [Kotlin client](../docs/guide/kotlin.md#a-client) |
| `rayfold-client-okhttp` | The WebSocket transport on OkHttp, for Android. | [Android](../docs/guide/kotlin.md#android) |
| `rayfold-opentelemetry` | OpenTelemetry spans for batches, ops and loader calls. | [Tracing](../docs/guide/tracing.md) |

```
./gradlew check                       # every module's tests, and the Android API check of the client modules
./gradlew :rayfold-core:test          # the runtime, incl. the conformance suite twice (embedded IR and schema text)
./gradlew publishToMavenLocal         # the artifacts into ~/.m2
node ../scripts/smoke-maven.mjs       # publish locally, then build and run a separate project against the jars
```

## rayfold-core

| File | Purpose |
|---|---|
| `SchemaText.kt` | `.rayfold` lexer, parser and validator; the IR, diagnostics, error messages and hash match `@rayfold/schema` exactly (`SchemaTextTest` compares them on every oracle case) |
| `Ir.kt` | the IR model, also read from JSON |
| `Shapes.kt` | shape text parser, canonical form, `sha256:` ids |
| `Expr.kt`, `Policy.kt` | policy expression evaluation, allow/deny decisions |
| `Args.kt` | argument coercion, `$ref` resolution |
| `Cost.kt`, `Views.kt` | static cost, default views, trusted-shape registry |
| `Executor.kt` | level-wise batched projection, defer/lazy, typed errors, patches |
| `Batch.kt` | dependency waves, serial commands, deadlines, idempotency replay |
| `RayfoldServer.kt`, `RayfoldHttp.kt` | facade and HTTP transport (`POST`/`QUERY`/`GET`, NDJSON frames, RFC 9457 problems, `/rayfold/openapi.json`); `HttpCall` lets any server (the starter's Spring MVC, for one) host it |
| `Guard.kt` | Host (DNS rebinding), Origin, media-type and body-size checks shared by every endpoint (spec 12) |
| `Bindings.kt`, `OpenApi.kt`, `JsonSchema.kt` | REST-style `@http` bindings, their cache headers, and the OpenAPI 3.2 document |
| `Mcp.kt` | MCP bridge (2026-07-28, stateless Streamable HTTP) |
| `Live.kt`, `RayfoldWebSocket.kt`, `WsSession.kt` | change bus and live-query diffs; the RFC 6455 WebSocket transport on its own listener, and the per-connection protocol the Spring starter reuses on the application's port |
| `Rb.kt` | the RB binary encoding, byte for byte the TypeScript codec's (`RbTest` checks it against a seeded corpus) |
| `Instrumentation.kt` | hooks around batches, ops and loaders, for tracing |

Resolvers are suspend functions; entity field loaders are batch by default:

```kotlin
val server = RayfoldServer(
    SchemaText.load(File("schema.rayfold").readText()).ir,
    Resolvers(
        queries = mapOf("book" to { args, _ -> store.book(args["id"]?.jsonPrimitive?.content) }),
        commands = mapOf("restock" to { args, _ -> CommandResult(row, patch = listOf(...), emit = listOf("StockChanged" to payload)) }),
        fields = mapOf("Book" to mapOf("author" to { parents, _, _ -> parents.map { store.author(it["authorId"]) } })),
    ),
)
val http = RayfoldHttp(server) { viewerFrom(it) }.start(4400)   // /rayfold, /rayfold/manifest, /rayfold/openapi.json
RayfoldBindings(server) { viewerFrom(it) }.mount(http)           // @http routes
RayfoldMcp(server) { viewerFrom(it) }.mount(http)                // POST /mcp
RayfoldWebSocket(server) { req -> viewerFrom(req) }.start(4401)  // /rayfold/ws, live queries
```

Where it differs from the TypeScript runtime:

- The JDK server's request timer (`sun.net.httpserver.maxReqTime`) is JVM-wide, not per server; the WebSocket
  listener bounds its handshake per listener. Under the Spring starter the servlet container's own timeouts apply.
- `RayfoldWebSocket` listens on its own port, since the JDK server cannot upgrade a connection; the Spring starter
  serves the WebSocket on the application's port.
- Resolvers get no pushed-down read policy (`ctx.policy` in TypeScript); the runtime's own check filters rows.
