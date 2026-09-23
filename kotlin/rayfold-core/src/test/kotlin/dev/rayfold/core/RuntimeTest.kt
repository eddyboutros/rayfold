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

    private val stockShop = SchemaText.load("entity Book { id: ID stock: Int } query book(id: ID): Book? command restock(id: ID, qty: Int): Book @simulate").ir

    @Test
    fun `a command's own result, and every op after it, load again, and a dry run keeps what was loaded (mirrors server test)`() = runTest(timeout = 5.seconds) {
        var stock = 1
        var loads = 0
        val server = RayfoldServer(stockShop, Resolvers(
            queries = mapOf("book" to { args, _ -> buildJsonObject { put("id", args.getValue("id")) } }),
            commands = mapOf("restock" to { args, ctx -> if (!ctx.simulate) stock += 10; CommandResult(buildJsonObject { put("id", args.getValue("id")) }) }),
            fields = mapOf("Book" to mapOf("stock" to { parents, _, _ -> loads++; parents.map { kotlinx.serialization.json.JsonPrimitive(stock) } })),
        ))
        suspend fun run(simulate: Boolean): Map<Int, JsonObject> = server.collect(obj(
            """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }"},""" +
                """{"id":2,"op":"restock","args":{"id":"b1","qty":10},"shape":"{ id stock }","key":"restock-00000000${if (simulate) 1 else 2}"${if (simulate) ""","simulate":true""" else ""}},""" +
                """{"id":3,"op":"book","args":{"id":{"${'$'}ref":"2.id"}},"shape":"{ id stock }"}]}""",
        ), u1).filter { it["fin"] != null }.associateBy { (it["id"] as kotlinx.serialization.json.JsonPrimitive).content.toInt() }
        fun stockOf(f: JsonObject?) = ((f?.get("data") ?: f?.get("ok")) as JsonObject)["stock"].toString()

        val dry = run(simulate = true)
        assertEquals(listOf("1", "1", "1"), (1..3).map { stockOf(dry[it]) }, "a dry run changed nothing")
        assertEquals(1, loads, "so the ops after it keep the first op's load")

        loads = 0
        val frames = run(simulate = false)
        assertEquals(listOf("1", "11", "11"), (1..3).map { stockOf(frames[it]) })
        assertEquals(2, loads, "before the command, then once for its result and the op after it")
    }

    @Test
    fun `one op's deadline ends that op, and an op sharing its load loads for itself instead of failing the batch`() = runTest(timeout = 5.seconds) {
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        var loads = 0
        val server = RayfoldServer(stockShop, Resolvers(
            queries = mapOf("book" to { args, _ -> buildJsonObject { put("id", args.getValue("id")) } }),
            fields = mapOf("Book" to mapOf("stock" to { parents, _, _ ->
                if (++loads == 1) gate.await() // the first load hangs until its op has run out of time
                parents.map { kotlinx.serialization.json.JsonPrimitive(7) }
            })),
        ))
        val frames = server.collect(obj(
            """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","deadline":50},""" +
                """{"id":2,"op":"book","args":{"id":"b1"},"shape":"{ id stock }"}]}""",
        ))
        assertEquals(listOf("deadline_exceeded"), frames.filter { it["id"].toString() == "1" }.mapNotNull { code(it) })
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1","stock":7}"""), frames.single { it["id"].toString() == "2" }["data"])
        assertEquals(2, loads, "op 2 loaded for itself once op 1 abandoned the load they shared")
        assertEquals(2, frames.size, "and nothing ended the batch: no frame without an id")
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
    fun `the same viewer built with its keys in another order is one idempotency scope, and a viewer with another id is not (guard)`() = runTest(timeout = 5.seconds) {
        var runs = 0
        val restock: suspend (JsonObject, RayfoldContext) -> Any? = { _, _ -> runs++; CommandResult(book) }
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to restock)))
        val key = "shared-key-000000006"
        // as a Map with another iteration order, or another instance sharing the store, would hand the viewer over
        val ada = obj("""{"id":"u1","roles":["ADMIN","AUTHOR"],"org":{"name":"Acme","region":"eu"}}""")
        val adaReordered = obj("""{"org":{"region":"eu","name":"Acme"},"roles":["ADMIN","AUTHOR"],"id":"u1"}""")
        assertEquals(ada, adaReordered)
        assertTrue(ada.toString() != adaReordered.toString(), "the two differ in key order only")

        val first = server.collect(envelope(op(1, "restock", restockArgs, key)), ada).single()
        val retry = server.collect(envelope(op(1, "restock", restockArgs, key)), adaReordered).single()
        assertEquals(1, runs, "a replay, not a second run")
        assertEquals(JsonObject(first + ("meta" to obj("""{"cost":1,"replay":true}"""))), retry)

        val grace = obj("""{"org":{"region":"eu","name":"Acme"},"roles":["ADMIN","AUTHOR"],"id":"u2"}""")
        assertEquals(first, server.collect(envelope(op(1, "restock", restockArgs, key)), grace).single(), "answered as a first run, with no replay marker")
        assertEquals(2, runs, "another viewer's identical key is a different command")
    }

    @Test
    fun `a field with arguments and no loader serves the value the resolver already put on its parent`() = runTest(timeout = 5.seconds) {
        val schema = SchemaText.load("entity Author { id: ID name: String books(page: PageArgs = { first: 10 }): Page<Book> } entity Book { id: ID } query author(id: ID): Author?").ir
        val planned = obj("""{"id":"a1","name":"Ursula","books":{"items":[{"id":"b1"}],"total":3,"hasMore":true,"cursor":"b1"}}""")
        val server = RayfoldServer(schema, Resolvers(queries = mapOf("author" to { _, _ -> planned })))
        val shape = "{ name books(page: { first: 1 }) { total items { id } } shelf: books(page: { first: 1 }) { hasMore } }"
        val frames = server.collect(obj("""{"ops":[{"id":1,"op":"author","args":{"id":"a1"},"shape":"$shape"}]}"""))
        assertEquals(listOf(obj("""{"id":1,"data":{"${'$'}type":"Author","name":"Ursula","books":{"total":3,"items":[{"${'$'}type":"Book","id":"b1"}]},"shelf":{"hasMore":true}},"meta":{"cost":6},"fin":true}""")), frames)
    }

    @Test
    fun `guard - without its value on the parent, a field with arguments still needs a loader`() = runTest(timeout = 5.seconds) {
        val schema = SchemaText.load("entity Author { id: ID name: String books(page: PageArgs = { first: 10 }): Page<Book> } entity Book { id: ID } query author(id: ID): Author?").ir
        val server = RayfoldServer(schema, Resolvers(queries = mapOf("author" to { _, _ -> obj("""{"id":"a1","name":"Ursula"}""") })))
        val frames = server.collect(obj("""{"ops":[{"id":1,"op":"author","args":{"id":"a1"},"shape":"{ name books(page: { first: 1 }) { total } }"}]}"""))
        assertEquals(listOf(obj("""{"id":1,"error":{"code":"unimplemented","message":"No loader for Author.books","path":"books"},"fin":true}""")), frames)
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
