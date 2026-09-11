package dev.rayfold.client.okhttp

import dev.rayfold.client.RayfoldClient
import dev.rayfold.client.args
import dev.rayfold.core.Code
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.RayfoldWebSocket
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.ConcurrentHashMap
import kotlin.test.assertEquals

/**
 * The OkHttp transport against the real Kotlin WebSocket server on a loopback port: concurrent batches on one socket,
 * pipelined refs, the viewer from a handshake header, live queries and their cancel, and a socket the server drops.
 * Every test is bounded to 5 s, so a missed frame fails it instead of hanging; nothing sleeps.
 */
class OkHttpTransportTest {
    private val schema = """
        entity Book { id: ID title: String stock: Int }
        input NewBook { title: String }
        query book(id: ID): Book?
        query me: String
        command buy(id: ID, qty: Int): Book
        command addBook(input: NewBook): Book
    """
    private val books = ConcurrentHashMap<String, JsonObject>()
    private lateinit var server: RayfoldServer
    private lateinit var listener: RayfoldWebSocket.Listener
    private lateinit var url: String
    private val http = OkHttpClient()
    private val transports = mutableListOf<OkHttpWebSocketTransport>()

    private fun JsonObject.str(k: String) = this[k]?.jsonPrimitive?.content ?: error("no $k in $this")
    private fun book(id: String, title: String, stock: Int) = buildJsonObject { put("id", id); put("title", title); put("stock", stock) }

    @BeforeEach
    fun start() {
        books["b1"] = book("b1", "The Dispossessed", 3)
        books["b2"] = book("b2", "Kindred", 5)
        server = RayfoldServer(
            SchemaText.load(schema).ir,
            Resolvers(
                queries = mapOf(
                    "book" to { args, _ -> books[args.str("id")] },
                    "me" to { _, ctx -> (ctx.viewer as? JsonObject)?.get("id") ?: JsonPrimitive("anonymous") },
                ),
                commands = mapOf(
                    "buy" to { args, _ ->
                        val id = args.str("id")
                        val b = books[id] ?: throw RayfoldException(Code.NOT_FOUND, "No book $id")
                        val stock = (b["stock"]?.jsonPrimitive?.int ?: 0) - (args["qty"]?.jsonPrimitive?.int ?: 0)
                        JsonObject(b + ("stock" to JsonPrimitive(stock))).also { books[id] = it }
                    },
                    "addBook" to { args, _ ->
                        val id = "b${books.size + 1}"
                        book(id, (args["input"] as? JsonObject)?.str("title") ?: error("no input"), 0).also { books[id] = it }
                    },
                ),
            ),
        )
        listener = RayfoldWebSocket(server) { req -> req.header("x-user")?.let { u -> buildJsonObject { put("id", u) } } ?: JsonNull }.start(0)
        url = "ws://127.0.0.1:${listener.port}/rayfold/ws"
    }

    @AfterEach
    fun stop() {
        transports.forEach { it.close() }
        listener.close()
        http.dispatcher.executorService.shutdown()
        http.connectionPool.evictAll()
    }

    private fun transport(user: String? = null) = OkHttpWebSocketTransport(url, user?.let { mapOf("X-User" to it) } ?: emptyMap(), http).also { transports.add(it) }

    private fun bounded(block: suspend CoroutineScope.() -> Unit) = runBlocking { withTimeout(5_000) { block() } }

    /** Yields until [cond] holds; the 5 s bound around every test fails it instead of spinning forever. */
    private suspend fun until(cond: () -> Boolean) {
        while (!cond()) yield()
    }

    private fun JsonElement.title() = jsonObject["title"]?.jsonPrimitive?.content

    @Test
    fun `one socket carries concurrent batches with their own op ids, refs are rewritten, and the handshake header names the viewer`() = bounded {
        val client = RayfoldClient(transport("alice"))
        val a = async { client.query("book", args("id" to "b1"), "{ title }") }
        val b = async { client.query("book", args("id" to "b2"), "{ title }") }
        assertEquals("The Dispossessed", a.await().title())
        assertEquals("Kindred", b.await().title())
        val batch = client.batch()
        val add = batch.command("addBook", args("input" to mapOf("title" to "Dawn")), "{ id }")
        val read = batch.query("book", args("id" to add.ref("id")), "{ title }")
        batch.run()
        assertEquals("Dawn", read.await().title())
        assertEquals(JsonPrimitive("alice"), client.query("me", args()))
        assertEquals(JsonPrimitive("anonymous"), RayfoldClient(transport()).query("me", args()), "guard: no header, no viewer")
    }

    @Test
    fun `a live query gets another client's change pushed, and cancelling it unsubscribes on the server`() = bounded {
        val alice = RayfoldClient(transport("alice"))
        val bob = RayfoldClient(transport("bob"))
        val stock = Channel<Int>(Channel.UNLIMITED)
        val job = launch { alice.live("book", args("id" to "b1"), "{ id stock }").collect { stock.send(it.jsonObject["stock"]?.jsonPrimitive?.int ?: -1) } }
        assertEquals(3, stock.receive())
        assertEquals(1, server.changes.size, "guard: the open live query holds a subscription")
        bob.command("buy", args("id" to "b1", "qty" to 1))
        assertEquals(2, stock.receive())
        job.cancelAndJoin()
        until { server.changes.size == 0 }
    }

    @Test
    fun `a socket the server drops ends its batches with unavailable, and the next batch reconnects`() = bounded {
        val t = transport()
        val live = async { t.send(buildJsonObject { put("ops", kotlinx.serialization.json.JsonArray(listOf(buildJsonObject { put("id", 1); put("op", "book"); put("args", buildJsonObject { put("id", "b1") }); put("shape", "{ id }"); put("live", true) }))) }, safe = true).toList() }
        until { server.changes.size == 1 }
        listener.close() // every connection closes, as when the server restarts
        val frames = live.await()
        assertEquals(JsonPrimitive("unavailable"), (frames.last()["error"] as? JsonObject)?.get("code"), "$frames")
        listener = RayfoldWebSocket(server) { JsonNull }.start(0)
        url = "ws://127.0.0.1:${listener.port}/rayfold/ws"
        assertEquals("Kindred", RayfoldClient(transport()).query("book", args("id" to "b2"), "{ title }").title(), "guard: a new socket works")
    }
}
