package dev.rayfold.core

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.net.Socket
import java.net.SocketException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * The security audit's findings, attack by attack. Every refused attack has a sibling proving that honest use of
 * the same feature still works. Transport findings drive [RayfoldHttp] over real HTTP; runtime findings drive
 * [RayfoldServer.execute]. JUnit's per-method lifecycle gives each test its own server, store and listener, @AfterEach
 * stops listeners and closes sockets, and every wait is bounded (5 s HTTP timeouts, runTest's 5 s, joins).
 */
class SecurityTest {
    private companion object {
        const val MAX_REQ_TIME = "sun.net.httpserver.maxReqTime"
    }

    private val fixture = Fixtures.load("core/03-pipelining.json")
    private val ir = Fixtures.ir(fixture)
    private val u1 = obj("""{"id":"u1","role":"customer"}""")
    private val u2 = obj("""{"id":"u2","role":"customer"}""")
    private val bookRow = obj("""{"id":"b1","title":"T1","stock":2,"authorId":"a1","version":1}""")
    private val b1 = """{"id":"b1"}"""
    private val restockArgs = """{"bookId":"b1","qty":5}"""
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val started = mutableListOf<HttpServer>()
    private val sockets = mutableListOf<Socket>()

    @AfterEach
    fun stop() {
        sockets.forEach { runCatching { it.close() } }
        started.forEach { it.stop(0) }
        client.shutdownNow()
        // the JDK reads its request timer from this JVM-wide property once, when its server class loads, so which test
        // ran first would decide it for all of them; build.gradle.kts pins it, and a test that moves it fails here
        assertEquals("2", System.getProperty(MAX_REQ_TIME), "the JVM-wide request timer was changed")
    }

    // ------------------------------------------------------------------ helpers

    private fun key(n: Int) = "security-key-%06d".format(n)

    /** Long enough that no test here can outlive a lease it takes, so nothing depends on how fast the machine is. */
    private val lease = 60 * 60 * 1000L

    private fun MemoryIdempotencyStore.owns(key: String): String =
        (claim("s", key, lease) as? IdempotencyClaim.Owned)?.token ?: error("expected to own $key")

    /** What a run does with a key it owns: claim it, then store the answer retries replay. */
    private fun MemoryIdempotencyStore.record(key: String, rec: IdempotencyRecord) = put("s", key, rec, owns(key))

    private fun op(id: Int, name: String, args: String, key: String? = null, shape: String? = null, simulate: Boolean = false, deadline: String? = null) = buildJsonObject {
        put("id", id); put("op", name); put("args", obj(args))
        if (key != null) put("key", key)
        if (shape != null) put("shape", shape)
        if (simulate) put("simulate", true)
        if (deadline != null) put("deadline", Json.parseToJsonElement(deadline))
    }

    private fun envelope(vararg ops: JsonObject, meta: JsonObject? = null) = buildJsonObject {
        put("ops", JsonArray(ops.toList()))
        if (meta != null) put("meta", meta)
    }

    private fun opError(id: Int, code: String, message: String, path: String? = null) = buildJsonObject {
        put("id", id)
        put("error", buildJsonObject { put("code", code); put("message", message); if (path != null) put("path", path) })
        put("fin", true)
    }

    private fun batchError(code: String, message: String) = buildJsonObject {
        put("error", buildJsonObject { put("code", code); put("message", message) })
        put("fin", true)
    }

    private fun JsonObject.replayed(): Boolean = ((this["meta"] as? JsonObject)?.get("replay") as? JsonPrimitive)?.content == "true"

    private fun stockOf(store: FixtureStore, id: String) = store.table("Book").single { it["id"] == JsonPrimitive(id) }["stock"]

    private fun withOp(schema: RayfoldSchemaIR, op: OpDef) = schema.copy(ops = schema.ops + (op.name to op))

    /** `echo(v: JSON): JSON`, a query that hands back any value, for nesting tests. */
    private val echoIr = withOp(ir, OpDef(kind = "query", name = "echo", args = listOf(ArgDef("v", type = TypeRef("named", "JSON", nullable = true))), returns = TypeRef("named", "JSON", nullable = true)))
    private fun echoServer() = RayfoldServer(echoIr, Resolvers(queries = mapOf("echo" to query { args, _ -> args["v"] })))

    private fun findIr(pattern: String) = withOp(ir, OpDef(
        kind = "query", name = "find", returns = TypeRef("named", "Book", nullable = true),
        args = listOf(ArgDef("slug", type = TypeRef("named", "String"), annotations = listOf(Annotation("format", mapOf("pattern" to JsonPrimitive(pattern)))))),
    ))
    private fun findServer(pattern: String = "^[a-z0-9]+$") = RayfoldServer(findIr(pattern), Resolvers(queries = mapOf("find" to query { _, _ -> bookRow })))
    private fun find(slug: String) = buildJsonObject { put("ops", JsonArray(listOf(buildJsonObject { put("id", 1); put("op", "find"); put("args", buildJsonObject { put("slug", slug) }); put("shape", "{ id }") }))) }

    /** Exactly [n] levels of nested arrays, built without recursion. */
    private fun nestedArrays(n: Int): JsonElement {
        var v: JsonElement = JsonArray(emptyList())
        repeat(n - 1) { v = JsonArray(listOf(v)) }
        return v
    }

    // ------------------------------------------------------------------ HTTP helpers

    private class Served(val port: Int, val store: FixtureStore, val http: HttpServer)

    private fun bearer(ex: HttpExchange): JsonElement {
        val auth = ex.requestHeaders.getFirst("Authorization")
        return if (auth != null && auth.startsWith("Bearer ")) buildJsonObject { put("id", auth.removePrefix("Bearer ")); put("role", "customer") } else JsonNull
    }

    private fun serve(options: HttpOptions = HttpOptions(), server: RayfoldServer? = null, viewer: (HttpExchange) -> JsonElement = { bearer(it) }): Served {
        val store = FixtureStore(Fixtures.data(fixture))
        val http = RayfoldHttp(server ?: RayfoldServer(ir, FixtureResolvers.build(fixture, store)), options, viewer).start(0)
        started.add(http)
        return Served(http.address.port, store, http)
    }

    private fun send(s: Served, method: String, path: String, body: String? = null, vararg headers: String): HttpResponse<String> {
        val b = HttpRequest.newBuilder(URI("http://127.0.0.1:${s.port}$path"))
            .timeout(Duration.ofSeconds(5))
            .method(method, if (body == null) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(body))
        headers.toList().chunked(2).forEach { (k, v) -> b.header(k, v) }
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString())
    }

    private fun post(s: Served, body: String, vararg headers: String) = send(s, "POST", "/rayfold", body, "Content-Type", "application/rayfold+json", *headers)
    private fun header(res: HttpResponse<String>, name: String): String? = res.headers().firstValue(name).orElse(null)
    private fun frames(res: HttpResponse<String>): List<JsonObject> = res.body().trim().split("\n").map { obj(it) }
    private fun b64(json: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())

    private fun problem(res: HttpResponse<String>, status: Int, code: String, detail: String, type: String = code) {
        assertEquals(status, res.statusCode(), res.body())
        assertEquals("application/problem+json", header(res, "Content-Type"))
        assertEquals("no-store", header(res, "Cache-Control"), "problems are never cached")
        assertEquals("nosniff", header(res, "X-Content-Type-Options"))
        assertEquals(buildJsonObject {
            put("type", "https://eddyboutros.github.io/rayfold/errors/$type"); put("title", type.replace('_', ' '))
            put("status", status); put("detail", detail); put("code", code)
        }, obj(res.body()))
    }

    private fun rawSocket(s: Served, text: String): Socket {
        val socket = Socket("127.0.0.1", s.port)
        sockets.add(socket)
        socket.soTimeout = 5000
        socket.getOutputStream().write(text.toByteArray())
        socket.getOutputStream().flush()
        return socket
    }

    private val bookQuery = """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}"""
    private val bookData = obj("""{"${'$'}type":"Book","id":"b1"}""")

    // ------------------------------------------------------------------ D1 content types

    @Test
    fun `D1 a text or form body is 415 and nothing runs`() {
        val s = serve()
        val buy = """{"ops":[{"id":1,"op":"buy","args":{"bookId":"b1"},"key":"${key(1)}"}]}"""
        for (ct in listOf("text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x")) {
            problem(send(s, "POST", "/rayfold", buy, "Content-Type", ct, "Authorization", "Bearer u1"), 415, "invalid_argument",
                "Content-Type $ct is not accepted; send application/rayfold+json", type = "unsupported_media_type")
        }
        problem(send(s, "POST", "/rayfold", buy, "Authorization", "Bearer u1"), 415, "invalid_argument",
            "Content-Type (none) is not accepted; send application/rayfold+json", type = "unsupported_media_type")
        problem(send(s, "QUERY", "/rayfold", bookQuery, "Content-Type", "text/plain"), 415, "invalid_argument",
            "Content-Type text/plain is not accepted; send application/rayfold+json", type = "unsupported_media_type")
        assertEquals(emptyMap(), s.store.calls.toMap(), "neither the command nor the query ran")
    }

    @Test
    fun `D1 guard - both JSON media types run, with parameters and in any case`() {
        val s = serve()
        for (ct in listOf("application/rayfold+json", "application/json", "application/json; charset=utf-8", "Application/Rayfold+JSON")) {
            val res = send(s, "POST", "/rayfold", bookQuery, "Content-Type", ct)
            assertEquals(200, res.statusCode(), "$ct: ${res.body()}")
            assertEquals(bookData, frames(res).single()["data"])
        }
        assertEquals(4, s.store.calls["Query.book"])
    }

    // ------------------------------------------------------------------ D2 origin

    @Test
    fun `D2 a cross-origin non-GET request is 403 and nothing runs`() {
        val s = serve()
        val buy = """{"ops":[{"id":1,"op":"buy","args":{"bookId":"b1"},"key":"${key(1)}"}]}"""
        for (origin in listOf("https://evil.example", "null", "http://127.0.0.1:1")) {
            problem(post(s, buy, "Origin", origin, "Authorization", "Bearer u1"), 403, "permission_denied", "Origin $origin is not allowed")
        }
        problem(post(s, bookQuery, "Origin", "https://evil.example", "Rayfold-Safe", "false"), 403, "permission_denied", "Origin https://evil.example is not allowed")
        assertEquals(emptyMap(), s.store.calls.toMap())
        assertEquals(JsonPrimitive(2), stockOf(s.store, "b1"), "no order was placed")
    }

    @Test
    fun `D2 a safe request from another origin is answered - POST with Rayfold-Safe and QUERY hold only queries`() {
        val s = serve()
        val safePost = post(s, bookQuery, "Rayfold-Safe", "true", "Origin", "https://other.example")
        assertEquals(200, safePost.statusCode(), safePost.body())
        assertEquals(bookData, frames(safePost).single()["data"])
        val query = send(s, "QUERY", "/rayfold", bookQuery, "Content-Type", "application/rayfold+json", "Origin", "https://other.example")
        assertEquals(200, query.statusCode(), query.body())
        assertEquals(bookData, frames(query).single()["data"])
        assertEquals(2, s.store.calls["Query.book"])
    }

    @Test
    fun `D2 guard - the same POST without Rayfold-Safe is 403, and a safe batch holding a command is 400 and never runs`() {
        val s = serve()
        problem(post(s, bookQuery, "Origin", "https://other.example"), 403, "permission_denied", "Origin https://other.example is not allowed")
        val buy = """{"ops":[{"id":1,"op":"buy","args":{"bookId":"b1"},"key":"${key(1)}"}]}"""
        problem(post(s, buy, "Rayfold-Safe", "true", "Origin", "https://other.example", "Authorization", "Bearer u1"), 400, "invalid_argument", "Safe requests (GET/QUERY) may only contain queries")
        problem(send(s, "QUERY", "/rayfold", buy, "Content-Type", "application/rayfold+json", "Origin", "https://other.example", "Authorization", "Bearer u1"), 400, "invalid_argument", "Safe requests (GET/QUERY) may only contain queries")
        assertEquals(emptyMap(), s.store.calls.toMap(), "neither the query nor the smuggled command ran")
        assertEquals(JsonPrimitive(2), stockOf(s.store, "b1"), "no order was placed")
    }

    @Test
    fun `D2 guard - same-origin, allow-listed, Origin-less and GET requests still run`() {
        val s = serve(HttpOptions(allowedOrigins = setOf("https://app.example")))
        for (h in listOf(emptyArray(), arrayOf("Origin", "http://127.0.0.1:${s.port}"), arrayOf("Origin", "https://app.example"))) {
            val res = post(s, bookQuery, *h)
            assertEquals(200, res.statusCode(), "${h.toList()}: ${res.body()}")
            assertEquals(bookData, frames(res).single()["data"])
        }
        val get = send(s, "GET", "/rayfold/book?a=${b64(b1)}", null, "Origin", "https://evil.example")
        assertEquals(200, get.statusCode(), "a GET only runs queries, so its Origin is not checked")
        assertEquals(4, s.store.calls["Query.book"])
    }

    // ------------------------------------------------------------------ D12 headers

    @Test
    fun `D12 every response says nosniff and problems are never cached`() {
        val s = serve()
        val ok = post(s, bookQuery)
        val manifest = send(s, "GET", "/rayfold/manifest")
        val single = send(s, "GET", "/rayfold/book?a=${b64(b1)}", null, "Accept", "application/json")
        for (res in listOf(ok, manifest, single)) {
            assertEquals(200, res.statusCode())
            assertEquals("nosniff", header(res, "X-Content-Type-Options"))
        }
        problem(send(s, "POST", "/rayfold/manifest", "{}"), 404, "not_found", "No route for POST /rayfold/manifest")
        problem(post(s, "{nope"), 400, "invalid_argument", "Body is not valid JSON")
        // a problem on a safe GET is no-store too, not the revalidatable caching of a successful GET
        problem(send(s, "GET", "/rayfold/buy?a=${b64("""{"bookId":"b1"}""")}"), 400, "invalid_argument", "Safe requests (GET/QUERY) may only contain queries")
        assertEquals("public, max-age=60", header(send(s, "GET", "/rayfold/book?a=${b64(b1)}"), "Cache-Control"), "guard: successful safe responses carry the schema's cache headers")
    }

    // ------------------------------------------------------------------ D11 manifest

    @Test
    fun `D11 the default manifest names policies but hides their expressions`() {
        val s = serve()
        val res = send(s, "GET", "/rayfold/manifest")
        assertEquals(200, res.statusCode())
        assertFalse(res.body().contains("\$expr"), "no policy expression leaves the server")
        val schema = RayfoldSchemaIR.json.decodeFromJsonElement(RayfoldSchemaIR.serializer(), obj(res.body())["schema"] ?: error("manifest has no schema"))
        assertEquals(Annotation("allow"), schema.ops["buy"]?.annotations?.single { it.name == "allow" })
        assertEquals(listOf(Annotation("allow")), schema.types["Order"]?.annotations)
        assertEquals(listOf(Annotation("allow")), schema.types["Book"]?.fields?.single { it.name == "secret" }?.annotations)
        assertEquals(ir.types["Book"]?.annotations, schema.types["Book"]?.annotations, "guard: other annotations (@cache) keep their arguments")
        assertEquals(ir.withoutPolicies(), schema, "everything else is the IR")
    }

    @Test
    fun `D11 FULL serves the IR as is and OFF has no manifest route`() {
        val full = serve(HttpOptions(manifest = ManifestMode.FULL))
        val res = send(full, "GET", "/rayfold/manifest")
        assertEquals(ir, RayfoldSchemaIR.json.decodeFromJsonElement(RayfoldSchemaIR.serializer(), obj(res.body())["schema"] ?: error("manifest has no schema")))

        val off = serve(HttpOptions(manifest = ManifestMode.OFF))
        problem(send(off, "GET", "/rayfold/manifest"), 404, "not_found", "No route for GET /rayfold/manifest")
        assertEquals(200, send(off, "GET", "/rayfold/book?a=${b64(b1)}").statusCode(), "guard: ops are still served")
    }

    // ------------------------------------------------------------------ routing

    @Test
    fun `a path that only shares the prefix is not an op route`() {
        val s = serve()
        problem(send(s, "GET", "/rayfoldbook?a=${b64(b1)}"), 404, "not_found", "No route for GET /rayfoldbook")
        problem(send(s, "POST", "/rayfoldx", bookQuery, "Content-Type", "application/rayfold+json"), 404, "not_found", "No route for POST /rayfoldx")
        assertNull(s.store.calls["Query.book"])
        assertEquals(200, send(s, "GET", "/rayfold/book?a=${b64(b1)}").statusCode(), "guard: the real route")
        assertEquals(200, send(s, "POST", "/rayfold/", bookQuery, "Content-Type", "application/rayfold+json").statusCode(), "guard: the endpoint with a trailing slash")
        assertEquals(2, s.store.calls["Query.book"])
    }

    // ------------------------------------------------------------------ D9 depth over HTTP

    @Test
    fun `D9 a body nested deeper than 64 levels is a 400 before anything runs, however deep`() {
        val s = serve(server = echoServer())
        // the body's object, ops array, op object and args object are four levels; `v` adds the rest
        fun body(n: Int) = """{"ops":[{"id":1,"op":"echo","args":{"v":${"[".repeat(n)}${"]".repeat(n)}}}]}"""
        problem(post(s, body(61)), 400, "invalid_argument", "body: nested deeper than 64 levels")
        problem(post(s, body(400_000)), 400, "invalid_argument", "body: nested deeper than 64 levels")
        problem(send(s, "GET", "/rayfold/echo?a=${b64("""{"v":${"[".repeat(64)}${"]".repeat(64)}}""")}"), 400, "invalid_argument", "query parameter a: nested deeper than 64 levels")
    }

    @Test
    fun `D9 guard - a body at exactly 64 levels is parsed and executed`() {
        val s = serve(server = echoServer())
        val res = post(s, """{"ops":[{"id":1,"op":"echo","args":{"v":${"[".repeat(60)}${"]".repeat(60)}}}]}""")
        assertEquals(200, res.statusCode(), res.body())
        assertEquals(nestedArrays(60), frames(res).single()["data"])
        val get = send(s, "GET", "/rayfold/echo?a=${b64("""{"v":${"[".repeat(63)}${"]".repeat(63)}}""")}")
        assertEquals(nestedArrays(63), frames(get).single()["data"])
    }

    @Test
    fun `D9 a StackOverflowError at the HTTP boundary is a 400, not a 500`() {
        val s = serve(viewer = { ex -> if (ex.requestHeaders.getFirst("X-Overflow") != null) throw StackOverflowError() else JsonNull })
        problem(post(s, bookQuery, "X-Overflow", "1"), 400, "invalid_argument", "Request is nested too deeply")
        assertEquals(200, post(s, bookQuery).statusCode(), "guard: the same request without the overflow")
    }

    // ------------------------------------------------------------------ D14 strict JSON over HTTP

    @Test
    fun `D14 non-standard numbers and duplicate keys are 400s that never reach a resolver`() {
        val s = serve()
        for (lit in listOf("NaN", "Infinity", "-Infinity", "1d", "01", "0x10", "1.", ".5", "+1", "tru")) {
            problem(post(s, """{"ops":[{"id":1,"op":"restock","args":{"bookId":"b1","qty":$lit},"key":"${key(1)}"}]}""", "Authorization", "Bearer u1"),
                400, "invalid_argument", "Body is not valid JSON")
        }
        // with last-one-wins a checker and a resolver could read different values of one key
        problem(post(s, """{"ops":[{"id":1,"op":"book","args":{"id":"b1","id":"b2"}}]}"""), 400, "invalid_argument", "Body is not valid JSON: duplicate key \"id\"")
        assertEquals(emptyMap(), s.store.calls.toMap())
    }

    @Test
    fun `D14 guard - standard numbers, escapes and whitespace pass through unchanged`() {
        val s = serve(server = echoServer())
        val v = """[0, -0.5, 1e2, 1E-2, 12345678901234567890, "a\u00e9\"\\\/", true, false, null, {"k": {}}]"""
        val res = post(s, " \r\n\t{\"ops\" : [ {\"id\":1, \"op\":\"echo\", \"args\":{\"v\":$v}} ] }\n")
        assertEquals(200, res.statusCode(), res.body())
        assertEquals(Json.parseToJsonElement(v), frames(res).single()["data"])
    }

    // ------------------------------------------------------------------ D14 strict JSON at the runtime entry

    @Test
    fun `D14 op ids must be positive integers written as integers`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        for (id in listOf("\"2\"", "1.9", "1e12", "1.0", "0", "-1", "2147483648", "null", "true")) {
            assertEquals(listOf(batchError("invalid_argument", "ops[0].id: expected a positive integer")),
                fx.server.collect(obj("""{"ops":[{"id":$id,"op":"book","args":{"id":"b1"}}]}""")), "id $id")
        }
        assertEquals(emptyMap(), fx.store.calls.toMap())
        val ok = fx.server.collect(obj("""{"ops":[{"id":7,"op":"book","args":{"id":"b1"}},{"id":2147483647,"op":"book","args":{"id":"b1"}}]}"""))
        assertEquals(listOf(7, 2147483647), ok.map { it.opId() }.sortedBy { it }, "guard")
    }

    @Test
    fun `D14 a lenient literal in a pre-built envelope is refused before coercion`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        // kotlinx's lenient parser lets these through as unquoted literals; RayfoldServer.execute does not trust its caller
        for (lit in listOf("NaN", "Infinity", "1d", "01", "abc")) {
            assertEquals(listOf(batchError("invalid_argument", "ops[0].args: $lit is not valid JSON")),
                fx.server.collect(obj("""{"ops":[{"id":1,"op":"restock","args":{"bookId":"b1","qty":$lit},"key":"${key(1)}"}]}"""), u1), lit)
        }
        assertEquals(listOf(batchError("invalid_argument", "ops[0].vars: NaN is not valid JSON")),
            fx.server.collect(obj("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"vars":{"n":NaN}}]}""")))
        assertEquals(listOf(batchError("invalid_argument", "meta: 1d is not valid JSON")),
            fx.server.collect(obj("""{"meta":{"x":1d},"ops":[{"id":1,"op":"book","args":{"id":"b1"}}]}""")))
        assertEquals(emptyMap(), fx.store.calls.toMap())
        val ok = fx.server.collect(obj("""{"ops":[{"id":1,"op":"restock","args":{"bookId":"b1","qty":1},"key":"${key(1)}"}]}"""), u1).single()
        assertNull(ok.errorCode(), "guard: $ok")
    }

    // ------------------------------------------------------------------ D3 cost

    private val big = (2..12).map { """{"id":$it,"op":"books","args":{"page":{"first":200}}}""" }.toTypedArray()

    @Test
    fun `D3 an op with invalid page args costs nothing, so it cannot offset the batch total`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        // before: first = -100000 gave op 1 a large negative cost, which let eleven 200-row pages through a budget of 1000
        val frames = fx.server.collect(batch("""{"id":1,"op":"books","args":{"page":{"first":-100000}}}""", *big))
        assertEquals(listOf(obj("""{"error":{"code":"resource_exhausted","message":"Batch cost 2266 exceeds budget 1000","data":{"cost":2266,"budget":1000}},"fin":true}""")), frames)
        assertEquals(emptyMap(), fx.store.calls.toMap())
    }

    @Test
    fun `D3 a missing or negative page variable counts as 200, so it cannot offset the batch total`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        val shape = "{ reviews(page: {first: ${'$'}n}) { items { id } } }"
        for (vars in listOf("""{"n":-1000000}""", "{}", """{"n":1e999}""", """{"n":2147483647}""")) {
            // book 1 + reviews 1 + 200 rows + items 1 = 203, plus eleven pages of 206 (it was -999997 for n = -1000000)
            val frames = fx.server.collect(batch("""{"id":1,"op":"book","args":{"id":"nope"},"shape":"$shape","vars":$vars}""", *big))
            assertEquals(obj("""{"error":{"code":"resource_exhausted","message":"Batch cost 2469 exceeds budget 1000","data":{"cost":2469,"budget":1000}},"fin":true}"""), frames.single(), vars)
        }
        assertEquals(emptyMap(), fx.store.calls.toMap())
    }

    @Test
    fun `D3 a page size behind a ref is charged 200`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer(options = BatchOptions(budget = 200))
        val viaRef = fx.server.collect(batch(
            """{"id":1,"op":"books","args":{"page":{"first":3}}}""",
            """{"id":2,"op":"books","args":{"page":{"first":{"${'$'}ref":"1.total"}}}}""",
        ))
        assertEquals(obj("""{"error":{"code":"resource_exhausted","message":"Batch cost 215 exceeds budget 200","data":{"cost":215,"budget":200}},"fin":true}"""), viaRef.single())
        val literal = fx.server.collect(batch("""{"id":1,"op":"books","args":{"page":{"first":3}}}""", """{"id":2,"op":"books","args":{"page":{"first":3}}}"""))
        assertEquals(listOf(9L, 9L), literal.map { ((it["meta"] as? JsonObject)?.get("cost") as? JsonPrimitive)?.content?.toLong() }, "guard: known sizes cost what they are")
    }

    @Test
    fun `D3 guard - the invalid op reports its own error when its turn comes and the rest run`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        val frames = fx.server.collect(batch("""{"id":1,"op":"books","args":{"page":{"first":-100000}}}""", """{"id":2,"op":"books","args":{"page":{"first":2000}}}""")).associateBy { it.opId() }
        assertEquals(opError(1, "invalid_argument", "books().page.first: must be >= 0"), frames[1])
        assertEquals(obj("""{"cost":206}"""), frames[2]?.get("meta"), "first 2000 is clamped to 200 and costed at 200")
        assertEquals(1, fx.store.calls["Query.books"])
    }

    // ------------------------------------------------------------------ D4 anonymous keys

    @Test
    fun `D4 an anonymous caller cannot use an idempotency key`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        val restock = envelope(op(1, "restock", restockArgs, key(1)))
        val refusal = listOf(opError(1, "unauthenticated", "restock(): idempotency keys need an identified caller"))
        assertEquals(refusal, fx.server.collect(restock))
        // before: a second anonymous caller got the first one's stored result back as a replay
        assertEquals(refusal, fx.server.collect(restock))
        assertNull(fx.store.calls["Command.restock"])
        assertEquals(JsonPrimitive(2), stockOf(fx.store, "b1"))
    }

    @Test
    fun `D4 guard - anonymous callers still run keyless and simulated commands, identified callers keep keys`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer { it.withOpAnnotations("restock", Annotation("idempotent", mapOf("value" to JsonPrimitive(false))), Annotation("simulate")) }
        val keyless = fx.server.collect(envelope(op(1, "restock", restockArgs))).single()
        assertEquals(JsonPrimitive(7), (keyless["ok"] as? JsonObject)?.get("stock"), "$keyless")
        val dryRun = fx.server.collect(envelope(op(1, "restock", restockArgs, key(1), simulate = true))).single()
        assertEquals(JsonPrimitive(12), (dryRun["ok"] as? JsonObject)?.get("stock"), "$dryRun")
        assertEquals(JsonPrimitive(7), stockOf(fx.store, "b1"), "the dry run committed nothing")
        val identified = fx.server.collect(envelope(op(1, "restock", restockArgs, key(2))), u1).single()
        assertEquals(JsonPrimitive(12), (identified["ok"] as? JsonObject)?.get("stock"), "$identified")
        assertEquals(3, fx.store.calls["Command.restock"])
    }

    // ------------------------------------------------------------------ D5 keys bound to the op

    @Test
    fun `D5 a key used for one op never replays for another op or other args`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        val k = key(1)
        assertNull(fx.server.collect(envelope(op(1, "restock", """{"bookId":"b1","qty":1}""", k)), u1).single().errorCode())
        val reuse = "Idempotency key $k was used for another operation or other arguments"
        // before: buy with the same key and the same args answered with restock's stored result
        assertEquals(listOf(opError(1, "already_exists", reuse)), fx.server.collect(envelope(op(1, "buy", """{"bookId":"b1","qty":1}""", k)), u1))
        assertEquals(listOf(opError(1, "already_exists", reuse)), fx.server.collect(envelope(op(1, "restock", """{"bookId":"b1","qty":2}""", k)), u1))
        assertNull(fx.store.calls["Command.buy"])
        val replay = fx.server.collect(envelope(op(1, "restock", """{"bookId":"b1","qty":1}""", k)), u1).single()
        assertTrue(replay.replayed(), "guard: same op, same args: $replay")
        assertEquals(1, fx.store.calls["Command.restock"])
    }

    @Test
    fun `D5 the write policy is checked before a replay is served`() = runTest(timeout = 5.seconds) {
        val keys = MemoryIdempotencyStore()
        val data = FixtureStore(Fixtures.data(fixture))
        fun server(schema: RayfoldSchemaIR) = RayfoldServer(schema, FixtureResolvers.build(fixture, data), idempotency = keys)
        val env = envelope(op(1, "restock", restockArgs, key(1)))
        assertNull(server(ir).collect(env, u1).single().errorCode())
        // the operator revokes u1's write access; the idempotency store outlives the deploy
        val isU1 = E.bin("==", E.path("viewer", "id"), E.lit("u1"))
        val revoked = server(ir.withOpAnnotations("restock", E.policy("deny", "write", isU1)))
        assertEquals(listOf(opError(1, "permission_denied", "Not allowed to access restock()")), revoked.collect(env, u1))
        val stillAllowed = server(ir.withOpAnnotations("restock", E.policy("allow", "write", isU1)))
        assertTrue(stillAllowed.collect(env, u1).single().replayed(), "guard: a caller who keeps the permission gets the replay")
        assertEquals(1, data.calls["Command.restock"])
    }

    // ------------------------------------------------------------------ D6 bounded stores

    @Test
    fun `D6 a shape refused at planning is never registered`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer(options = BatchOptions(maxDepth = 1))
        fun idOf(text: String) = Shapes.idOf(Shapes.canonical(Shapes.parse(text), ir))
        fun book(shape: String) = batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"$shape"}""")
        val deep = "{ id author { name } }"
        assertEquals("Shape depth 2 exceeds 1", fx.server.collect(book(deep)).single().errorMessage())
        assertEquals("Unknown shape ${idOf(deep)}", fx.server.collect(book(idOf(deep))).single().errorMessage())
        val overBudget = fixtureServer(options = BatchOptions(budget = 1))
        assertEquals("resource_exhausted", overBudget.server.collect(book("{ title author { name } }")).single().errorCode())
        assertEquals("not_found", overBudget.server.collect(book(idOf("{ title author { name } }"))).single().errorCode(), "a batch over budget registers nothing")
        assertNull(fx.server.collect(book("{ id }")).single().errorCode())
        assertEquals(bookData, fx.server.collect(book(idOf("{ id }"))).single()["data"], "guard: an accepted shape is registered")
    }

    @Test
    fun `D6 inline shapes are capped least recently used first, and server registrations stay`() = runTest(timeout = 5.seconds) {
        assertEquals(10_000, BatchOptions().maxInlineShapes)
        val fx = fixtureServer(options = BatchOptions(maxInlineShapes = 2))
        fun idOf(text: String) = Shapes.idOf(Shapes.canonical(Shapes.parse(text), ir))
        suspend fun code(shape: String) = fx.server.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"$shape"}""")).single().errorCode()
        val pinned = fx.server.registerShape("{ stock }")
        for (s in listOf("{ id }", "{ title }")) assertNull(code(s))
        assertNull(code(idOf("{ id }")), "touch { id }, so { title } is now the least recently used")
        assertNull(code("{ id title }"))
        assertEquals("not_found", code(idOf("{ title }")), "evicted")
        assertNull(code(idOf("{ id }")))
        assertNull(code(idOf("{ id title }")))
        for (s in listOf("{ version }", "{ id version }", "{ title version }")) assertNull(code(s))
        assertNull(code(pinned), "registerShape entries are never evicted")
    }

    @Test
    fun `D6 a stored result expires after the TTL`() = runTest(timeout = 5.seconds) {
        var clock = 0L
        var runs = 0
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ -> runs++; CommandResult(bookRow) })),
            idempotency = MemoryIdempotencyStore(ttlMs = 1_000, now = { clock }))
        val env = envelope(op(1, "restock", restockArgs, key(1)))
        assertFalse(server.collect(env, u1).single().replayed())
        clock = 999
        assertTrue(server.collect(env, u1).single().replayed(), "guard: inside the TTL the key replays")
        clock = 1_000
        assertFalse(server.collect(env, u1).single().replayed(), "expired: the command runs again")
        assertEquals(2, runs)
    }

    @Test
    fun `D6 the memory store sweeps expired records on put, evicts the oldest when full, and never drops a claim in flight`() {
        var clock = 0L
        val rec = IdempotencyRecord("h", JsonObject(emptyMap()), JsonObject(emptyMap()))
        val store = MemoryIdempotencyStore(ttlMs = 100, maxSize = 3, now = { clock })
        assertEquals(100_000, MemoryIdempotencyStore::class.java.getDeclaredField("maxSize").let { f -> f.isAccessible = true; f.get(MemoryIdempotencyStore()) })
        store.record("a", rec); store.record("b", rec)
        clock = 99
        assertEquals(rec, store.get("s", "a"), "guard: not expired yet")
        clock = 100
        store.record("c", rec)
        assertEquals(1, store.size, "a and b expired and the put swept them, without any get")
        store.record("d", rec); store.record("e", rec)
        store.record("f", rec)
        assertEquals(3, store.size, "full: the oldest record made room")
        assertNull(store.get("s", "c"))
        for (k in listOf("d", "e", "f")) assertEquals(rec, store.get("s", k))

        val claims = MemoryIdempotencyStore(maxSize = 2)
        val x = claims.owns("x")
        claims.record("y", rec); claims.record("z", rec)
        assertTrue(claims.claim("s", "x", lease) is IdempotencyClaim.InFlight, "the oldest entry was a claim in flight, so y was evicted instead")
        assertNull(claims.get("s", "y"))
        claims.release("s", "x", x)
        assertTrue(claims.claim("s", "x", lease) is IdempotencyClaim.Owned, "released claims can be taken again")
    }

    @Test
    fun `D6 a full store forgets the oldest key, and the newest still replays`() = runTest(timeout = 5.seconds) {
        var runs = 0
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ -> runs++; CommandResult(bookRow) })), idempotency = MemoryIdempotencyStore(maxSize = 1))
        fun env(n: Int) = envelope(op(1, "restock", restockArgs, key(n)))
        server.collect(env(1), u1); server.collect(env(2), u1)
        assertTrue(server.collect(env(2), u1).single().replayed(), "guard: the newest key replays")
        assertFalse(server.collect(env(1), u1).single().replayed(), "the oldest key was evicted")
        assertEquals(3, runs)
    }

    @Test
    fun `D6 two concurrent runs with one key execute the command once`() = runTest(timeout = 5.seconds) {
        val gate = CompletableDeferred<Unit>()
        var runs = 0
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ -> runs++; gate.await(); CommandResult(bookRow) })))
        val env = envelope(op(1, "restock", restockArgs, key(1), shape = "{ id }"))
        val a = async { server.collect(env, u1) }
        val b = async { server.collect(env, u1) }
        runCurrent() // the first batch is inside the resolver, the second waits on the claim
        assertEquals(1, runs)
        gate.complete(Unit)
        val both = a.await() + b.await()
        assertEquals(1, runs, "before: both ran")
        assertEquals(listOf(false, true), both.map { it.replayed() })
        assertEquals(both[0]["ok"], both[1]["ok"])
    }

    @Test
    fun `D6 guard - when the first run fails, the waiting run takes the key and executes`() = runTest(timeout = 5.seconds) {
        val gate = CompletableDeferred<Unit>()
        var runs = 0
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ ->
            runs++
            if (runs == 1) { gate.await(); throw RayfoldException(Code.UNAVAILABLE, "try again") }
            CommandResult(bookRow)
        })))
        val env = envelope(op(1, "restock", restockArgs, key(1), shape = "{ id }"))
        val a = async { server.collect(env, u1) }
        val b = async { server.collect(env, u1) }
        runCurrent()
        gate.complete(Unit)
        assertEquals(listOf(opError(1, "unavailable", "try again")), a.await())
        val second = b.await().single()
        assertEquals(bookData, second["ok"])
        assertFalse(second.replayed())
        assertEquals(2, runs)
    }

    // ------------------------------------------------------------------ D7 policy comparisons

    private fun payServer(deny: JsonObject): RayfoldServer {
        val pay = OpDef(kind = "command", name = "pay", args = listOf(ArgDef("amount", type = TypeRef("named", "Decimal"))), returns = TypeRef("named", "Book"),
            annotations = listOf(E.policy("deny", "write", deny)))
        return RayfoldServer(withOp(ir, pay), Resolvers(commands = mapOf("pay" to command { _, _ -> CommandResult(bookRow) })))
    }

    @Test
    fun `D7 a deny on a Decimal amount compares exact numbers, not text`() = runTest(timeout = 5.seconds) {
        var n = 0
        suspend fun pay(server: RayfoldServer, amount: String) = server.collect(buildJsonObject {
            put("ops", JsonArray(listOf(buildJsonObject {
                put("id", 1); put("op", "pay"); put("args", buildJsonObject { put("amount", Json.parseToJsonElement(amount)) }); put("key", key(++n))
            })))
        }, u1).single()
        val denied = opError(1, "permission_denied", "Not allowed to access pay()")
        val over1000 = payServer(E.bin(">", E.path("args", "amount"), E.lit(1000)))
        // before: a Decimal travels as a string, a string never ordered against a number, so the deny never fired
        for (a in listOf("\"5000\"", "5000", "\"1000.01\"")) assertEquals(denied, pay(over1000, a), "amount $a")
        for (a in listOf("\"999.99\"", "\"1000\"", "1000")) assertNull(pay(over1000, a).errorCode(), "guard: amount $a")
        val over2p53 = payServer(E.bin(">", E.path("args", "amount"), E.lit(JsonPrimitive(9007199254740992L))))
        assertEquals(denied, pay(over2p53, "\"9007199254740993\""), "exact past 2^53, where doubles round")
        assertNull(pay(over2p53, "\"9007199254740992\"").errorCode(), "guard")
    }

    @Test
    fun `D7 a policy whose comparison cannot be evaluated fails closed`() = runTest(timeout = 5.seconds) {
        val levelOver3 = E.bin(">", E.path("viewer", "level"), E.lit(3))
        val allowFx = fixtureServer { it.withOpAnnotations("book", E.policy("allow", "read", levelOver3)) }
        val denyFx = fixtureServer { it.withOpAnnotations("book", E.policy("deny", "read", levelOver3)) }
        fun viewer(level: String) = obj("""{"id":"u1","level":$level}""")
        val req = batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}""")
        val denied = listOf(opError(1, "permission_denied", "Not allowed to access book()"))
        for (level in listOf("\"high\"", "true", "[5]", """{"n":5}""")) {
            assertEquals(denied, allowFx.server.collect(req, viewer(level)), "allow with level $level")
            assertEquals(denied, denyFx.server.collect(req, viewer(level)), "deny with level $level")
        }
        assertEquals(bookData, allowFx.server.collect(req, viewer("5")).single()["data"], "guard: a number orders")
        assertEquals(bookData, allowFx.server.collect(req, viewer("\"5\"")).single()["data"], "guard: a numeric string orders as a number")
        assertEquals(bookData, denyFx.server.collect(req, viewer("2")).single()["data"], "guard: a deny that does not hold")
        assertEquals(bookData, denyFx.server.collect(req, viewer("null")).single()["data"], "guard: a null comparison is false, not an error")
    }

    // ------------------------------------------------------------------ D8 existence

    @Test
    fun `D8 an entity denied at a nullable position reads as null, exactly like a missing one`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        fun order(id: String) = batch("""{"id":1,"op":"order","args":{"id":"$id"},"shape":"{ id }"}""")
        val hidden = fx.server.collect(order("o0"), u2).single()
        assertEquals(obj("""{"id":1,"data":null,"meta":{"cost":1},"fin":true}"""), hidden, "before: permission_denied told u2 that o0 exists")
        assertEquals(fx.server.collect(order("o404"), u2).single(), hidden)
        assertEquals(obj("""{"${'$'}type":"Order","id":"o0"}"""), fx.server.collect(order("o0"), u1).single()["data"], "guard: the owner sees it")
    }

    @Test
    fun `D8 guard - a denied entity at a non-null position or in a list still fails the op`() = runTest(timeout = 5.seconds) {
        val annOnly = fixtureServer { it.withTypeAnnotations("Author", E.policy("deny", "read", E.bin("==", E.path("this", "name"), E.lit("Ann")))) }
        assertEquals(listOf(opError(1, "permission_denied", "Not allowed to access Author at author", "author")),
            annOnly.server.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id author { name } }"}""")))
        val inStock = fixtureServer { it.withTypeAnnotations("Book", E.policy("deny", "read", E.bin("==", E.path("this", "stock"), E.lit(0)))) }
        assertEquals(listOf(opError(1, "permission_denied", "Not allowed to access Book at items.1", "items.1")),
            inStock.server.collect(batch("""{"id":1,"op":"books","shape":"{ items { id } }"}""")))
    }

    // ------------------------------------------------------------------ D9 depth at the runtime entry

    @Test
    fun `D9 args, vars, ifVersion and meta nested deeper than 64 levels fail the batch before any recursion`() = runTest(timeout = 5.seconds) {
        val server = echoServer()
        // built without a parser: a caller of RayfoldServer.execute can hand over a tree no parser would produce
        val deep = nestedArrays(200_000)
        fun echo(extra: String, value: JsonElement) = buildJsonObject {
            put("id", 1); put("op", "echo"); put("args", if (extra == "args") buildJsonObject { put("v", value) } else JsonObject(emptyMap()))
            if (extra != "args") put(extra, if (extra == "vars") buildJsonObject { put("x", value) } else value)
        }
        for (where in listOf("args", "vars", "ifVersion")) {
            assertEquals(listOf(batchError("invalid_argument", "ops[0].$where: nested deeper than 64 levels")), server.collect(envelope(echo(where, deep))), where)
        }
        assertEquals(listOf(batchError("invalid_argument", "meta: nested deeper than 64 levels")),
            server.collect(envelope(echo("args", JsonNull), meta = buildJsonObject { put("x", deep) })))
        // the args object is one level, so `v` may nest 63 more
        assertEquals(listOf(batchError("invalid_argument", "ops[0].args: nested deeper than 64 levels")), server.collect(envelope(echo("args", nestedArrays(64)))))
        assertEquals(nestedArrays(63), server.collect(envelope(echo("args", nestedArrays(63)))).single()["data"], "guard: 64 levels run")
    }

    @Test
    fun `D9 shape text nested deeper than 64 levels is refused by the parser, however deep`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        fun shape(levels: Int) = "{" + "a{".repeat(levels - 1) + "}".repeat(levels)
        fun book(levels: Int) = buildJsonObject { put("ops", JsonArray(listOf(buildJsonObject { put("id", 1); put("op", "book"); put("args", obj(b1)); put("shape", shape(levels)) }))) }
        for (levels in listOf(65, 50_000)) {
            assertEquals(listOf(opError(1, "invalid_argument", "Bad shape: nested deeper than 64 levels")), fx.server.collect(book(levels)), "$levels levels")
        }
        assertEquals(listOf(opError(1, "invalid_argument", "Book has no field a")), fx.server.collect(book(64)), "guard: 64 levels parse")
    }

    // ------------------------------------------------------------------ D10 simulate

    @Test
    fun `D10 simulate on a command without @simulate is refused and nothing runs`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        assertEquals(listOf(opError(1, "failed_precondition", "restock() does not support dry runs")),
            fx.server.collect(envelope(op(1, "restock", restockArgs, key(1), simulate = true)), u1))
        assertNull(fx.store.calls["Command.restock"])
        assertEquals(JsonPrimitive(2), stockOf(fx.store, "b1"))
    }

    @Test
    fun `D10 guard - a command that declares @simulate runs dry and leaves nothing to replay`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer { it.withOpAnnotations("restock", Annotation("simulate")) }
        val dry = fx.server.collect(envelope(op(1, "restock", restockArgs, key(1), simulate = true)), u1).single()
        assertEquals(JsonPrimitive(7), (dry["ok"] as? JsonObject)?.get("stock"), "$dry")
        assertEquals(JsonPrimitive(2), stockOf(fx.store, "b1"))
        val real = fx.server.collect(envelope(op(1, "restock", restockArgs, key(1))), u1).single()
        assertFalse(real.replayed(), "a dry run stores no result under its key")
        assertEquals(JsonPrimitive(7), stockOf(fx.store, "b1"))
        assertEquals(2, fx.store.calls["Command.restock"])
    }

    // ------------------------------------------------------------------ D13 deadlines

    private val deadlineRule = "expected an integer number of milliseconds from 0 to 600000"

    @Test
    fun `D13 malformed deadlines are refused, the batch one before anything runs and an op one for that op`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        for (d in listOf("-1", "600001", "1.5", "\"100\"", "1e30", "true", "{}")) {
            assertEquals(listOf(batchError("invalid_argument", "meta.deadline: $deadlineRule")),
                fx.server.collect(envelope(op(1, "book", b1), meta = buildJsonObject { put("deadline", Json.parseToJsonElement(d)) })), "meta.deadline $d")
        }
        assertEquals(emptyMap(), fx.store.calls.toMap())
        val frames = fx.server.collect(envelope(op(1, "book", b1, deadline = "-5"), op(2, "book", b1, shape = "{ id }"))).associateBy { it.opId() }
        assertEquals(opError(1, "invalid_argument", "ops[0].deadline: $deadlineRule"), frames[1])
        assertEquals(bookData, frames[2]?.get("data"))
        assertEquals(1, fx.store.calls["Query.book"])
    }

    @Test
    fun `D13 guard - both ends of the deadline range are accepted`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        val max = fx.server.collect(envelope(op(1, "book", b1, shape = "{ id }", deadline = "600000"), meta = obj("""{"deadline":600000}""")))
        assertEquals(bookData, max.single()["data"])
        val zero = fx.server.collect(envelope(op(1, "book", b1), meta = obj("""{"deadline":0}""")))
        assertEquals(listOf(opError(1, "deadline_exceeded", "Batch deadline exceeded")), zero, "0 is valid and already over")
        assertEquals(1, fx.store.calls["Query.book"])
    }

    @Test
    fun `D13 one timer covers the whole batch, not one per op`() = runTest(timeout = 5.seconds) {
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ -> delay(60); CommandResult(bookRow) })))
        val frames = server.collect(envelope(op(1, "restock", restockArgs, key(1)), op(2, "restock", restockArgs, key(2)), meta = obj("""{"deadline":100}""")), u1)
        assertEquals(listOf(1, 2), frames.map { it.opId() })
        assertNull(frames[0].errorCode(), "op 1 finished at 60")
        assertEquals(opError(2, "deadline_exceeded", "Batch deadline exceeded"), frames[1])
        assertEquals(100, currentTime, "a timer per op would have let op 2 finish at 120")
    }

    @Test
    fun `D13 an op deadline is honoured and ends only that op`() = runTest(timeout = 5.seconds) {
        var cancelled = false
        val server = RayfoldServer(ir, Resolvers(queries = mapOf("book" to query { args, _ ->
            if (args["id"] == JsonPrimitive("b1")) {
                try { awaitCancellation() } finally { cancelled = true }
            }
            delay(50)
            bookRow
        })))
        val frames = server.collect(envelope(op(1, "book", b1, deadline = "30"), op(2, "book", """{"id":"b2"}""", shape = "{ id }"))).associateBy { it.opId() }
        assertEquals(opError(1, "deadline_exceeded", "Op deadline exceeded"), frames[1])
        assertEquals(bookData, frames[2]?.get("data"), "guard: the op without a deadline finishes")
        assertTrue(cancelled, "the resolver was cancelled at its deadline")
        assertEquals(50, currentTime)
    }

    // ------------------------------------------------------------------ M6 @format

    @Test
    fun `M6 format matches the whole value, so a line break cannot slip past the end anchor`() = runTest(timeout = 5.seconds) {
        val server = findServer()
        for (v in listOf("abc\n", "abc\r\n", "abc\u0085", "abc\u2028", "abc\u2029", "ab c")) {
            assertEquals(listOf(opError(1, "invalid_argument", "find().slug: must match ^[a-z0-9]+$")), server.collect(find(v)), Canonical.json(JsonPrimitive(v)))
        }
        assertEquals(bookData, server.collect(find("abc")).single()["data"], "guard")
        val digit = findServer("[0-9]")
        assertEquals("invalid_argument", digit.collect(find("a1b")).single().errorCode(), "an unanchored pattern must match all of the value too")
        assertEquals(bookData, digit.collect(find("7")).single()["data"], "guard")
    }

    @Test
    fun `M6 a pattern Java cannot compile is a schema error at startup, not a 500 per request`() {
        val e = assertFailsWith<IllegalArgumentException> { RayfoldServer(findIr("[^]"), Resolvers()) }
        assertTrue(e.message?.startsWith("Schema error: @format pattern [^] on find(slug) does not compile") == true, e.message)
        RayfoldServer(findIr("^[^x]$"), Resolvers()) // guard: a valid pattern constructs
    }

    @Test
    fun `M6 input past 10000 characters is refused before matching`() = runTest(timeout = 5.seconds) {
        val server = findServer()
        assertEquals(listOf(opError(1, "invalid_argument", "find().slug: longer than 10000 characters, too long to match ^[a-z0-9]+$")), server.collect(find("a".repeat(10_001))))
        assertEquals(bookData, server.collect(find("a".repeat(10_000))).single()["data"], "guard: exactly at the cap")
    }

    @Test
    fun `M6 a regex stack overflow is invalid_argument, not a crash`() {
        val schema = findIr("^(a|b)*$")
        val defs = schema.ops["find"]?.args ?: error("no find op")
        // java.util.regex recurses once per repetition here; a small stack overflows well inside the length cap
        fun onSmallStack(slug: String): Any? {
            val out = AtomicReference<Any?>()
            val t = Thread(null, {
                out.set(try { Args.coerce(schema, defs, buildJsonObject { put("slug", slug) }, "find()") } catch (e: Throwable) { e })
            }, "small-stack", 256 * 1024)
            t.start()
            t.join(5_000)
            assertFalse(t.isAlive, "bounded wait")
            return out.get()
        }
        val e = onSmallStack("ab".repeat(5_000)) as? RayfoldException ?: error("expected a RayfoldException")
        assertEquals(Code.INVALID_ARGUMENT, e.code)
        assertEquals("find().slug: too complex to match ^(a|b)*$", e.message)
        assertEquals(buildJsonObject { put("slug", "abab") }, onSmallStack("abab"), "guard: a short value on the same stack matches")
    }

    // ------------------------------------------------------------------ M11 buffering caps

    @Test
    fun `M11 a stream is cut off past maxStreamItems`() = runTest(timeout = 5.seconds) {
        assertEquals(10_000, BatchOptions().maxStreamItems)
        val endless: StreamResolver = { _, _ -> flow { var n = 0; while (true) emit(buildJsonObject { put("n", ++n) }) } }
        val server = RayfoldServer(ir, Resolvers(streams = mapOf("ticks" to endless)), BatchOptions(maxStreamItems = 3))
        val frames = server.collect(batch("""{"id":1,"op":"ticks","args":{"n":1}}"""))
        assertEquals((1..3).map { obj("""{"id":1,"item":{"n":$it}}""") } + opError(1, "resource_exhausted", "ticks() yielded more than 3 items"), frames)
        val three: StreamResolver = { _, _ -> flow { for (n in 1..3) emit(buildJsonObject { put("n", n) }) } }
        val guard = RayfoldServer(ir, Resolvers(streams = mapOf("ticks" to three)), BatchOptions(maxStreamItems = 3)).collect(batch("""{"id":1,"op":"ticks","args":{"n":1}}"""))
        assertEquals((1..3).map { obj("""{"id":1,"item":{"n":$it}}""") } + obj("""{"id":1,"fin":true}"""), guard, "guard: exactly at the cap")
    }

    @Test
    fun `M11 a batch cannot produce more than maxFrames frames`() = runTest(timeout = 5.seconds) {
        assertEquals(100_000, BatchOptions().maxFrames)
        val two = batch("""{"id":1,"op":"ticks","args":{"n":1}}""", """{"id":2,"op":"ticks","args":{"n":1}}""") // each: 2 items and fin
        val capped = fixtureServer(options = BatchOptions(maxFrames = 4)).server.collect(two)
        assertEquals(listOf(obj("""{"code":"resource_exhausted","message":"Batch produced more than 4 frames"}""")), capped.mapNotNull { it["error"] })
        assertEquals(4, capped.count { it["error"] == null })
        val fits = fixtureServer(options = BatchOptions(maxFrames = 6)).server.collect(two)
        assertEquals(6, fits.size, "guard: $fits")
        assertTrue(fits.none { it["error"] != null })
    }

    @Test
    fun `M11 NDJSON frames reach the client while the batch is still running`() {
        val release = CompletableDeferred<Unit>()
        val ticks: StreamResolver = { _, _ -> flow { emit(buildJsonObject { put("n", 1) }); release.await(); emit(buildJsonObject { put("n", 2) }) } }
        val s = serve(server = RayfoldServer(ir, Resolvers(streams = mapOf("ticks" to ticks))))
        val req = HttpRequest.newBuilder(URI("http://127.0.0.1:${s.port}/rayfold")).timeout(Duration.ofSeconds(5)).header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString("""{"ops":[{"id":1,"op":"ticks","args":{"n":1}}]}""")).build()
        val lines = client.send(req, HttpResponse.BodyHandlers.ofLines()).body()
        try {
            val it = lines.iterator()
            fun next(): String = CompletableFuture.supplyAsync { it.next() }.get(5, TimeUnit.SECONDS)
            assertEquals(obj("""{"id":1,"item":{"n":1}}"""), obj(next()), "the first item arrives while the stream is held open")
            release.complete(Unit)
            assertEquals(obj("""{"id":1,"item":{"n":2}}"""), obj(next()))
            assertEquals(obj("""{"id":1,"fin":true}"""), obj(next()))
        } finally {
            release.complete(Unit)
            lines.close()
        }
    }

    // ------------------------------------------------------------------ commands failing after their side effect

    @Test
    fun `a command whose shape fails after the side effect records the failure, so a retry does not run it again`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer { it.withFieldAnnotations("Book", "stock", E.policy("allow", "read", E.bin("==", E.path("viewer", "role"), E.lit("admin")))) }
        val env = envelope(op(1, "restock", restockArgs, key(1), shape = "{ id stock }"))
        val denial = opError(1, "permission_denied", "Not allowed to access Book.stock", "stock")
        assertEquals(listOf(denial), fx.server.collect(env, u1))
        assertEquals(JsonPrimitive(7), stockOf(fx.store, "b1"), "the restock itself happened")
        val retry = fx.server.collect(env, u1).single()
        assertEquals(JsonObject(denial + ("meta" to obj("""{"replay":true}"""))), retry, "before: the retry restocked again")
        assertEquals(JsonPrimitive(7), stockOf(fx.store, "b1"))
        assertEquals(1, fx.store.calls["Command.restock"])
        val unknownField = envelope(op(1, "restock", restockArgs, key(2), shape = "{ id nope }"))
        assertEquals(listOf(opError(1, "invalid_argument", "Book has no field nope")), fx.server.collect(unknownField, u1))
        assertTrue(fx.server.collect(unknownField, u1).single().replayed())
        assertEquals(2, fx.store.calls["Command.restock"])
    }

    @Test
    fun `guard - a command that fails before its side effect is not recorded and runs again on retry`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        val env = envelope(op(1, "buy", """{"bookId":"b2"}""", key(1)))
        repeat(2) { assertEquals("domain", fx.server.collect(env, u1).single().errorCode()) }
        assertEquals(2, fx.store.calls["Command.buy"], "an out-of-stock refusal changes nothing, so a retry may try again")
    }

    // ------------------------------------------------------------------ H5 transport

    @Test
    fun `H5 a stalled upload does not hold up other clients`() {
        val s = serve()
        rawSocket(s, "POST /rayfold HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"ops\":")
        // before: the JDK default executor read that body on the accept thread, and this request timed out behind it
        val res = post(s, bookQuery)
        assertEquals(200, res.statusCode(), res.body())
        assertEquals(bookData, frames(res).single()["data"])
    }

    @Test
    fun `H5 the server drops a client that never finishes its request, freeing the worker`() {
        assertEquals("2", System.getProperty(MAX_REQ_TIME), "build.gradle.kts sets the JDK request timer for tests")
        val s = serve(HttpOptions(threads = 1))
        val stalled = rawSocket(s, "POST /rayfold HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"ops\":")
        // bounded by soTimeout (5 s): a SocketTimeoutException is not a SocketException, so a server that never drops it fails here
        val dropped = try { stalled.getInputStream().read() == -1 } catch (e: SocketException) { true }
        assertTrue(dropped, "the server closed the stalled connection")
        val res = post(s, bookQuery)
        assertEquals(200, res.statusCode(), "the only worker serves the next client")
    }

    /**
     * requestTimeoutSeconds is JVM-wide (see its KDoc): the first start sets the property only when nothing has, so a
     * later server with another value does not move the timer under the servers already running.
     */
    @Test
    fun `H5 a server started with another request timeout leaves the JVM-wide timer as it was`() {
        try {
            serve(HttpOptions(requestTimeoutSeconds = 99))
            assertEquals("2", System.getProperty(MAX_REQ_TIME))
        } finally {
            System.setProperty(MAX_REQ_TIME, "2") // so a failure here does not leak into the tests after it
        }
    }

    @Test
    fun `H5 the listener binds to loopback unless a host is given, and its workers stop with it`() {
        val server = RayfoldServer(ir, Resolvers())
        val loopback = RayfoldHttp(server).start(0)
        started.add(loopback)
        assertEquals("127.0.0.1", loopback.address.address.hostAddress)
        val explicit = RayfoldHttp(server).start(0, host = "127.0.0.2")
        started.add(explicit)
        assertEquals("127.0.0.2", explicit.address.address.hostAddress, "guard: an explicit host is honoured")
        val pool = loopback.executor as? ThreadPoolExecutor ?: error("expected a bounded pool, got ${loopback.executor}")
        assertEquals(16, pool.maximumPoolSize)
        loopback.stop(0)
        assertTrue(pool.isShutdown, "no worker threads outlive the server")
    }

    @Test
    fun `a body over maxBodyBytes is 413 and nothing runs`() {
        val s = serve(HttpOptions(maxBodyBytes = 1024))
        val padded = """{"ops":[{"id":1,"op":"book","args":{"id":"b1"}}],"pad":"${"x".repeat(2000)}"}"""
        problem(post(s, padded), 413, "resource_exhausted", "Body exceeds 1024 bytes", type = "payload_too_large")
        assertNull(s.store.calls["Query.book"])
        assertEquals(200, post(s, bookQuery).statusCode(), "guard: a body under the cap")
    }
}
