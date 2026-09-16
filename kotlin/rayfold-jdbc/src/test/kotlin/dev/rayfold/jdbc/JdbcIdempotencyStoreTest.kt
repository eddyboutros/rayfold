package dev.rayfold.jdbc

import dev.rayfold.core.BatchOptions
import dev.rayfold.core.Canonical
import dev.rayfold.core.Code
import dev.rayfold.core.CommandResult
import dev.rayfold.core.IdempotencyClaim
import dev.rayfold.core.IdempotencyRecord
import dev.rayfold.core.IdempotencyStore
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
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.security.MessageDigest
import java.sql.Connection
import java.sql.DriverManager
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
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
        const val TABLE = "rayfold_idempotency"
    }

    /** The clock every store here shares, as processes on one wall clock do. */
    private val clock = AtomicLong()
    private val runs = AtomicInteger()
    private lateinit var url: String
    private lateinit var keepAlive: Connection

    private fun store(ttlMs: Long = DAY, maxSize: Int = 100_000, table: String = TABLE, connection: () -> Connection = { DriverManager.getConnection(url) }) =
        JdbcIdempotencyStore(connection, JdbcIdempotencyOptions(table = table, ttlMs = ttlMs, maxSize = maxSize, now = clock::get))

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
    private fun server(store: IdempotencyStore, options: BatchOptions = BatchOptions(), resolver: suspend (JsonObject, RayfoldContext) -> Any?) =
        RayfoldServer(ir, Resolvers(commands = mapOf("restock" to resolver)), options, idempotency = store)

    /** A command that answers at once, with the stock counting how often any server has run it. */
    private val counted: suspend (JsonObject, RayfoldContext) -> Any? = { _, _ -> CommandResult(obj("""{"id":"b1","stock":${runs.incrementAndGet()}}""")) }

    private fun restock(key: String = this.key, qty: Int = 1, compact: Boolean = false) = buildJsonObject {
        put("id", 1); put("op", "restock"); put("args", buildJsonObject { put("bookId", "b1"); put("qty", qty) }); put("key", key)
        if (compact) put("compact", true)
    }

    private suspend fun answer(server: RayfoldServer, viewer: JsonElement, op: JsonObject = restock()): JsonObject =
        server.collect(buildJsonObject { put("ops", JsonArray(listOf(op))) }, viewer).single()

    private fun collect(server: RayfoldServer, viewer: JsonElement, op: JsonObject = restock()): JsonObject =
        runBlocking { withTimeout(5_000) { answer(server, viewer, op) } }

    /** What a run does with a key it owns: claim it, then store the answer retries replay. */
    private fun JdbcIdempotencyStore.record(key: String, rec: IdempotencyRecord): String {
        val owned = claim(SCOPE, key, 60_000L) as? IdempotencyClaim.Owned ?: error("expected to own $key")
        put(SCOPE, key, rec, owned.token)
        return owned.token
    }

    private fun JdbcIdempotencyStore.owns(key: String): IdempotencyClaim.Owned =
        claim(SCOPE, key, 1_000L) as? IdempotencyClaim.Owned ?: error("expected to own $key")

    /** The scope the runtime files a viewer's keys under, as [dev.rayfold.core.BatchRunner] derives it. */
    private fun scopeOf(viewer: JsonElement): String =
        MessageDigest.getInstance("SHA-256").digest(Canonical.json(viewer).toByteArray()).joinToString("") { "%02x".format(it) }

    private fun rows(table: String = "\"$TABLE\""): Int = keepAlive.createStatement().use { s ->
        s.executeQuery("SELECT COUNT(*) FROM $table").use { r -> if (r.next()) r.getInt(1) else 0 }
    }

    private fun heldUntil(key: String): Long? = keepAlive.prepareStatement("""SELECT "held_until" FROM "$TABLE" WHERE "scope" = ? AND "key" = ?""").use { s ->
        s.setObject(1, SCOPE)
        s.setObject(2, key)
        s.executeQuery().use { r -> if (r.next()) r.getLong(1) else null }
    }

    private fun JsonObject.replayed(): Boolean = ((this["meta"] as? JsonObject)?.get("replay") as? JsonPrimitive)?.content == "true"

    private fun JsonObject.stock(): Int? = ((this["ok"] as? JsonObject)?.get("stock") as? JsonPrimitive)?.content?.toIntOrNull()

    private fun JsonObject.code(): String? = ((this["error"] as? JsonObject)?.get("code") as? JsonPrimitive)?.content

    private fun JsonObject.message(): String? = ((this["error"] as? JsonObject)?.get("message") as? JsonPrimitive)?.content

    /** A command that says it is inside, then holds until the test lets it out; the stock is numbered on the way in. */
    private fun held(entered: CountDownLatch, gate: CountDownLatch): suspend (JsonObject, RayfoldContext) -> Any? = { _, _ ->
        val n = runs.incrementAndGet()
        entered.countDown()
        assertTrue(gate.await(5, TimeUnit.SECONDS), "the test never opened the gate")
        CommandResult(obj("""{"id":"b1","stock":$n}"""))
    }

    private fun <T : Any> intercept(type: Class<T>, target: T, after: (method: String, args: Array<out Any?>, result: Any?) -> Any?): T =
        type.cast(
            Proxy.newProxyInstance(JdbcIdempotencyStoreTest::class.java.classLoader, arrayOf(type)) { _, method, args ->
                val a: Array<out Any?> = args ?: emptyArray()
                val result = try {
                    method.invoke(target, *a)
                } catch (e: InvocationTargetException) {
                    throw e.targetException
                }
                after(method.name, a, result)
            },
        )

    // ------------------------------------------------------------------ one key, two servers

    @Test
    fun `a dozen retries of one key across two servers run the command once and all get the same answer`() {
        val ready = CountDownLatch(12)
        val entered = CountDownLatch(1)
        val gate = CountDownLatch(1)
        val a = server(store(), resolver = held(entered, gate))
        val b = server(store(), resolver = held(entered, gate))
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
        assertEquals(setOf(obj("""{"${'$'}type":"Book","id":"b1","stock":1}""")), answers.mapNotNull { it["ok"] }.toSet())
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
        val srv = server(store(), resolver = counted)
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

    @Test
    fun `a retry with other arguments on another server is refused from the stored hash and never runs`() {
        val a = server(store(), resolver = counted)
        val b = server(store(), resolver = counted)
        assertEquals(1, collect(a, u1, restock(qty = 1)).stock())
        assertEquals(
            obj("""{"id":1,"error":{"code":"already_exists","message":"Idempotency key $key was used for another operation or other arguments"},"fin":true}"""),
            collect(b, u1, restock(qty = 2)),
        )
        assertEquals(1, runs.get(), "the refused retry ran nothing")
        assertEquals(1, collect(b, u1, restock(qty = 1)).stock(), "guard: the same arguments on the other server replay")
        assertTrue(collect(b, u1, restock(qty = 1)).replayed())
        assertEquals(1, runs.get())
    }

    @Test
    fun `a table in another schema is created, quoted and replayed from under its qualified name`() {
        keepAlive.createStatement().use { it.execute("""CREATE SCHEMA "app"""") }
        val qualified = store(table = "app.rayfold_idempotency")
        assertTrue(qualified.schema().startsWith("""CREATE TABLE IF NOT EXISTS "app"."rayfold_idempotency" ("""), qualified.schema())
        keepAlive.createStatement().use { it.execute(qualified.schema()) }
        val a = server(qualified, resolver = counted)
        val b = server(store(table = "app.rayfold_idempotency"), resolver = counted)
        assertEquals(1, collect(a, u1).stock())
        val retry = collect(b, u1)
        assertTrue(retry.replayed())
        assertEquals(1, retry.stock())
        assertEquals(1, runs.get())
        assertEquals(1, rows(""""app"."rayfold_idempotency""""))
        assertEquals(0, rows(), "nothing landed in the default table")
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
        a.release(SCOPE, key, first.token)
        assertEquals(2_000L, (a.claim(SCOPE, key, 1_000L) as? IdempotencyClaim.InFlight)?.heldUntil, "nor does it free the key its new owner holds")
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
    fun `renewing with a wrong, stale or already-answered token changes nothing`() {
        val a = store()
        val held = a.owns(key)
        assertEquals(1_000L, heldUntil(key))
        assertFalse(a.renew(SCOPE, key, UUID.randomUUID().toString(), 5_000L), "a token nobody was given")
        assertEquals(1_000L, heldUntil(key))
        clock.set(500)
        assertTrue(a.renew(SCOPE, key, held.token, 1_000L), "guard: the owner's token renews")
        assertEquals(1_500L, heldUntil(key))

        clock.set(1_500)
        val next = store().owns(key)
        assertEquals(2_500L, heldUntil(key))
        assertFalse(a.renew(SCOPE, key, held.token, 9_000L), "the token of the run that lost the key is stale")
        assertEquals(2_500L, heldUntil(key))

        store().put(SCOPE, key, record, next.token)
        assertEquals(0L, heldUntil(key), "a stored answer holds no lease")
        assertFalse(store().renew(SCOPE, key, next.token, 9_000L), "and the token that stored it cannot start one")
        assertEquals(0L, heldUntil(key))
        assertEquals(record, a.get(SCOPE, key))
    }

    /** Server A's store, on a database it can no longer reach in time: every renewal fails, and says so. */
    private class Unrenewable(private val inner: IdempotencyStore, private val asked: CountDownLatch, val renewals: AtomicInteger) : IdempotencyStore by inner {
        override fun renew(scope: String, key: String, token: String, leaseMs: Long): Boolean {
            renewals.incrementAndGet()
            asked.countDown()
            return false
        }
    }

    @Test
    fun `when a server's renewals fail, another takes the key over and its answer is the one that stands`() {
        val entered = CountDownLatch(1)
        val gate = CountDownLatch(1)
        val asked = CountDownLatch(1)
        val renewals = AtomicInteger()
        // a 30 ms lease, so the runtime asks for a renewal 10 ms in; the refusal ends its renewals, the clock ends its lease
        val slow = server(Unrenewable(store(), asked, renewals), BatchOptions(idempotencyLeaseMs = 30), held(entered, gate))
        val quick = server(store(), resolver = counted)
        val (stranded, second) = runBlocking {
            withTimeout(20_000) {
                val call = async(Dispatchers.IO) { answer(slow, u1) }
                assertTrue(entered.await(5, TimeUnit.SECONDS), "the first server is inside the command, holding the key")
                assertTrue(asked.await(5, TimeUnit.SECONDS), "its runtime asked to renew and was refused")
                clock.set(30)
                val taken = answer(quick, u1)
                gate.countDown()
                call.await() to taken
            }
        }
        assertEquals(1, renewals.get(), "the first refusal ended the renewals")
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

    /** A connection on which every read of a key's row is followed by another process taking that row over. */
    private fun contended(steals: AtomicInteger): Connection = intercept(Connection::class.java, DriverManager.getConnection(url)) { name, args, result ->
        if (name != "prepareStatement" || !(args[0] as String).startsWith("SELECT \"args_hash\"")) return@intercept result
        intercept(PreparedStatement::class.java, result as PreparedStatement) { n, _, r ->
            if (n != "executeQuery") return@intercept r
            intercept(ResultSet::class.java, r as ResultSet) { rn, _, rr ->
                if (rn == "next" && rr == true) {
                    keepAlive.prepareStatement("""UPDATE "$TABLE" SET "token" = ?""").use { s -> s.setObject(1, "stolen-${steals.incrementAndGet()}"); s.executeUpdate() }
                }
                rr
            }
        }
    }

    @Test
    fun `a claim that loses every race gives up as unavailable, and the command never runs`() {
        val scope = scopeOf(u1)
        store().claim(scope, key, 0L) // a claim whose lease is already over: every attempt below tries to take it over
        val steals = AtomicInteger()
        val store = store(connection = { contended(steals) })
        val refused = assertFailsWith<RayfoldException> { store.claim(scope, key, 1_000L) }
        assertEquals(Code.UNAVAILABLE, refused.code)
        assertEquals("rayfold-jdbc: idempotency key $key changed hands 8 times", refused.message)
        assertEquals(8, steals.get(), "one attempt per change of hands, then it stopped")

        val srv = server(store, resolver = counted)
        val frame = collect(srv, u1)
        assertEquals("unavailable", frame.code())
        assertEquals("rayfold-jdbc: idempotency key $key changed hands 8 times", frame.message())
        assertEquals(0, runs.get())
        assertEquals(16, steals.get())

        val calm = server(store(), resolver = counted)
        assertEquals(1, collect(calm, u1).stock(), "guard: with nobody else on the row, the first attempt takes it over")
        assertEquals(1, runs.get())
    }

    // ------------------------------------------------------------------ what the store may keep (spec 12 section 3.6)

    @Test
    fun `a record is gone once its TTL has passed`() {
        assertEquals(DAY, JdbcIdempotencyOptions().ttlMs)
        val store = store(ttlMs = 100)
        store.record("k", record)
        clock.set(99)
        assertEquals(record, store.get(SCOPE, "k"), "guard: one millisecond inside the TTL it replays")
        clock.set(100)
        assertNull(store.get(SCOPE, "k"), "at exactly the TTL it is gone")
        assertEquals(0, rows(), "the expired row is dropped, not only hidden")
        store.record("later", record)
        clock.set(201)
        assertNull(store.get(SCOPE, "later"), "one millisecond past the TTL it is gone")
        assertEquals(0, rows())
    }

    @Test
    fun `a keyed command replays up to the TTL and runs again from it`() {
        val srv = server(store(ttlMs = 100), resolver = counted)
        assertEquals(1, collect(srv, u1).stock())
        clock.set(99)
        val inside = collect(srv, u1)
        assertTrue(inside.replayed())
        assertEquals(1, inside.stock())
        clock.set(100)
        val again = collect(srv, u1)
        assertFalse(again.replayed(), "the record expired, so the command ran again")
        assertEquals(2, again.stock())
        clock.set(101)
        assertTrue(collect(srv, u1).replayed(), "and the second run's record is what replays now")
        assertEquals(2, runs.get())
        assertEquals(1, rows())
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

    @Test
    fun `the bound never evicts a claim in flight, whose answer then lands and replays`() {
        val store = store(maxSize = 2)
        val inFlight = store.owns("x")
        for ((i, k) in listOf("y", "z", "w").withIndex()) {
            clock.set(i + 1L)
            store.record(k, record)
        }
        assertEquals(2, rows())
        assertNull(store.get(SCOPE, "y"))
        assertNull(store.get(SCOPE, "z"), "the two oldest records went, the claim did not")
        assertEquals(record, store.get(SCOPE, "w"))
        assertEquals(1_000L, heldUntil("x"), "still held")
        store.put(SCOPE, "x", record, inFlight.token)
        assertEquals(record, store.get(SCOPE, "x"))
        assertEquals(2, rows())
    }

    @Test
    fun `a command still running is never evicted to make room, and its answer replays afterwards`() {
        val entered = CountDownLatch(1)
        val gate = CountDownLatch(1)
        val srv = server(store(maxSize = 2), resolver = counted)
        val busy = server(store(maxSize = 2), resolver = held(entered, gate))
        val stranded = runBlocking {
            withTimeout(20_000) {
                val call = async(Dispatchers.IO) { answer(busy, u1, restock(key = "jdbc-key-0000000-busy")) }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                clock.set(1)
                assertEquals(2, answer(srv, u1, restock(key = "jdbc-key-0000000002")).stock())
                clock.set(2)
                assertEquals(3, answer(srv, u1, restock(key = "jdbc-key-0000000003")).stock())
                assertEquals(2, rows(), "the running command's claim and the newest record")
                gate.countDown()
                call.await()
            }
        }
        assertEquals(1, stranded.stock())
        assertTrue(collect(busy, u1, restock(key = "jdbc-key-0000000-busy")).replayed(), "the claim survived the bound, so its answer replays")
        assertTrue(collect(srv, u1, restock(key = "jdbc-key-0000000003")).replayed())
        assertFalse(collect(srv, u1, restock(key = "jdbc-key-0000000002")).replayed(), "guard: the record that was evicted runs again")
        assertEquals(4, runs.get())
    }
}
