package dev.rayfold.core

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.logging.Handler
import java.util.logging.Level
import java.util.logging.LogRecord
import java.util.logging.Logger
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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

    // RayfoldHttp logs through System.Logger, which the JDK hands to the java.util.logging logger of the same name
    private val httpLog: Logger = Logger.getLogger(RayfoldHttp::class.java.name)
    private val logged = CopyOnWriteArrayList<LogRecord>()
    private val capture = object : Handler() {
        override fun publish(record: LogRecord) {
            logged.add(record)
        }
        override fun flush() = Unit
        override fun close() = Unit
    }
    private var levelBefore: Level? = null

    @BeforeEach
    fun start() {
        levelBefore = httpLog.level
        httpLog.level = Level.ALL
        httpLog.useParentHandlers = false
        httpLog.addHandler(capture)
        store = FixtureStore(Fixtures.data(fixture))
        port = serve(RayfoldServer(ir, FixtureResolvers.build(fixture, store)))
    }

    @AfterEach
    fun stop() {
        started.forEach { it.stop(0) }
        client.shutdownNow()
        httpLog.removeHandler(capture)
        httpLog.level = levelBefore
        httpLog.useParentHandlers = true
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
    fun `a compact read gets the cache headers of the types in its result, found from the schema rather than type tags`() {
        fun query(body: String) = send("QUERY", "/rayfold", body, "Content-Type", "application/rayfold+json")
        val compact = query("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }","compact":true}]}""")
        assertEquals(200, compact.statusCode(), compact.body())
        assertFalse("\$type" in compact.body(), "the frame really is compact")
        assertEquals("public, max-age=60", header(compact, "Cache-Control"))

        val page = query("""{"ops":[{"id":1,"op":"books","args":{"page":{"first":2}},"shape":"{ items { id } }","compact":true}]}""")
        assertEquals("public, max-age=60", header(page, "Cache-Control"))

        // guard: Author declares no @cache, so a compact author read stays uncacheable; the walk is not a blanket max-age
        val author = query("""{"ops":[{"id":1,"op":"author","args":{"id":"a1"},"shape":"{ id name }","compact":true}]}""")
        assertEquals("public, max-age=0, no-cache", header(author, "Cache-Control"))
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
    fun `a live query on a request that is otherwise answered whole streams its first result and each change`() {
        // marked safe, sent as QUERY, or one op asked for as plain JSON: each was buffered until the batch ended,
        // which a live query never does, so the caller heard nothing and the worker thread was held for good
        val live = """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}]}"""
        val asks = listOf(
            listOf("POST", "Rayfold-Safe", "true"),
            listOf("QUERY", "X-Nothing", "-"),
            listOf("POST", "Accept", "application/json"),
        )
        var stock = 2
        for ((method, name, value) in asks) {
            val req = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold")).timeout(Duration.ofSeconds(5))
                .header("Content-Type", "application/rayfold+json").header(name, value)
                .method(method, HttpRequest.BodyPublishers.ofString(live)).build()
            val res = client.sendAsync(req, HttpResponse.BodyHandlers.ofLines()).get(5, TimeUnit.SECONDS)
            assertEquals("application/rayfold-frames+json", res.headers().firstValue("Content-Type").orElse(null), "$method $name")
            assertEquals("no-store", res.headers().firstValue("Cache-Control").orElse(null), "never stored, though the request was safe")
            val lines = res.body().filter { it.isNotEmpty() }.iterator()
            assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1","stock":$stock},"meta":{"cost":1}}"""), obj(lines.next()))
            val restock = post("""{"ops":[{"id":1,"op":"restock","args":{"bookId":"b1","qty":1},"key":"${"k$stock".padEnd(16, 'k')}"}]}""", "Authorization", "Bearer u1")
            assertEquals(200, restock.statusCode(), restock.body())
            stock++
            assertEquals(obj("""{"id":1,"patch":[{"set":"Book:b1","value":{"stock":$stock}}]}"""), obj(lines.next()), "$method $name")
            res.body().close()
        }
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
        assertEquals(
            listOf(
                obj("""{"id":1,"data":{"${'$'}type":"Author","id":"a1","name":"Ann"},"meta":{"cost":1}}"""),
                obj("""{"id":1,"at":"","data":{"bio":"Writes."}}"""),
                obj("""{"id":1,"fin":true}"""),
            ),
            frames(deferred),
        )
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
            obj("""{"type":"https://eddyboutros.github.io/rayfold/errors/invalid_argument","title":"invalid argument","status":400,"detail":"Body is not valid JSON","code":"invalid_argument"}"""),
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

    @Test
    fun `the manifest publishes the limits this server was configured with, each under its own name`() {
        // every value differs from its default and from the others, so a limit read from the wrong option shows
        port = serve(RayfoldServer(ir, FixtureResolvers.build(fixture, store), BatchOptions(trustedShapes = true, budget = 77, maxOps = 3, maxDepth = 4, maxFields = 55)))
        assertEquals(
            obj("""{"budget":77,"maxOps":3,"maxDepth":4,"maxFields":55,"trustedShapes":true}"""),
            obj(get("/rayfold/manifest").body())["limits"],
        )
    }

    /** A batch POST through [RayfoldHttp.serve], as a server of its own hands it over; the body stream throws [failure] on the first write. */
    private class Exchange(private val failure: Throwable?) : HttpCall {
        val statuses = mutableListOf<Int>()
        var aborted = false
        val written = ByteArrayOutputStream()
        override val method = "POST"
        override val path = "/rayfold"
        override val rawQuery: String? = null
        override val body: InputStream = """{"ops":[{"id":1,"op":"book","args":{"id":"b1"}}]}""".byteInputStream()
        override val secure = false
        override val localAddress: InetAddress? = null
        override fun header(name: String): String? = mapOf("host" to "localhost", "content-type" to "application/rayfold+json")[name.lowercase()]
        override fun setHeader(name: String, value: String) = Unit
        override fun respond(status: Int, length: Long): OutputStream {
            statuses.add(status)
            return object : OutputStream() {
                override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
                override fun write(b: ByteArray, off: Int, len: Int) {
                    failure?.let { throw it }
                    written.write(b, off, len)
                }
            }
        }
        override fun abort() {
            aborted = true
        }
    }

    private fun serveExchange(exchange: Exchange) = RayfoldHttp(RayfoldServer(ir, FixtureResolvers.build(fixture, store))).serve(exchange, "/rayfold") { JsonNull }

    @Test
    fun `a failure after the response started is logged as an error with its exception, and the exchange is aborted`() {
        val broken = IllegalStateException("the response stream broke")
        val exchange = Exchange(broken)
        serveExchange(exchange)
        assertEquals(listOf(200), exchange.statuses, "the stream had begun, so no problem response follows")
        assertTrue(exchange.aborted)
        val record = logged.single()
        assertEquals(Level.SEVERE, record.level)
        assertTrue(record.thrown.carries(broken), "the log holds the failure: ${record.thrown}")
    }

    // coroutines' stack trace recovery may rethrow a copy that holds the original as its cause
    private fun Throwable?.carries(original: Throwable): Boolean = generateSequence(this) { it.cause }.any { it === original }

    @Test
    fun `a client that went away mid-stream is logged at debug level, not as an error`() {
        val gone = IOException("Broken pipe")
        val exchange = Exchange(gone)
        serveExchange(exchange)
        assertTrue(exchange.aborted)
        val record = logged.single()
        assertEquals(Level.FINE, record.level, "System.Logger's DEBUG")
        assertTrue(record.thrown.carries(gone), "the log holds the failure: ${record.thrown}")
    }

    @Test
    fun `guard - a stream that completes logs nothing and is not aborted`() {
        val exchange = Exchange(null)
        serveExchange(exchange)
        assertEquals(listOf(200), exchange.statuses)
        assertFalse(exchange.aborted)
        assertEquals(obj(bookB1), frames(exchange.written.toString(Charsets.UTF_8)).single()["data"])
        assertEquals(emptyList(), logged.toList())
    }

    private fun frames(body: String): List<JsonObject> = body.trim().split("\n").map { obj(it) }

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

    /**
     * Identity and `GET /rayfold/stats`. Mirrors the TypeScript cases in `packages/server/src/fetch.test.ts`, since a
     * fleet console reads the same document from either runtime.
     */
    private fun serveWithStats(allow: ((HttpCall) -> Boolean)?): Int = serveWithStats(allow, statsServer(FixtureResolvers.build(fixture, store)))

    private fun statsServer(resolvers: Resolvers) = RayfoldServer(
        ir,
        resolvers,
        identity = ServerIdentity(name = "bookshop", version = "1.4.0", labels = mapOf("region" to "eu-west")),
    )

    private fun serveWithStats(allow: ((HttpCall) -> Boolean)?, server: RayfoldServer, viewer: JsonObject? = null): Int {
        val http = RayfoldHttp(server, HttpOptions(stats = allow)) { viewer ?: JsonNull }.start(0)
        started.add(http)
        return http.address.port
    }

    private fun statsAt(p: Int, vararg headers: String): HttpResponse<String> {
        val b = HttpRequest.newBuilder(URI("http://127.0.0.1:$p/rayfold/stats")).timeout(Duration.ofSeconds(5)).GET()
        headers.toList().chunked(2).forEach { (k, v) -> b.header(k, v) }
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString())
    }

    @Test
    fun `stats says who the server is and what it is doing`() {
        val server = statsServer(FixtureResolvers.build(fixture, store))
        val res = statsAt(serveWithStats({ true }, server))
        assertEquals(200, res.statusCode(), res.body())
        assertEquals("no-store", res.headers().firstValue("Cache-Control").orElse(null))
        val body = obj(res.body())
        val id = body["identity"] as JsonObject
        assertEquals(JsonPrimitive("bookshop"), id["name"])
        assertEquals(JsonPrimitive("1.4.0"), id["version"])
        assertEquals(JsonPrimitive("eu-west"), (id["labels"] as JsonObject)["region"])
        assertEquals(JsonPrimitive(server.identity.instance), id["instance"])
        assertEquals(JsonPrimitive(0), body["inflight"])
        assertEquals(JsonPrimitive(false), body["draining"])
        assertEquals(JsonPrimitive(true), body["ready"])
        assertEquals(JsonPrimitive(0), body["live"])
    }

    /** The idle case above reads the same zeros from a server that counts nothing; this one has work to count. */
    @Test
    fun `stats counts a running command and an open live query, and says when it is draining`() {
        val running = CountDownLatch(1)
        val release = CountDownLatch(1)
        val base = FixtureResolvers.build(fixture, store)
        val held = command { _, _ ->
            running.countDown()
            // bounded: a test that fails before releasing must not leave the worker thread parked
            assertTrue(release.await(5, TimeUnit.SECONDS), "the test never released the command")
            obj("""{"id":"b1","title":"Dune","stock":3}""")
        }
        val server = statsServer(Resolvers(base.queries, base.commands + ("restock" to held), base.streams, base.fields))
        val p = serveWithStats({ true }, server, obj("""{"id":"u1"}"""))
        fun stats() = obj(statsAt(p).body()).let { b -> listOf("inflight", "live", "draining", "ready", "reasons").associateWith { b[it] } }
        fun rayfold(body: String) = HttpRequest.newBuilder(URI("http://127.0.0.1:$p/rayfold")).timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json").POST(HttpRequest.BodyPublishers.ofString(body)).build()

        val command = client.sendAsync(rayfold("""{"ops":[{"id":1,"op":"restock","args":{"bookId":"b1","qty":1},"key":"0123456789abcdef"}]}"""), HttpResponse.BodyHandlers.ofString())
        try {
            assertTrue(running.await(5, TimeUnit.SECONDS), "the command running")
            assertEquals(
                mapOf("inflight" to JsonPrimitive(1), "live" to JsonPrimitive(0), "draining" to JsonPrimitive(false), "ready" to JsonPrimitive(true), "reasons" to JsonArray(emptyList())),
                stats(),
            )

            val live = client.sendAsync(rayfold("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }","live":true}]}"""), HttpResponse.BodyHandlers.ofLines())
                .get(5, TimeUnit.SECONDS).body().iterator()
            // a live query subscribes before its first frame is written, so the count is settled once the frame is here
            assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1"},"meta":{"cost":1}}"""), obj(live.next()))
            assertEquals(
                mapOf("inflight" to JsonPrimitive(2), "live" to JsonPrimitive(1), "draining" to JsonPrimitive(false), "ready" to JsonPrimitive(true), "reasons" to JsonArray(emptyList())),
                stats(),
            )
        } finally {
            release.countDown()
        }
        assertEquals(200, command.get(5, TimeUnit.SECONDS).statusCode())

        // drain ends the live query and returns once no batch is left running
        runBlocking { withTimeout(5_000) { server.drain(timeoutMs = 5_000) } }
        assertEquals(
            mapOf("inflight" to JsonPrimitive(0), "live" to JsonPrimitive(0), "draining" to JsonPrimitive(true), "ready" to JsonPrimitive(false), "reasons" to JsonArray(listOf(JsonPrimitive("shutting down")))),
            stats(),
        )
    }

    @Test
    fun `stats does not exist unless it was configured`() {
        // an unconfigured server must look from outside like one that never had the route at all
        assertEquals(404, statsAt(serveWithStats(null)).statusCode())
    }

    @Test
    fun `stats refuses a caller its function turned down`() {
        val p = serveWithStats { it.header("Authorization") == "Bearer ops" }
        assertEquals(403, statsAt(p).statusCode())
        // guard: the same route answers the caller it allows, so the refusal is the function's doing
        assertEquals(200, statsAt(p, "Authorization", "Bearer ops").statusCode())
    }

    @Test
    fun `two servers get different instance ids, and one given is kept`() {
        val a = RayfoldServer(ir, FixtureResolvers.build(fixture, store))
        val b = RayfoldServer(ir, FixtureResolvers.build(fixture, store))
        assertTrue(a.identity.instance != b.identity.instance)
        val named = RayfoldServer(ir, FixtureResolvers.build(fixture, store), identity = ServerIdentity(instance = "web-3"))
        assertEquals("web-3", named.identity.instance)
    }

    /**
     * Counters. Same names as packages/server/src/counters.ts, because a fleet console reads them from either runtime.
     */
    @Test
    fun `counters record a refusal nothing else can see`() {
        val counters = MemoryCounters()
        val server = RayfoldServer(ir, FixtureResolvers.build(fixture, store), counters = counters)
        val http = RayfoldHttp(server, HttpOptions(allowedOrigins = setOf("https://app.example"))) { JsonNull }.start(0)
        started.add(http)
        val p = http.address.port

        // a 415 is answered and returned before a batch is built, so no Instrumentation hook ever sees it
        val b = HttpRequest.newBuilder(URI("http://127.0.0.1:$p/rayfold"))
            .header("Content-Type", "text/plain")
            .POST(HttpRequest.BodyPublishers.ofString("{}"))
            .timeout(Duration.ofSeconds(5))
        assertEquals(415, client.send(b.build(), HttpResponse.BodyHandlers.ofString()).statusCode())
        assertEquals(1, countOf(counters, "rayfold.refused", mapOf("reason" to "media")))
        // guard: the reasons are not interchangeable
        assertEquals(0, countOf(counters, "rayfold.refused", mapOf("reason" to "origin")))
        assertEquals(1L, countOf(counters, "rayfold.requests", mapOf("method" to "POST")))
    }

    @Test
    fun `a full counter sink says so instead of going quiet`() {
        // MemoryUsage stops recording when it is full, which leaves a graph that keeps drawing and stops being true
        val c = MemoryCounters(2)
        c.add("a", mapOf("x" to "1"))
        c.add("b", mapOf("x" to "1"))
        c.add("c", mapOf("x" to "1"))
        assertEquals(2, c.size)
        assertEquals(1L, c.dropped)
        c.add("a", 5, mapOf("x" to "1"))
        assertEquals(6L, countOf(c, "a", mapOf("x" to "1"))) // a series it already knows still counts
    }

    @Test
    fun `counter labels in any order are one series`() {
        val c = MemoryCounters()
        c.add("x", mapOf("a" to "1", "b" to "2"))
        c.add("x", mapOf("b" to "2", "a" to "1"))
        assertEquals(1, c.snapshot().size)
        assertEquals(2L, c.snapshot()[0].count)
    }

    private fun countOf(c: MemoryCounters, name: String, labels: Map<String, String>): Long =
        c.snapshot().firstOrNull { it.name == name && labels.all { (k, v) -> it.labels[k] == v } }?.count ?: 0L

    // ------------------------------------------------------------------ CORS (spec 04 section 4b)

    private fun serveWith(options: HttpOptions): Int {
        val http = RayfoldHttp(RayfoldServer(ir, FixtureResolvers.build(fixture, store)), options) { ex ->
            val auth = ex.requestHeaders.getFirst("Authorization")
            if (auth != null && auth.startsWith("Bearer ")) buildJsonObject { put("id", auth.removePrefix("Bearer ")); put("role", "customer") } else JsonNull
        }.start(0)
        started.add(http)
        return http.address.port
    }

    private fun preflight(p: Int, origin: String): HttpResponse<String> = client.send(
        HttpRequest.newBuilder(URI("http://127.0.0.1:$p/rayfold")).timeout(Duration.ofSeconds(5))
            .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
            .header("Origin", origin).header("Access-Control-Request-Method", "POST").header("Access-Control-Request-Headers", "content-type").build(),
        HttpResponse.BodyHandlers.ofString(),
    )

    @Test
    fun `a preflight from an allowed origin is answered 204 with the headers that let it through, from allowedOrigins alone`() {
        val p = serveWith(HttpOptions(allowedOrigins = setOf("https://app.example")))
        val res = preflight(p, "https://app.example")
        assertEquals(204, res.statusCode(), res.body())
        assertEquals("https://app.example", header(res, "Access-Control-Allow-Origin"))
        assertEquals("GET, POST, QUERY, OPTIONS", header(res, "Access-Control-Allow-Methods"))
        assertEquals("Content-Type, Authorization, Rayfold-Client, Rayfold-Deadline, Rayfold-Safe, Rayfold-Upload-Name, Rayfold-Upload-Type", header(res, "Access-Control-Allow-Headers"))
        assertEquals("Origin", header(res, "Vary"))
        assertEquals("", res.body())
    }

    @Test
    fun `guard - a preflight from another origin gets no Access-Control-Allow headers, so the browser stops there`() {
        val p = serveWith(HttpOptions(allowedOrigins = setOf("https://app.example")))
        val res = preflight(p, "https://evil.example")
        assertEquals(204, res.statusCode(), res.body())
        assertEquals(emptyList(), res.headers().map().keys.filter { it.lowercase().startsWith("access-control-") })
    }

    @Test
    fun `the answer to an allowed origin is readable by it, and a cacheable one varies by origin`() {
        port = serveWith(HttpOptions(allowedOrigins = setOf("https://app.example")))
        val write = post("""{"ops":[$buyB1]}""", "Origin", "https://app.example", "Authorization", "Bearer u1")
        assertEquals(200, write.statusCode(), write.body())
        assertEquals("https://app.example", header(write, "Access-Control-Allow-Origin"))
        val book = "/rayfold/book?a=${b64("""{"id":"b1"}""")}"
        val read = get(book, "Origin", "https://app.example")
        assertEquals("https://app.example", header(read, "Access-Control-Allow-Origin"))
        assertEquals("Rayfold-Client, Accept, Authorization, Origin", header(read, "Vary"))
        // guard: a read from an origin not listed is answered, but not made readable to that origin
        val foreign = get(book, "Origin", "https://evil.example")
        assertEquals(200, foreign.statusCode())
        assertNull(header(foreign, "Access-Control-Allow-Origin"))
        assertEquals("Rayfold-Client, Accept, Authorization", header(foreign, "Vary"))
    }

    // ------------------------------------------------------------------ stale-while-revalidate (spec 07 section 2)

    private fun swrServer(querySwr: String): Int {
        val schema = SchemaText.load("entity Note @cache(maxAge: 60s, swr: 300s) { id: ID } query note: Note @cache(maxAge: 30s$querySwr)").ir
        val http = RayfoldHttp(RayfoldServer(schema, Resolvers(queries = mapOf("note" to { _, _ -> obj("""{"id":"n1"}""") })))).start(0)
        started.add(http)
        return http.address.port
    }

    @Test
    fun `stale-while-revalidate takes the smallest swr, as max-age takes the smallest maxAge`() {
        port = swrServer(", swr: 10s")
        assertEquals("public, max-age=30, stale-while-revalidate=10", header(get("/rayfold/note"), "Cache-Control"))
    }

    @Test
    fun `guard - a declaration without swr does not count, so the one that has it decides`() {
        port = swrServer("")
        assertEquals("public, max-age=30, stale-while-revalidate=300", header(get("/rayfold/note"), "Cache-Control"))
    }
}
