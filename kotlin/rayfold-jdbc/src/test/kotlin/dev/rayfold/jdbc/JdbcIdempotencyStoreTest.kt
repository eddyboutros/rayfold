package dev.rayfold.jdbc

import dev.rayfold.core.Code
import dev.rayfold.core.CommandResult
import dev.rayfold.core.IdempotencyClaim
import dev.rayfold.core.IdempotencyRecord
import dev.rayfold.core.RayfoldContext
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Two [RayfoldServer] instances over one database, as two processes behind a load balancer: what the in-memory store
 * cannot do, because each process would decide on its own. The real servers run the real pipeline, so a retry that
 * lands on the other one goes through claiming, waiting and replaying exactly as a client's would.
 *
 * H2 stands in for Postgres; the SQL is the same either way. Leases are measured against an injected clock, so a
 * lease runs out because the test moved the clock, never because the machine was slow, and every latch is bounded.
 */
class JdbcIdempotencyStoreTest {
    private val ir = SchemaText.load("entity Book { id: ID stock: Int } command restock(bookId: ID, qty: Int): Book").ir
    private val u1 = obj("""{"id":"u1"}""")
    private val u2 = obj("""{"id":"u2"}""")
    private val key = "jdbc-key-0000000001"
    private val record = IdempotencyRecord("h", obj("""{"id":1,"ok":{"id":"b1"}}"""), obj("""{"id":1,"ok":{"id":"b1"}}"""))

    private companion object {
        /** JUnit builds a fresh instance per test, so the counter that names each database has to outlive it. */
        val databases = AtomicInteger()
        const val DAY = 24 * 60 * 60 * 1000L
        const val SCOPE = "viewer-scope"
    }

    /** The clock every store here shares, as processes on one wall clock do. */
    private val clock = AtomicLong()
    private val runs = AtomicInteger()
    private lateinit var url: String
    private lateinit var keepAlive: Connection

    private fun store(ttlMs: Long = DAY, maxSize: Int = 100_000) = JdbcIdempotencyStore(
        { DriverManager.getConnection(url) },
        JdbcIdempotencyOptions(ttlMs = ttlMs, maxSize = maxSize, now = clock::get),
    )

    @BeforeEach
    fun open() {
        url = "jdbc:h2:mem:rayfoldkeys${databases.incrementAndGet()}" // a database of its own, alive while this connection is
        keepAlive = DriverManager.getConnection(url)
        keepAlive.createStatement().use { it.execute(store().schema()) }
    }

    @AfterEach
    fun close() {
        keepAlive.close()
    }

    // ------------------------------------------------------------------ helpers

    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    /** One server, as one process runs it: its own store over the shared database. */
    private fun server(store: JdbcIdempotencyStore, resolver: suspend (JsonObject, RayfoldContext) -> Any?) =
        RayfoldServer(ir, Resolvers(commands = mapOf("restock" to resolver)), idempotency = store)

    /** A command that answers at once, with the stock counting how often any server has run it. */
    private val counted: suspend (JsonObject, RayfoldContext) -> Any? = { _, _ -> CommandResult(obj("""{"id":"b1","stock":${runs.incrementAndGet()}}""")) }

    private fun restock(compact: Boolean = false) = buildJsonObject {
        put("id", 1); put("op", "restock"); put("args", buildJsonObject { put("bookId", "b1"); put("qty", 1) }); put("key", key)
        if (compact) put("compact", true)
    }

    private suspend fun answer(server: RayfoldServer, viewer: JsonElement, op: JsonObject = restock()): JsonObject =
        server.collect(buildJsonObject { put("ops", JsonArray(listOf(op))) }, viewer).single()

    private fun collect(server: RayfoldServer, viewer: JsonElement, op: JsonObject = restock()): JsonObject =
        runBlocking { withTimeout(5_000) { answer(server, viewer, op) } }

    /** What a run does with a key it owns: claim it, then store the answer retries replay. */
    private fun JdbcIdempotencyStore.record(key: String, rec: IdempotencyRecord) {
        val owned = claim(SCOPE, key, 60_000L) as? IdempotencyClaim.Owned ?: error("expected to own $key")
        put(SCOPE, key, rec, owned.token)
    }

    private fun rows(): Int = keepAlive.createStatement().use { s ->
        s.executeQuery("""SELECT COUNT(*) FROM "rayfold_idempotency"""").use { r -> if (r.next()) r.getInt(1) else 0 }
    }

    private fun JsonObject.replayed(): Boolean = ((this["meta"] as? JsonObject)?.get("replay") as? JsonPrimitive)?.content == "true"

    private fun JsonObject.stock(): Int? = ((this["ok"] as? JsonObject)?.get("stock") as? JsonPrimitive)?.content?.toIntOrNull()

    private fun JsonObject.code(): String? = ((this["error"] as? JsonObject)?.get("code") as? JsonPrimitive)?.content

    // ------------------------------------------------------------------ one key, two servers

    @Test
    fun `a dozen retries of one key across two servers run the command once and all get the same answer`() {
        val ready = CountDownLatch(12)
        val entered = CountDownLatch(1)
        val gate = CountDownLatch(1)
        val held: suspend (JsonObject, RayfoldContext) -> Any? = { _, _ ->
            runs.incrementAndGet()
            entered.countDown()
            assertTrue(gate.await(5, TimeUnit.SECONDS), "the test never opened the gate")
            CommandResult(obj("""{"id":"b1","stock":7}"""))
        }
        val a = server(store(), held)
        val b = server(store(), held)
        val answers = runBlocking {
            withTimeout(20_000) {
                val calls = (0 until 12).map { i ->
                    async(Dispatchers.IO) {
                        ready.countDown()
                        answer(if (i % 2 == 0) a else b, u1)
                    }
                }
                assertTrue(ready.await(5, TimeUnit.SECONDS), "every caller is in flight before the command answers")
                assertTrue(entered.await(5, TimeUnit.SECONDS), "one of them claimed the key and ran the command")
                gate.countDown()
                calls.awaitAll()
            }
        }
        assertEquals(1, runs.get(), "whichever server claimed the key, it is the only one that ran the command")
        assertEquals(12, answers.size)
        assertEquals(1, answers.count { !it.replayed() }, "exactly one answer is the run itself, the rest are replays")
        assertEquals(setOf(obj("""{"${'$'}type":"Book","id":"b1","stock":7}""")), answers.mapNotNull { it["ok"] }.toSet())
        assertEquals(1, rows())
    }

    @Test
    fun `a first attempt that fails before committing frees the key, and the answer that follows replays in either form`() {
        val srv = server(store()) { _, _ ->
            if (runs.incrementAndGet() == 1) throw RayfoldException(Code.UNAVAILABLE, "try again")
            CommandResult(obj("""{"id":"b1","stock":${runs.get()}}"""))
        }
        assertEquals("unavailable", collect(srv, u1).code())
        assertEquals(0, rows(), "the run that failed before its effect let the key go")

        val ran = collect(srv, u1)
        assertFalse(ran.replayed())
        assertEquals(2, ran.stock())
        assertEquals(1, rows())

        val replay = collect(srv, u1)
        assertTrue(replay.replayed())
        assertEquals(ran["ok"], replay["ok"])
        val compact = collect(srv, u1, restock(compact = true))
        assertTrue(compact.replayed())
        assertEquals(obj("""{"id":"b1","stock":2}"""), compact["ok"], "both frame forms came back out of the database")
        assertEquals(2, runs.get(), "guard: a command that answered is never run again")
    }

    @Test
    fun `two viewers with one key do not share a record`() {
        val srv = server(store(), counted)
        val mine = collect(srv, u1)
        val theirs = collect(srv, u2)
        assertEquals(1, mine.stock())
        assertEquals(2, theirs.stock())
        assertFalse(theirs.replayed(), "another viewer's identical key is a different command")
        assertEquals(2, rows(), "one row per viewer")
        val again = collect(srv, u1)
        assertTrue(again.replayed())
        assertEquals(1, again.stock(), "guard: each viewer replays its own answer")
        assertEquals(2, runs.get())
    }

    // ------------------------------------------------------------------ leases

    @Test
    fun `a lease that runs out is handed to another server, and the answer of the run that lost it is ignored`() {
        val a = store()
        val b = store()
        val first = a.claim(SCOPE, key, 1_000L) as? IdempotencyClaim.Owned ?: error("the key was free")
        assertEquals(1_000L, (b.claim(SCOPE, key, 1_000L) as? IdempotencyClaim.InFlight)?.heldUntil)
        clock.set(999)
        assertTrue(b.claim(SCOPE, key, 1_000L) is IdempotencyClaim.InFlight, "guard: inside the lease the key stays held")
        clock.set(1_000)
        val second = b.claim(SCOPE, key, 1_000L) as? IdempotencyClaim.Owned ?: error("the lease ran out, so the key is free")
        assertNotEquals(first.token, second.token)
        assertFalse(a.renew(SCOPE, key, first.token, 1_000L), "the server that lost the key learns it here")

        a.put(SCOPE, key, record, first.token)
        assertNull(b.get(SCOPE, key), "a run that no longer owns the key stores nothing")
        b.put(SCOPE, key, record, second.token)
        assertEquals(record, a.get(SCOPE, key))
        assertEquals(1, rows())
    }

    @Test
    fun `guard - a renewed lease is not handed over until the renewal itself runs out`() {
        val a = store()
        val b = store()
        val held = a.claim(SCOPE, key, 1_000L) as? IdempotencyClaim.Owned ?: error("the key was free")
        clock.set(900)
        assertTrue(a.renew(SCOPE, key, held.token, 1_000L))
        clock.set(1_000)
        assertEquals(1_900L, (b.claim(SCOPE, key, 1_000L) as? IdempotencyClaim.InFlight)?.heldUntil, "renewed at 900, held to 1900")
        clock.set(1_900)
        assertTrue(b.claim(SCOPE, key, 1_000L) is IdempotencyClaim.Owned)
    }

    @Test
    fun `when a server stops renewing, another takes the key over and its answer is the one that stands`() {
        val entered = CountDownLatch(1)
        val gate = CountDownLatch(1)
        val slow = server(store()) { _, _ ->
            val n = runs.incrementAndGet() // numbered on the way in: this server got the key first
            entered.countDown()
            assertTrue(gate.await(5, TimeUnit.SECONDS), "the test never opened the gate")
            CommandResult(obj("""{"id":"b1","stock":$n}"""))
        }
        val quick = server(store(), counted)
        val taken = runBlocking {
            withTimeout(20_000) {
                val call = async(Dispatchers.IO) { answer(slow, u1) }
                assertTrue(entered.await(5, TimeUnit.SECONDS), "the first server is inside the command, holding the key")
                // its lease ran to 30 s and its next renewal is 10 s of real time away, so moving the clock strands it
                clock.set(30_000)
                val second = answer(quick, u1)
                gate.countDown()
                call.await() to second
            }
        }
        val (stranded, second) = taken
        assertEquals(2, runs.get(), "a lease that ran out is the one way one key runs twice")
        assertEquals(listOf(false, false), listOf(stranded.replayed(), second.replayed()))
        assertEquals(1, stranded.stock(), "the first server still answered its own caller")
        assertEquals(2, second.stock())
        val afterwards = collect(quick, u1)
        assertTrue(afterwards.replayed())
        assertEquals(2, afterwards.stock(), "the run that lost the key stored nothing; the new owner's answer replays")
        assertEquals(2, runs.get())
        assertEquals(1, rows())
    }

    // ------------------------------------------------------------------ what the store may keep (spec 12 section 3.6)

    @Test
    fun `a record is gone once its TTL has passed`() {
        assertEquals(DAY, JdbcIdempotencyOptions().ttlMs)
        val store = store(ttlMs = 100)
        store.record("k", record)
        clock.set(99)
        assertEquals(record, store.get(SCOPE, "k"), "guard: inside the TTL it replays")
        clock.set(100)
        assertNull(store.get(SCOPE, "k"))
        assertEquals(0, rows(), "the expired row is dropped, not only hidden")
    }

    @Test
    fun `the store stays inside its bound, oldest record first`() {
        assertEquals(100_000, JdbcIdempotencyOptions().maxSize)
        val store = store(maxSize = 3)
        for ((i, k) in listOf("a", "b", "c", "d").withIndex()) {
            clock.set(i.toLong())
            store.record(k, record)
        }
        assertEquals(3, rows())
        assertNull(store.get(SCOPE, "a"), "the oldest record made room")
        for (k in listOf("b", "c", "d")) assertEquals(record, store.get(SCOPE, k))
    }
}
