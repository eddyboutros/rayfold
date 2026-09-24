package dev.rayfold.client

import com.sun.net.httpserver.HttpServer
import dev.rayfold.core.Code
import dev.rayfold.core.CommandResult
import dev.rayfold.core.HttpOptions
import dev.rayfold.core.Instrumentation
import dev.rayfold.core.OpInfo
import dev.rayfold.core.Outcome
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldHttp
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.RayfoldWebSocket
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.yield
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.net.http.HttpClient
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The Kotlin client against the real Kotlin server, over HTTP and over WebSocket on loopback ports. Every wait is
 * bounded to 5 s, so a missed frame fails the test instead of hanging it; nothing sleeps.
 */
class ClientTest {
    private val schema = """
        entity Author { id: ID name: String }
        entity Book { id: ID title: String stock: Int author: Author }
        error OutOfStock { available: Int }
        input NewBook { title: String authorId: ID }
        query book(id: ID): Book?
        query books: [Book]
        command buy(id: ID, qty: Int): Book throws OutOfStock
        command addBook(input: NewBook): Book
        stream ticks(n: Int): Int
        entity Note { id: ID text: String version: Int @version }
        query note(id: ID): Note?
        command restock(id: ID, qty: Int): Book @simulate
        command editNote(id: ID, text: String): Note
    """

    private val authors = mapOf(
        "a1" to buildJsonObject { put("id", "a1"); put("name", "Ursula K. Le Guin") },
        "a2" to buildJsonObject { put("id", "a2"); put("name", "Octavia E. Butler") },
    )
    private val books = ConcurrentHashMap<String, JsonObject>()
    private val authorLoads = AtomicInteger()
    private val notes = ConcurrentHashMap<String, JsonObject>()

    /** The Rayfold-Safe header of every batch request, in order; "absent" when it was not sent. */
    private val safeHeaders = CopyOnWriteArrayList<String>()
    private lateinit var server: RayfoldServer
    private lateinit var http: HttpServer
    private lateinit var ws: RayfoldWebSocket.Listener
    private lateinit var url: String
    private lateinit var wsUri: URI
    private val closeables = mutableListOf<AutoCloseable>()

    /** Completes once a `book` query has ended on the server; a live op's hook returns only after it unsubscribed. */
    private val bookQueryEnded = CompletableDeferred<Unit>()
    private val bookQueryEnds = object : Instrumentation {
        override suspend fun op(info: OpInfo, run: suspend () -> Outcome): Outcome = try {
            run()
        } finally {
            if (info.kind == "query" && info.name == "book") bookQueryEnded.complete(Unit)
        }
    }

    private fun JsonObject.str(k: String) = this[k]?.jsonPrimitive?.content ?: error("no $k in $this")
    private fun JsonElement.stock() = jsonObject["stock"]?.jsonPrimitive?.int ?: error("no stock in $this")
    private fun book(id: String, title: String, stock: Int, authorId: String) = buildJsonObject { put("id", id); put("title", title); put("stock", stock); put("authorId", authorId) }
    private fun note(id: String, text: String, version: Int) = buildJsonObject { put("id", id); put("text", text); put("version", version) }
    private fun viewerOf(user: String?): JsonElement = user?.let { u -> buildJsonObject { put("id", u) } } ?: JsonNull

    @BeforeEach
    fun start() {
        books["b1"] = book("b1", "The Dispossessed", 3, "a1")
        books["b2"] = book("b2", "Kindred", 5, "a2")
        notes["n1"] = note("n1", "draft", 1)
        server = RayfoldServer(
            SchemaText.load(schema).ir,
            Resolvers(
                queries = mapOf(
                    "book" to { args, _ -> books[args.str("id")] },
                    "books" to { _, _ -> JsonArray(books.values.sortedBy { it.str("id") }) },
                    "note" to { args, _ -> notes[args.str("id")] },
                ),
                commands = mapOf(
                    "buy" to { args, _ ->
                        val id = args.str("id")
                        val qty = args["qty"]?.jsonPrimitive?.int ?: error("no qty")
                        val b = books[id] ?: throw RayfoldException(Code.NOT_FOUND, "No book $id")
                        val stock = b["stock"]?.jsonPrimitive?.int ?: 0
                        if (qty > stock) throw RayfoldException.domain("OutOfStock", buildJsonObject { put("available", stock) }, "Only $stock left")
                        JsonObject(b + ("stock" to JsonPrimitive(stock - qty))).also { books[id] = it }
                    },
                    "addBook" to { args, _ ->
                        val input = args["input"] as? JsonObject ?: error("no input")
                        val id = "b${books.size + 1}"
                        book(id, input.str("title"), 0, input.str("authorId")).also { books[id] = it }
                    },
                    // answers with a patch that marks every cached `book` result stale, as a change the server cannot name would
                    "restock" to { args, ctx ->
                        val id = args.str("id")
                        val b = books[id] ?: throw RayfoldException(Code.NOT_FOUND, "No book $id")
                        val next = JsonObject(b + ("stock" to JsonPrimitive((b["stock"]?.jsonPrimitive?.int ?: 0) + (args["qty"]?.jsonPrimitive?.int ?: 0))))
                        if (!ctx.simulate) books[id] = next
                        CommandResult(next, patch = listOf(buildJsonObject { put("invOp", JsonArray(listOf(JsonPrimitive("book")))) }))
                    },
                    "editNote" to { args, ctx ->
                        val id = args.str("id")
                        val n = notes[id] ?: throw RayfoldException(Code.NOT_FOUND, "No note $id")
                        ctx.checkVersion("Note:$id", n["version"], n)
                        note(id, args.str("text"), (n["version"]?.jsonPrimitive?.int ?: 0) + 1).also { notes[id] = it }
                    },
                ),
                streams = mapOf("ticks" to { args, _ -> ticks(args["n"]?.jsonPrimitive?.int ?: 0) }),
                fields = mapOf("Book" to mapOf("author" to { parents, _, _ -> authorLoads.incrementAndGet(); parents.map { p -> authors[p.str("authorId")] } })),
            ),
            instrumentation = bookQueryEnds,
        )
        http = RayfoldHttp(server, HttpOptions()) { ex ->
            safeHeaders.add(ex.requestHeaders.getFirst("Rayfold-Safe") ?: "absent")
            viewerOf(ex.requestHeaders.getFirst("X-User"))
        }.start(0)
        url = "http://127.0.0.1:${http.address.port}/rayfold"
        ws = RayfoldWebSocket(server) { req -> viewerOf(req.header("x-user")) }.start(0)
        wsUri = URI("ws://127.0.0.1:${ws.port}/rayfold/ws")
    }

    private fun ticks(n: Int): Flow<JsonElement> = flow { repeat(n) { emit(JsonPrimitive(it)) } }

    @AfterEach
    fun stop() {
        closeables.forEach { runCatching { it.close() } }
        http.stop(0)
        ws.close()
    }

    /** Records every envelope a client sends. */
    private class Recording(private val inner: Transport) : Transport {
        val sent = CopyOnWriteArrayList<JsonObject>()
        override fun send(envelope: JsonObject, safe: Boolean): Flow<JsonObject> {
            sent.add(envelope)
            return inner.send(envelope, safe)
        }
        fun ops(i: Int): List<String> = sent[i]["ops"]?.jsonArray?.map { it.jsonObject["op"]?.jsonPrimitive?.content ?: "" } ?: emptyList()
    }

    private fun http(user: String? = null) = Recording(HttpTransport(url, { if (user != null) mapOf("X-User" to user) else emptyMap() }))

    private fun bounded(block: suspend kotlinx.coroutines.CoroutineScope.() -> Unit) = runBlocking { withTimeout(5_000) { block() } }

    /** A JDK client for a WebSocket transport, closed after the test with the transport. */
    private fun wsTransport(user: String): JdkWebSocketTransport {
        val jdk = HttpClient.newHttpClient()
        closeables.add(AutoCloseable { jdk.shutdownNow() })
        return JdkWebSocketTransport(wsUri, mapOf("X-User" to user), jdk).also { closeables.add(it) }
    }

    @Test
    fun `a query returns the requested shape and the envelope carries the client name and deadline`() = bounded {
        val t = http()
        val client = RayfoldClient(t, ClientOptions(client = "test/1", deadlineMs = 5000))
        val b = client.query("book", args("id" to "b1"), "{ id title author { name } }")
        assertEquals(Json.parseToJsonElement("""{"${'$'}type":"Book","id":"b1","title":"The Dispossessed","author":{"${'$'}type":"Author","name":"Ursula K. Le Guin"}}"""), b)
        assertEquals(
            Json.parseToJsonElement("""{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id title author { name } }"}],"meta":{"client":"test/1","deadline":5000}}"""),
            t.sent.single(),
        )
    }

    private fun stocked(stock: Int) = Json.parseToJsonElement("""{"${'$'}type":"Book","id":"b1","stock":$stock}""")

    @Test
    fun `Policy CACHE answers a fresh result without a request, and refetches once a patch made it stale`() = bounded {
        val t = http("alice")
        val client = RayfoldClient(t)
        assertEquals(stocked(3), client.query("book", args("id" to "b1"), "{ id stock }", Policy.CACHE), "a miss asks the server")
        assertEquals(1, t.sent.size)
        books["b1"] = book("b1", "The Dispossessed", 7, "a1") // changed behind the client's back
        assertEquals(stocked(3), client.query("book", args("id" to "b1"), "{ id stock }", Policy.CACHE), "a fresh hit is the cached answer")
        assertEquals(1, t.sent.size, "and costs no request")
        // guard: the same query under NETWORK asks anyway
        assertEquals(stocked(7), client.query("book", args("id" to "b1"), "{ id stock }"))
        assertEquals(2, t.sent.size)

        // restock's patch invalidates the `book` op; its own result comes back in the same response
        assertEquals(stocked(8), client.command("restock", args("id" to "b1", "qty" to 1), "{ id stock }"))
        assertEquals(3, t.sent.size)
        books["b1"] = book("b1", "The Dispossessed", 9, "a1")
        assertEquals(stocked(9), client.query("book", args("id" to "b1"), "{ id stock }", Policy.CACHE), "a stale result is fetched again")
        assertEquals(4, t.sent.size)
        assertEquals(listOf("book"), t.ops(3))
    }

    @Test
    fun `the same entity selected through an alias reads back what each result asked for, and plain fields stay shared`() = bounded {
        // a field under an alias was stored on the shared entity by its output name: the later result overwrote the
        // earlier one's, and a watcher of the first saw the second's answer
        val client = RayfoldClient(http("alice"))
        val named = Channel<JsonElement>(Channel.UNLIMITED)
        val watching = launch { client.watch("book", args("id" to "b1"), "{ id x: title }").collect { named.send(it.jsonObject.getValue("x")) } }
        assertEquals(JsonPrimitive("The Dispossessed"), named.receive())
        assertEquals(JsonPrimitive(3), client.query("book", args("id" to "b1"), "{ id x: stock }").jsonObject.getValue("x"))
        // the second query touched the same book, so the watcher may hear again; what it hears is still the title
        val heard = generateSequence { named.tryReceive().getOrNull() }.toList()
        assertTrue(heard.all { it == JsonPrimitive("The Dispossessed") }, "the first result's x is still the title, not $heard")
        assertEquals(JsonPrimitive("The Dispossessed"), client.query("book", args("id" to "b1"), "{ id x: title }", Policy.CACHE).jsonObject.getValue("x"))
        assertEquals(null, client.cache.get("Book:b1")?.get("x"), "no book has a field called x")
        // guard: a plain field is still the entity's, so a command's patch reaches every result that selects it
        assertEquals(stocked(3), client.query("book", args("id" to "b1"), "{ id stock }"))
        client.command("buy", args("id" to "b1", "qty" to 1), "{ id stock }")
        assertEquals(stocked(2), client.query("book", args("id" to "b1"), "{ id stock }", Policy.CACHE))
        watching.cancel()
    }

    @Test
    fun `the shape reader finds what belongs to a selection at each level, through on and defer`() {
        val level = SelectionLevel.of("""{ id x: title reviews(page: { first: 1 }) { items { id n: rating } } plain() ...on Book { y: stock } @defer(label: "later") { z: id } stock @eager }""")
        assertEquals(setOf("x", "reviews", "y", "z"), level?.bySelection)
        assertEquals(setOf("n"), level?.child?.get("reviews")?.child?.get("items")?.bySelection)
        assertEquals(null, SelectionLevel.of("sha256:" + "0".repeat(64)), "a trusted shape id has no text to read")
    }

    @Test
    fun `a dry run answers with what would happen and changes nothing a watcher sees, and the real run does`() = bounded {
        val client = RayfoldClient(http("alice"))
        val stock = Channel<Int>(Channel.UNLIMITED)
        val watching = launch { client.watch("book", args("id" to "b1"), "{ id stock }").collect { stock.send(it.stock()) } }
        assertEquals(3, stock.receive())
        val b = client.batch()
        val dry = b.command("restock", args("id" to "b1", "qty" to 100), "{ id stock }", simulate = true)
        b.run()
        assertEquals(stocked(103), dry.await(), "what the restock would leave")
        assertEquals(stocked(3), client.query("book", args("id" to "b1"), "{ id stock }", Policy.CACHE), "the cache still holds the real stock")
        assertTrue(stock.tryReceive().isFailure, "and the watcher saw nothing: written to the cache, the dry run showed 103")
        // guard: the same command for real reaches the cache
        client.command("restock", args("id" to "b1", "qty" to 100), "{ id stock }")
        assertEquals(stocked(103), client.query("book", args("id" to "b1"), "{ id stock }", Policy.CACHE))
        watching.cancel()
    }

    @Test
    fun `batches of only known queries go out as safe requests, and anything else does not`() = bounded {
        val client = RayfoldClient(http("alice"), ClientOptions(queries = setOf("book")))
        client.query("book", args("id" to "b1"), "{ id }")
        client.query("books", shape = "{ id }") // not known as a query yet
        client.markQueries("books")
        client.query("books", shape = "{ id }")
        // guard: a batch holding a command is never marked safe
        val b = client.batch()
        b.query("book", args("id" to "b1"), "{ id }")
        b.command("buy", args("id" to "b1", "qty" to 1), "{ id }")
        b.run()
        assertEquals(listOf("true", "absent", "true", "absent"), safeHeaders.toList())
    }

    @Test
    fun `a live query of a known query never goes out as a safe request, so a server that buffers those still streams it`() = runBlocking {
        val client = RayfoldClient(http("alice"), ClientOptions(queries = setOf("book")))
        val stock = Channel<Int>(Channel.UNLIMITED)
        val scope = CoroutineScope(Dispatchers.IO)
        try {
            val job = scope.launch { client.live("book", args("id" to "b1"), "{ id stock }").collect { stock.send(it.stock()) } }
            assertEquals(3, withTimeout(5_000) { stock.receive() })
            job.cancel()
            assertNotNull(withTimeoutOrNull(5_000) { job.join() })
        } finally {
            scope.cancel()
        }
        withTimeout(5_000) { client.query("book", args("id" to "b1"), "{ id }") } // guard: the same op read once is still safe
        assertEquals(listOf("absent", "true"), safeHeaders.toList())
    }

    @Test
    fun `a version conflict puts the server's current entity into the cache before it fails the command`() = bounded {
        val client = RayfoldClient(http("alice"))
        client.query("note", args("id" to "n1"), "{ id text version }")
        notes["n1"] = note("n1", "theirs", 2) // another writer got there first
        val e = assertFailsWith<RayfoldClientException> {
            client.command("editNote", args("id" to "n1", "text" to "mine"), "{ id text version }", ifVersion = JsonPrimitive(1))
        }
        assertEquals("failed_precondition" to "VersionConflict", e.code to e.type)
        assertEquals<JsonElement?>(Json.parseToJsonElement("""{"${'$'}type":"Note","id":"n1","text":"theirs","version":2}"""), client.cache.get("Note:n1"))
        assertEquals(note("n1", "theirs", 2), notes["n1"], "the refused edit changed nothing")
    }

    @Test
    fun `a command's result reaches a watch of the same book without a refetch`() = bounded {
        val t = http("alice")
        val client = RayfoldClient(t)
        val stock = Channel<Int>(Channel.UNLIMITED)
        val job = launch { client.watch("book", args("id" to "b1"), "{ id stock }").collect { stock.send(it.stock()) } }
        assertEquals(3, stock.receive())
        val before = t.sent.size
        client.command("buy", args("id" to "b1", "qty" to 1), "{ id stock }")
        assertEquals(2, stock.receive())
        assertEquals(before + 1, t.sent.size)
        assertEquals(listOf("buy"), t.ops(t.sent.size - 1))
        job.cancelAndJoin()
    }

    @Test
    fun `a watch reports its own book only, not another book of the same query`() = bounded {
        val client = RayfoldClient(http("alice"))
        val b1 = Channel<Int>(Channel.UNLIMITED)
        val b2 = Channel<Int>(Channel.UNLIMITED)
        val j1 = launch { client.watch("book", args("id" to "b1"), "{ id stock }").collect { b1.send(it.stock()) } }
        val j2 = launch { client.watch("book", args("id" to "b2"), "{ id stock }").collect { b2.send(it.stock()) } }
        assertEquals(3, b1.receive())
        assertEquals(5, b2.receive())
        client.command("buy", args("id" to "b1", "qty" to 1), "{ id stock }")
        assertEquals(2, b1.receive())
        client.command("buy", args("id" to "b2", "qty" to 2), "{ id stock }")
        assertEquals(3, b2.receive())
        // each watch saw its own book's change and nothing else
        assertTrue(b1.tryReceive().isFailure)
        assertTrue(b2.tryReceive().isFailure)
        j1.cancelAndJoin()
        j2.cancelAndJoin()
    }

    @Test
    fun `a command's answer is not kept as a result, so commands with new arguments do not pile up, while a query's is (guard)`() = bounded {
        val client = RayfoldClient(http("alice"))
        for ((qty, left) in listOf(1 to 2, 2 to 0)) {
            val a = args("id" to "b1", "qty" to qty)
            assertEquals(left, client.command("buy", a, "{ id stock }").stock())
            assertEquals(null, client.cache.getResult(RayfoldCache.resultKey("buy", a, "{ id stock }", null)))
        }
        assertEquals(JsonPrimitive(0), client.cache.get("Book:b1")?.get("stock"))
        val predicted = listOf(OptimisticOp("Book:b2", buildJsonObject { put("stock", 99) }))
        assertEquals(4, client.command("buy", args("id" to "b2", "qty" to 1), "{ id stock }", optimistic = predicted).stock(), "settled: the server's value, not the prediction")
        client.query("book", args("id" to "b1"), "{ id stock }")
        assertNotNull(client.cache.getResult(RayfoldCache.resultKey("book", args("id" to "b1"), "{ id stock }", null)))
    }

    @Test
    fun `a batch creates a book and reads it back in one round trip`() = bounded {
        val t = http("alice")
        val client = RayfoldClient(t)
        val b = client.batch()
        val add = b.command("addBook", args("input" to mapOf("title" to "Parable of the Sower", "authorId" to "a2")), "{ id }")
        val read = b.query("book", args("id" to add.ref("id")), "{ title author { name } }")
        b.run()
        assertEquals("Parable of the Sower", read.await().jsonObject["title"]?.jsonPrimitive?.content)
        assertEquals("Octavia E. Butler", read.await().jsonObject["author"]?.jsonObject?.get("name")?.jsonPrimitive?.content)
        assertEquals(1, t.sent.size)
    }

    @Test
    fun `a declared error arrives typed, with its data, and changes nothing`() = bounded {
        val client = RayfoldClient(http("alice"))
        val e = assertFailsWith<RayfoldClientException> { client.command("buy", args("id" to "b2", "qty" to 99)) }
        assertEquals("domain", e.code)
        assertTrue(e.isType("OutOfStock"))
        assertFalse(e.isType("PaymentDeclined"))
        assertEquals(Json.parseToJsonElement("""{"available":5}"""), e.data)
        assertEquals("Only 5 left", e.message)
        assertEquals(5, books["b2"]?.get("stock")?.jsonPrimitive?.int)
    }

    @Test
    fun `an anonymous command is refused and changes nothing`() = bounded {
        val e = assertFailsWith<RayfoldClientException> { RayfoldClient(http()).command("buy", args("id" to "b1", "qty" to 1)) }
        assertEquals("unauthenticated", e.code)
        assertEquals(3, books["b1"]?.get("stock")?.jsonPrimitive?.int)
        // guard: the same command by a signed-in user goes through
        RayfoldClient(http("alice")).command("buy", args("id" to "b1", "qty" to 1))
        assertEquals(2, books["b1"]?.get("stock")?.jsonPrimitive?.int)
    }

    @Serializable
    data class BookCard(@SerialName("\$type") val type: String, val id: String, val title: String, val stock: Int)

    @Test
    fun `results decode into serializable classes`() = bounded {
        val client = RayfoldClient(http())
        assertEquals(BookCard("Book", "b1", "The Dispossessed", 3), client.queryAs<BookCard>("book", args("id" to "b1"), "{ id title stock }"))
        val all: List<BookCard> = client.queryAs("books", shape = "{ id title stock }")
        assertEquals(listOf("b1", "b2"), all.map { it.id })
    }

    @Test
    fun `a stream arrives item by item and ends with the server's last frame`() = bounded {
        assertEquals((0..3).map { JsonPrimitive(it) }, RayfoldClient(http()).stream("ticks", args("n" to 4)).toList())
    }

    @Test
    fun `a stream whose frames stop without fin fails as unavailable, and one that ends with fin completes (guard)`() = bounded {
        val cut = Transport { _, _ -> flow { emit(Json.parseToJsonElement(ITEM).jsonObject) } }
        val refused = assertFailsWith<RayfoldClientException> { RayfoldClient(cut).stream("ticks").collect {} }
        assertEquals("unavailable", refused.code)
        val whole = Transport { _, _ -> flow { emit(Json.parseToJsonElement(ITEM).jsonObject); emit(Json.parseToJsonElement("""{"id":1,"fin":true}""").jsonObject) } }
        assertEquals(listOf<JsonElement>(JsonPrimitive(1)), RayfoldClient(whole).stream("ticks").toList())
    }

    @Test
    fun `a problem response becomes an exception with the server's code`() = bounded {
        val client = RayfoldClient(HttpTransport("$url/nope"))
        val e = assertFailsWith<RayfoldClientException> { client.query("book", args("id" to "b1")) }
        assertEquals("not_found", e.code)
    }

    @Test
    fun `cancelling a live query over HTTP ends it at once, not at the server's next keep-alive`() = runBlocking {
        val client = RayfoldClient(http("alice"))
        val stock = Channel<Int>(Channel.UNLIMITED)
        // a scope of its own: a collection that does not end fails the bounded join below instead of holding runBlocking
        val scope = CoroutineScope(Dispatchers.IO)
        try {
            val job = scope.launch { client.live("book", args("id" to "b1"), "{ id stock }").collect { stock.send(it.stock()) } }
            assertEquals(3, withTimeout(5_000) { stock.receive() })
            assertEquals(1, server.changes.size, "guard: the live query is open on the server")
            job.cancel()
            assertNotNull(withTimeoutOrNull(5_000) { job.join() }, "the collection ended within 5 s, while the server's keep-alive is 15 s away")
        } finally {
            scope.cancel()
        }
    }

    /**
     * The JDK client's path only. The HttpURLConnection path drops the request through disconnect(), which closes the
     * socket at once on Android; the JVM's own HttpURLConnection waits for the read blocked on it (see the KDoc on
     * HttpTransport.viaUrlConnection), so on this JVM that path cannot show a prompt close. Its read timeout is below.
     */
    @Test
    fun `cancelling a response the server keeps open closes its connection`() = runBlocking {
        SilentStream(ITEM).use { silent ->
            val frames = Channel<JsonObject>(Channel.UNLIMITED)
            val scope = CoroutineScope(Dispatchers.IO)
            try {
                val job = scope.launch { HttpTransport(silent.url).send(NO_OPS, false).collect { frames.send(it) } }
                assertEquals(Json.parseToJsonElement(ITEM), withTimeout(5_000) { frames.receive() })
                assertEquals(1L, silent.closed.count, "guard: collecting the response keeps its connection open")
                job.cancel()
                assertTrue(silent.closed.await(5, TimeUnit.SECONDS), "the cancel closed the connection")
                assertNotNull(withTimeoutOrNull(5_000) { job.join() }, "and the collection ended")
            } finally {
                scope.cancel()
            }
        }
    }

    /** Both paths: the JDK client's, and HttpURLConnection's, the one Android takes. */
    @ParameterizedTest(name = "jdkClient = {0}")
    @ValueSource(booleans = [true, false])
    fun `a read timeout fails a response that goes quiet, and drops its connection`(jdkClient: Boolean) = runBlocking {
        SilentStream(ITEM).use { silent ->
            // a scope of its own: without a timeout, HttpURLConnection's disconnect blocks behind the read it would
            // end, so a collection cancelled on this thread would hold it; this way the test fails instead of hanging
            val scope = CoroutineScope(Dispatchers.IO)
            try {
                val collected = scope.async {
                    runCatching { HttpTransport(silent.url, { emptyMap() }, 10_000, 100, jdkClient).send(NO_OPS, false).collect {} }.exceptionOrNull()
                }
                val failure = withTimeoutOrNull(5_000) { collected.await() }
                assertIs<SocketTimeoutException>(failure, "the read timed out within 5 s")
                assertTrue(silent.closed.await(5, TimeUnit.SECONDS), "the connection was dropped")
            } finally {
                scope.cancel()
            }
        }
    }

    @Test
    fun `the HttpURLConnection path, the one Android takes, answers queries, streams and problems`() = bounded {
        fun transport(to: String) = HttpTransport(to, { mapOf("X-User" to "alice") }, 10_000, 0, jdkClient = false)
        val client = RayfoldClient(transport(url))
        assertEquals("The Dispossessed", client.query("book", args("id" to "b1"), "{ title }").jsonObject["title"]?.jsonPrimitive?.content)
        assertEquals((0..2).map { JsonPrimitive(it) }, client.stream("ticks", args("n" to 3)).toList())
        val e = assertFailsWith<RayfoldClientException> { RayfoldClient(transport("$url/nope")).query("book", args("id" to "b1")) }
        assertEquals("not_found", e.code)
    }

    /**
     * Answers one POST with a streaming response that holds [frame] and then stays silent, as a live query does between
     * changes. [closed] counts down once the client closes the connection.
     */
    private class SilentStream(frame: String) : AutoCloseable {
        private val listener = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        @Volatile
        private var socket: Socket? = null
        val closed = CountDownLatch(1)
        val url = "http://127.0.0.1:${listener.localPort}/rayfold"

        init {
            thread(isDaemon = true, name = "silent-stream") {
                runCatching {
                    listener.accept().use { s ->
                        socket = s
                        val input = s.getInputStream()
                        val head = StringBuilder()
                        while (!head.endsWith("\r\n\r\n")) head.append(input.read().takeIf { it >= 0 }?.toChar() ?: return@use)
                        input.readNBytes(Regex("(?i)content-length: *(\\d+)").find(head)?.groupValues?.get(1)?.toInt() ?: 0)
                        val chunk = "$frame\n".toByteArray()
                        s.getOutputStream().apply {
                            write("HTTP/1.1 200 OK\r\nContent-Type: application/rayfold-frames+json\r\nTransfer-Encoding: chunked\r\n\r\n".toByteArray())
                            write("${Integer.toHexString(chunk.size)}\r\n".toByteArray() + chunk + "\r\n".toByteArray())
                            flush()
                        }
                        // nothing more is written, so only the client closing the connection ends this read
                        runCatching { input.read() }
                        closed.countDown()
                    }
                }
            }
        }

        override fun close() {
            listener.close()
            socket?.close()
        }
    }

    private companion object {
        const val ITEM = """{"id":1,"item":1}"""
        val NO_OPS = buildJsonObject { put("ops", JsonArray(emptyList())) }
    }

    @Test
    fun `one socket carries concurrent batches with their own op ids, and refs are rewritten`() = bounded {
        val client = RayfoldClient(wsTransport("alice"))
        val a = async { client.query("book", args("id" to "b1"), "{ title }") }
        val b = async { client.query("book", args("id" to "b2"), "{ title }") }
        assertEquals("The Dispossessed", a.await().jsonObject["title"]?.jsonPrimitive?.content)
        assertEquals("Kindred", b.await().jsonObject["title"]?.jsonPrimitive?.content)
        val batch = client.batch()
        val add = batch.command("addBook", args("input" to mapOf("title" to "Dawn", "authorId" to "a2")), "{ id }")
        val read = batch.query("book", args("id" to add.ref("id")), "{ title }")
        batch.run()
        assertEquals("Dawn", read.await().jsonObject["title"]?.jsonPrimitive?.content)
    }

    @Test
    fun `a refused batch on a shared socket is rejected and closed, and a live query on the same socket keeps going untouched`() = bounded {
        val alice = RayfoldClient(wsTransport("alice"))
        val stock = Channel<Int>(Channel.UNLIMITED)
        val errors = CopyOnWriteArrayList<Throwable>()
        val job = launch { alice.live("book", args("id" to "b1"), "{ id stock }", onError = { e, _ -> errors.add(e) }).collect { stock.send(it.stock()) } }
        assertEquals(3, stock.receive())
        val refused = assertFailsWith<RayfoldClientException> { alice.query("noSuchOp") }
        assertEquals("invalid_argument", refused.code)
        // guard: the socket and the live query on it are still good
        assertEquals("Kindred", alice.query("book", args("id" to "b2"), "{ title }").jsonObject["title"]?.jsonPrimitive?.content)
        RayfoldClient(http("bob")).command("buy", args("id" to "b1", "qty" to 1))
        assertEquals(2, stock.receive())
        assertEquals(emptyList(), errors.toList())
        job.cancelAndJoin()
    }

    /** A socket whose server is the test: it records what the client sends and answers with whatever frames it is given. */
    private class ScriptedSocket : WebSocketTransportBase() {
        val sent = Channel<JsonObject>(Channel.UNLIMITED)
        override fun connect(): CompletableFuture<out Connection> = CompletableFuture.completedFuture(Connection { sent.trySend(Json.parseToJsonElement(it).jsonObject) })
        fun answer(frame: String) = receive(frame)
        override fun close() = Unit
    }

    @Test
    fun `a refusal without an op id waits while two batches could own it, and goes to the one left once the other answers`() = bounded {
        val socket = ScriptedSocket()
        val client = RayfoldClient(socket)
        val good = async { runCatching { client.query("book", args("id" to "b1")) } }
        assertEquals(1, socket.sent.receive()["ops"]?.jsonArray?.single()?.jsonObject?.get("id")?.jsonPrimitive?.int)
        val bad = async { runCatching { client.query("noSuchOp") } }
        assertEquals(2, socket.sent.receive()["ops"]?.jsonArray?.single()?.jsonObject?.get("id")?.jsonPrimitive?.int)
        socket.answer("""{"error":{"code":"invalid_argument","message":"Unknown op noSuchOp"},"fin":true}""")
        yield()
        assertFalse(good.isCompleted, "either batch could be the refused one: neither is failed on a guess")
        assertFalse(bad.isCompleted)
        socket.answer("""{"id":1,"data":{"${'$'}type":"Book","id":"b1"},"fin":true}""")
        assertEquals(Json.parseToJsonElement("""{"${'$'}type":"Book","id":"b1"}"""), good.await().getOrThrow())
        assertEquals("invalid_argument", (bad.await().exceptionOrNull() as? RayfoldClientException)?.code)
    }

    @Test
    fun `two refusals among two unanswered batches are one each, and a batch answered before them is not failed (guard)`() = bounded {
        val socket = ScriptedSocket()
        val client = RayfoldClient(socket)
        val errors = CopyOnWriteArrayList<Throwable>()
        val seen = Channel<JsonElement>(Channel.UNLIMITED)
        val live = launch { client.live("book", args("id" to "b1"), onError = { e, _ -> errors.add(e) }).collect { seen.send(it) } }
        socket.sent.receive()
        socket.answer("""{"id":1,"data":{"${'$'}type":"Book","id":"b1"}}""")
        seen.receive()
        val bad1 = async { runCatching { client.query("noSuchOp") } }
        val bad2 = async { runCatching { client.query("otherBadOp") } }
        socket.sent.receive()
        socket.sent.receive()
        socket.answer("""{"error":{"code":"invalid_argument","message":"Unknown op"},"fin":true}""")
        socket.answer("""{"error":{"code":"invalid_argument","message":"Unknown op"},"fin":true}""")
        assertEquals("invalid_argument", (bad1.await().exceptionOrNull() as? RayfoldClientException)?.code)
        assertEquals("invalid_argument", (bad2.await().exceptionOrNull() as? RayfoldClientException)?.code)
        socket.answer("""{"id":1,"patch":[{"set":"Book:b1","value":{"stock":3}}]}""")
        seen.receive()
        assertEquals(emptyList(), errors.toList())
        assertEquals<JsonElement?>(Json.parseToJsonElement("""{"${'$'}type":"Book","id":"b1","stock":3}"""), client.cache.get("Book:b1"))
        live.cancelAndJoin()
    }

    @Test
    fun `a live query over WebSocket gets another user's change pushed, and cancelling it unsubscribes`() = bounded {
        val alice = RayfoldClient(wsTransport("alice"))
        val bob = RayfoldClient(http("bob"))
        val stock = Channel<Int>(Channel.UNLIMITED)
        val job = launch { alice.live("book", args("id" to "b1"), "{ id stock }").collect { stock.send(it.stock()) } }
        assertEquals(3, stock.receive())
        assertEquals(1, server.changes.size, "guard: the open live query holds a subscription")
        bob.command("buy", args("id" to "b1", "qty" to 1))
        assertEquals(2, stock.receive())
        job.cancelAndJoin()
        bookQueryEnded.await() // bounded by the test's 5 s: the cancel must reach the server
        assertEquals(0, server.changes.size)
    }
}
