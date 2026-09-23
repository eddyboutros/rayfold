package dev.rayfold.jdbc

import dev.rayfold.core.CommandResult
import dev.rayfold.core.ExecuteOptions
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Relay
import dev.rayfold.core.RelayMessage
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.sql.Connection
import java.sql.DriverManager
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The relay over Postgres, mirroring packages/postgres/src/relay.test.ts. H2 cannot NOTIFY, so several relays share
 * one [Hub] standing in for the channel, over one H2 database standing in for the relay table; what crosses the
 * hub is pinned byte for byte, since a TypeScript server must be able to share the real channel. The pgjdbc adapter
 * itself is exercised only by the CI job against a real Postgres.
 */
class PgRelayTest {
    /** The NOTIFY channel in memory: every payload reaches every listener on it, the sender's own included. */
    private class Hub : Notifications {
        private class Listener(val channel: String, val onPayload: (String) -> Unit)

        private val listeners = CopyOnWriteArrayList<Listener>()

        override suspend fun listen(channel: String, onPayload: (String) -> Unit): suspend () -> Unit {
            val l = Listener(channel, onPayload)
            listeners.add(l)
            return { listeners.remove(l) }
        }

        override suspend fun notify(channel: String, payload: String) {
            for (l in listeners) if (l.channel == channel) l.onPayload(payload)
        }
    }

    private companion object {
        val databases = AtomicInteger()
    }

    private val hub = Hub()
    private var now = 1_000L
    private lateinit var url: String
    private lateinit var keepAlive: Connection

    @BeforeEach
    fun open() {
        url = "jdbc:h2:mem:rayfoldrelay${databases.incrementAndGet()}"
        keepAlive = DriverManager.getConnection(url)
        // H2 has JSON but not Postgres's jsonb; a domain lets the relay's own DDL and INSERT run unchanged
        keepAlive.createStatement().use { it.execute("CREATE DOMAIN jsonb AS JSON") }
        relay("setup").migrate()
    }

    @AfterEach
    fun close() {
        keepAlive.close()
    }

    private fun relay(origin: String, ttlMs: Long = 5 * 60_000L, maxInline: Int = 7900, onError: (Throwable) -> Unit = {}) =
        PgRelay(hub, { DriverManager.getConnection(url) }, PgRelayOptions(origin = origin, ttlMs = ttlMs, maxInline = maxInline, onError = onError, now = { now }))

    private fun rows(): List<Long> = keepAlive.createStatement().use { s ->
        s.executeQuery("SELECT id FROM rayfold_relay ORDER BY id").use { r -> generateSequence { if (r.next()) r.getLong(1) else null }.toList() }
    }

    private fun change(key: String) = RelayMessage.Change(setOf(key), emptySet())

    /** A message as text, so two can be compared exactly. */
    private fun show(m: RelayMessage): String = when (m) {
        is RelayMessage.Change -> "change keys=${m.keys} ops=${m.ops}"
        is RelayMessage.Event -> "event ${m.name} ${m.payload}"
    }

    /** A relay end that records what reaches it. */
    private class Ear(val received: CopyOnWriteArrayList<String>, val stop: suspend () -> Unit)

    private suspend fun ear(origin: String): Ear {
        val received = CopyOnWriteArrayList<String>()
        val stop = relay(origin).subscribe { received.add(show(it)) }
        return Ear(received, stop)
    }

    @Test
    fun `puts exactly this on the wire, so a server in the other runtime can share the channel`() = runBlocking {
        val sent = mutableListOf<Pair<String, String>>()
        val spy = object : Notifications {
            override suspend fun listen(channel: String, onPayload: (String) -> Unit): suspend () -> Unit = {}
            override suspend fun notify(channel: String, payload: String) { sent.add(channel to payload) }
        }
        val r = PgRelay(spy, { DriverManager.getConnection(url) }, PgRelayOptions(origin = "a"))
        r.publish(RelayMessage.Change(linkedSetOf("Book:b1", "Author:a1"), linkedSetOf("books")))
        r.publish(RelayMessage.Event("StockChanged", buildJsonObject { put("bookId", "b1"); put("stock", 4) }))
        assertEquals(
            listOf(
                "rayfold" to """{"from":"a","change":{"keys":["Book:b1","Author:a1"],"ops":["books"]}}""",
                "rayfold" to """{"from":"a","event":{"name":"StockChanged","payload":{"bookId":"b1","stock":4}}}""",
            ),
            sent,
        )
        assertEquals("CREATE TABLE IF NOT EXISTS rayfold_relay (id bigserial PRIMARY KEY, message jsonb NOT NULL, at bigint NOT NULL)", r.schema())
        assertEquals("CREATE TABLE IF NOT EXISTS app.relay (id bigserial PRIMARY KEY, message jsonb NOT NULL, at bigint NOT NULL)", PgRelay(spy, { keepAlive }, PgRelayOptions(table = "app.relay")).schema())
    }

    @Test
    fun `a message too large for a payload goes through the table and arrives whole, and a small one leaves no row`() = runBlocking {
        val a = relay("a")
        val b = ear("b")
        val blob = "x".repeat(20_000)
        a.publish(RelayMessage.Event("Imported", buildJsonObject { put("blob", blob) }))
        assertEquals(listOf("event Imported ${buildJsonObject { put("blob", blob) }}"), b.received.toList())
        assertEquals(listOf(1L), rows())

        a.publish(change("Book:b1"))
        assertEquals("change keys=[Book:b1] ops=[]", b.received.last())
        assertEquals(2, b.received.size)
        assertEquals(listOf(1L), rows(), "it fit: no row")
        b.stop()
    }

    @Test
    fun `sweeps table rows past their lifetime as new ones are written`() = runBlocking {
        val a = relay("a", ttlMs = 1_000, maxInline = 10)
        val b = ear("b")
        a.publish(change("Book:b1")) // every change is over 10 bytes, so each is a row
        now += 1_000
        a.publish(change("Book:b2"))
        assertEquals(listOf(1L, 2L), rows(), "row 1 is exactly its lifetime old: kept")
        now += 1
        a.publish(change("Book:b3"))
        assertEquals(listOf(2L, 3L), rows(), "one millisecond past: swept; row 2 is a millisecond old")
        now += 1_001
        a.publish(change("Book:b4"))
        assertEquals(listOf(4L), rows())
        assertEquals(listOf("Book:b1", "Book:b2", "Book:b3", "Book:b4").map { "change keys=[$it] ops=[]" }, b.received.toList(), "every change arrived, swept afterwards or not")
        b.stop()
    }

    @Test
    fun `drops what it published itself, and hears what others publish`() = runBlocking {
        val a = relay("a")
        val heardByA = CopyOnWriteArrayList<String>()
        val stopA = a.subscribe { heardByA.add(show(it)) }
        val b = relay("b")
        a.publish(change("Book:mine"))
        b.publish(change("Book:theirs")) // the barrier: a's own message was sent before it
        assertEquals(listOf("change keys=[Book:theirs] ops=[]"), heardByA.toList())
        stopA()
    }

    @Test
    fun `stops delivering once unsubscribed, and delivered until then`() = runBlocking {
        val a = relay("a")
        val b = ear("b")
        a.publish(change("Book:1"))
        assertEquals(listOf("change keys=[Book:1] ops=[]"), b.received.toList())
        b.stop()
        a.publish(change("Book:2"))
        val c = ear("c") // subscribed after the second change: the third is the barrier
        a.publish(change("Book:3"))
        assertEquals(listOf("change keys=[Book:3] ops=[]"), c.received.toList())
        assertEquals(listOf("change keys=[Book:1] ops=[]"), b.received.toList())
        c.stop()
    }

    @Test
    fun `reports a message it cannot read instead of failing silently, and keeps listening`() = runBlocking {
        val errors = CopyOnWriteArrayList<Throwable>()
        val b = relay("b", onError = { errors.add(it) })
        val received = CopyOnWriteArrayList<String>()
        val stop = b.subscribe { received.add(show(it)) }
        hub.notify("rayfold", """{"from":"a","ref":999}""") // a row that was swept before b read it
        hub.notify("rayfold", "not json at all")
        hub.notify("rayfold", """{"from":"a","change":{"keys":["Book:b1"],"ops":[]}}""")
        assertEquals(listOf("change keys=[Book:b1] ops=[]"), received.toList(), "the readable message after the unreadable ones")
        assertEquals(2, errors.size)
        assertEquals("rayfold relay: message 999 is gone from rayfold_relay", errors[0].message)
        stop()
    }

    // ------------------------------------------------------------------ through two servers

    private val ir = SchemaText.load(
        "entity Book { id: ID title: String stock: Int } event StockChanged { bookId: ID stock: Int } " +
            "query book(id: ID): Book? command restock(id: ID, qty: Int): Book emits StockChanged stream stockUpdates(bookIds: [ID]): StockChanged",
    ).ir
    private val viewer = Json.parseToJsonElement("""{"id":"u1"}""")

    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private fun str(o: JsonObject, k: String): String = (o[k] as? JsonPrimitive)?.content ?: error("no $k in $o")

    private fun int(o: JsonObject, k: String): Int = (o[k] as? JsonPrimitive)?.content?.toIntOrNull() ?: error("no integer $k in $o")

    /** A server over the shared books, with its own relay over the shared hub and database. */
    private fun instance(books: ConcurrentHashMap<String, JsonObject>, relay: Relay, subscribed: CompletableDeferred<Unit> = CompletableDeferred()): RayfoldServer = RayfoldServer(
        ir,
        Resolvers(
            queries = mapOf("book" to { args, _ -> books[str(args, "id")] ?: JsonNull }),
            commands = mapOf(
                "restock" to { args, _ ->
                    val id = str(args, "id")
                    val book = books[id] ?: error("no book $id")
                    val next = JsonObject(book + ("stock" to JsonPrimitive(int(book, "stock") + int(args, "qty"))))
                    books[id] = next
                    CommandResult(next, emit = listOf("StockChanged" to buildJsonObject { put("bookId", id); put("stock", int(next, "stock")) }))
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
        ),
        relay = relay,
    )

    private class Open(scope: CoroutineScope, server: RayfoldServer, op: String, viewer: JsonElement) {
        private val cancel = Job()
        private val channel = Channel<JsonObject>(Channel.UNLIMITED)
        private val job = scope.launch {
            try {
                server.execute(Json.parseToJsonElement("""{"ops":[$op]}""").jsonObject, ExecuteOptions(viewer, cancel = cancel)).collect { channel.send(it) }
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

    @Test
    fun `a command on one server reaches a live query and a stream open on another, through the channel`() = runBlocking {
        val books = ConcurrentHashMap(mapOf("b1" to obj("""{"id":"b1","title":"Dune","stock":3}""")))
        val a = instance(books, relay("a"))
        val subscribed = CompletableDeferred<Unit>()
        val b = instance(books, relay("b"), subscribed)
        withTimeout(5_000) { a.ready(); b.ready() }
        val live = Open(this, b, """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}""", viewer)
        val stream = Open(this, b, """{"id":1,"op":"stockUpdates","args":{"bookIds":["b1"]}}""", viewer)
        assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1","stock":3},"meta":{"cost":1}}"""), live.next())
        withTimeout(5_000) { subscribed.await() }

        val ok = withTimeout(5_000) { a.collect(obj("""{"ops":[{"id":1,"op":"restock","args":{"id":"b1","qty":2},"key":"0123456789abcdef"}]}"""), viewer) }.single()
        assertEquals(JsonPrimitive(5), (ok["ok"] as? JsonObject)?.get("stock"))
        assertEquals(obj("""{"id":1,"patch":[{"set":"Book:b1","value":{"stock":5}}]}"""), live.next(), "b's live query hearing a's change")
        assertEquals(obj("""{"id":1,"item":{"bookId":"b1","stock":5}}"""), stream.next(), "b's stream hearing a's event")
        assertTrue(rows().isEmpty(), "both messages fit a payload: nothing went through the table")
        live.stop()
        stream.stop()
        withTimeout(5_000) { a.close(); b.close() }
    }

    /**
     * The listening connection is taken in turns, fairly.
     *
     * One connection serves three callers: the notification poll loop, a publish, and an unsubscribe. `synchronized`
     * is unfair, and the poll loop asks for the connection again on the next line of its own `while`, so it barged in
     * front of the other two for as long as it liked: a JVM server told to stop queued behind its own poll loop, and
     * the fleet job watched a member take 19.9 seconds to answer a SIGTERM against a bound of 20 (measured in a
     * container against a real Postgres: 0.7s at every delay once the lock was fair, 0.7 → 5.7 → 8.9 → 19.9s as the
     * server ran longer before it was, which is why it failed intermittently rather than always).
     *
     * This asserts the fairness itself. Starvation is a race, so a test that tried to provoke it would pass on the
     * broken code often enough to be worthless — the behaviour is held by the fleet end-to-end job, and this holds
     * the one line that job cannot explain.
     */
    @Test
    fun `the listening connection is taken in turns, fairly`() {
        val notifications = PgNotifications(keepAlive)
        val turn = PgNotifications::class.java.getDeclaredField("turn").apply { isAccessible = true }.get(notifications)
        assertTrue((turn as ReentrantLock).isFair, "an unfair lock lets the poll loop starve a publish and an unsubscribe")
    }

    /**
     * A listening connection that works until [dies] is set, then fails every poll the way pgjdbc does once the
     * connection is gone. The real [PgNotifications] poll loop runs over it.
     */
    private class Dying {
        @Volatile var dies = false
        private val loader = PgRelayTest::class.java.classLoader
        private val statement = java.lang.reflect.Proxy.newProxyInstance(loader, arrayOf(java.sql.Statement::class.java)) { _, m, _ ->
            if (m.name == "execute") false else null
        }
        private val pg = java.lang.reflect.Proxy.newProxyInstance(loader, arrayOf(org.postgresql.PGConnection::class.java)) { _, m, _ ->
            if (m.name != "getNotifications") null
            else if (dies) throw org.postgresql.util.PSQLException("This connection has been closed.", org.postgresql.util.PSQLState.CONNECTION_DOES_NOT_EXIST)
            else emptyArray<org.postgresql.PGNotification>()
        }
        val connection = java.lang.reflect.Proxy.newProxyInstance(loader, arrayOf(Connection::class.java)) { _, m, _ ->
            when (m.name) {
                "createStatement" -> statement
                "unwrap" -> pg
                else -> null
            }
        } as Connection
    }

    @Test
    fun `when the listening connection dies, the server stops being ready and names the relay`() = runBlocking {
        val dying = Dying()
        val lost = Channel<Throwable>(Channel.UNLIMITED)
        val server = RayfoldServer(ir, Resolvers(), relay = PgRelay(PgNotifications(dying.connection, pollMs = 1), { DriverManager.getConnection(url) }), onRelayError = { lost.trySend(it) })
        withTimeout(5_000) { server.ready() }
        assertEquals(emptyList(), server.readiness().reasons)

        dying.dies = true
        val e = withTimeout(5_000) { lost.receive() }
        assertEquals("This connection has been closed.", e.message)
        assertEquals(listOf("relay: This connection has been closed."), server.readiness().reasons)
        assertEquals(false, server.readiness().ready)
        withTimeout(5_000) { server.close() }
    }

    @Test
    fun `guard - a server that stops listening itself is not told it lost the relay`() = runBlocking {
        val dying = Dying()
        val lost = CopyOnWriteArrayList<Throwable>()
        val server = RayfoldServer(ir, Resolvers(), relay = PgRelay(PgNotifications(dying.connection, pollMs = 1), { DriverManager.getConnection(url) }), onRelayError = { lost.add(it) })
        withTimeout(5_000) { server.ready() }
        withTimeout(5_000) { server.close() } // stops the poll loop before the connection goes
        dying.dies = true
        assertEquals(emptyList(), lost.toList())
        assertEquals(emptyList(), server.readiness().reasons)
    }
}
