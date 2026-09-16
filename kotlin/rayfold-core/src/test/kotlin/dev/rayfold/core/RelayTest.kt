package dev.rayfold.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotSame
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Two servers behind one load balancer share a database and nothing else (mirrors packages/server/src/relay.test.ts).
 * A command run on one must reach a live query or a stream open on the other, and neither server may hear its own
 * change a second time. The relay hands messages over on its own thread, so these run on the wall clock with every
 * wait bounded at 5 s, and each test proves its counts with a barrier: a later change every server is seen to hear.
 */
class RelayTest {
    private val ir = SchemaText.load(
        "entity Book { id: ID title: String stock: Int } event StockChanged { bookId: ID stock: Int } " +
            "query book(id: ID): Book? command restock(id: ID, qty: Int): Book emits StockChanged stream stockUpdates(bookIds: [ID]): StockChanged",
    ).ir
    private val key = "0123456789abcdef"
    private val viewer = obj("""{"id":"u1"}""")
    private val opened = obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1","stock":3},"meta":{"cost":1}}""")

    private fun patch(stock: Int) = obj("""{"id":1,"patch":[{"set":"Book:b1","value":{"stock":$stock}}]}""")

    private fun shelf() = ConcurrentHashMap(mapOf("b1" to obj("""{"id":"b1","title":"Dune","stock":3}""")))

    /** A server over the shared books, as one instance behind the balancer; [reads] counts its runs of `book`. */
    private class Instance(val server: RayfoldServer, val reads: AtomicInteger, val subscribed: CompletableDeferred<Unit>)

    private fun instance(books: ConcurrentHashMap<String, JsonObject>, relay: Relay? = null, onRelayError: (Throwable) -> Unit = {}): Instance {
        val reads = AtomicInteger()
        val subscribed = CompletableDeferred<Unit>()
        val resolvers = Resolvers(
            queries = mapOf("book" to query { args, _ -> reads.incrementAndGet(); books[args.s("id")] ?: JsonNull }),
            commands = mapOf(
                "restock" to command { args, _ ->
                    val id = args.s("id")
                    val book = books[id] ?: error("no book $id")
                    val next = JsonObject(book + ("stock" to JsonPrimitive(book.i("stock") + args.i("qty"))))
                    books[id] = next
                    CommandResult(next, emit = listOf("StockChanged" to buildJsonObject { put("bookId", id); put("stock", next.i("stock")) }))
                },
            ),
            streams = mapOf(
                "stockUpdates" to { args, ctx ->
                    val wanted = (args["bookIds"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }?.toSet() ?: emptySet()
                    callbackFlow<JsonElement> {
                        val off = ctx.events.on("StockChanged") { p -> if ((p["bookId"] as? JsonPrimitive)?.content in wanted) trySend(p) }
                        subscribed.complete(Unit)
                        awaitClose { off() }
                    }
                },
            ),
        )
        return Instance(RayfoldServer(ir, resolvers, relay = relay, onRelayError = onRelayError), reads, subscribed)
    }

    /** An op that stays open (a live query or a stream): [next] takes its next frame, bounded, and [stop] ends it. */
    private class Open(scope: CoroutineScope, server: RayfoldServer, op: String, viewer: JsonElement) {
        private val cancel = Job()
        private val channel = Channel<JsonObject>(Channel.UNLIMITED)
        private val job = scope.launch {
            try {
                server.execute(obj("""{"ops":[$op]}"""), ExecuteOptions(viewer, cancel = cancel)).collect { channel.send(it) }
            } finally {
                channel.close()
            }
        }

        suspend fun next(): JsonObject = withTimeout(5_000) { channel.receive() }

        suspend fun stop() {
            cancel.complete()
            withTimeout(5_000) { job.join() }
        }
    }

    private fun CoroutineScope.live(server: RayfoldServer) = Open(this, server, """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}""", viewer)

    private suspend fun restock(server: RayfoldServer, key: String, qty: Int = 1): JsonObject =
        server.collect(obj("""{"ops":[{"id":1,"op":"restock","args":{"id":"b1","qty":$qty},"key":"$key"}]}"""), viewer).single()

    private fun JsonObject.stock(): Int? = ((this["ok"] as? JsonObject)?.get("stock") as? JsonPrimitive)?.content?.toIntOrNull()

    @Test
    fun `a command run on one server updates a live query open on another, and each server hears each change exactly once`() = runBlocking {
        val books = shelf()
        val relay = MemoryRelay()
        val a = instance(books, relay.join())
        val b = instance(books, relay.join())
        withTimeout(5_000) { a.server.ready(); b.server.ready() }
        assertEquals(2, relay.size)
        val onA = live(a.server)
        val onB = live(b.server)
        assertEquals(opened, onA.next())
        assertEquals(opened, onB.next())

        assertEquals(4, restock(a.server, key + "1").stock())
        // the shape names `id`, so the result is an entity and the patch is keyed to it: every cached view of Book:b1 applies it
        assertEquals(patch(4), onB.next(), "b hears a's change over the relay")
        assertEquals(patch(4), onA.next())

        // a second change is the barrier: once both servers have delivered it, every earlier delivery has happened too
        assertEquals(5, restock(b.server, key + "2").stock())
        assertEquals(patch(5), onA.next(), "a hears b's change over the relay")
        assertEquals(patch(5), onB.next(), "b hears its own change")
        // one read to answer, one per change: a relay that echoed a server's own change back would make it read again
        assertEquals(3, a.reads.get())
        assertEquals(3, b.reads.get())
        onA.stop()
        onB.stop()
        assertEquals(0, a.server.changes.size + b.server.changes.size, "the open ops let go of their subscriptions")
    }

    @Test
    fun `an event raised on one server reaches a stream open on another`() = runBlocking {
        val books = shelf()
        val relay = MemoryRelay()
        val a = instance(books, relay.join())
        val b = instance(books, relay.join())
        withTimeout(5_000) { a.server.ready(); b.server.ready() }
        val stream = Open(this, b.server, """{"id":1,"op":"stockUpdates","args":{"bookIds":["b1"]}}""", viewer)
        withTimeout(5_000) { b.subscribed.await() } // the stream subscribes as it starts, so the command comes after

        assertEquals(5, restock(a.server, key + "1", 2).stock())
        assertEquals(obj("""{"id":1,"item":{"bookId":"b1","stock":5}}"""), stream.next(), "b's stream delivers a's event, projected through StockChanged")
        stream.stop()
    }

    @Test
    fun `guard - without a relay, a server hears only itself`() = runBlocking {
        val books = shelf()
        val a = instance(books)
        val b = instance(books)
        val onB = live(b.server)
        assertEquals(opened, onB.next())

        assertEquals(4, restock(a.server, key + "1").stock()) // and b has no way to know
        assertEquals(5, restock(b.server, key + "2").stock()) // the barrier, and the first change b can hear
        assertEquals(patch(5), onB.next(), "straight from 3 to 5")
        assertEquals(2, b.reads.get())
        assertEquals(0, a.reads.get(), "a answered no live query and re-ran nothing")
        onB.stop()
    }

    @Test
    fun `a relay that refuses a message reports it, and the command that made the change still succeeds`() = runBlocking {
        val refused = CopyOnWriteArrayList<Throwable>()
        val reported = CountDownLatch(2)
        val down = object : Relay {
            override suspend fun publish(message: RelayMessage) = throw IllegalStateException("the relay is down")
            override suspend fun subscribe(onMessage: (RelayMessage) -> Unit): suspend () -> Unit = {}
        }
        val a = instance(shelf(), down) { refused.add(it); reported.countDown() }
        assertEquals(4, restock(a.server, key + "1").stock())
        // the change and the event were both refused: two messages, two reports
        assertTrue(reported.await(5, TimeUnit.SECONDS), "both refusals being reported")
        assertEquals(listOf("the relay is down", "the relay is down"), refused.map { it.message })
        assertEquals("the relay is down", a.server.relayFailure?.message)
    }

    @Test
    fun `ready() waits until the server hears the others, and throws what stopped it`() = runBlocking {
        val listening = CompletableDeferred<Unit>()
        val slow = object : Relay {
            override suspend fun publish(message: RelayMessage) {}
            override suspend fun subscribe(onMessage: (RelayMessage) -> Unit): suspend () -> Unit { listening.await(); return {} }
        }
        val a = instance(shelf(), slow)
        val waiting = async { a.server.ready() }
        repeat(20) { yield() }
        assertFalse(waiting.isCompleted, "not ready while the relay is still connecting")
        listening.complete(Unit)
        withTimeout(5_000) { waiting.await() }
        assertNull(a.server.relayFailure)

        val refused = CopyOnWriteArrayList<Throwable>()
        val broken = object : Relay {
            override suspend fun publish(message: RelayMessage) {}
            override suspend fun subscribe(onMessage: (RelayMessage) -> Unit): suspend () -> Unit = throw IllegalStateException("LISTEN failed")
        }
        val b = instance(shelf(), broken) { refused.add(it) }
        val failure = assertFailsWith<IllegalStateException> { withTimeout(5_000) { b.server.ready() } }
        assertEquals("LISTEN failed", failure.message)
        assertEquals("LISTEN failed", b.server.relayFailure?.message)
        assertEquals(listOf("LISTEN failed"), refused.map { it.message })
        withTimeout(5_000) { b.server.close() } // nothing to stop, and not a second failure
    }

    @Test
    fun `close() stops hearing the other servers, and until then they are heard`() = runBlocking {
        val books = shelf()
        val relay = MemoryRelay()
        val a = instance(books, relay.join())
        val b = instance(books, relay.join())
        withTimeout(5_000) { a.server.ready(); b.server.ready() }
        assertEquals(2, relay.size)
        val onB = live(b.server)
        assertEquals(opened, onB.next())

        assertEquals(4, restock(a.server, key + "1").stock())
        assertEquals(patch(4), onB.next(), "heard before close")
        withTimeout(5_000) { b.server.close() }
        assertEquals(1, relay.size)

        assertEquals(5, restock(a.server, key + "2").stock()) // no longer heard
        assertEquals(6, restock(b.server, key + "3").stock()) // the barrier
        assertEquals(patch(6), onB.next(), "b hears its own change, and nothing of a's second one")
        assertEquals(3, b.reads.get())
        onB.stop()
    }

    @Test
    fun `a MemoryRelay end hears every other end's messages as copies, and never its own`() = runBlocking {
        val relay = MemoryRelay()
        val a = relay.join()
        val b = relay.join()
        val heardByA = CopyOnWriteArrayList<RelayMessage>()
        val heardByB = CopyOnWriteArrayList<RelayMessage>()
        val stopA = a.subscribe { heardByA.add(it) }
        val stopB = b.subscribe { heardByB.add(it) }
        assertEquals(2, relay.size)
        val payload = obj("""{"bookId":"b1","stock":4}""")
        val event = RelayMessage.Event("StockChanged", payload)
        val change = RelayMessage.Change(linkedSetOf("Book:b1", "Author:a1"), linkedSetOf("books"))
        a.publish(event)
        a.publish(change)
        assertEquals(emptyList(), heardByA.toList(), "a never hears itself")
        val (e, c) = heardByB.toList()
        assertEquals("StockChanged" to payload, (e as RelayMessage.Event).let { it.name to it.payload })
        assertNotSame(payload, e.payload, "a copy, as a wire would give")
        assertEquals(listOf("Book:b1", "Author:a1") to listOf("books"), (c as RelayMessage.Change).let { it.keys.toList() to it.ops.toList() })
        assertNotSame(change.keys, c.keys)
        stopB()
        assertEquals(1, relay.size)
        a.publish(change)
        assertEquals(2, heardByB.size, "guard: nothing after unsubscribing")
        stopA()
        assertEquals(0, relay.size)
    }
}
