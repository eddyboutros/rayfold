package dev.rayfold.client

import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.net.ConnectException
import java.net.SocketException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Sub-profile `sync` in the Kotlin client, against the real Kotlin server through a network that can be up, down,
 * lossy (the server runs the batch and the answer is lost) or held at a gate. Every test is bounded to 5 s.
 */
class SyncTest {
    private val schema = """
        entity Book { id: ID title: String stock: Int }
        error OutOfStock { available: Int }
        query book(id: ID): Book?
        command restock(id: ID, qty: Int): Book
        command buy(id: ID, qty: Int): Book throws OutOfStock
    """
    private val books = ConcurrentHashMap(mapOf("b1" to book("b1", 3), "b2" to book("b2", 1)))
    private val restocks = AtomicInteger()
    private val viewer = buildJsonObject { put("id", "u1") }
    private val server = RayfoldServer(
        SchemaText.load(schema).ir,
        Resolvers(
            queries = mapOf("book" to { a, _ -> books[a.id()] }),
            commands = mapOf(
                "restock" to { a, _ ->
                    restocks.incrementAndGet()
                    book(a.id(), stockOf(a.id()) + a.qty()).also { books[a.id()] = it }
                },
                "buy" to { a, _ ->
                    val stock = stockOf(a.id())
                    if (a.qty() > stock) throw RayfoldException.domain("OutOfStock", buildJsonObject { put("available", stock) }, "Only $stock left")
                    book(a.id(), stock - a.qty()).also { books[a.id()] = it }
                },
            ),
        ),
    )

    private fun book(id: String, stock: Int) = buildJsonObject { put("id", id); put("title", "T$id"); put("stock", stock) }
    private fun stockOf(id: String) = books[id]?.get("stock")?.jsonPrimitive?.int ?: 0
    private fun JsonObject.id() = this["id"]?.jsonPrimitive?.content ?: error("no id")
    private fun JsonObject.qty() = this["qty"]?.jsonPrimitive?.int ?: error("no qty")
    private fun JsonElement.stock() = jsonObject["stock"]?.jsonPrimitive?.int

    private inner class Network : Transport {
        @Volatile var mode = "up"
        @Volatile var gate: CompletableDeferred<Unit>? = null
        val sent = CopyOnWriteArrayList<JsonObject>()

        override fun send(envelope: JsonObject, safe: Boolean): Flow<JsonObject> = flow {
            gate?.await()
            if (mode == "down") throw ConnectException("Connection refused")
            sent.add(envelope)
            if (mode == "lossy") {
                server.execute(envelope, viewer).collect { } // the server answered, and the answer never arrives
                throw SocketException("Connection reset")
            }
            emitAll(server.execute(envelope, viewer))
        }

        fun keys() = sent.map { it["ops"]?.let { ops -> (ops as kotlinx.serialization.json.JsonArray)[0].jsonObject["key"]?.jsonPrimitive?.content } }
    }

    private val keyN = AtomicInteger()
    private fun client(net: Network, offline: OfflineOptions? = null) =
        RayfoldClient(net, ClientOptions(keyGen = { "sync-key-" + keyN.incrementAndGet().toString().padStart(8, '0') }, offline = offline))

    private fun bounded(block: suspend CoroutineScope.() -> Unit) = runBlocking { withTimeout(5_000) { block() } }
    private fun predict(id: String, stock: Int) = listOf(OptimisticOp("Book:$id", buildJsonObject { put("stock", stock) }))
    private fun RayfoldClient.stock(id: String = "b1") = cache.get("Book:$id")?.get("stock")?.jsonPrimitive?.int

    /** Queue events as they happen, to wait on. */
    private fun events(c: RayfoldClient): Channel<QueueEvent> = Channel<QueueEvent>(Channel.UNLIMITED).also { ch -> c.onQueue { ch.trySend(it) } }

    @Test
    fun `predictions stack, and removing one leaves the server's value under whatever prediction is left`() {
        val cache = RayfoldCache()
        cache.applyPatch(listOf(buildJsonObject { put("set", "Book:b1"); put("value", buildJsonObject { put("stock", 5); put("title", "T") }) }))
        cache.addLayer("a", predict("b1", 6))
        cache.addLayer("b", predict("b1", 8))
        assertEquals(8, cache.get("Book:b1")?.get("stock")?.jsonPrimitive?.int)
        cache.removeLayer("b")
        assertEquals(6, cache.get("Book:b1")?.get("stock")?.jsonPrimitive?.int)
        cache.applyPatch(listOf(buildJsonObject { put("set", "Book:b1"); put("value", buildJsonObject { put("stock", 7) }) })) // the server moves underneath
        assertEquals(6, cache.get("Book:b1")?.get("stock")?.jsonPrimitive?.int)
        cache.removeLayer("a")
        assertEquals(7, cache.get("Book:b1")?.get("stock")?.jsonPrimitive?.int)
        assertEquals(JsonPrimitive("T"), cache.get("Book:b1")?.get("title"))
        assertEquals(emptyList(), cache.predictions)
    }

    @Test
    fun `a command shows its prediction at once, then the server's own value when it answers`() = bounded {
        val net = Network()
        val c = client(net)
        val seen = Channel<Int>(Channel.UNLIMITED)
        val watching = launch { c.watch("book", args("id" to "b1"), "{ id stock }").collect { seen.send(it.stock() ?: -1) } }
        assertEquals(3, seen.receive())
        net.gate = CompletableDeferred()
        // the prediction is one short on purpose: the server's answer has to win
        val done = async { c.command("restock", args("id" to "b1", "qty" to 2), "{ id stock }", optimistic = predict("b1", 4)) }
        assertEquals(4, seen.receive())
        assertEquals(3, stockOf("b1"), "nothing has reached the server yet")
        net.gate?.complete(Unit)
        assertEquals(5, done.await().stock())
        // the answer lands under the prediction, which the watch reports as a change to its book (still 4), and then the
        // settled command takes the prediction away; nothing else follows
        assertEquals(listOf(4, 5), listOf(seen.receive(), seen.receive()))
        assertTrue(seen.tryReceive().isFailure, "no value after the server's own")
        assertEquals(5, c.stock())
        assertEquals(emptyList(), c.cache.predictions)
        watching.cancel()
    }

    @Test
    fun `a failed command rolls its prediction back, and the failure still reaches the caller`() = bounded {
        val c = client(Network())
        c.query("book", args("id" to "b1"), "{ id stock }")
        val e = assertFailsWith<RayfoldClientException> { c.command("buy", args("id" to "b1", "qty" to 99), optimistic = predict("b1", -96)) }
        assertTrue(e.isType("OutOfStock"))
        assertEquals(3, c.stock())
        assertEquals(emptyList(), c.cache.predictions)
    }

    @Test
    fun `commands made while the server is unreachable wait with their predictions and go out in order with their keys`() = bounded {
        val net = Network()
        val c = client(net, OfflineOptions())
        val events = events(c)
        net.mode = "down"
        val first = async { c.command("restock", args("id" to "b1", "qty" to 1), "{ id stock }", optimistic = predict("b1", 4)) }
        assertEquals(QueueEvent.Type.QUEUED, events.receive().type)
        // a second command while the server is still out waits behind the first
        val second = async { c.command("restock", args("id" to "b1", "qty" to 2), "{ id stock }") }
        assertEquals(QueueEvent.Type.QUEUED, events.receive().type)
        assertEquals(listOf("sync-key-00000001", "sync-key-00000002"), c.queued.map { it.key })
        assertEquals(4, c.stock())
        assertEquals(emptyList(), net.sent)

        net.mode = "up"
        assertEquals(0, c.drain())
        assertEquals(4, first.await().stock())
        assertEquals(6, second.await().stock())
        assertEquals(listOf("sync-key-00000001", "sync-key-00000002"), net.keys())
        assertEquals(6, stockOf("b1"))
        assertEquals(6, c.stock())
    }

    @Test
    fun `a drain while the server is still unreachable sends nothing and keeps every command`() = bounded {
        val net = Network()
        val c = client(net, OfflineOptions())
        val events = events(c)
        net.mode = "down"
        launch { c.command("restock", args("id" to "b1", "qty" to 1)) }
        events.receive()
        launch { c.command("restock", args("id" to "b2", "qty" to 1)) }
        events.receive()
        assertEquals(2, c.drain())
        assertEquals(0, restocks.get())
        coroutineContext.cancelChildren()
    }

    @Test
    fun `a command the server ran before its answer was lost is replayed on the retry, not run twice`() = bounded {
        val net = Network()
        val c = client(net, OfflineOptions())
        val events = events(c)
        net.mode = "lossy"
        val restocked = async { c.command("restock", args("id" to "b1", "qty" to 1), "{ id stock }") }
        events.receive()
        assertEquals(1, restocks.get(), "it did run on the server")
        net.mode = "up"
        assertEquals(0, c.drain())
        assertEquals(4, restocked.await().stock())
        assertEquals(1, restocks.get(), "the retry carried the same key and was answered from the record")
    }

    @Test
    fun `a queued command the server refuses is rolled back and refused, and the next one still goes out`() = bounded {
        val net = Network()
        val c = client(net, OfflineOptions())
        val events = events(c)
        net.mode = "down"
        val tooMany = async { runCatching { c.command("buy", args("id" to "b1", "qty" to 99), optimistic = predict("b1", -96)) } }
        events.receive()
        val one = async { c.command("buy", args("id" to "b1", "qty" to 1), "{ id stock }") }
        events.receive()
        net.mode = "up"
        assertEquals(0, c.drain())
        assertTrue((tooMany.await().exceptionOrNull() as? RayfoldClientException)?.isType("OutOfStock") == true)
        assertEquals(2, one.await().stock())
        assertEquals(listOf(QueueEvent.Type.FAILED, QueueEvent.Type.SENT), listOf(events.receive().type, events.receive().type))
        assertEquals(emptyList(), c.cache.predictions)
    }

    @Test
    fun `the queue survives a restart in a file, shows its prediction again, and sends the command`(@TempDir dir: File) = bounded {
        val net = Network()
        val file = File(dir, "queue.json")
        val before = client(net, OfflineOptions(FileQueueStorage(file)))
        val events = events(before)
        net.mode = "down"
        launch { before.command("restock", args("id" to "b1", "qty" to 1), "{ id stock }", optimistic = predict("b1", 4)) }
        events.receive()
        assertTrue(file.readText().contains("sync-key-00000001"))

        val after = client(net, OfflineOptions(FileQueueStorage(file)))
        assertEquals(1, after.drain(), "still offline: the restored command waits")
        assertEquals(4, after.stock())
        net.mode = "up"
        assertEquals(0, after.drain())
        assertEquals(listOf("sync-key-00000001"), net.keys())
        assertEquals(4, stockOf("b1"))
        assertTrue(!file.exists(), "an empty queue leaves no file")
        coroutineContext.cancelChildren()
    }

    @Test
    fun `a command made once the server is back sends the waiting ones first and then itself, with no drain`() = bounded {
        val net = Network()
        val c = client(net, OfflineOptions())
        val events = events(c)
        net.mode = "down"
        val first = async { c.command("restock", args("id" to "b1", "qty" to 1), "{ id stock }") }
        assertEquals(QueueEvent.Type.QUEUED, events.receive().type)
        net.mode = "up"
        assertEquals(6, c.command("restock", args("id" to "b1", "qty" to 2), "{ id stock }").stock())
        assertEquals(4, first.await().stock())
        assertEquals(listOf("sync-key-00000001", "sync-key-00000002"), net.keys())
        assertEquals(emptyList(), c.queued)
    }

    @Test
    fun `after a restart the first command sends the restored ones before itself`(@TempDir dir: File) = bounded {
        val net = Network()
        val file = File(dir, "queue.json")
        val before = client(net, OfflineOptions(FileQueueStorage(file)))
        val events = events(before)
        net.mode = "down"
        launch { before.command("restock", args("id" to "b1", "qty" to 1), "{ id stock }", optimistic = predict("b1", 4)) }
        events.receive()
        coroutineContext.cancelChildren()

        net.mode = "up"
        val after = client(net, OfflineOptions(FileQueueStorage(file)))
        assertEquals(4, after.stock(), "the restored prediction is shown")
        assertEquals(emptyList(), net.sent)
        assertEquals(6, after.command("restock", args("id" to "b1", "qty" to 2), "{ id stock }").stock())
        assertEquals(listOf("sync-key-00000001", "sync-key-00000002"), net.keys())
        assertEquals(emptyList(), after.queued)
        assertTrue(!file.exists())
    }

    @Test
    fun `a damaged queue file is dropped instead of blocking the client`(@TempDir dir: File) {
        val file = File(dir, "queue.json").apply { writeText("{ not json") }
        assertEquals(emptyList(), FileQueueStorage(file).load())
    }

    @Test
    fun `guard - without offline, an unreachable server fails the command, rolls the prediction back and queues nothing`() = bounded {
        val net = Network()
        val c = client(net)
        net.mode = "down"
        assertFailsWith<ConnectException> { c.command("restock", args("id" to "b1", "qty" to 1), optimistic = predict("b1", 4)) }
        assertEquals(emptyList(), c.queued)
        assertNull(c.cache.get("Book:b1"))
        assertEquals(0, c.drain())
    }

    private fun kotlin.coroutines.CoroutineContext.cancelChildren() = this[kotlinx.coroutines.Job]?.children?.forEach { it.cancel() }
}
