package dev.rayfold.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
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

    private fun restockOp(shape: String? = null, deadline: Int? = null) = buildJsonObject {
        put("id", 1); put("op", "restock"); put("args", buildJsonObject { put("bookId", "b1"); put("qty", 1) }); put("key", key)
        if (shape != null) put("shape", shape)
        if (deadline != null) put("deadline", deadline)
    }

    private fun envelope(op: JsonObject) = buildJsonObject { put("ops", JsonArray(listOf(op))) }

    private fun JsonObject.replayed(): Boolean = ((this["meta"] as? JsonObject)?.get("replay") as? JsonPrimitive)?.content == "true"

    /** A store that cannot wake a waiter, as no store behind a database can: only claiming again answers. */
    private class Unwakeable(private val inner: IdempotencyStore) : IdempotencyStore by inner {
        val waits = AtomicInteger()

        override suspend fun awaitSettled(scope: String, key: String, timeoutMs: Long) {
            waits.incrementAndGet()
            delay(timeoutMs)
        }
    }

    /** Every lease renewal the runtime asked for, by the token it renewed. */
    private class Recording(private val inner: IdempotencyStore) : IdempotencyStore by inner {
        val renewals = CopyOnWriteArrayList<String>()

        override fun renew(scope: String, key: String, token: String, leaseMs: Long): Boolean {
            renewals.add(token)
            return inner.renew(scope, key, token, leaseMs)
        }
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
    fun `the runtime renews the lease every third of it while the command runs`() = runTest(timeout = 5.seconds) {
        val store = Recording(MemoryIdempotencyStore())
        // 95 s of command against the 30 s lease: renewals at 10, 20 ... 90 s, and none due when the command returns
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to command { _, _ -> delay(95_000); CommandResult(book) })), idempotency = store)
        val frames = server.collect(envelope(restockOp(shape = "{ id }")), u1)
        assertNull(frames.single().errorCode())
        assertEquals(9, store.renewals.size)
        assertEquals(1, store.renewals.toSet().size, "every renewal carried the token of the one claim")
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
        assertNull(store.get("s", "k"), "a run that no longer owns the key stores nothing")
        store.put("s", "k", kept, second.token)
        assertEquals(kept, store.get("s", "k"))
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
}
