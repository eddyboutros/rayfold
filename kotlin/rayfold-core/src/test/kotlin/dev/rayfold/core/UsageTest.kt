package dev.rayfold.core

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.Duration.Companion.seconds

/**
 * Field-usage telemetry (spec 11), case for case with packages/server/src/usage.test.ts: what a server records when
 * it is given a sink, and that it records nothing when it is not.
 */
class UsageTest {
    private val fixture = Json.parseToJsonElement(File(System.getProperty("rayfold.fixtures") ?: "../conformance/fixtures", "core/01-default-view.json").readText()).jsonObject
    private val ir = RayfoldSchemaIR.json.decodeFromJsonElement(RayfoldSchemaIR.serializer(), fixture["ir"] ?: error("fixture has no ir"))
    private val book = buildJsonObject { put("id", "b1"); put("title", "T1"); put("stock", 2); put("authorId", "a1") }

    private fun server(usage: UsageSink?) =
        RayfoldServer(ir, Resolvers(queries = mapOf("book" to { _, _ -> book })), usage = usage)

    private fun request(client: String?, shape: String) = Json.parseToJsonElement(
        """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"$shape"}]${if (client == null) "" else ""","meta":{"client":"$client"}"""}}""",
    ).jsonObject

    @Test
    fun `records the operation and every member the client asked for`() = runTest(timeout = 5.seconds) {
        val usage = MemoryUsage()
        val s = server(usage)
        s.execute(request("web", "{ id title }")).toList()
        assertEquals(
            listOf("web book ", "web book Book.id", "web book Book.title"),
            usage.snapshot().map { "${it.client} ${it.op} ${it.path}" },
        )

        // a second client asking for less is a second set of records, so "who still uses this" has an answer
        s.execute(request("ios", "{ id }")).toList()
        assertEquals(listOf("", "Book.id"), usage.snapshot().filter { it.client == "ios" }.map { it.path })
        assertEquals(1, usage.snapshot().first { it.client == "web" && it.path == "Book.title" }.count)
    }

    @Test
    fun `counts repeats, and a caller that does not name itself is recorded without a name`() = runTest(timeout = 5.seconds) {
        val usage = MemoryUsage()
        val s = server(usage)
        s.execute(request("web", "{ id }")).toList()
        s.execute(request("web", "{ id }")).toList()
        s.execute(request(null, "{ id }")).toList()
        assertEquals(2, usage.snapshot().first { it.client == "web" && it.path == "Book.id" }.count)
        assertEquals(1, usage.snapshot().first { it.client == "" && it.path == "Book.id" }.count)
    }

    @Test
    fun `records nothing without a sink, and stops at the limit of one that is full`() = runTest(timeout = 5.seconds) {
        val quiet = server(null)
        quiet.execute(request("web", "{ id title }")).toList()
        assertNull(quiet.usage)

        // guard: a full sink records no more rather than growing without bound
        val small = MemoryUsage(2)
        server(small).execute(request("web", "{ id title }")).toList()
        assertEquals(2, small.size)
    }
}
