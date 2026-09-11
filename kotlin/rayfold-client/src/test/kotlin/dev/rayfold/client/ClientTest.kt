package dev.rayfold.client

import com.sun.net.httpserver.HttpServer
import dev.rayfold.core.Code
import dev.rayfold.core.HttpOptions
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldHttp
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.RayfoldWebSocket
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
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
    """

    private val authors = mapOf(
        "a1" to buildJsonObject { put("id", "a1"); put("name", "Ursula K. Le Guin") },
        "a2" to buildJsonObject { put("id", "a2"); put("name", "Octavia E. Butler") },
    )
    private val books = ConcurrentHashMap<String, JsonObject>()
    private val authorLoads = AtomicInteger()
    private lateinit var server: RayfoldServer
    private lateinit var http: HttpServer
    private lateinit var ws: RayfoldWebSocket.Listener
    private lateinit var url: String
    private lateinit var wsUri: URI
    private val closeables = mutableListOf<AutoCloseable>()

    private fun JsonObject.str(k: String) = this[k]?.jsonPrimitive?.content ?: error("no $k in $this")
    private fun JsonElement.stock() = jsonObject["stock"]?.jsonPrimitive?.int ?: error("no stock in $this")
    private fun book(id: String, title: String, stock: Int, authorId: String) = buildJsonObject { put("id", id); put("title", title); put("stock", stock); put("authorId", authorId) }
    private fun viewerOf(user: String?): JsonElement = user?.let { u -> buildJsonObject { put("id", u) } } ?: JsonNull

    @BeforeEach
    fun start() {
        books["b1"] = book("b1", "The Dispossessed", 3, "a1")
        books["b2"] = book("b2", "Kindred", 5, "a2")
        server = RayfoldServer(
            SchemaText.load(schema).ir,
            Resolvers(
                queries = mapOf(
                    "book" to { args, _ -> books[args.str("id")] },
                    "books" to { _, _ -> JsonArray(books.values.sortedBy { it.str("id") }) },
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
                ),
                streams = mapOf("ticks" to { args, _ -> ticks(args["n"]?.jsonPrimitive?.int ?: 0) }),
                fields = mapOf("Book" to mapOf("author" to { parents, _, _ -> authorLoads.incrementAndGet(); parents.map { p -> authors[p.str("authorId")] } })),
            ),
        )
        http = RayfoldHttp(server, HttpOptions()) { ex -> viewerOf(ex.requestHeaders.getFirst("X-User")) }.start(0)
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

    /** Yields until [cond] holds; the 5 s bound around every test fails it instead of spinning forever. */
    private suspend fun until(cond: () -> Boolean) {
        while (!cond()) yield()
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
    fun `a problem response becomes an exception with the server's code`() = bounded {
        val client = RayfoldClient(HttpTransport("$url/nope"))
        val e = assertFailsWith<RayfoldClientException> { client.query("book", args("id" to "b1")) }
        assertEquals("not_found", e.code)
    }

    @Test
    fun `one socket carries concurrent batches with their own op ids, and refs are rewritten`() = bounded {
        val t = JdkWebSocketTransport(wsUri, mapOf("X-User" to "alice")).also { closeables.add(it) }
        val client = RayfoldClient(t)
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
    fun `a live query over WebSocket gets another user's change pushed, and cancelling it unsubscribes`() = bounded {
        val alice = RayfoldClient(JdkWebSocketTransport(wsUri, mapOf("X-User" to "alice")).also { closeables.add(it) })
        val bob = RayfoldClient(http("bob"))
        val stock = Channel<Int>(Channel.UNLIMITED)
        val job = launch { alice.live("book", args("id" to "b1"), "{ id stock }").collect { stock.send(it.stock()) } }
        assertEquals(3, stock.receive())
        assertEquals(1, server.changes.size, "guard: the open live query holds a subscription")
        bob.command("buy", args("id" to "b1", "qty" to 1))
        assertEquals(2, stock.receive())
        job.cancelAndJoin()
        until { server.changes.size == 0 }
    }
}
