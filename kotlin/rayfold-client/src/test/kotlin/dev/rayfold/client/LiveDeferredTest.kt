package dev.rayfold.client

import dev.rayfold.core.Change
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * A live query whose shape has a deferred part, through the real client against the real Kotlin server in process.
 * The server sends the part after the first result and a live query never sends `fin`, so a client that waited for
 * one showed the result without it until something else changed.
 */
class LiveDeferredTest {
    private val schema = SchemaText.load(
        """
        entity Author { id: ID  name: String  bio: String? @lazy }
        query author(id: ID): Author?
        """,
    ).ir

    @Volatile private var name = "Ursula K. Le Guin"

    private val server = RayfoldServer(
        schema,
        Resolvers(
            queries = mapOf("author" to { _, _ -> json("""{"id":"a1","name":"$name"}""") }),
            fields = mapOf("Author" to mapOf("bio" to { parents, _, _ -> parents.map { Json.parseToJsonElement("\"Wrote Earthsea.\"") } })),
        ),
    )

    private val inProcess = Transport { envelope, _ -> flow<JsonObject> { emitAll(server.execute(envelope, JsonNull)) } }

    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

    /** Every value [values] reports, read one at a time with a bound. */
    private class Reading(values: Flow<JsonElement>, scope: CoroutineScope) {
        private val channel = Channel<JsonElement>(Channel.UNLIMITED)
        val job = scope.launch { values.collect { channel.send(it) } }
        suspend fun next(): JsonElement = withTimeout(5_000) { channel.receive() }
    }

    /** The whole test is bounded, so a collection that ignores its cancellation fails instead of hanging the JVM. */
    private fun bounded(block: suspend CoroutineScope.() -> Unit): Unit = runBlocking { withTimeout(5_000) { block() } }

    @Test
    fun `a live query reports its deferred part when it arrives, not only after the next change`() = bounded {
        val reading = Reading(RayfoldClient(inProcess).live("author", args("id" to "a1"), "{ id name bio }"), this)
        assertEquals(json("""{"${'$'}type":"Author","id":"a1","name":"Ursula K. Le Guin"}"""), reading.next())
        assertEquals(json("""{"${'$'}type":"Author","id":"a1","name":"Ursula K. Le Guin","bio":"Wrote Earthsea."}"""), reading.next())
        reading.job.cancel()
        reading.job.join()
        assertEquals(0, server.changes.size)
    }

    @Test
    fun `guard - a live query with nothing deferred reports its result once, and nothing more until a change`() = bounded {
        val reading = Reading(RayfoldClient(inProcess).live("author", args("id" to "a1"), "{ id name }"), this)
        assertEquals(json("""{"${'$'}type":"Author","id":"a1","name":"Ursula K. Le Guin"}"""), reading.next())
        // the next value reported is the change's: a second report of the first result would arrive before it
        name = "Ursula Le Guin"
        server.changes.publish(Change(setOf("Author:a1"), emptySet()))
        assertEquals(json("""{"${'$'}type":"Author","id":"a1","name":"Ursula Le Guin"}"""), reading.next())
        reading.job.cancel()
        reading.job.join()
        assertEquals(0, server.changes.size)
    }
}
