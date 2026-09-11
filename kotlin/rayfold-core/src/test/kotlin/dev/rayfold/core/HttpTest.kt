package dev.rayfold.core

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The JDK HTTP transport end to end. JUnit's default per-method lifecycle gives every test its own server and
 * store, and every HTTP call carries a 5 s timeout so a hung exchange fails the test instead of the build.
 */
class HttpTest {
    private val fixture = Fixtures.load("core/03-pipelining.json")
    private val ir = Fixtures.ir(fixture)
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val started = mutableListOf<HttpServer>()
    private lateinit var store: FixtureStore
    private var port = 0

    @BeforeEach
    fun start() {
        store = FixtureStore(Fixtures.data(fixture))
        port = serve(RayfoldServer(ir, FixtureResolvers.build(fixture, store)))
    }

    @AfterEach
    fun stop() {
        started.forEach { it.stop(0) }
        client.shutdownNow()
    }

    private fun serve(server: RayfoldServer): Int {
        val http = RayfoldHttp(server) { ex ->
            val auth = ex.requestHeaders.getFirst("Authorization")
            if (auth != null && auth.startsWith("Bearer ")) buildJsonObject { put("id", auth.removePrefix("Bearer ")); put("role", "customer") } else JsonNull
        }.start(0)
        started.add(http)
        return http.address.port
    }

    private fun send(method: String, path: String, body: String? = null, vararg headers: String): HttpResponse<String> {
        val b = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path"))
            .timeout(Duration.ofSeconds(5))
            .method(method, if (body == null) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(body))
        headers.toList().chunked(2).forEach { (k, v) -> b.header(k, v) }
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString())
    }

    private fun post(body: String, vararg headers: String) = send("POST", "/rayfold", body, "Content-Type", "application/rayfold+json", *headers)
    private fun get(path: String, vararg headers: String) = send("GET", path, null, *headers)
    private fun frames(res: HttpResponse<String>): List<JsonObject> = res.body().trim().split("\n").map { obj(it) }
    private fun header(res: HttpResponse<String>, name: String): String? = res.headers().firstValue(name).orElse(null)
    private fun b64(json: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(json.toByteArray())
    private fun url(s: String) = URLEncoder.encode(s, Charsets.UTF_8)
    private fun problem(res: HttpResponse<String>, status: Int, code: String, detail: String) {
        assertEquals(status, res.statusCode(), res.body())
        assertEquals("application/problem+json", header(res, "Content-Type"))
        val body = obj(res.body())
        assertEquals(JsonPrimitive(code), body["code"])
        assertEquals(JsonPrimitive(detail), body["detail"])
    }

    private val bookB1 = """{"${'$'}type":"Book","id":"b1","title":"T1","stock":2}"""
    private val buyB1 = """{"id":1,"op":"buy","args":{"bookId":"b1","qty":1},"key":"kkkkkkkkkkkkkkkk"}"""

    @Test
    fun `POST streams NDJSON frames and a ref reads the id the command just created`() {
        val res = post(
            """{"ops":[$buyB1,{"id":2,"op":"order","args":{"id":{"${'$'}ref":"1.id"}},"shape":"{ id qty }"}]}""",
            "Authorization", "Bearer u1",
        )
        assertEquals(200, res.statusCode())
        assertEquals("application/rayfold-frames+json", header(res, "Content-Type"))
        assertEquals("no-store", header(res, "Cache-Control"))
        assertEquals(SchemaText.hash(ir), header(res, "Rayfold-Schema"), "the schema hash, as TypeScript computes it")
        val fs = frames(res)
        assertEquals(listOf(1, 2), fs.map { it.opId() })
        val created = (fs[0]["ok"] as? JsonObject)?.get("id") ?: error("buy returned no id: ${fs[0]}")
        assertEquals(created, (fs[1]["data"] as? JsonObject)?.get("id"))
        assertEquals(JsonPrimitive(1), (fs[1]["data"] as? JsonObject)?.get("qty"))
        val stored = store.table("Order").single { it["id"] == created }
        assertEquals(JsonPrimitive("u1"), stored["customerId"], "the viewer comes from the Authorization header")
    }

    @Test
    fun `QUERY is a safe batch that runs queries and is revalidatable`() {
        val res = send("QUERY", "/rayfold", """{"ops":[{"id":1,"op":"book","args":{"id":"b1"}}]}""", "Content-Type", "application/rayfold+json")
        assertEquals(200, res.statusCode(), res.body())
        assertEquals("public, max-age=60", header(res, "Cache-Control"), "Book is @cache(maxAge: 60s, scope: public)")
        assertEquals(obj(bookB1), frames(res).single()["data"])
    }

    @Test
    fun `QUERY carrying a command is refused before anything runs`() {
        val res = send("QUERY", "/rayfold", """{"ops":[$buyB1]}""", "Content-Type", "application/rayfold+json", "Authorization", "Bearer u1")
        problem(res, 400, "invalid_argument", "Safe requests (GET/QUERY) may only contain queries")
        assertNull(store.calls["Command.buy"])
    }

    @Test
    fun `Rayfold-Safe true makes a POST safe, and only the literal true does`() {
        val safeQuery = post("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"}}]}""", "Rayfold-Safe", "true")
        assertEquals("public, max-age=60", header(safeQuery, "Cache-Control"))
        problem(post("""{"ops":[$buyB1]}""", "Rayfold-Safe", "true", "Authorization", "Bearer u1"), 400, "invalid_argument", "Safe requests (GET/QUERY) may only contain queries")
        assertNull(store.calls["Command.buy"])
        val unsafe = post("""{"ops":[$buyB1]}""", "Rayfold-Safe", "false", "Authorization", "Bearer u1")
        assertEquals(200, unsafe.statusCode(), unsafe.body())
        assertEquals("no-store", header(unsafe, "Cache-Control"))
        assertEquals(1, store.calls["Command.buy"])
    }

    @Test
    fun `GET op decodes base64url args, a shape and base64url vars`() {
        val shape = "{ id reviews(page: {first: ${'$'}n}) { total items { id } } }"
        val res = get("/rayfold/book?a=${b64("""{"id":"b1"}""")}&s=${url(shape)}&v=${b64("""{"n":1}""")}")
        assertEquals(200, res.statusCode(), res.body())
        assertEquals("application/rayfold-frames+json", header(res, "Content-Type"))
        assertEquals("public, max-age=60", header(res, "Cache-Control"), "Review declares no @cache, so Book's 60 s stands")
        assertEquals(
            obj("""{"${'$'}type":"Book","id":"b1","reviews":{"total":2,"items":[{"${'$'}type":"Review","id":"r1"}]}}"""),
            frames(res).single()["data"],
        )
    }

    @Test
    fun `GET of a command or an unknown op is refused as unsafe`() {
        problem(get("/rayfold/buy?a=${b64("""{"bookId":"b1"}""")}", "Authorization", "Bearer u1"), 400, "invalid_argument", "Safe requests (GET/QUERY) may only contain queries")
        problem(get("/rayfold/nope"), 400, "invalid_argument", "Safe requests (GET/QUERY) may only contain queries")
        assertNull(store.calls["Command.buy"])
    }

    @Test
    fun `Accept json collapses a single frame into one document`() {
        val res = get("/rayfold/book?a=${b64("""{"id":"b1"}""")}", "Accept", "application/json")
        assertEquals(200, res.statusCode())
        assertEquals("application/json; charset=utf-8", header(res, "Content-Type"))
        assertEquals(obj("""{"id":1,"data":$bookB1,"meta":{"cost":1},"fin":true}"""), obj(res.body()))
    }

    @Test
    fun `Accept json keeps NDJSON for two ops or for one op that yields several frames`() {
        val two = post("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"}},{"id":2,"op":"book","args":{"id":"b2"}}]}""", "Accept", "application/json")
        assertEquals("application/rayfold-frames+json", header(two, "Content-Type"))
        assertEquals(listOf(1, 2), frames(two).map { it.opId() }.sortedBy { it })
        // bio is @lazy: data, then an `at` frame, then fin
        val deferred = post("""{"ops":[{"id":1,"op":"author","args":{"id":"a1"},"shape":"{ id name bio }"}]}""", "Accept", "application/json")
        assertEquals("application/rayfold-frames+json", header(deferred, "Content-Type"))
        assertEquals(3, frames(deferred).size, deferred.body())
    }

    @Test
    fun `single-document mode maps op error codes to HTTP statuses`() {
        fun status(res: HttpResponse<String>, code: String): Int {
            assertEquals(JsonPrimitive(code), (obj(res.body())["error"] as? JsonObject)?.get("code"), res.body())
            return res.statusCode()
        }
        val order = b64("""{"id":"o0"}""")
        assertEquals(401, status(get("/rayfold/order?a=$order", "Accept", "application/json"), "unauthenticated"))
        assertEquals(403, status(get("/rayfold/book?a=${b64("""{"id":"b1"}""")}&s=${url("{ id secret }")}", "Accept", "application/json", "Authorization", "Bearer u2"), "permission_denied"))
        assertEquals(400, status(get("/rayfold/book?a=${b64("{}")}", "Accept", "application/json"), "invalid_argument"))
        assertEquals(404, status(get("/rayfold/book?a=${b64("""{"id":"b1"}""")}&s=sha256:${"0".repeat(64)}", "Accept", "application/json"), "not_found"))
    }

    @Test
    fun `single-document mode maps command failures to 422 and key reuse to 409`() {
        val outOfStock = post("""{"ops":[{"id":1,"op":"buy","args":{"bookId":"b2"},"key":"kkkkkkkkkkkkkkkk"}]}""", "Accept", "application/json", "Authorization", "Bearer u1")
        assertEquals(422, outOfStock.statusCode(), outOfStock.body())
        assertEquals(JsonPrimitive("OutOfStock"), (obj(outOfStock.body())["error"] as? JsonObject)?.get("type"))

        val key = "reuse-key-00000001"
        val first = post("""{"ops":[{"id":1,"op":"buy","args":{"bookId":"b1","qty":1},"key":"$key"}]}""", "Accept", "application/json", "Authorization", "Bearer u1")
        assertEquals(200, first.statusCode(), first.body())
        val reused = post("""{"ops":[{"id":1,"op":"buy","args":{"bookId":"b1","qty":2},"key":"$key"}]}""", "Accept", "application/json", "Authorization", "Bearer u1")
        assertEquals(409, reused.statusCode(), reused.body())
        assertEquals(2, store.calls["Command.buy"], "the out-of-stock attempt and the first buy ran; the reuse did not")
        assertEquals(2, store.table("Order").size, "o0 plus the one new order")
    }

    @Test
    fun `an over-budget batch is 429 as a document and a batch frame in NDJSON`() {
        port = serve(RayfoldServer(ir, FixtureResolvers.build(fixture, store), BatchOptions(budget = 10)))
        val single = get("/rayfold/books", "Accept", "application/json")
        assertEquals(429, single.statusCode(), single.body())
        val stream = get("/rayfold/books")
        assertEquals(200, stream.statusCode())
        assertEquals("resource_exhausted", frames(stream).single().errorCode())
        assertNull(store.calls["Query.books"])
    }

    @Test
    fun `a deadline in the envelope meta cancels a hung resolver and maps to 504`() {
        val cancelled = CountDownLatch(1)
        port = serve(RayfoldServer(ir, Resolvers(queries = mapOf("book" to query { _, _ ->
            try { awaitCancellation() } finally { cancelled.countDown() }
        }))))
        val res = post("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"}}],"meta":{"deadline":1}}""", "Accept", "application/json")
        assertEquals(504, res.statusCode(), res.body())
        assertEquals(obj("""{"id":1,"error":{"code":"deadline_exceeded","message":"Batch deadline exceeded"},"fin":true}"""), obj(res.body()))
        assertTrue(cancelled.await(5, TimeUnit.SECONDS), "the resolver was cancelled, not abandoned")
    }

    @Test
    fun `the viewer is resolved per request`() {
        val order = b64("""{"id":"o0"}""")
        val owner = get("/rayfold/order?a=$order", "Accept", "application/json", "Authorization", "Bearer u1")
        assertEquals(JsonPrimitive("o0"), ((obj(owner.body())["data"] as? JsonObject)?.get("id")), owner.body())
        val other = get("/rayfold/order?a=$order", "Accept", "application/json", "Authorization", "Bearer u2")
        assertEquals(JsonNull, obj(other.body())["data"], "another customer's order is null in the default view")
    }

    @Test
    fun `malformed bodies and query parameters are 400 problems, not 500s`() {
        val bad = post("{nope")
        assertEquals(400, bad.statusCode())
        assertEquals("application/problem+json", header(bad, "Content-Type"))
        assertEquals(
            obj("""{"type":"https://rayfold.dev/errors/invalid_argument","title":"invalid argument","status":400,"detail":"Body is not valid JSON","code":"invalid_argument"}"""),
            obj(bad.body()),
        )
        problem(get("/rayfold/book?a=${url("!!!")}"), 400, "invalid_argument", "Query parameter a is not base64url JSON")
        problem(get("/rayfold/book?a=${b64("""{"id":"b1"}""")}&v=${b64("{nope")}"), 400, "invalid_argument", "Query parameter v is not base64url JSON")
        assertNull(store.calls["Query.book"])
    }

    @Test
    fun `non-object op entries and non-object args are batch errors, not 500s`() {
        val entry = post("""{"ops":[5]}""")
        assertEquals(200, entry.statusCode(), entry.body())
        assertEquals(listOf(obj("""{"error":{"code":"invalid_argument","message":"ops[0]: expected an object"},"fin":true}""")), frames(entry))
        val args = post("""{"ops":[{"id":1,"op":"book","args":[1]}]}""", "Accept", "application/json")
        assertEquals(400, args.statusCode(), args.body())
        assertEquals("ops[0].args: expected an object", obj(args.body()).errorMessage())
        assertNull(store.calls["Query.book"])
    }

    @Test
    fun `unsupported methods and routes are problems`() {
        problem(get("/rayfold"), 501, "unimplemented", "Method GET not allowed on /rayfold")
        problem(send("PUT", "/rayfold/book", ""), 404, "not_found", "No route for PUT /rayfold/book")
        problem(send("POST", "/rayfold/manifest", "{}"), 404, "not_found", "No route for POST /rayfold/manifest")
    }

    @Test
    fun `GET manifest returns the schema IR without policy expressions`() {
        val res = get("/rayfold/manifest")
        assertEquals(200, res.statusCode())
        assertEquals("application/json; charset=utf-8", header(res, "Content-Type"))
        val body = obj(res.body())
        assertEquals(JsonPrimitive("0.1"), body["rayfold"])
        assertEquals(JsonArray(listOf(JsonPrimitive("live"), JsonPrimitive("rb"))), body["extensions"], "this schema binds no REST routes")
        assertEquals(ir.withoutPolicies(), RayfoldSchemaIR.json.decodeFromJsonElement(RayfoldSchemaIR.serializer(), body["schema"] ?: error("manifest has no schema")))
    }

    private fun sendBytes(method: String, body: ByteArray, vararg headers: String): HttpResponse<ByteArray> {
        val b = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold")).timeout(Duration.ofSeconds(5))
            .method(method, HttpRequest.BodyPublishers.ofByteArray(body))
        headers.toList().chunked(2).forEach { (k, v) -> b.header(k, v) }
        return client.send(b.build(), HttpResponse.BodyHandlers.ofByteArray())
    }

    @Test
    fun `RB request and response bodies carry the frames the JSON run carries, on POST and on QUERY`() {
        val rb = RbCodec(ir)
        val batch = """{"ops":[{"id":1,"op":"book","args":{"id":"b1"}},{"id":2,"op":"books","args":{"page":{"first":2}},"shape":"{ total items { id } }"}]}"""
        val res = sendBytes("POST", rb.encode(obj(batch)), "Content-Type", "application/rayfold", "Accept", "application/rayfold")
        assertEquals(200, res.statusCode())
        assertEquals("application/rayfold", res.headers().firstValue("Content-Type").orElse(null))
        assertEquals(frames(post(batch)), rb.decodeFrames(res.body()))
        val safe = sendBytes("QUERY", rb.encode(obj(batch)), "Content-Type", "application/rayfold", "Accept", "application/rayfold")
        assertEquals("public, max-age=60", safe.headers().firstValue("Cache-Control").orElse(null))
        assertEquals(rb.decodeFrames(res.body()), rb.decodeFrames(safe.body()))
        assertEquals("application/rayfold-frames+json", header(post(batch, "Accept", "application/rayfold, application/rayfold-frames+json"), "Content-Type"), "guard: a client that also takes NDJSON gets NDJSON")
    }

    @Test
    fun `a body that is not RB, or an RB value that is not an envelope, is a 400 problem and runs nothing`() {
        for (body in listOf(byteArrayOf(0x0a), RbCodec(ir).encode(JsonPrimitive(1)))) {
            val res = sendBytes("POST", body, "Content-Type", "application/rayfold")
            assertEquals(400, res.statusCode())
            assertEquals(JsonPrimitive("Body is not valid RB"), obj(res.body().toString(Charsets.UTF_8))["detail"])
        }
        assertEquals(emptyMap(), store.calls.toMap())
    }

    @Test
    fun `safe responses carry the schema's cache headers and revalidate with 304, and a signed-in viewer makes them private`() {
        val q = """{"ops":[{"id":1,"op":"book","args":{"id":"b1"}}]}"""
        val first = send("QUERY", "/rayfold", q, "Content-Type", "application/rayfold+json")
        assertEquals("public, max-age=60", header(first, "Cache-Control"))
        assertEquals("Rayfold-Client, Accept, Authorization", header(first, "Vary"))
        val etag = header(first, "ETag") ?: error("no ETag")
        assertTrue(etag.startsWith("\"sha256-"), etag)
        val again = send("QUERY", "/rayfold", q, "Content-Type", "application/rayfold+json", "If-None-Match", etag)
        assertEquals(304, again.statusCode())
        assertEquals("", again.body())
        assertEquals(200, send("QUERY", "/rayfold", q, "Content-Type", "application/rayfold+json", "If-None-Match", "\"sha256-other\"").statusCode(), "guard: another ETag gets the body")
        assertEquals(3, store.calls["Query.book"], "a revalidation runs the query to compare")
        assertEquals("private, max-age=60", header(send("QUERY", "/rayfold", q, "Content-Type", "application/rayfold+json", "Authorization", "Bearer u1"), "Cache-Control"))
        val write = post("""{"ops":[$buyB1]}""", "Authorization", "Bearer u1")
        assertNull(header(write, "ETag"), "guard: a request that can change data gets no ETag")
        assertEquals("no-store", header(write, "Cache-Control"))
    }
}
