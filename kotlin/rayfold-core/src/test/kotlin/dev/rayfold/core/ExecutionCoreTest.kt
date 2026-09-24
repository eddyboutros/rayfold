package dev.rayfold.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/** The execution core's fixes, mirroring packages/server/src/execution-core.test.ts, driven through RayfoldServer. */
class ExecutionCoreTest {
    private val key = "0123456789abcdef"
    private val u1 = obj("""{"id":"u1"}""")
    private val t = "${'$'}type"

    private fun server(schema: String, resolvers: Resolvers, options: BatchOptions = BatchOptions(), instrumentation: Instrumentation = Instrumentation.NONE) =
        RayfoldServer(SchemaText.load(schema).ir, resolvers, options, instrumentation = instrumentation)

    // ---------------------------------------------------------------- 1. a committed command publishes its change

    private val committing = """entity A { id: ID name: String }
        event Made { id: ID }
        command make(id: ID): A emits Made
        command refuse(id: ID): A emits Made
    """

    private fun committingServer() = server(committing, Resolvers(commands = mapOf(
        // `name` is non-null and missing, so projecting the result fails after the write happened
        "make" to { a, _ -> CommandResult(buildJsonObject { put("id", a["id"] ?: JsonNull) }, emit = listOf("Made" to buildJsonObject { put("id", a["id"] ?: JsonNull) })) },
        "refuse" to { _, _ -> throw IllegalStateException("no") },
    )))

    @Test
    fun `a command that commits and then fails to answer still publishes its change and its declared events`() = runTest(timeout = 5.seconds) {
        val s = committingServer()
        val changes = mutableListOf<Change>()
        val events = mutableListOf<JsonObject>()
        s.changes.subscribe { changes.add(it) }
        s.events.on("Made") { events.add(it) }
        val frames = s.collect(batch("""{"id":1,"op":"make","args":{"id":"a1"},"key":"$key"}"""), u1)
        assertEquals(listOf(obj("""{"id":1,"error":{"code":"internal","message":"Non-null field A.name resolved to null","path":"name"},"fin":true}""")), frames)
        assertEquals(listOf(Change(setOf("A:a1"), emptySet())), changes)
        assertEquals(listOf(obj("""{"id":"a1","seq":1}""")), events)
    }

    @Test
    fun `guard - a command that failed before it committed publishes nothing`() = runTest(timeout = 5.seconds) {
        val s = committingServer()
        val changes = mutableListOf<Change>()
        val events = mutableListOf<JsonObject>()
        s.changes.subscribe { changes.add(it) }
        s.events.on("Made") { events.add(it) }
        val frames = s.collect(batch("""{"id":1,"op":"refuse","args":{"id":"a1"},"key":"$key"}"""), u1)
        assertEquals(listOf(obj("""{"id":1,"error":{"code":"internal","message":"Internal error"},"fin":true}""")), frames)
        assertEquals(emptyList(), changes)
        assertEquals(emptyList(), events)
    }

    // ---------------------------------------------------------------- 2. @defer and conditions at a union position

    private val unionSchema = """object Named @interface { name: String }
        entity Author implements Named { id: ID name: String }
        entity Book { id: ID title: String }
        union Hit = Book | Author
        query hit(book: Boolean): Hit
    """

    private fun unionServer() = server(unionSchema, Resolvers(queries = mapOf("hit" to { a, _ ->
        if ((a["book"] as? JsonPrimitive)?.content == "true") obj("""{"$t":"Book","id":"b1","title":"T"}""") else obj("""{"$t":"Author","id":"a1","name":"A"}""")
    })))

    @Test
    fun `a deferred block at a union position reaches the member in a later frame`() = runTest(timeout = 5.seconds) {
        assertEquals(
            listOf(
                obj("""{"id":1,"data":{"$t":"Author","id":"a1"},"meta":{"cost":2}}"""),
                obj("""{"id":1,"at":"","data":{"name":"A"}}"""),
                obj("""{"id":1,"fin":true}"""),
            ),
            unionServer().collect(batch("""{"id":1,"op":"hit","args":{"book":false},"shape":"{ ...on Author { id } @defer { name } }"}""")),
        )
    }

    @Test
    fun `a condition on an interface the union member implements selects its fields`() = runTest(timeout = 5.seconds) {
        assertEquals(
            listOf(obj("""{"id":1,"data":{"$t":"Author","name":"A"},"meta":{"cost":1},"fin":true}""")),
            unionServer().collect(batch("""{"id":1,"op":"hit","args":{"book":false},"shape":"{ ...on Named { name } }"}""")),
        )
    }

    @Test
    fun `guard - a condition on an interface the member does not implement selects nothing, so its default view applies`() = runTest(timeout = 5.seconds) {
        assertEquals(
            listOf(obj("""{"id":1,"data":{"$t":"Book","id":"b1","title":"T"},"meta":{"cost":1},"fin":true}""")),
            unionServer().collect(batch("""{"id":1,"op":"hit","args":{"book":true},"shape":"{ ...on Named { name } }"}""")),
        )
    }

    // ---------------------------------------------------------------- 3. errors of a deferred frame

    private fun lazyServer() = server("entity Book { id: ID bio: String @lazy } query books: [Book] query book: Book", Resolvers(
        queries = mapOf(
            "books" to { _, _ -> kotlinx.serialization.json.JsonArray((0 until 12).map { obj("""{"id":"b$it"}""") }) },
            "book" to { _, _ -> obj("""{"id":"b10"}""") },
        ),
        fields = mapOf("Book" to mapOf("bio" to { ps, _, _ -> ps.map { p -> if ((p["id"] as JsonPrimitive).content == "b10") null else JsonPrimitive("bio of ${(p["id"] as JsonPrimitive).content}") } })),
    ))

    @Test
    fun `deferred errors belong to the frame at their own path, not to one whose path is a prefix of it`() = runTest(timeout = 5.seconds) {
        val frames = lazyServer().collect(batch("""{"id":1,"op":"books","shape":"{ id bio @partial }"}"""))
        val withErrors = frames.filter { "errors" in it }.map { (it["at"] as JsonPrimitive).content to it["errors"] }
        assertEquals(listOf("10" to kotlinx.serialization.json.Json.parseToJsonElement("""[{"code":"internal","message":"Non-null field Book.bio resolved to null","path":"10.bio"}]""")), withErrors)
    }

    @Test
    fun `guard - a deferred frame at the root carries every error beneath it`() = runTest(timeout = 5.seconds) {
        assertEquals(
            listOf(
                obj("""{"id":1,"data":{"$t":"Book","id":"b10"},"meta":{"cost":1}}"""),
                obj("""{"id":1,"at":"","data":{"bio":null},"errors":[{"code":"internal","message":"Non-null field Book.bio resolved to null","path":"bio"}]}"""),
                obj("""{"id":1,"fin":true}"""),
            ),
            lazyServer().collect(batch("""{"id":1,"op":"book","shape":"{ id bio @partial }"}""")),
        )
    }

    // ---------------------------------------------------------------- 6. @idempotent(false) takes no key

    private fun idemServer(runs: MutableList<String>) = server("entity A { id: ID } command free(n: Int): A @idempotent(false) command kept(n: Int): A", Resolvers(commands = mapOf(
        "free" to { _, _ -> runs.add("free"); obj("""{"id":"f${runs.size}"}""") },
        "kept" to { _, _ -> runs.add("kept"); obj("""{"id":"k${runs.size}"}""") },
    )))

    @Test
    fun `a key sent to an @idempotent(false) command is ignored - every call runs, and none is a replay`() = runTest(timeout = 5.seconds) {
        val runs = mutableListOf<String>()
        val s = idemServer(runs)
        val call = batch("""{"id":1,"op":"free","args":{"n":1},"key":"$key"}""")
        assertEquals(listOf(obj("""{"id":1,"ok":{"$t":"A","id":"f1"},"patch":[{"set":"A:f1","value":{"$t":"A","id":"f1"}}],"meta":{"cost":1},"fin":true}""")), s.collect(call, u1))
        assertEquals(listOf(obj("""{"id":1,"ok":{"$t":"A","id":"f2"},"patch":[{"set":"A:f2","value":{"$t":"A","id":"f2"}}],"meta":{"cost":1},"fin":true}""")), s.collect(call, u1))
        // nor does a key from an anonymous caller refuse it: there is no replay scope to share
        assertEquals("f3", ((s.collect(call).single()["ok"] as JsonObject)["id"] as JsonPrimitive).content)
        assertEquals(listOf("free", "free", "free"), runs)
    }

    @Test
    fun `guard - a command that does not opt out still replays its key`() = runTest(timeout = 5.seconds) {
        val runs = mutableListOf<String>()
        val s = idemServer(runs)
        val call = batch("""{"id":1,"op":"kept","args":{"n":1},"key":"$key"}""")
        s.collect(call, u1)
        val replay = s.collect(call, u1).single()
        assertEquals(JsonPrimitive(true), (replay["meta"] as JsonObject)["replay"])
        assertEquals(listOf("kept"), runs)
    }

    // ---------------------------------------------------------------- 8. what a resolver threw reaches the op hook

    private val boom = IllegalStateException("db connection string postgres://secret")

    private fun causeServer(outcomes: MutableList<Outcome>) = server(
        "entity A { id: ID name: String } query bad: A query good: A command make: A @idempotent(false)",
        Resolvers(
            queries = mapOf("bad" to { _, _ -> throw boom }, "good" to { _, _ -> obj("""{"id":"g","name":"G"}""") }),
            commands = mapOf("make" to { _, _ -> obj("""{"id":"m","name":"M"}""") }),
            fields = mapOf("A" to mapOf("name" to { _, _, _ -> throw boom })),
        ),
        instrumentation = object : Instrumentation {
            override suspend fun op(info: OpInfo, run: suspend () -> Outcome): Outcome = run().also { outcomes.add(it) }
        },
    )

    @Test
    fun `a query's exception is the outcome's cause, and the client is told only internal`() = runTest(timeout = 5.seconds) {
        val outcomes = mutableListOf<Outcome>()
        assertEquals(listOf(obj("""{"id":1,"error":{"code":"internal","message":"Internal error"},"fin":true}""")), causeServer(outcomes).collect(batch("""{"id":1,"op":"bad"}""")))
        assertEquals(1, outcomes.size)
        assertEquals("internal", outcomes[0].code)
        assertSame(boom, outcomes[0].cause)
    }

    @Test
    fun `a command that committed and then failed in a loader reports the loader's exception`() = runTest(timeout = 5.seconds) {
        val outcomes = mutableListOf<Outcome>()
        assertEquals(listOf(obj("""{"id":1,"error":{"code":"internal","message":"Internal error"},"fin":true}""")), causeServer(outcomes).collect(batch("""{"id":1,"op":"make","shape":"{ id name }"}""")))
        assertSame(boom, outcomes.single().cause)
    }

    @Test
    fun `guard - an op that succeeded has no cause`() = runTest(timeout = 5.seconds) {
        val outcomes = mutableListOf<Outcome>()
        causeServer(outcomes).collect(batch("""{"id":1,"op":"good","shape":"{ id }"}"""))
        assertEquals(listOf(Outcome()), outcomes)
    }

    // ---------------------------------------------------------------- 9. live re-runs do not count toward maxFrames

    @Test
    fun `a live query outlives maxFrames changes`() = runTest(timeout = 5.seconds) {
        var n = 0
        val s = server("entity A { id: ID n: Int } query a: A", Resolvers(queries = mapOf("a" to { _, _ -> obj("""{"id":"a1","n":${n}}""") })), BatchOptions(maxFrames = 3))
        val cancel = Job()
        val frames = Channel<JsonObject>(Channel.UNLIMITED)
        val job = launch {
            try { s.execute(batch("""{"id":1,"op":"a","shape":"{ id n }","live":true}"""), ExecuteOptions(cancel = cancel)).collect { frames.send(it) } } finally { frames.close() }
        }
        assertEquals(obj("""{"id":1,"data":{"$t":"A","id":"a1","n":0},"meta":{"cost":1}}"""), withTimeout(5_000) { frames.receive() })
        for (i in 1..5) {
            n = i
            s.changes.publish(Change(setOf("A:a1"), emptySet()))
            assertEquals(obj("""{"id":1,"patch":[{"set":"A:a1","value":{"n":$i}}]}"""), withTimeout(5_000) { frames.receive() })
            advanceUntilIdle()
        }
        cancel.complete()
        val rest = mutableListOf<JsonObject>()
        withTimeout(5_000) { for (f in frames) rest.add(f) }
        job.join()
        assertEquals(listOf(obj("""{"id":1,"error":{"code":"canceled","message":"Canceled"},"fin":true}""")), rest)
    }

    @Test
    fun `guard - a stream still ends at maxFrames`() = runTest(timeout = 5.seconds) {
        val s = server("entity A { id: ID } stream many: A", Resolvers(streams = mapOf("many" to { _, _ -> flow { for (i in 1..5) emit(obj("""{"id":"a$i"}""")) } })), BatchOptions(maxFrames = 3))
        val frames = s.collect(batch("""{"id":1,"op":"many","shape":"{ id }"}"""))
        assertEquals(obj("""{"id":1,"error":{"code":"resource_exhausted","message":"Batch produced more than 3 frames"},"fin":true}"""), frames.last())
        assertEquals(4, frames.size)
    }

    // ---------------------------------------------------------------- 11. order of checks

    @Test
    fun `an unauthorized dry run of a command without @simulate is refused for permission, revealing nothing else`() = runTest(timeout = 5.seconds) {
        val s = server("""entity A { id: ID } command careless: A @idempotent(false) @allow(write: viewer.role == "admin")""", Resolvers(commands = mapOf("careless" to { _, _ -> obj("""{"id":"a"}""") })))
        assertEquals("permission_denied", s.collect(batch("""{"id":1,"op":"careless","simulate":true}"""), obj("""{"id":"u1","role":"customer"}""")).single().errorCode())
        // guard: an authorized caller learns the command takes no dry run
        assertEquals("failed_precondition", s.collect(batch("""{"id":1,"op":"careless","simulate":true}"""), obj("""{"id":"u9","role":"admin"}""")).single().errorCode())
    }

    // ---------------------------------------------------------------- 12. drain()

    @Test
    fun `every concurrent drain wakes when the last batch ends, not at its timeout`() = runTest(timeout = 5.seconds) {
        val running = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val s = server("entity A { id: ID } command hold: A @idempotent(false)", Resolvers(commands = mapOf("hold" to { _, _ -> running.complete(Unit); release.await(); obj("""{"id":"h"}""") })))
        val batchJob = launch { s.collect(batch("""{"id":1,"op":"hold"}""")) }
        withTimeout(5_000) { running.await() }
        val first = async { s.drain(10_000) }
        val second = async { s.drain(10_000) }
        runCurrent()
        assertFalse(first.isCompleted || second.isCompleted, "the command still runs")
        release.complete(Unit)
        first.await(); second.await(); batchJob.join()
        assertTrue(currentTime < 10_000, "both drains woke when the batch ended, at $currentTime ms, not at the timeout")
        assertEquals(0, s.inflight)
    }

    // ---------------------------------------------------------------- non-finite numbers

    @Test
    fun `a resolver's NaN and infinities go out as null, so the answer is JSON, as in TypeScript (guard - finite numbers stay)`() = runTest(timeout = 5.seconds) {
        val s = server("entity A { id: ID x: Float? xs: [Float?] y: Float } query a: A", Resolvers(queries = mapOf("a" to { _, _ ->
            buildJsonObject {
                put("id", "a1"); put("x", Double.NaN); put("y", 1.5)
                put("xs", kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive(Double.POSITIVE_INFINITY), JsonPrimitive(Double.NEGATIVE_INFINITY), JsonPrimitive(2.0))))
            }
        })))
        val text = s.collect(batch("""{"id":1,"op":"a","shape":"{ id x xs y }"}"""), u1).single().toString()
        assertEquals(obj("""{"id":1,"data":{"$t":"A","id":"a1","x":null,"xs":[null,null,2.0],"y":1.5},"meta":{"cost":1},"fin":true}"""), kotlinx.serialization.json.Json.parseToJsonElement(text))
    }
}
