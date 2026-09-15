package dev.rayfold.client

import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import dev.rayfold.core.mergePolicies
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Per-field conflict policy (spec 08 section 5), case for case with packages/client/src/merge.test.ts: what happens
 * when the server speaks for a field a prediction also set. The cache cases come first; then the same rules through
 * [RayfoldClient] against the real server, with the predicting command held at a gate on the server so the other
 * writer's patch lands while the prediction is still shown.
 */
class MergePolicyTest {
    private val policies = mapOf("Doc.title" to "serverWins", "Doc.body" to "crdtText")

    private fun cache() = RayfoldCache(now = { 0 }, mergePolicies = policies)

    private fun fields(vararg pairs: Pair<String, String>): JsonObject = buildJsonObject { for ((k, v) in pairs) put(k, v) }

    private fun value(c: RayfoldCache, field: String): String? = (c.get("Doc:d1")?.get(field) as? JsonPrimitive)?.content

    @Test
    fun `a field the server speaks for leaves the prediction, one without a policy keeps it`() {
        val c = cache()
        c.merge("Doc:d1", fields("title" to "server", "notes" to "server note"))
        c.addLayer("cmd-1", listOf(OptimisticOp("Doc:d1", fields("title" to "mine", "notes" to "my note"))))
        assertEquals("mine", value(c, "title"))
        assertEquals("my note", value(c, "notes"))

        // the server writes both fields while the command is still in flight
        c.merge("Doc:d1", fields("title" to "theirs", "notes" to "their note"))
        assertEquals("theirs", value(c, "title"), "serverWins drops the predicted title at once")
        assertEquals("my note", value(c, "notes"), "a field with no policy keeps its prediction")

        // and when the command settles, what is left is exactly what the server said
        c.removeLayer("cmd-1")
        assertEquals("theirs", value(c, "title"))
        assertEquals("their note", value(c, "notes"))
    }

    @Test
    fun `refuses to predict a field whose policy it cannot carry out`() {
        val c = cache()
        val refused = assertFailsWith<IllegalArgumentException> {
            c.addLayer("cmd-2", listOf(OptimisticOp("Doc:d1", fields("body" to "typed locally"))))
        }
        assertEquals("@merge(crdtText) is not implemented: Doc.body cannot be predicted optimistically", refused.message)

        // guard: the same prediction on a field it can carry out is accepted
        c.addLayer("cmd-3", listOf(OptimisticOp("Doc:d1", fields("title" to "typed locally"))))
        assertEquals("typed locally", value(c, "title"))
    }

    @Test
    fun `a cache given no policies behaves as it always has`() {
        val plain = RayfoldCache(now = { 0 })
        plain.merge("Doc:d1", fields("title" to "server"))
        plain.addLayer("cmd-4", listOf(OptimisticOp("Doc:d1", fields("title" to "mine"))))
        plain.merge("Doc:d1", fields("title" to "theirs"))
        assertEquals("mine", value(plain, "title"))
    }

    // ------------------------------------------------------------------ through the client

    private val schema = """
        entity Doc { id: ID title: String @merge(serverWins) summary: String @merge(lww) notes: String body: String @merge(crdtText) }
        query doc(id: ID): Doc?
        command edit(id: ID, title: String, summary: String, notes: String): Doc
    """
    private val ir = SchemaText.load(schema).ir
    private val docs = ConcurrentHashMap(mapOf("d1" to doc("server", "server", "server")))
    private val edits = AtomicInteger()

    /** Set before a command that must wait on the server: its resolver completes the first and waits for the second. */
    private val gate = AtomicReference<Pair<CompletableDeferred<Unit>, CompletableDeferred<Unit>>?>(null)

    private val server = RayfoldServer(
        ir,
        Resolvers(
            queries = mapOf("doc" to { args, _ -> docs[args.text("id")] }),
            commands = mapOf(
                "edit" to { args, _ ->
                    gate.getAndSet(null)?.let { (entered, release) ->
                        entered.complete(Unit)
                        release.await()
                    }
                    edits.incrementAndGet()
                    doc(args.text("title"), args.text("summary"), args.text("notes")).also { docs[args.text("id")] = it }
                },
            ),
        ),
    )

    private fun doc(title: String, summary: String, notes: String) =
        buildJsonObject { put("id", "d1"); put("title", title); put("summary", summary); put("notes", notes); put("body", "text") }

    private fun JsonObject.text(k: String) = this[k]?.jsonPrimitive?.content ?: error("no $k in $this")

    /** The real server in process: every frame the client reads is one the server produced for [viewer]. */
    private inner class InProcess(private val viewer: JsonElement) : Transport {
        val batches = AtomicInteger()
        override fun send(envelope: JsonObject, safe: Boolean): Flow<JsonObject> = flow {
            batches.incrementAndGet()
            emitAll(server.execute(envelope, viewer))
        }
    }

    private val alice = buildJsonObject { put("id", "alice") }
    private val bob = buildJsonObject { put("id", "bob") }

    private fun bounded(block: suspend CoroutineScope.() -> Unit) = runBlocking { withTimeout(5_000) { block() } }

    private fun edit(title: String, summary: String, notes: String) = args("id" to "d1", "title" to title, "summary" to summary, "notes" to notes)

    private fun predict(title: String, summary: String, notes: String) =
        listOf(OptimisticOp("Doc:d1", buildJsonObject { put("title", title); put("summary", summary); put("notes", notes) }))

    private fun shown(title: String, summary: String, notes: String): JsonElement =
        Json.parseToJsonElement("""{"${'$'}type":"Doc","id":"d1","title":"$title","summary":"$summary","notes":"$notes"}""")

    private val shape = "{ id title summary notes }"

    /** Bob commits his edit on the server directly, as another device would. */
    private suspend fun bobEdits() {
        val frames = server.collect(Json.parseToJsonElement("""{"ops":[{"id":1,"op":"edit","args":{"id":"d1","title":"theirs","summary":"theirs","notes":"theirs"},"key":"bob-key-0000000001","shape":"{ id }"}]}""") as JsonObject, bob)
        assertEquals(Json.parseToJsonElement("""{"id":1,"ok":{"${'$'}type":"Doc","id":"d1"},"patch":[{"set":"Doc:d1","value":{"${'$'}type":"Doc","id":"d1"}}],"meta":{"cost":1},"fin":true}"""), frames.single())
    }

    @Test
    fun `a live patch from another writer overrules a held prediction per field - serverWins and lww give way, a field without a policy keeps it`() = bounded {
        val client = RayfoldClient(InProcess(alice), ClientOptions(mergePolicies = mergePolicies(ir)))
        val seen = Channel<JsonElement>(Channel.UNLIMITED)
        val live = launch { client.live("doc", args("id" to "d1"), shape).collect { seen.send(it) } }
        assertEquals(shown("server", "server", "server"), seen.receive())

        val held = CompletableDeferred<Unit>() to CompletableDeferred<Unit>()
        gate.set(held)
        val mine = async { client.command("edit", edit("mine", "mine", "mine"), shape, optimistic = predict("mine", "mine", "mine")) }
        held.first.await()
        assertEquals(shown("mine", "mine", "mine"), client.cache.denormalize(Json.parseToJsonElement("""{"${'$'}ref":"Doc:d1"}""")), "the prediction is shown while the command waits")

        bobEdits()
        // the live query re-ran for Bob's commit and its patch has been applied to the cache
        assertEquals(shown("theirs", "theirs", "mine"), seen.receive())
        assertEquals<JsonElement?>(Json.parseToJsonElement("""{"${'$'}type":"Doc","id":"d1","title":"theirs","summary":"theirs","notes":"mine"}"""), client.cache.get("Doc:d1"))
        assertEquals(1, edits.get(), "Alice's command is still held")

        held.second.complete(Unit)
        assertEquals(shown("mine", "mine", "mine"), mine.await(), "her command ran after Bob's, so the server now says what she wrote")
        assertEquals(shown("mine", "mine", "mine"), seen.receive())
        assertEquals(emptyList(), client.cache.predictions)
        assertEquals(doc("mine", "mine", "mine"), docs["d1"])
        assertEquals(2, edits.get())
        live.cancelAndJoin()
    }

    @Test
    fun `guard - a client told no policies keeps the whole prediction through the same patch`() = bounded {
        val client = RayfoldClient(InProcess(alice))
        val seen = Channel<JsonElement>(Channel.UNLIMITED)
        val live = launch { client.live("doc", args("id" to "d1"), shape).collect { seen.send(it) } }
        assertEquals(shown("server", "server", "server"), seen.receive())

        val held = CompletableDeferred<Unit>() to CompletableDeferred<Unit>()
        gate.set(held)
        val mine = async { client.command("edit", edit("mine", "mine", "mine"), shape, optimistic = predict("mine", "mine", "mine")) }
        held.first.await()
        bobEdits()
        assertEquals(shown("mine", "mine", "mine"), seen.receive(), "Bob's patch landed underneath the prediction")

        held.second.complete(Unit)
        assertEquals(shown("mine", "mine", "mine"), mine.await())
        live.cancelAndJoin()
    }

    @Test
    fun `a command's own answer overrules another held prediction the way a live patch does`() = bounded {
        val client = RayfoldClient(InProcess(alice), ClientOptions(mergePolicies = mergePolicies(ir)))
        client.query("doc", args("id" to "d1"), shape)

        val held = CompletableDeferred<Unit>() to CompletableDeferred<Unit>()
        gate.set(held)
        val first = async { client.command("edit", edit("first", "first", "first"), shape, optimistic = predict("first", "first", "first")) }
        held.first.await()
        // a second command from the same client, not predicted: its ok frame carries the server's set patch, and its result
        // is read back from the cache, where the first command's prediction still stands on the field without a policy
        assertEquals(shown("second", "second", "first"), client.command("edit", edit("second", "second", "second"), shape))
        assertEquals<JsonElement?>(Json.parseToJsonElement("""{"${'$'}type":"Doc","id":"d1","title":"second","summary":"second","notes":"first"}"""), client.cache.get("Doc:d1"))

        held.second.complete(Unit)
        assertEquals(shown("first", "first", "first"), first.await())
        assertEquals<JsonElement?>(Json.parseToJsonElement("""{"${'$'}type":"Doc","id":"d1","title":"first","summary":"first","notes":"first"}"""), client.cache.get("Doc:d1"))
    }

    @Test
    fun `a prediction the client cannot merge is refused before anything is sent, and a mergeable one goes out (guard)`() = bounded {
        val transport = InProcess(alice)
        val client = RayfoldClient(transport, ClientOptions(mergePolicies = mergePolicies(ir)))
        val refused = assertFailsWith<IllegalArgumentException> {
            client.command("edit", edit("x", "x", "x"), shape, optimistic = listOf(OptimisticOp("Doc:d1", buildJsonObject { put("body", "typed locally") })))
        }
        assertEquals("@merge(crdtText) is not implemented: Doc.body cannot be predicted optimistically", refused.message)
        assertEquals(0, transport.batches.get())
        assertEquals(0, edits.get())
        assertEquals(emptyList(), client.cache.predictions)

        assertEquals(shown("x", "x", "x"), client.command("edit", edit("x", "x", "x"), shape, optimistic = predict("x", "x", "x")))
        assertEquals(1, transport.batches.get())
        assertEquals(1, edits.get())
    }
}
