package dev.rayfold.core

import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * Runtime behaviour the declarative fixtures cannot express: deadlines, scheduling order and idempotency scope.
 * Everything runs on the coroutine test scheduler (virtual time), so nothing depends on the machine's clock.
 */
class RuntimeTest {
    private val fixture = Json.parseToJsonElement(File(System.getProperty("rayfold.fixtures") ?: "../conformance/fixtures", "core/01-default-view.json").readText()).jsonObject
    private val ir = RayfoldSchemaIR.json.decodeFromJsonElement(RayfoldSchemaIR.serializer(), fixture["ir"] ?: error("fixture has no ir"))
    private val book = buildJsonObject { put("id", "b1"); put("title", "T1"); put("stock", 2); put("authorId", "a1") }
    private val restockArgs = buildJsonObject { put("bookId", "b1"); put("qty", 1) }
    private val u1 = buildJsonObject { put("id", "u1") }
    private val u2 = buildJsonObject { put("id", "u2") }

    private fun op(id: Int, name: String, args: JsonObject = buildJsonObject { put("id", "b1") }, key: String? = null) = buildJsonObject {
        put("id", id); put("op", name); put("args", args); if (key != null) put("key", key)
    }

    private fun envelope(vararg ops: JsonObject, deadline: Long? = null) = buildJsonObject {
        put("ops", JsonArray(ops.toList()))
        if (deadline != null) put("meta", buildJsonObject { put("deadline", deadline) })
    }

    private fun code(frame: JsonElement): String? = ((frame as JsonObject)["error"] as? JsonObject)?.get("code")?.let { (it as kotlinx.serialization.json.JsonPrimitive).content }

    @Test
    fun `a batch deadline cancels an op that is still running`() = runTest(timeout = 5.seconds) {
        var cancelled = false
        val server = RayfoldServer(ir, Resolvers(queries = mapOf("book" to { _, _ ->
            try { awaitCancellation() } finally { cancelled = true }
        })))
        val frames = server.execute(envelope(op(1, "book"), deadline = 50)).toList()
        assertEquals(1, frames.size)
        assertEquals("deadline_exceeded", code(frames.single()))
        assertEquals(1, (frames.single()["id"] as kotlinx.serialization.json.JsonPrimitive).content.toInt())
        assertTrue(cancelled, "the resolver must be cancelled, not left running")
        assertEquals(50, currentTime, "the deadline fired at 50 ms of virtual time")
    }

    @Test
    fun `an op that finishes before the deadline is unaffected`() = runTest(timeout = 5.seconds) {
        val server = RayfoldServer(ir, Resolvers(queries = mapOf("book" to { _, _ -> delay(49); book })))
        val frames = server.execute(envelope(op(1, "book"), deadline = 50)).toList()
        assertEquals(buildJsonObject { put("\$type", "Book"); put("id", "b1"); put("title", "T1"); put("stock", 2) }, frames.single()["data"])
        assertEquals(49, currentTime)
    }

    @Test
    fun `commands run one at a time in id order, even when the first one suspends`() = runTest(timeout = 5.seconds) {
        val log = mutableListOf<String>()
        val restock: suspend (JsonObject, RayfoldContext) -> Any? = { _, ctx ->
            log.add("start ${ctx.opId}")
            if (ctx.opId == 1) delay(100)
            log.add("end ${ctx.opId}")
            CommandResult(book)
        }
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to restock)))
        // listed out of order on purpose: id order decides, not array order
        val frames = server.execute(envelope(op(2, "restock", restockArgs, "k".repeat(16) + "2"), op(1, "restock", restockArgs, "k".repeat(16) + "1")), u1).toList()
        assertEquals(listOf("start 1", "end 1", "start 2", "end 2"), log)
        assertEquals(listOf(1, 2), frames.map { (it["id"] as kotlinx.serialization.json.JsonPrimitive).content.toInt() })
    }

    @Test
    fun `queries in the same batch run concurrently (guard for the command rule)`() = runTest(timeout = 5.seconds) {
        val log = mutableListOf<String>()
        val server = RayfoldServer(ir, Resolvers(queries = mapOf("book" to { _, ctx ->
            log.add("start ${ctx.opId}")
            if (ctx.opId == 1) delay(100)
            log.add("end ${ctx.opId}")
            book
        })))
        val frames = server.execute(envelope(op(1, "book"), op(2, "book"))).toList()
        assertEquals(listOf("start 1", "start 2", "end 2", "end 1"), log)
        assertEquals(listOf(2, 1), frames.map { (it["id"] as kotlinx.serialization.json.JsonPrimitive).content.toInt() }, "the fast query's frame is not held back")
    }

    @Test
    fun `an idempotency key replays for the same viewer and never across viewers`() = runTest(timeout = 5.seconds) {
        var runs = 0
        val restock: suspend (JsonObject, RayfoldContext) -> Any? = { _, _ -> runs++; CommandResult(book) }
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to restock)))
        val key = "shared-key-000000001"
        val first = server.collect(envelope(op(1, "restock", restockArgs, key)), u1)
        val replay = server.collect(envelope(op(1, "restock", restockArgs, key)), u1)
        assertEquals(1, runs, "same viewer, same key: the resolver runs once")
        assertEquals(true, ((replay.single()["meta"] as JsonObject)["replay"] as kotlinx.serialization.json.JsonPrimitive).content.toBoolean())
        assertEquals(first.single()["ok"], replay.single()["ok"])
        server.collect(envelope(op(1, "restock", restockArgs, key)), u2)
        assertEquals(2, runs, "another viewer's identical key is a different command")
    }

    @Test
    fun `reusing a key with different arguments is rejected without running the command`() = runTest(timeout = 5.seconds) {
        var runs = 0
        val restock: suspend (JsonObject, RayfoldContext) -> Any? = { _, _ -> runs++; CommandResult(book) }
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to restock)))
        val key = "shared-key-000000002"
        server.collect(envelope(op(1, "restock", restockArgs, key)), u1)
        val other = buildJsonObject { put("bookId", "b1"); put("qty", 2) }
        val frames = server.collect(envelope(op(1, "restock", other, key)), u1)
        assertEquals("already_exists", code(frames.single()))
        assertEquals(1, runs)
    }

    private fun restockOp(id: Int, key: String, compact: Boolean = false) = buildJsonObject {
        put("id", id); put("op", "restock"); put("args", restockArgs); put("key", key); if (compact) put("compact", true)
    }
    private val fullBook = """{"${'$'}type":"Book","id":"b1","title":"T1","stock":2}"""
    private val compactBook = """{"id":"b1","title":"T1","stock":2}"""

    @Test
    fun `a compact first run replays in full to a plain retry`() = runTest(timeout = 5.seconds) {
        var runs = 0
        val restock: suspend (JsonObject, RayfoldContext) -> Any? = { _, _ -> runs++; CommandResult(book) }
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to restock)))
        val key = "shared-key-000000003"
        val first = server.collect(envelope(restockOp(1, key, compact = true)), u1).single()
        assertEquals(obj("""{"id":1,"ok":$compactBook,"patch":[],"fin":true}"""), first)
        val retry = server.collect(envelope(restockOp(1, key)), u1).single()
        assertEquals(obj("""{"id":1,"ok":$fullBook,"patch":[{"set":"Book:b1","value":$fullBook}],"meta":{"cost":1,"replay":true},"fin":true}"""), retry)
        assertEquals(1, runs)
    }

    @Test
    fun `a plain first run replays compact to a compact retry, keeping meta for the replay marker`() = runTest(timeout = 5.seconds) {
        var runs = 0
        val restock: suspend (JsonObject, RayfoldContext) -> Any? = { _, _ -> runs++; CommandResult(book) }
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to restock)))
        val key = "shared-key-000000004"
        val first = server.collect(envelope(restockOp(1, key)), u1).single()
        assertEquals(obj("""{"id":1,"ok":$fullBook,"patch":[{"set":"Book:b1","value":$fullBook}],"meta":{"cost":1},"fin":true}"""), first)
        val retry = server.collect(envelope(restockOp(1, key, compact = true)), u1).single()
        assertEquals(obj("""{"id":1,"ok":$compactBook,"patch":[],"meta":{"replay":true},"fin":true}"""), retry)
        assertEquals(1, runs)
    }

    @Test
    fun `a replay answers under the retrying op's id and still feeds a later ref`() = runTest(timeout = 5.seconds) {
        var runs = 0
        val restock: suspend (JsonObject, RayfoldContext) -> Any? = { _, _ -> runs++; CommandResult(book) }
        val server = RayfoldServer(ir, Resolvers(
            queries = mapOf("book" to query { args, _ -> if ((args["id"] as? kotlinx.serialization.json.JsonPrimitive)?.content == "b1") book else null }),
            commands = mapOf("restock" to restock),
        ))
        val key = "shared-key-000000005"
        server.collect(envelope(restockOp(1, key)), u1)
        val byRef = buildJsonObject { put("id", buildJsonObject { put("\$ref", "2.id") }) }
        val frames = server.collect(envelope(op(1, "book"), restockOp(2, key), op(3, "book", byRef)), u1)
        val replay = frames.single { it["ok"] != null }
        assertEquals(2, replay.opId(), "the stored frame was op 1's; this retry is op 2")
        assertEquals("true", ((replay["meta"] as? JsonObject)?.get("replay") as? kotlinx.serialization.json.JsonPrimitive)?.content)
        assertEquals(buildJsonObject { put("\$type", "Book"); put("id", "b1"); put("title", "T1"); put("stock", 2) }, frames.single { it.opId() == 3 }["data"])
        assertEquals(1, runs)
    }
}
