package dev.rayfold.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * The run-once guarantee where the store is shared with other server processes: leases, claiming again rather than
 * being woken, and what a retry is told when a command's effect happened but its op ended before the answer did.
 *
 * Everything runs on the coroutine test scheduler, so every wait is virtual time rather than the machine's clock,
 * and the stores that need one take an injected clock. Each test builds its own server and store.
 */
class IdempotencyTest {
    private val ir = SchemaText.load(
        "entity Book { id: ID title: String author: Author } entity Author { id: ID name: String } " +
            "command restock(bookId: ID, qty: Int): Book",
    ).ir
    private val book = obj("""{"id":"b1","title":"T1","authorId":"a1"}""")
    private val u1 = obj("""{"id":"u1"}""")
    private val key = "lease-key-000000001"

    private fun restockOp(shape: String? = null, deadline: Int? = null, compact: Boolean = false) = buildJsonObject {
        put("id", 1); put("op", "restock"); put("args", buildJsonObject { put("bookId", "b1"); put("qty", 1) }); put("key", key)
        if (shape != null) put("shape", shape)
        if (deadline != null) put("deadline", deadline)
        if (compact) put("compact", true)
    }

    private fun envelope(op: JsonObject) = buildJsonObject { put("ops", JsonArray(listOf(op))) }

    private fun JsonObject.replayed(): Boolean = ((this["meta"] as? JsonObject)?.get("replay") as? JsonPrimitive)?.content == "true"

    private fun JsonObject.stock(): Int? = ((this["ok"] as? JsonObject)?.get("stock") as? JsonPrimitive)?.content?.toIntOrNull()

    /** The scope the runtime files a viewer's keys under, as [BatchRunner] derives it. */
    private fun scopeOf(viewer: JsonElement): String =
        MessageDigest.getInstance("SHA-256").digest(Canonical.json(viewer).toByteArray()).joinToString("") { "%02x".format(it) }

    /** A command answering with the number of its run, so two servers' answers can be told apart. */
    private fun numbered(runs: AtomicInteger, delayMs: Long = 0) = command { _, _ ->
        val n = runs.incrementAndGet()
        if (delayMs > 0) delay(delayMs)
        CommandResult(obj("""{"id":"b1","title":"T1","stock":$n}"""))
    }

    private val stockIr = SchemaText.load("entity Book { id: ID stock: Int } command restock(bookId: ID, qty: Int): Book").ir

    /** A store that cannot wake a waiter, as no store behind a database can: only claiming again answers. */
    private class Unwakeable(private val inner: IdempotencyStore) : IdempotencyStore by inner {
        val waits = AtomicInteger()

        override suspend fun awaitSettled(scope: String, key: String, timeoutMs: Long) {
            waits.incrementAndGet()
            delay(timeoutMs)
        }
    }

    private class Renewal(val token: String, val leaseMs: Long, val kept: Boolean)

    /** Every lease the runtime asked for and every renewal, with what the store answered. */
    private class Recording(private val inner: IdempotencyStore) : IdempotencyStore by inner {
        val leases = CopyOnWriteArrayList<Long>()
        val renewals = CopyOnWriteArrayList<Renewal>()

        override fun claim(scope: String, key: String, leaseMs: Long): IdempotencyClaim {
            leases.add(leaseMs)
            return inner.claim(scope, key, leaseMs)
        }

        override fun renew(scope: String, key: String, token: String, leaseMs: Long): Boolean =
            inner.renew(scope, key, token, leaseMs).also { renewals.add(Renewal(token, leaseMs, it)) }
    }

    @Test
    fun `a waiter that is never woken claims again until the first run has answered`() = runTest(timeout = 5.seconds) {
        val gate = CompletableDeferred<Unit>()
        var runs = 0
        val store = Unwakeable(MemoryIdempotencyStore())
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ -> runs++; gate.await(); CommandResult(book) })), idempotency = store)
        val env = envelope(restockOp(shape = "{ id }"))
        val first = async { server.collect(env, u1) }
        val second = async { server.collect(env, u1) }
        runCurrent() // the first batch is inside the resolver, the second has claimed and found the key held
        assertEquals(1, runs)
        gate.complete(Unit)
        val both = (first.await() + second.await()).map { it }
        assertEquals(1, runs, "the command ran once, with nothing but the next claim to tell the waiter")
        assertEquals(listOf(false, true), both.map { it.replayed() })
        assertEquals(both[0]["ok"], both[1]["ok"])
        assertEquals(1, store.waits.get(), "one 50 ms wait, then the claim that found the answer")
        assertEquals(50L, currentTime)
    }

    @Test
    fun `a retry whose deadline passes while the key is held ends with its own frame and leaves the key to the holder`() = runTest(timeout = 5.seconds) {
        val gate = CompletableDeferred<Unit>()
        val runs = AtomicInteger()
        val store = MemoryIdempotencyStore()
        val server = RayfoldServer(stockIr, Resolvers(commands = mapOf("restock" to command { _, _ -> gate.await(); CommandResult(obj("""{"id":"b1","stock":${runs.incrementAndGet()}}""")) })), idempotency = store)
        val holder = async { server.collect(envelope(restockOp()), u1) }
        runCurrent()
        // waits of 50 and 100 ms: the deadline at 120 cuts the second one short
        val gaveUp = server.collect(envelope(restockOp(deadline = 120)), u1).single()
        assertEquals(obj("""{"id":1,"error":{"code":"deadline_exceeded","message":"Op deadline exceeded"},"fin":true}"""), gaveUp)
        assertEquals(120L, currentTime)
        assertEquals(0, runs.get(), "the holder is still inside the command; the retry never ran it")
        assertTrue(store.claim(scopeOf(u1), key, 1L) is IdempotencyClaim.InFlight, "the key is still the holder's")

        gate.complete(Unit)
        val first = holder.await().single()
        assertFalse(first.replayed())
        assertEquals(1, first.stock())
        val later = server.collect(envelope(restockOp()), u1).single()
        assertTrue(later.replayed())
        assertEquals(1, later.stock())
        assertEquals(1, runs.get())
    }

    @Test
    fun `a retry whose caller goes away while the key is held is canceled, and the holder's answer still replays`() = runTest(timeout = 5.seconds) {
        val gate = CompletableDeferred<Unit>()
        val runs = AtomicInteger()
        val server = RayfoldServer(stockIr, Resolvers(commands = mapOf("restock" to command { _, _ -> gate.await(); CommandResult(obj("""{"id":"b1","stock":${runs.incrementAndGet()}}""")) })))
        val holder = async { server.collect(envelope(restockOp()), u1) }
        runCurrent()
        val gone = Job()
        val waiter = async { server.collect(envelope(restockOp()), ExecuteOptions(viewer = u1, cancel = gone)) }
        advanceTimeBy(70) // into its second wait
        gone.complete()
        assertEquals(obj("""{"id":1,"error":{"code":"canceled","message":"Canceled"},"fin":true}"""), waiter.await().single())
        assertEquals(70L, currentTime)
        assertEquals(0, runs.get())

        gate.complete(Unit)
        assertEquals(1, holder.await().single().stock())
        val later = server.collect(envelope(restockOp()), u1).single()
        assertTrue(later.replayed())
        assertEquals(1, later.stock())
        assertEquals(1, runs.get())
    }

    @Test
    fun `the runtime renews the lease every third of it while the command runs`() = runTest(timeout = 5.seconds) {
        val store = Recording(MemoryIdempotencyStore())
        // 95 s of command against the 30 s lease: renewals at 10, 20 ... 90 s, and none due when the command returns
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ -> delay(95_000); CommandResult(book) })), idempotency = store)
        val frames = server.collect(envelope(restockOp(shape = "{ id }")), u1)
        assertNull(frames.single().errorCode())
        assertEquals(9, store.renewals.size)
        assertEquals(1, store.renewals.map { it.token }.toSet().size, "every renewal carried the token of the one claim")
        assertEquals(listOf(true), store.renewals.map { it.kept }.distinct())
        assertEquals(95_000L, currentTime)
    }

    @Test
    fun `guard - a command that ends at once renews nothing, and a command without a key holds no lease`() = runTest(timeout = 5.seconds) {
        val store = Recording(MemoryIdempotencyStore())
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ -> CommandResult(book) })), idempotency = store)
        assertNull(server.collect(envelope(restockOp(shape = "{ id }")), u1).single().errorCode())
        assertEquals(emptyList(), store.renewals.toList())

        val optedOut = RayfoldServer(
            ir.withOpAnnotations("restock", Annotation("idempotent", mapOf("value" to JsonPrimitive(false)))),
            Resolvers(commands = mapOf("restock" to command { _, _ -> delay(95_000); CommandResult(book) })),
            idempotency = store,
        )
        val keyless = buildJsonObject {
            put("id", 1); put("op", "restock"); put("args", buildJsonObject { put("bookId", "b1"); put("qty", 1) }); put("shape", "{ id }")
        }
        assertNull(optedOut.collect(envelope(keyless), u1).single().errorCode())
        assertEquals(emptyList(), store.renewals.toList(), "there was no claim to renew")
        assertEquals(listOf(30_000L), store.leases.toList(), "and no claim either: the one lease is the keyed command's")
    }

    @Test
    fun `the configured lease reaches the store on every claim and renewal, and the default is 30 seconds`() = runTest(timeout = 5.seconds) {
        assertEquals(30_000L, BatchOptions().idempotencyLeaseMs)
        val store = Recording(MemoryIdempotencyStore())
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ -> delay(3_000); CommandResult(book) })), BatchOptions(idempotencyLeaseMs = 7_000), idempotency = store)
        assertNull(server.collect(envelope(restockOp(shape = "{ id }")), u1).single().errorCode())
        assertEquals(listOf(7_000L), store.leases.toList())
        assertEquals(listOf(7_000L), store.renewals.map { it.leaseMs }, "one renewal, a third of the lease in")
        assertEquals(3_000L, currentTime)

        val retry = server.collect(envelope(restockOp(shape = "{ id }")), u1).single()
        assertTrue(retry.replayed())
        assertEquals(listOf(7_000L, 7_000L), store.leases.toList(), "a replay claims with the same lease, and finds the answer")
    }

    @Test
    fun `renewals stop at the first refusal, and the answer of the run that lost the key is not stored`() = runTest(timeout = 5.seconds) {
        var clock = 0L
        val runs = AtomicInteger()
        val store = Recording(MemoryIdempotencyStore(now = { clock }))
        val slow = RayfoldServer(stockIr, Resolvers(commands = mapOf("restock" to numbered(runs, delayMs = 35_000))), idempotency = store)
        val quick = RayfoldServer(stockIr, Resolvers(commands = mapOf("restock" to numbered(runs))), idempotency = store)

        val call = async { slow.collect(envelope(restockOp()), u1) }
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(listOf(true), store.renewals.map { it.kept }, "the first renewal, 10 s in, was kept")
        clock = 30_000 // as the store sees it, the lease renewed at 0 has just run out
        val taken = quick.collect(envelope(restockOp()), u1).single()
        assertFalse(taken.replayed())
        assertEquals(2, taken.stock(), "the other server took the key over and ran the command")
        advanceTimeBy(15_000)
        runCurrent()
        assertEquals(listOf(true, false), store.renewals.map { it.kept }, "the renewal at 20 s was refused; none at 30 s")

        val stranded = call.await().single()
        assertEquals(35_000L, currentTime)
        assertFalse(stranded.replayed())
        assertEquals(1, stranded.stock(), "the first server still answered its own caller")
        assertEquals(listOf(true, false), store.renewals.map { it.kept })
        assertEquals(2, obj(store.get(scopeOf(u1), key)?.frame.toString()).stock(), "the stored answer is the second server's")
        val later = quick.collect(envelope(restockOp()), u1).single()
        assertTrue(later.replayed())
        assertEquals(2, later.stock())
        assertEquals(2, runs.get())
    }

    @Test
    fun `a lease that runs out is handed over, and the answer of the run that lost it is ignored`() {
        var clock = 0L
        val store = MemoryIdempotencyStore(now = { clock })
        val first = store.claim("s", "k", 1_000L) as? IdempotencyClaim.Owned ?: error("the key was free")
        assertEquals(1_000L, (store.claim("s", "k", 1_000L) as? IdempotencyClaim.InFlight)?.heldUntil)
        clock = 999
        assertTrue(store.claim("s", "k", 1_000L) is IdempotencyClaim.InFlight, "guard: inside the lease the key stays held")
        clock = 1_000
        val second = store.claim("s", "k", 1_000L) as? IdempotencyClaim.Owned ?: error("the lease ran out, so the key is free")
        assertNotEquals(first.token, second.token)
        assertFalse(store.renew("s", "k", first.token, 1_000L), "the run that lost the key learns it here")

        val lost = IdempotencyRecord("h", obj("""{"id":1,"ok":"lost"}"""), obj("""{"id":1,"ok":"lost"}"""))
        val kept = IdempotencyRecord("h", obj("""{"id":1,"ok":"kept"}"""), obj("""{"id":1,"ok":"kept"}"""))
        store.put("s", "k", lost, first.token)
        assertNull(store.get("s", "k"), "a run that no longer owns the key stores nothing while the new owner runs")
        store.release("s", "k", first.token)
        assertEquals(2_000L, (store.claim("s", "k", 1_000L) as? IdempotencyClaim.InFlight)?.heldUntil, "nor does it free the key")
        store.put("s", "k", kept, second.token)
        assertEquals(kept, store.get("s", "k"))
        store.put("s", "k", lost, first.token)
        assertEquals(kept, store.get("s", "k"), "and nothing once the new owner has answered")
        store.release("s", "k", first.token)
        assertEquals(kept, store.get("s", "k"))
        assertEquals(1, store.size)
    }

    @Test
    fun `guard - a renewed lease is not handed over until the renewal itself runs out`() {
        var clock = 0L
        val store = MemoryIdempotencyStore(now = { clock })
        val held = store.claim("s", "k", 1_000L) as? IdempotencyClaim.Owned ?: error("the key was free")
        clock = 900
        assertTrue(store.renew("s", "k", held.token, 1_000L))
        clock = 1_000
        assertEquals(1_900L, (store.claim("s", "k", 1_000L) as? IdempotencyClaim.InFlight)?.heldUntil, "renewed at 900, held to 1900")
        clock = 1_900
        assertTrue(store.claim("s", "k", 1_000L) is IdempotencyClaim.Owned)
    }

    @Test
    fun `a claim nobody renewed or retried is swept like an expired record, so the bound holds`() {
        var clock = 0L
        val rec = IdempotencyRecord("h", JsonObject(emptyMap()), JsonObject(emptyMap()))
        val store = MemoryIdempotencyStore(maxSize = 2, now = { clock })
        fun MemoryIdempotencyStore.record(key: String) = put("s", key, rec, (claim("s", key, 1_000L) as? IdempotencyClaim.Owned)?.token ?: error("expected to own $key"))
        store.claim("s", "gone", 10L) // its holder died, and no retry ever comes for it
        clock = 10
        for (k in listOf("a", "b", "c", "d")) store.record(k)
        assertEquals(2, store.size, "the dead claim at the head did not shield what came after it")
        assertNull(store.get("s", "a"))
        assertNull(store.get("s", "b"))
        for (k in listOf("c", "d")) assertEquals(rec, store.get("s", k))
        assertTrue(store.claim("s", "gone", 10L) is IdempotencyClaim.Owned, "the dead claim is gone too")

        val busy = MemoryIdempotencyStore(maxSize = 2, now = { clock })
        val held = busy.claim("s", "busy", 1_000L) as? IdempotencyClaim.Owned ?: error("the key was free")
        for (k in listOf("a", "b", "c")) busy.record(k)
        assertEquals(2, busy.size, "guard: a claim in flight counts against the bound and is never swept")
        assertEquals(1_010L, (busy.claim("s", "busy", 1_000L) as? IdempotencyClaim.InFlight)?.heldUntil)
        assertNull(busy.get("s", "b"))
        assertEquals(rec, busy.get("s", "c"))
        busy.put("s", "busy", rec, held.token)
        assertEquals(rec, busy.get("s", "busy"), "its answer lands afterwards")
        assertEquals(2, busy.size)
    }

    /** A command whose effect lands, followed by a projection that hangs until the op's deadline ends it. */
    private fun hangingServer(runs: AtomicInteger, name: String?) = RayfoldServer(
        ir,
        Resolvers(
            commands = mapOf("restock" to command { _, _ -> runs.incrementAndGet(); CommandResult(book) }),
            fields = mapOf(
                "Book" to mapOf(
                    "author" to loader { _, _, _ -> if (name == null) awaitCancellation() else listOf(obj("""{"id":"a1","name":"$name"}""")) },
                ),
            ),
        ),
    )

    @Test
    fun `a command canceled after it committed is recorded, and the retry replays instead of running it again`() = runTest(timeout = 5.seconds) {
        val runs = AtomicInteger()
        val server = hangingServer(runs, name = null)
        val shape = "{ id author { name } }"
        val canceled = server.collect(envelope(restockOp(shape = shape, deadline = 50)), u1).single()
        assertEquals("deadline_exceeded", canceled.errorCode())
        assertEquals(1, runs.get())

        val retry = server.collect(envelope(restockOp(shape = shape)), u1).single()
        assertEquals(
            obj("""{"id":1,"error":{"code":"canceled","message":"restock() committed, then the op ended before its result was delivered"},"fin":true,"meta":{"replay":true}}"""),
            retry,
        )
        assertEquals(1, runs.get(), "before: the key was released and the retry ran the command a second time")
    }

    @Test
    fun `guard - a command canceled before it committed frees the key, and one that answers replays its answer`() = runTest(timeout = 5.seconds) {
        val stuck = AtomicInteger()
        val never = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ -> stuck.incrementAndGet(); awaitCancellation() })))
        repeat(2) { assertEquals("deadline_exceeded", never.collect(envelope(restockOp(shape = "{ id }", deadline = 50)), u1).single().errorCode()) }
        assertEquals(2, stuck.get(), "nothing had committed, so the key was free and the retry ran the command")

        val runs = AtomicInteger()
        val server = hangingServer(runs, name = "Ann")
        val shape = "{ id author { name } }"
        val first = server.collect(envelope(restockOp(shape = shape, deadline = 50)), u1).single()
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1","author":{"${'$'}type":"Author","name":"Ann"}}"""), first["ok"])
        val retry = server.collect(envelope(restockOp(shape = shape)), u1).single()
        assertTrue(retry.replayed())
        assertEquals(first["ok"], retry["ok"], "the answer is replayed, not a cancellation")
        assertEquals(1, runs.get())
    }

    @Test
    fun `a failure after the command committed replays as recorded, in compact form to a compact retry`() = runTest(timeout = 5.seconds) {
        val runs = AtomicInteger()
        // the resolver's row lacks the non-null title, so projecting it fails after the effect stands
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ -> runs.incrementAndGet(); CommandResult(obj("""{"id":"b1"}""")) })))
        val failed = obj("""{"id":1,"error":{"code":"internal","message":"Non-null field Book.title resolved to null","path":"title"},"fin":true}""")
        assertEquals(failed, server.collect(envelope(restockOp(shape = "{ id title }")), u1).single())
        assertEquals(1, runs.get())
        val compact = server.collect(envelope(restockOp(shape = "{ id title }", compact = true)), u1).single()
        assertEquals(JsonObject(failed + ("meta" to obj("""{"replay":true}"""))), compact)
        val full = server.collect(envelope(restockOp(shape = "{ id title }")), u1).single()
        assertEquals(compact, full, "an error has one form; both retries get it with the replay marker")
        assertEquals(1, runs.get(), "the command never ran again")
    }

    @Test
    fun `a replayed failure is a failure, so a later op does not run on an answer that never came`() = runTest(timeout = 5.seconds) {
        // Treating the replay as a success would let a $ref op run with nothing to read, and would count a command
        // that never succeeds as one that always does. Same names as packages/server/src/counters.ts: a fleet console
        // reads these from either runtime.
        val counters = MemoryCounters()
        val runs = AtomicInteger()
        val withQuery = SchemaText.load("entity Book { id: ID title: String } query book(id: ID): Book command restock(bookId: ID, qty: Int): Book").ir
        // the row lacks the non-null title, so projecting it fails after the effect stands
        val server = RayfoldServer(
            withQuery,
            Resolvers(
                queries = mapOf("book" to query { args, _ -> obj("""{"id":${args["id"]},"title":"T1"}""") }),
                commands = mapOf("restock" to command { _, _ -> runs.incrementAndGet(); CommandResult(obj("""{"id":"b1"}""")) }),
            ),
            counters = counters,
        )
        assertEquals("internal", server.collect(envelope(restockOp(shape = "{ id title }")), u1).single().errorCode())

        val retry = server.collect(
            obj("""{"ops":[${Canonical.json(restockOp(shape = "{ id title }"))},{"id":2,"op":"book","args":{"id":{"${'$'}ref":"1.id"}},"shape":"{ id }"}]}"""),
            u1,
        )
        assertEquals(1, runs.get(), "replayed, not run again")
        assertTrue(retry[0].replayed())
        assertEquals("internal", retry[0].errorCode())
        assertEquals("DependencyFailed", ((retry[1]["error"] as? JsonObject)?.get("type") as? JsonPrimitive)?.content)

        assertEquals(2, countOf(counters, "rayfold.ops", mapOf("kind" to "command", "outcome" to "internal")), "the run and the replay")
        assertEquals(0, countOf(counters, "rayfold.ops", mapOf("kind" to "command", "outcome" to "ok")))
        assertEquals(2, countOf(counters, "rayfold.errors", mapOf("op" to "restock", "code" to "internal")))
    }

    @Test
    fun `guard - a replayed success still feeds the op that depends on it, and counts as a success`() = runTest(timeout = 5.seconds) {
        val counters = MemoryCounters()
        val runs = AtomicInteger()
        val withQuery = SchemaText.load("entity Book { id: ID stock: Int } query book(id: ID): Book command restock(bookId: ID, qty: Int): Book").ir
        val server = RayfoldServer(
            withQuery,
            Resolvers(
                queries = mapOf("book" to query { args, _ -> obj("""{"id":${args["id"]},"stock":7}""") }),
                commands = mapOf("restock" to numbered(runs)),
            ),
            counters = counters,
        )
        server.collect(envelope(restockOp(shape = "{ id stock }")), u1)

        val retry = server.collect(
            obj("""{"ops":[${Canonical.json(restockOp(shape = "{ id stock }"))},{"id":2,"op":"book","args":{"id":{"${'$'}ref":"1.id"}},"shape":"{ id stock }"}]}"""),
            u1,
        )
        assertTrue(retry[0].replayed())
        assertEquals(1, runs.get())
        assertEquals("b1", ((retry[1]["data"] as? JsonObject)?.get("id") as? JsonPrimitive)?.content, "the dependent op read the replayed answer")
        assertEquals(2, countOf(counters, "rayfold.ops", mapOf("kind" to "command", "outcome" to "ok")))
        assertTrue(counters.snapshot().none { it.name == "rayfold.errors" })
    }

    /** A store that claims but cannot record: what a server sees when its database goes away after a command committed. */
    private class Unwritable(private val inner: IdempotencyStore = MemoryIdempotencyStore()) : IdempotencyStore by inner {
        override fun put(scope: String, key: String, record: IdempotencyRecord, token: String) = throw IllegalStateException("the database went away")
    }

    /** The command, then a query reading its result through a `$ref`. */
    private fun recording(store: IdempotencyStore, runs: AtomicInteger, counters: MemoryCounters? = null): Pair<RayfoldServer, JsonObject> {
        val ir = SchemaText.load("entity Book { id: ID stock: Int } command restock(bookId: ID, qty: Int): Book query stockOf(n: Int): Book").ir
        val server = RayfoldServer(
            ir,
            Resolvers(
                commands = mapOf("restock" to numbered(runs)),
                queries = mapOf("stockOf" to { a, _ -> obj("""{"id":"s","stock":${a["n"]}}""") }),
            ),
            idempotency = store,
            counters = counters,
        )
        val env = buildJsonObject {
            put("ops", JsonArray(listOf(restockOp("{ id stock }"), obj("""{"id":2,"op":"stockOf","args":{"n":{"${'$'}ref":"1.stock"}},"shape":"{ stock }"}"""))))
        }
        return server to env
    }

    @Test
    fun `a store that fails to record a committed command - one terminal frame, a success for the op, and the key kept held`() = runTest(timeout = 5.seconds) {
        val store = Unwritable()
        val runs = AtomicInteger()
        val counters = MemoryCounters()
        val (server, env) = recording(store, runs, counters)
        val frames = server.collect(env, u1)
        val book = """{"${'$'}type":"Book","id":"b1","stock":1}"""
        assertEquals(listOf(obj("""{"id":1,"ok":$book,"patch":[{"set":"Book:b1","value":$book}],"meta":{"cost":1},"fin":true}""")), frames.filter { it.opId() == 1 })
        // the op after it reads its result, rather than failing on a dependency its client saw succeed
        assertEquals(listOf(obj("""{"id":2,"data":{"${'$'}type":"Book","stock":1},"meta":{"cost":1},"fin":true}""")), frames.filter { it.opId() == 2 })
        assertEquals(1, runs.get())
        // released, the key would be free for a retry to run the command again; held, a retry waits out the lease
        assertTrue(store.claim(scopeOf(u1), key, 1_000) is IdempotencyClaim.InFlight)
        assertEquals(1L, countOf(counters, "rayfold.idempotency", mapOf("record" to "failed")))
    }

    @Test
    fun `guard - with a store that records, the key holds the answer and a retry replays it`() = runTest(timeout = 5.seconds) {
        val store = MemoryIdempotencyStore()
        val runs = AtomicInteger()
        val (server, env) = recording(store, runs)
        server.collect(env, u1)
        assertTrue(store.claim(scopeOf(u1), key, 1_000) is IdempotencyClaim.Done)
        assertTrue(server.collect(env, u1).first { it.opId() == 1 }.replayed())
        assertEquals(1, runs.get())
    }

    private fun countOf(c: MemoryCounters, name: String, labels: Map<String, String>): Long =
        c.snapshot().find { it.name == name && labels.all { (k, v) -> it.labels[k] == v } }?.count ?: 0L
}
