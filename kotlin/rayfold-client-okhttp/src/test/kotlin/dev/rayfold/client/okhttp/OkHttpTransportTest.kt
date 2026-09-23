package dev.rayfold.client.okhttp

import dev.rayfold.client.RayfoldClient
import dev.rayfold.client.RayfoldClientException
import dev.rayfold.client.args
import dev.rayfold.core.Code
import dev.rayfold.core.Instrumentation
import dev.rayfold.core.OpInfo
import dev.rayfold.core.Outcome
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.RayfoldWebSocket
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
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
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs

/**
 * The OkHttp transport against the real Kotlin WebSocket server on a loopback port: concurrent batches on one socket,
 * pipelined refs, the viewer from a handshake header, live queries and their cancel, a refused handshake, and a socket
 * the server drops. Every test is bounded to 5 s, so a missed frame fails it instead of hanging; nothing sleeps, and
 * every wait on the server is for a signal (a frame, or the end of an op) rather than a poll.
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
    private val bookQueries = AtomicInteger()
    private lateinit var server: RayfoldServer
    private lateinit var listener: RayfoldWebSocket.Listener
    private lateinit var url: String
    private val http = OkHttpClient()
    private val transports = mutableListOf<OkHttpWebSocketTransport>()
    private val relays = mutableListOf<Relay>()

    /** Receives once for every `book` query that ended on the server; a live op's hook returns only after it unsubscribed. */
    private val bookQueryEnded = Channel<Unit>(Channel.UNLIMITED)

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
                    "book" to { args, _ -> bookQueries.incrementAndGet(); books[args.str("id")] },
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
            instrumentation = object : Instrumentation {
                override suspend fun op(info: OpInfo, run: suspend () -> Outcome): Outcome = try {
                    run()
                } finally {
                    if (info.kind == "query" && info.name == "book") bookQueryEnded.trySend(Unit)
                }
            },
        )
        listener = RayfoldWebSocket(server) { req -> req.header("x-user")?.let { u -> buildJsonObject { put("id", u) } } ?: JsonNull }.start(0)
        url = "ws://127.0.0.1:${listener.port}/rayfold/ws"
    }

    @AfterEach
    fun stop() {
        transports.forEach { it.close() }
        relays.forEach { it.close() }
        listener.close()
        http.dispatcher.executorService.shutdown()
        http.connectionPool.evictAll()
    }

    private fun transport(user: String? = null, to: String = url, origin: String? = null): OkHttpWebSocketTransport {
        val headers = listOfNotNull(user?.let { "X-User" to it }, origin?.let { "Origin" to it }).toMap()
        return OkHttpWebSocketTransport(to, headers, http).also { transports.add(it) }
    }

    private fun bounded(block: suspend CoroutineScope.() -> Unit) = runBlocking { withTimeout(5_000) { block() } }

    private fun JsonElement.title() = jsonObject["title"]?.jsonPrimitive?.content
    private fun JsonElement.stock() = jsonObject["stock"]?.jsonPrimitive?.int ?: -1

    /**
     * A TCP relay in front of the listener. [cut] closes every connection through it, both ways at once, as a network
     * that fails or a server that goes away does: neither end gets another byte from the other.
     */
    private class Relay(target: Int) : AutoCloseable {
        private val accepting = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        private val open = CopyOnWriteArrayList<Socket>()
        val port: Int = accepting.localPort

        init {
            thread(isDaemon = true, name = "relay-accept") {
                while (true) {
                    val downstream = runCatching { accepting.accept() }.getOrNull() ?: break
                    val upstream = Socket(InetAddress.getLoopbackAddress(), target)
                    open.add(downstream)
                    open.add(upstream)
                    pump(downstream, upstream)
                    pump(upstream, downstream)
                }
            }
        }

        private fun pump(from: Socket, to: Socket) = thread(isDaemon = true, name = "relay-pump") {
            runCatching { from.getInputStream().transferTo(to.getOutputStream()) }
            runCatching { from.close() }
            runCatching { to.close() }
        }

        fun cut() {
            open.forEach { runCatching { it.close() } }
            open.clear()
        }

        override fun close() {
            runCatching { accepting.close() }
            cut()
        }
    }

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
        val job = launch { alice.live("book", args("id" to "b1"), "{ id stock }").collect { stock.send(it.stock()) } }
        assertEquals(3, stock.receive())
        assertEquals(1, server.changes.size, "guard: the open live query holds a subscription")
        bob.command("buy", args("id" to "b1", "qty" to 1))
        assertEquals(2, stock.receive())
        job.cancelAndJoin()
        bookQueryEnded.receive()
        assertEquals(0, server.changes.size)
    }

    @Test
    fun `a handshake the server refuses with 403 fails the batch with a typed error and runs nothing (guard - the page's own origin is served)`() = bounded {
        val refused = assertFailsWith<RayfoldClientException> {
            RayfoldClient(transport(origin = "https://evil.example")).query("book", args("id" to "b1"), "{ title }")
        }
        assertEquals("unavailable", refused.code)
        assertEquals("WebSocket connection failed: Expected HTTP 101 response but was '403 Forbidden'", refused.message)
        assertEquals(null, refused.type)
        assertEquals(0, bookQueries.get())

        val same = RayfoldClient(transport(origin = "http://127.0.0.1:${listener.port}"))
        assertEquals(Json.parseToJsonElement("""{"${'$'}type":"Book","title":"The Dispossessed"}"""), same.query("book", args("id" to "b1"), "{ title }"))
        assertEquals(1, bookQueries.get())
    }

    @Test
    fun `a socket the server drops ends its batches with unavailable, and the next batch reconnects`() = bounded {
        val t = transport()
        val frames = Channel<JsonObject>(Channel.UNLIMITED)
        val envelope = buildJsonObject { put("ops", JsonArray(listOf(buildJsonObject { put("id", 1); put("op", "book"); put("args", buildJsonObject { put("id", "b1") }); put("shape", "{ id }"); put("live", true) }))) }
        val live = async { t.send(envelope, safe = true).collect { frames.send(it) } }
        assertEquals(Json.parseToJsonElement("""{"id":1,"data":{"${'$'}type":"Book","id":"b1"},"meta":{"cost":1}}"""), frames.receive())
        assertEquals(1, server.changes.size, "the first frame comes after the live query subscribed")
        val port = listener.port
        listener.close() // every connection closes, as when the server restarts
        live.await()
        frames.close()
        val rest = frames.toList()
        assertEquals(JsonPrimitive("unavailable"), (rest.last()["error"] as? JsonObject)?.get("code"), "$rest")
        // back at the same address, so the transport that lost its socket can find the server again
        listener = RayfoldWebSocket(server) { JsonNull }.start(port)
        assertEquals("Kindred", RayfoldClient(t).query("book", args("id" to "b2"), "{ title }").title(), "guard: the same transport opens a new socket")
    }

    @Test
    fun `after the socket drops, a live query says so and reopens by itself on a new socket, and gets the next patch`() = bounded {
        val relay = Relay(listener.port).also { relays.add(it) }
        val alice = RayfoldClient(transport("alice", to = "ws://127.0.0.1:${relay.port}/rayfold/ws"))
        val bob = RayfoldClient(transport("bob"))

        val stock = Channel<Int>(Channel.UNLIMITED)
        val failures = Channel<Pair<String?, Boolean>>(Channel.UNLIMITED)
        val live = launch {
            alice.live("book", args("id" to "b1"), "{ id stock }", onError = { e, retrying -> failures.trySend((e as? RayfoldClientException)?.code to retrying) })
                .collect { stock.send(it.stock()) }
        }
        assertEquals(3, stock.receive())
        assertEquals(1, server.changes.size)
        relay.cut()
        assertEquals("unavailable" to true, failures.receive(), "the drop is reported as one it is coming back from")
        bookQueryEnded.receive()
        // it reopens after half a second, on a socket of its own: the application collects one flow throughout
        assertEquals(3, stock.receive())
        assertEquals(1, server.changes.size, "subscribed again, on a new socket")
        bob.command("buy", args("id" to "b1", "qty" to 1))
        assertEquals(2, stock.receive())
        live.cancelAndJoin()
        bookQueryEnded.receive()
        assertEquals(0, server.changes.size)
        assertEquals(2, bookQueries.get() - 1, "two runs of the reopened query (first result, the patch re-run) after the one that dropped")
    }
}
