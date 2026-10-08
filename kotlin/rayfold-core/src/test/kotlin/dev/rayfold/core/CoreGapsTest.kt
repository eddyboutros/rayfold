package dev.rayfold.core

import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.net.InetAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * What the mutation sweep found no test for: how a live query describes a change (the same entity in two places, a row
 * replaced, a selection's own fields, a plain object, deferred rows), what reaches the relay, the shape grammar's
 * edges and the identity of a shape, cost weights, the Host and Origin rules, a chunked body at the limit, and the
 * upload store's lifetime and bound at their exact edges. Each through the entry point a caller uses.
 */
class CoreGapsTest {
    private val t = "${'$'}type"
    private val started = mutableListOf<com.sun.net.httpserver.HttpServer>()
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

    @AfterEach
    fun stop() {
        started.forEach { it.stop(0) }
        client.shutdownNow()
    }

    private class LiveRun(scope: kotlinx.coroutines.CoroutineScope, server: RayfoldServer, op: String) {
        val cancel = Job()
        private val channel = Channel<JsonObject>(Channel.UNLIMITED)
        val job = scope.launch {
            try { server.execute(obj("""{"ops":[$op]}"""), ExecuteOptions(cancel = cancel)).collect { channel.send(it) } } finally { channel.close() }
        }
        suspend fun next(): JsonObject = withTimeout(5_000) { channel.receive() }
        suspend fun stop() { cancel.complete(); job.join() }
    }

    // ---------------------------------------------------------------- live diffs

    @Test
    fun `an entity that appears twice with other fields is one entity to a live query, so a change to either part is heard`() = runTest(timeout = 5.seconds) {
        var name = "Ann"
        val s = RayfoldServer(
            SchemaText.load("entity Author { id: ID name: String bio: String } object Two { a: Author b: Author } query two: Two").ir,
            Resolvers(queries = mapOf("two" to { _, _ -> obj("""{"a":{"id":"a1","name":"$name","bio":"x"},"b":{"id":"a1","name":"$name","bio":"x"}}""") })),
        )
        val live = LiveRun(this, s, """{"id":1,"op":"two","shape":"{ a { id name } b { id bio } }","live":true}""")
        live.next()
        name = "Anna"
        s.changes.publish(Change(setOf("Author:a1"), emptySet()))
        assertEquals(obj("""{"id":1,"patch":[{"set":"Author:a1","value":{"name":"Anna"}}]}"""), live.next())
        live.stop()
        assertEquals(0, s.changes.size)
    }

    private val shelf = SchemaText.load(
        """
        entity Book { id: ID title: String stock: Int bio: String? @lazy }
        entity Author { id: ID name: String books: [Book] }
        object Stats { total: Int note: String }
        query books: [Book]
        query author: Author
        query stats: Stats
        """,
    ).ir

    private class Shelf {
        @Volatile var books = listOf("b1", "b2", "b3", "b4")
        @Volatile var bio = "old"
        @Volatile var total = 1
    }

    private fun shelfServer(sh: Shelf) = RayfoldServer(
        shelf,
        Resolvers(
            queries = mapOf(
                "books" to { _, _ -> JsonArray(sh.books.map { obj("""{"id":"$it","title":"T$it","stock":1}""") }) },
                "author" to { _, _ -> obj("""{"id":"a1","name":"Ann","books":[${sh.books.joinToString(",") { """{"id":"$it","title":"T$it","stock":1}""" }}]}""") },
                "stats" to { _, _ -> obj("""{"total":${sh.total},"note":"a note long enough that a patch for the total is the cheaper message"}""") },
            ),
            fields = mapOf("Book" to mapOf("bio" to { ps, _, _ -> ps.map { JsonPrimitive(sh.bio) } })),
        ),
    )

    @Test
    fun `a row replaced in a live list goes out as a deletion and an insertion, not the whole result again`() = runTest(timeout = 5.seconds) {
        val sh = Shelf()
        val s = shelfServer(sh)
        val live = LiveRun(this, s, """{"id":1,"op":"books","shape":"{ id title }","live":true}""")
        live.next()
        sh.books = listOf("b1", "b2", "b3", "b5")
        s.changes.publish(Change(setOf("Book:b4", "Book:b5"), emptySet()))
        assertEquals(obj("""{"id":1,"patch":[{"list":"","del":[3],"ins":[{"at":3,"value":{"$t":"Book","id":"b5","title":"Tb5"}}]}]}"""), live.next())
        live.stop()
    }

    @Test
    fun `a result sent whole again carries the selection's own fields`() = runTest(timeout = 5.seconds) {
        val sh = Shelf()
        val s = shelfServer(sh)
        val live = LiveRun(this, s, """{"id":1,"op":"books","shape":"{ id left: stock }","live":true}""")
        live.next()
        sh.books = listOf("b4", "b3", "b2", "b1") // a reorder cannot be described, so the result goes out whole
        s.changes.publish(Change(setOf("Book:b1"), emptySet()))
        assertEquals(
            obj("""{"id":1,"data":[{"$t":"Book","id":"b4","left":1},{"$t":"Book","id":"b3","left":1},{"$t":"Book","id":"b2","left":1},{"$t":"Book","id":"b1","left":1}],"meta":{"cost":1}}"""),
            live.next(),
        )
        live.stop()
    }

    @Test
    fun `a plain object's aliased field is its own, so a change to it goes out in place`() = runTest(timeout = 5.seconds) {
        val sh = Shelf()
        val s = shelfServer(sh)
        val live = LiveRun(this, s, """{"id":1,"op":"stats","shape":"{ n: total note }","live":true}""")
        live.next()
        sh.total = 2
        s.changes.publish(Change(emptySet(), setOf("stats")))
        assertEquals(obj("""{"id":1,"patch":[{"at":"","value":{"n":2}}]}"""), live.next())
        live.stop()
    }

    @Test
    fun `a deferred field of a row in a live list is part of what it watches`() = runTest(timeout = 5.seconds) {
        val sh = Shelf().apply { books = listOf("b1", "b2") }
        val s = shelfServer(sh)
        val live = LiveRun(this, s, """{"id":1,"op":"books","shape":"{ id bio }","live":true}""")
        assertEquals(obj("""{"id":1,"data":[{"$t":"Book","id":"b1"},{"$t":"Book","id":"b2"}],"meta":{"cost":1}}"""), live.next())
        assertEquals(obj("""{"id":1,"at":"0","data":{"bio":"old"}}"""), live.next())
        assertEquals(obj("""{"id":1,"at":"1","data":{"bio":"old"}}"""), live.next())
        sh.bio = "new"
        s.changes.publish(Change(setOf("Book:b1"), emptySet()))
        assertEquals(obj("""{"id":1,"patch":[{"set":"Book:b1","value":{"bio":"new"}},{"set":"Book:b2","value":{"bio":"new"}}]}"""), live.next())
        live.stop()
    }

    @Test
    fun `a command that changed nothing sends nothing to the other servers, and one that changed something does (guard)`() = runBlocking {
        val relay = MemoryRelay()
        val heard = CopyOnWriteArrayList<String>()
        val got = CountDownLatch(1)
        val s = RayfoldServer(
            SchemaText.load("entity Book { id: ID } command nothing: Book? @idempotent(false) command make: Book @idempotent(false)").ir,
            Resolvers(commands = mapOf("nothing" to { _, _ -> JsonNull }, "make" to { _, _ -> obj("""{"id":"b1"}""") })),
            relay = relay.join(),
        )
        withTimeout(5_000) { s.ready() }
        val stop = relay.join().subscribe { m -> heard.add(if (m is RelayMessage.Change) "change ${m.keys}" else "event"); got.countDown() }
        withTimeout(5_000) { s.collect(obj("""{"ops":[{"id":1,"op":"nothing"}]}""")) }
        withTimeout(5_000) { s.collect(obj("""{"ops":[{"id":1,"op":"make","shape":"{ id }"}]}""")) }
        assertTrue(got.await(5, TimeUnit.SECONDS))
        assertEquals(listOf("change [Book:b1]"), heard.toList(), "the empty change of the first command never left")
        stop()
        withTimeout(5_000) { s.close() }
    }

    // ---------------------------------------------------------------- the shape grammar

    private val echo = SchemaText.load("entity Thing { id: ID n(v: Int): Int } query thing: Thing").ir
    private val echoServer = RayfoldServer(echo, Resolvers(
        queries = mapOf("thing" to { _, _ -> obj("""{"id":"t1"}""") }),
        fields = mapOf("Thing" to mapOf("n" to { ps, a, _ -> ps.map { a["v"] } })),
    ))

    private fun shaped(shape: String): JsonObject = runBlocking {
        withTimeout(5_000) { echoServer.collect(obj("""{"ops":[{"id":1,"op":"thing","shape":${JsonPrimitive(shape)}}]}""")) }.single()
    }

    @Test
    fun `the shape grammar reads durations, and refuses what it does not define`() {
        assertEquals(obj("""{"id":1,"data":{"$t":"Thing","n":2000},"meta":{"cost":1},"fin":true}"""), shaped("{ n(v: 2s) }"))
        val refused = mapOf(
            "{ id } /* not closed" to "Bad shape: unterminated block comment",
            "{ n(v: 1.) }" to "Bad shape: expected a name",
            "{ n(v: 1.5s) }" to "Bad shape: expected ':'",
        )
        for ((shape, message) in refused) {
            assertEquals(obj("""{"id":1,"error":{"code":"invalid_argument","message":"$message"},"fin":true}"""), shaped(shape), shape)
        }
    }

    @Test
    fun `a shape's id does not depend on the order of its items, arguments included`() {
        val s = RayfoldServer(echo, Resolvers())
        assertEquals(s.registerShape("{ a: n(v: 2) a: n(v: 1) }"), s.registerShape("{ a: n(v: 1) a: n(v: 2) }"))
        // guard: other arguments are another shape
        assertTrue(s.registerShape("{ a: n(v: 1) }") != s.registerShape("{ a: n(v: 2) }"))
    }

    @Test
    fun `a field aliased to its own name is the entity's field, and an alias inside a view is the selection's`() = runTest(timeout = 5.seconds) {
        val s = RayfoldServer(
            SchemaText.load("entity Book { id: ID stock: Int } view Book.card = { left: stock } command restock: Book @idempotent(false)").ir,
            Resolvers(commands = mapOf("restock" to { _, _ -> obj("""{"id":"b1","stock":4}""") })),
        )
        assertEquals(
            obj("""{"id":1,"ok":{"$t":"Book","id":"b1","stock":4},"patch":[{"set":"Book:b1","value":{"$t":"Book","id":"b1","stock":4}}],"meta":{"cost":1},"fin":true}"""),
            s.collect(obj("""{"ops":[{"id":1,"op":"restock","shape":"{ id stock: stock }"}]}""")).single(),
        )
        assertEquals(
            obj("""{"id":1,"ok":{"$t":"Book","id":"b1","left":4},"patch":[{"set":"Book:b1","value":{"$t":"Book","id":"b1"}}],"meta":{"cost":1},"fin":true}"""),
            s.collect(obj("""{"ops":[{"id":1,"op":"restock","shape":"{ id ...Book.card }"}]}""")).single(),
        )
    }

    // ---------------------------------------------------------------- cost

    @Test
    fun `a negative cost weight counts as nothing, so it cannot lower what the other fields add up to`() = runTest(timeout = 5.seconds) {
        val s = RayfoldServer(
            SchemaText.load("entity A { id: ID } entity B { id: ID a: A @cost(base: -3) c: A d: A } query b: B").ir,
            Resolvers(queries = mapOf("b" to { _, _ -> obj("""{"id":"b1","a":{"id":"x"},"c":{"id":"y"},"d":{"id":"z"}}""") })),
        )
        assertEquals(JsonPrimitive(3), (s.collect(obj("""{"ops":[{"id":1,"op":"b","shape":"{ a { id } c { id } d { id } }"}]}""")).single()["meta"] as JsonObject)["cost"])
    }

    @Test
    fun `a page argument that is not an object is costed as the largest page, so a batch cannot slip under its budget with it`() = runTest(timeout = 5.seconds) {
        val s = RayfoldServer(
            SchemaText.load("entity Book { id: ID } query book(id: ID): Book query shelf(id: ID, page: PageArgs): Page<Book>").ir,
            Resolvers(queries = mapOf("book" to { _, _ -> obj("""{"id":"b1"}""") })),
            BatchOptions(budget = 100),
        )
        val refused = s.collect(obj("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"},{"id":2,"op":"shelf","args":{"id":{"${'$'}ref":"1.id"},"page":"x"},"shape":"{ items { id } }"}]}"""))
        assertEquals(1, refused.size)
        assertEquals("resource_exhausted", refused.single().errorCode(), "${refused.single()}")
    }

    @Test
    fun `an Instant argument must carry its offset`() = runTest(timeout = 5.seconds) {
        val s = RayfoldServer(SchemaText.load("query at(t: Instant): String").ir, Resolvers(queries = mapOf("at" to { a, _ -> a["t"] })))
        assertEquals(
            obj("""{"id":1,"error":{"code":"invalid_argument","message":"at().t: expected Instant (RFC 3339)"},"fin":true}"""),
            s.collect(obj("""{"ops":[{"id":1,"op":"at","args":{"t":"2026-10-08T10:00:00"}}]}""")).single(),
        )
        assertEquals(obj("""{"id":1,"data":"2026-10-08T10:00:00Z","meta":{"cost":1},"fin":true}"""), s.collect(obj("""{"ops":[{"id":1,"op":"at","args":{"t":"2026-10-08T10:00:00Z"}}]}""")).single())
    }

    // ---------------------------------------------------------------- Host, Origin and body limits

    @Test
    fun `an allowed host may be listed with its port, and the request that names it is answered`() {
        val server = RayfoldServer(echo, Resolvers(queries = mapOf("thing" to { _, _ -> obj("""{"id":"t1"}""") })))
        val probe = RayfoldHttp(server, HttpOptions()).start(0).also { started.add(it) }
        val port = probe.address.port
        probe.stop(0)
        val http = RayfoldHttp(server, HttpOptions(allowedHosts = setOf("127.0.0.1:$port"))).start(port).also { started.add(it) }
        val res = client.send(
            HttpRequest.newBuilder(URI("http://127.0.0.1:${http.address.port}/rayfold")).timeout(Duration.ofSeconds(5))
                .header("Content-Type", "application/rayfold+json").POST(HttpRequest.BodyPublishers.ofString("""{"ops":[{"id":1,"op":"thing","shape":"{ id }"}]}""")).build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        assertEquals(200, res.statusCode(), res.body())
        assertNull(Guard.hostProblem("127.0.0.1:$port", InetAddress.getLoopbackAddress(), setOf("127.0.0.1:$port")))
        assertEquals("Host 127.0.0.1:1 is not allowed", Guard.hostProblem("127.0.0.1:1", InetAddress.getLoopbackAddress(), setOf("127.0.0.1:$port")), "guard: another port is another host")
    }

    @Test
    fun `an origin is the server's own whatever the case of the Host header`() {
        assertNull(Guard.originProblem("http://app.example:8080", "App.Example:8080", emptySet()))
        assertEquals("Origin http://app.example:8081 is not allowed", Guard.originProblem("http://app.example:8081", "App.Example:8080", emptySet()), "guard: another port")
    }

    @Test
    fun `a chunked MCP body one byte over the limit is refused, and one at the limit is answered`() {
        val body = """{"jsonrpc":"2.0","id":1,"method":"ping"}"""
        val bs = Bookstore()
        val mcp = RayfoldMcp(bs.server, McpOptions(maxBodyBytes = body.length - 1))
        val at = RayfoldMcp(bs.server, McpOptions(path = "/at", maxBodyBytes = body.length))
        val http = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        http.createContext("/") { ex -> if (!mcp.handle(ex) && !at.handle(ex)) { ex.sendResponseHeaders(404, -1); ex.close() } }
        http.start()
        started.add(http)
        fun chunked(path: String) = client.send(
            HttpRequest.newBuilder(URI("http://127.0.0.1:${http.address.port}$path")).timeout(Duration.ofSeconds(5)).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofInputStream { ByteArrayInputStream(body.toByteArray()) }).build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        assertEquals(413, chunked("/mcp").statusCode())
        val ok = chunked("/at")
        assertEquals(200 to obj("""{"jsonrpc":"2.0","id":1,"result":{}}"""), ok.statusCode() to obj(ok.body()))
    }

    // ---------------------------------------------------------------- the upload store's edges

    @Test
    fun `an upload is gone at exactly its lifetime, read or swept, and the store holds exactly its bound`() = runTest(timeout = 5.seconds) {
        var clock = 0L
        val viewer = obj("""{"id":"u1"}""")
        val store = MemoryUploadStore(ttlMs = 100, maxBytes = 2_048, now = { clock })
        val first = store.put(ByteArrayInputStream(ByteArray(10)), null, null, viewer)
        clock = 99
        assertEquals(first, store.open(first.id)?.first, "a millisecond inside its lifetime")
        clock = 100
        assertNull(store.open(first.id), "read at its lifetime")
        val second = store.put(ByteArrayInputStream(ByteArray(10)), null, null, viewer)
        clock = 200
        store.put(ByteArrayInputStream(ByteArray(10)), null, null, viewer)
        assertEquals(1, store.size, "swept at its lifetime by the next write")
        assertNull(store.open(second.id))
        // the bound: exactly full stays, one byte over evicts the oldest
        val bounded = MemoryUploadStore(maxBytes = 2_048, now = { clock })
        val a = bounded.put(ByteArrayInputStream(ByteArray(1_024)), null, null, viewer)
        bounded.put(ByteArrayInputStream(ByteArray(1_024)), null, null, viewer)
        assertEquals(2 to 2_048L, bounded.size to bounded.bytes)
        bounded.put(ByteArrayInputStream(ByteArray(1)), null, null, viewer)
        assertNull(bounded.open(a.id))
        assertEquals(2 to 1_025L, bounded.size to bounded.bytes)
    }

    // ---------------------------------------------------------------- RayfoldHttp's response headers

    private fun httpServe(options: HttpOptions = HttpOptions()): Int {
        val s = RayfoldServer(
            SchemaText.load("entity Thing { id: ID } query thing: Thing stream ticks: Int").ir,
            Resolvers(
                queries = mapOf("thing" to { _, _ -> obj("""{"id":"t1"}""") }),
                streams = mapOf("ticks" to { _, _ -> kotlinx.coroutines.flow.flowOf(JsonPrimitive(1), JsonPrimitive(2)) }),
            ),
        )
        return RayfoldHttp(s, options).start(0).also { started.add(it) }.address.port
    }

    private fun send(port: Int, method: String, path: String, body: String?, vararg headers: String): HttpResponse<String> {
        val b = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path")).timeout(Duration.ofSeconds(5))
            .method(method, if (body == null) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(body))
        headers.toList().chunked(2).forEach { (k, v) -> b.header(k, v) }
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString())
    }

    @Test
    fun `a stream asked for as one JSON document still streams, and is never stored`() {
        val port = httpServe()
        val res = send(port, "POST", "/rayfold", """{"ops":[{"id":1,"op":"ticks"}]}""", "Content-Type", "application/rayfold+json", "Accept", "application/json")
        assertEquals(200 to "application/rayfold-frames+json", res.statusCode() to res.headers().firstValue("Content-Type").orElse(null))
        assertEquals("no", res.headers().firstValue("X-Accel-Buffering").orElse(null), "streamed as it is produced, not buffered")
        assertEquals("no-store", res.headers().firstValue("Cache-Control").orElse(null))
        assertEquals("""{"id":1,"item":1}""" + "\n" + """{"id":1,"item":2}""" + "\n" + """{"fin":true,"id":1}""" + "\n", res.body())
        // guard: a query by GET is a cacheable answer
        assertEquals("public, max-age=0, no-cache", send(port, "GET", "/rayfold/thing", null).headers().firstValue("Cache-Control").orElse(null))
    }

    @Test
    fun `a batch answered as one JSON document that was not sent as safe is never stored`() {
        val port = httpServe()
        val res = send(port, "POST", "/rayfold", """{"ops":[{"id":1,"op":"thing","shape":"{ id }"}]}""", "Content-Type", "application/rayfold+json", "Accept", "application/json")
        assertEquals(200, res.statusCode())
        assertEquals("no-store", res.headers().firstValue("Cache-Control").orElse(null))
        assertEquals(obj("""{"id":1,"data":{"$t":"Thing","id":"t1"},"meta":{"cost":1},"fin":true}"""), obj(res.body()))
    }

    @Test
    fun `allowed origins of star answer any origin's preflight with that origin`() {
        val port = httpServe(HttpOptions(allowedOrigins = setOf("*")))
        val res = send(port, "OPTIONS", "/rayfold", null, "Origin", "https://anywhere.example", "Access-Control-Request-Method", "POST")
        assertEquals(204, res.statusCode())
        assertEquals("https://anywhere.example", res.headers().firstValue("Access-Control-Allow-Origin").orElse(null))
        assertEquals("GET, POST, QUERY, OPTIONS", res.headers().firstValue("Allow").orElse(null))
        // guard: without the star, the same origin gets none
        val none = send(httpServe(), "OPTIONS", "/rayfold", null, "Origin", "https://anywhere.example", "Access-Control-Request-Method", "POST")
        assertEquals(null, none.headers().firstValue("Access-Control-Allow-Origin").orElse(null))
    }

    // ---------------------------------------------------------------- more of RayfoldHttp

    @Test
    fun `a batch of several ops asked for as JSON streams its frames, unbuffered`() {
        val port = httpServe()
        val res = send(port, "POST", "/rayfold", """{"ops":[{"id":1,"op":"thing","shape":"{ id }"},{"id":2,"op":"thing","shape":"{ id }"}]}""", "Content-Type", "application/rayfold+json", "Accept", "application/json")
        assertEquals("no" to "application/rayfold-frames+json", res.headers().firstValue("X-Accel-Buffering").orElse(null) to res.headers().firstValue("Content-Type").orElse(null))
        // guard: one op asked for as JSON is one document, buffered
        val one = send(port, "POST", "/rayfold", """{"ops":[{"id":1,"op":"thing","shape":"{ id }"}]}""", "Content-Type", "application/rayfold+json", "Accept", "application/json")
        assertEquals(null to "application/json; charset=utf-8", one.headers().firstValue("X-Accel-Buffering").orElse(null) to one.headers().firstValue("Content-Type").orElse(null))
    }

    @Test
    fun `a Rayfold-Deadline header that is not a whole number is ignored, and trace context reaches the batch whole`() {
        val metas = CopyOnWriteArrayList<JsonObject>()
        val s = RayfoldServer(
            SchemaText.load("entity Thing { id: ID } query thing: Thing").ir,
            Resolvers(queries = mapOf("thing" to { _, _ -> obj("""{"id":"t1"}""") })),
            instrumentation = object : Instrumentation {
                override suspend fun batch(info: BatchInfo, run: suspend () -> Outcome): Outcome { metas.add(info.meta); return run() }
            },
        )
        val port = RayfoldHttp(s, HttpOptions()).start(0).also { started.add(it) }.address.port
        val res = send(
            port, "POST", "/rayfold", """{"ops":[{"id":1,"op":"thing","shape":"{ id }"}]}""", "Content-Type", "application/rayfold+json",
            "Rayfold-Deadline", "-5", "traceparent", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", "tracestate", "vendor=opaque",
        )
        assertEquals(200, res.statusCode(), res.body())
        assertEquals(listOf(obj("""{"traceparent":"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01","tracestate":"vendor=opaque"}""")), metas.toList())
    }

    @Test
    fun `stats says how many counter series it dropped once its sink is full`() {
        val counters = MemoryCounters(max = 1)
        val s = RayfoldServer(SchemaText.load("entity Thing { id: ID } query thing: Thing").ir, Resolvers(queries = mapOf("thing" to { _, _ -> obj("""{"id":"t1"}""") })), counters = counters)
        val port = RayfoldHttp(s, HttpOptions(stats = { true })).start(0).also { started.add(it) }.address.port
        send(port, "POST", "/rayfold", """{"ops":[{"id":1,"op":"thing","shape":"{ id }"}]}""", "Content-Type", "application/rayfold+json")
        val stats = obj(send(port, "GET", "/rayfold/stats", null).body())
        assertTrue(counters.dropped > 0, "the batch counted more series than one")
        assertEquals(JsonPrimitive(counters.dropped), stats["countersDropped"])
    }

    @Test
    fun `a private cache scope makes an anonymous answer private`() {
        val s = RayfoldServer(
            SchemaText.load("entity Thing { id: ID } query mine: Thing @cache(maxAge: 60s, scope: private) query open: Thing @cache(maxAge: 60s)").ir,
            Resolvers(queries = mapOf("mine" to { _, _ -> obj("""{"id":"t1"}""") }, "open" to { _, _ -> obj("""{"id":"t1"}""") })),
        )
        val port = RayfoldHttp(s, HttpOptions()).start(0).also { started.add(it) }.address.port
        assertEquals("private, max-age=60", send(port, "GET", "/rayfold/mine", null).headers().firstValue("Cache-Control").orElse(null))
        assertEquals("public, max-age=60", send(port, "GET", "/rayfold/open", null).headers().firstValue("Cache-Control").orElse(null), "guard")
    }

    // ---------------------------------------------------------------- the WebSocket session

    private class Session(server: RayfoldServer, viewer: kotlinx.serialization.json.JsonElement, onFrame: (Session, JsonObject) -> Unit = { _, _ -> }) {
        val frames = java.util.concurrent.LinkedBlockingQueue<JsonObject>()
        val session: RayfoldWsSession = RayfoldWsSession(server, viewer, { text -> obj(text).let { frames.add(it); onFrame(this, it) } }, { })
        fun next(): JsonObject = frames.poll(5, TimeUnit.SECONDS) ?: error("no frame within 5 s")
    }

    private val clocked = SchemaText.load("entity Thing { id: ID } query thing: Thing").ir

    private fun clockedServer(now: Long) = RayfoldServer(clocked, Resolvers(queries = mapOf("thing" to { _, _ -> obj("""{"id":"t1"}""") })), now = { now })

    private val thingAnswer get() = obj("""{"id":1,"data":{"$t":"Thing","id":"t1"},"meta":{"cost":1},"fin":true}""")

    @Test
    fun `a capability is expired from the very millisecond of its exp, served the millisecond before, and an exp in text is none`() {
        val expired = Session(clockedServer(1_000), obj("""{"id":"u1","caps":{"exp":1000}}"""))
        expired.session.onText("""{"ops":[{"id":1,"op":"thing","shape":"{ id }"}]}""")
        assertEquals(obj("""{"id":1,"error":{"code":"unauthenticated","message":"Capability has expired"},"fin":true}"""), expired.next())
        expired.session.close()
        val before = Session(clockedServer(999), obj("""{"id":"u1","caps":{"exp":1000}}"""))
        before.session.onText("""{"ops":[{"id":1,"op":"thing","shape":"{ id }"}]}""")
        assertEquals(thingAnswer, before.next())
        before.session.close()
        val text = Session(clockedServer(5_000), obj("""{"id":"u1","caps":{"exp":"1000"}}"""))
        text.session.onText("""{"ops":[{"id":1,"op":"thing","shape":"{ id }"}]}""")
        assertEquals(thingAnswer, text.next())
        text.session.close()
    }

    @Test
    fun `an expired capability's envelope without op ids is refused as a whole`() {
        val s = Session(clockedServer(2_000), obj("""{"id":"u1","caps":{"exp":1000}}"""))
        s.session.onText("""{"ops":[]}""")
        assertEquals(obj("""{"error":{"code":"unauthenticated","message":"Capability has expired"},"fin":true}"""), s.next())
        s.session.close()
    }

    @Test
    fun `a cancel names an op by a number, and a cancel by text is not one`() {
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val server = RayfoldServer(clocked, Resolvers(queries = mapOf("thing" to { _, _ -> gate.await(); obj("""{"id":"t1"}""") })))
        val s = Session(server, JsonNull)
        s.session.onText("""{"ops":[{"id":7,"op":"thing","shape":"{ id }"}]}""")
        s.session.onText("""{"cancel":"7"}""")
        assertEquals(obj("""{"error":{"code":"invalid_argument","message":"Expected a batch envelope or {cancel}"},"fin":true}"""), s.next())
        gate.complete(Unit)
        assertEquals(obj("""{"id":7,"data":{"$t":"Thing","id":"t1"},"meta":{"cost":1},"fin":true}"""), s.next(), "op 7 was not cancelled")
        s.session.close()
    }

    @Test
    fun `an op id is free again by the time its final frame is out, so a client may reuse it at once`() {
        val reused = CopyOnWriteArrayList<Boolean>()
        val server = RayfoldServer(clocked, Resolvers(queries = mapOf("thing" to { _, _ -> obj("""{"id":"t1"}""") })))
        val s = Session(server, JsonNull) { self, f ->
            if (f["fin"] == JsonPrimitive(true) && f.opId() == 7 && reused.isEmpty()) {
                reused.add(true)
                self.session.onText("""{"ops":[{"id":7,"op":"thing","shape":"{ id }"}]}""") // as the frame arrives
            }
        }
        s.session.onText("""{"ops":[{"id":7,"op":"thing","shape":"{ id }"}]}""")
        val answer = obj("""{"id":7,"data":{"$t":"Thing","id":"t1"},"meta":{"cost":1},"fin":true}""")
        assertEquals(listOf(answer, answer), listOf(s.next(), s.next()))
        s.session.close()
    }

    // ---------------------------------------------------------------- bindings, cache scope, RB, schema checks

    private fun bound(prefix: String = ""): Int {
        val s = RayfoldServer(
            SchemaText.load("""entity Thing { id: ID } query thing(id: ID): Thing? @http(method: GET, path: "/things/{id}")""").ir,
            Resolvers(queries = mapOf("thing" to { a, _ -> obj("""{"id":${a["id"]}}""") })),
        )
        val http = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        RayfoldBindings(s, BindingOptions(prefix = prefix)).mount(http)
        http.start()
        started.add(http)
        return http.address.port
    }

    @Test
    fun `a percent escape cut short at the end of a path parameter is the client's error`() {
        // the JDK server refuses such a URI itself, so another host's handler is the caller this guards
        val e = runCatching { RayfoldBindings.decodePathSegment("a%4", "id") }.exceptionOrNull()
        assertEquals(RayfoldException(Code.INVALID_ARGUMENT, "Path parameter id is not valid percent-encoding").toWire(), (e as? RayfoldException)?.toWire())
        assertEquals("a@", RayfoldBindings.decodePathSegment("a%40", "id"), "guard: a whole escape is decoded")
    }

    @Test
    fun `bindings under a prefix answer only paths that start with it`() {
        val port = bound(prefix = "/api")
        assertEquals(200, send(port, "GET", "/api/things/t1", null).statusCode())
        assertEquals(404, send(port, "GET", "/zzzz/things/t1", null).statusCode(), "four other characters are not the prefix")
    }

    @Test
    fun `a Location fills its template with each value percent-encoded as encodeURIComponent does`() {
        assertEquals("/things/a%2Fb%20c%3F~", RayfoldBindings.fillTemplate("/things/{id}", obj("""{"id":"a/b c?~"}""")))
    }

    @Test
    fun `a deny that reads the viewer makes even an anonymous answer private`() {
        val s = RayfoldServer(
            SchemaText.load("entity Thing @deny(read: viewer.banned == true) { id: ID } query thing: Thing @cache(maxAge: 60s) entity Open { id: ID } query open: Open @cache(maxAge: 60s)").ir,
            Resolvers(queries = mapOf("thing" to { _, _ -> obj("""{"id":"t1"}""") }, "open" to { _, _ -> obj("""{"id":"o1"}""") })),
        )
        val port = RayfoldHttp(s, HttpOptions()).start(0).also { started.add(it) }.address.port
        assertEquals("private, max-age=60", send(port, "GET", "/rayfold/thing", null).headers().firstValue("Cache-Control").orElse(null))
        assertEquals("public, max-age=60", send(port, "GET", "/rayfold/open", null).headers().firstValue("Cache-Control").orElse(null), "guard")
    }

    @Test
    fun `the RB dictionary holds the names of field arguments, and Bytes decode as base64url without padding`() {
        val codec = RbCodec(SchemaText.load("entity Book { id: ID reviews(minStars: Int): [String] } query book: Book").ir)
        assertTrue("minStars" in codec.keys, "${codec.keys}")
        assertEquals(JsonPrimitive("-_8"), codec.decode(byteArrayOf(0x09, 0x02, 0xfb.toByte(), 0xff.toByte())))
    }

    @Test
    fun `a deprecation sunset that is not a quoted date stops the schema`() {
        val e = runCatching { SchemaText.load("entity Book { id: ID old: String @deprecated(sunset: 2027) }") }.exceptionOrNull()
        assertTrue(e is RayfoldSchemaException, "$e")
        assertTrue("@deprecated sunset must be a quoted date" in (e.message ?: ""), e.message)
        // guard: a quoted date is accepted
        SchemaText.load("""entity Book { id: ID old: String @deprecated(sunset: "2027-06-30") } query book: Book""")
    }
}
