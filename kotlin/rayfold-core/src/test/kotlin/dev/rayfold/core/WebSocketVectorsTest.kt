package dev.rayfold.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.Socket
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The published `websocket/` vectors (spec 04 section 5), run against [RayfoldWebSocket] over a real socket. The client
 * is a raw RFC 6455 one, so it can send bytes no WebSocket API would (a text message that is not UTF-8) and read the
 * handshake's status and the close frame's code and reason. Reads time out after 5 s, so a frame that never comes fails
 * the case instead of hanging it. `packages/server/src/websocket-vectors.test.ts` runs the same file on TypeScript.
 */
class WebSocketVectorsTest {
    private val root = File(System.getProperty("rayfold.vectors") ?: "../conformance/vectors")
    private val caseKeys = setOf("name", "why", "viewer", "hook", "connect", "steps")
    private val stepKeys = mapOf(
        "send" to emptySet(), "sendHex" to emptySet(), "command" to emptySet(), "clock" to emptySet(),
        "expect" to emptySet(), "close" to setOf("reason"), "ran" to emptySet(), "handshake" to emptySet<String>(),
    )

    @TestFactory
    fun websocket(): List<DynamicTest> {
        val doc = Json.parseToJsonElement(File(File(root, "websocket"), "sessions.json").readText()).jsonObject
        val ir = SchemaText.load(doc.str("schema")).ir
        val out = doc.req("cases").jsonArray.map { it.jsonObject }.map { c ->
            DynamicTest.dynamicTest("websocket/${c.str("name")}") { run(doc, ir, c) }
        }
        assertTrue(out.size > 10, "no websocket vectors were found under ${root.absolutePath}")
        return out
    }

    private fun run(doc: JsonObject, ir: RayfoldSchemaIR, c: JsonObject) {
        val name = c.str("name")
        val why = c["why"]?.jsonPrimitive?.content ?: name
        for (k in c.keys) assertTrue(k in caseKeys, "$name: no runner for case member \"$k\"")

        val rows = ConcurrentHashMap<String, JsonObject>()
        for (r in doc.req("data").jsonArray) rows[r.jsonObject.str("id")] = r.jsonObject
        val ran = ConcurrentHashMap<String, AtomicInteger>()
        fun count(op: String) = ran.getOrPut(op) { AtomicInteger() }.incrementAndGet()
        val clock = AtomicLong(doc.str("clock").toLong())
        val server = RayfoldServer(
            ir,
            Resolvers(
                queries = mapOf(
                    "book" to { args, _ -> count("book"); rows[args.str("id")] ?: JsonNull },
                    "pricey" to { args, _ -> count("pricey"); rows[args.str("id")] ?: JsonNull },
                ),
                commands = mapOf(
                    "restock" to command { args: JsonObject, _: RayfoldContext ->
                        count("restock")
                        val id = args.str("id")
                        val row = rows[id] ?: throw RayfoldException(Code.NOT_FOUND, "No such book")
                        val next = JsonObject(row + ("stock" to JsonPrimitive(row.str("stock").toInt() + args.str("qty").toInt())))
                        rows[id] = next
                        CommandResult(next)
                    },
                ),
            ),
            BatchOptions(budget = doc.str("budget").toInt()),
            now = { clock.get() },
        )
        val viewer = c["viewer"] ?: doc.req("viewer")
        val hook = c["hook"]?.jsonPrimitive?.content
        val listener = RayfoldWebSocket(server) {
            when (hook) {
                null -> viewer
                "unauthenticated" -> throw RayfoldException(Code.UNAUTHENTICATED, "Token expired")
                "throws" -> throw IllegalStateException("key server down")
                else -> error("$name: no runner for hook $hook")
            }
        }.start(0)
        val hashes = mapOf("\$server" to server.hash, "\$public" to server.publicHash)
        assertTrue(server.hash != server.publicHash, "the vector needs a schema whose public form hashes differently")
        try {
            val query = (c["connect"] as? JsonObject)?.let { connect ->
                for (k in connect.keys) assertEquals("schema", k, "$name: no runner for connect.$k")
                val named = connect.str("schema")
                "?schema=" + URLEncoder.encode(hashes[named] ?: named, Charsets.UTF_8)
            } ?: ""
            Socket("127.0.0.1", listener.port).use { socket ->
                socket.soTimeout = 5000
                val client = Client(socket)
                client.write(
                    ("GET /rayfold/ws$query HTTP/1.1\r\nHost: 127.0.0.1:${listener.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: rayfold.0.1\r\n\r\n").toByteArray(),
                )
                val steps = c.req("steps").jsonArray.map { it.jsonObject }
                val handshake = steps.firstOrNull { "handshake" in it }?.str("handshake")?.toInt() ?: 101
                assertEquals(handshake, client.status(), "$why: handshake")

                for (step in steps) {
                    val action = step.keys.first()
                    val modifiers = stepKeys[action] ?: error("$name: no runner for step $step")
                    for (m in step.keys.drop(1)) assertTrue(m in modifiers, "$name: no runner for \"$m\" on a $action step")
                    when (action) {
                        "handshake" -> Unit // checked above, before any other step
                        "send" -> client.text(step.req("send").toString().toByteArray(Charsets.UTF_8))
                        "sendHex" -> client.text(step.str("sendHex").chunked(2).map { it.toInt(16).toByte() }.toByteArray())
                        "clock" -> clock.set(step.str("clock").toLong())
                        "command" -> {
                            val op = step.req("command").jsonObject
                            val env = buildJsonObject {
                                put("ops", JsonArray(listOf(buildJsonObject {
                                    put("id", 1); put("op", op.str("op")); put("args", op.req("args")); put("key", "vector-${op.str("op")}-${System.nanoTime()}")
                                })))
                            }
                            val frames = runBlocking { server.collect(env, viewer) }
                            assertTrue(frames.none { "error" in it }, "$name: the command failed: $frames")
                        }
                        "expect" -> {
                            val want = step.req("expect").jsonArray.map { it.jsonObject }
                            val got = want.map { client.next(why) }
                            assertEquals(byOp(want).keys, byOp(got).keys, "$why: $got")
                            for ((id, frames) in byOp(want)) frames.forEachIndexed { i, f ->
                                val g = byOp(got).getValue(id)[i]
                                assertTrue(matches(f, g), "$why: op $id frame $i: wanted $f, got $g")
                            }
                        }
                        "close" -> {
                            val (code, reason) = client.close(why)
                            assertEquals(step.str("close").toInt(), code, "$why: close code")
                            step["reason"]?.let { val r = it.jsonPrimitive.content; assertEquals(hashes[r] ?: r, reason, "$why: close reason") }
                        }
                        "ran" -> for ((op, n) in step.req("ran").jsonObject) assertEquals(n.jsonPrimitive.content.toInt(), ran[op]?.get() ?: 0, "$why: $op ran")
                        else -> error("$name: no runner for step $step")
                    }
                }
            }
        } finally {
            listener.close()
        }
    }

    /** Exactly the expected members; `error` by code; "*" accepts anything present. */
    private fun matches(want: JsonObject, got: JsonObject): Boolean {
        if (want.keys != got.keys) return false
        return want.all { (k, v) ->
            when {
                v is JsonPrimitive && v.isString && v.content == "*" -> true
                k == "error" -> v.jsonObject.keys == setOf("code") && (got[k] as? JsonObject)?.get("code") == v.jsonObject["code"]
                else -> v == got[k]
            }
        }
    }

    private fun byOp(frames: List<JsonObject>): Map<String, List<JsonObject>> =
        frames.groupBy { (it["id"] as? JsonPrimitive)?.content ?: "batch" }

    private class Client(private val socket: Socket) {
        private val input = BufferedInputStream(socket.getInputStream())
        private val out = socket.getOutputStream()

        fun write(bytes: ByteArray) { out.write(bytes); out.flush() }

        fun status(): Int {
            val b = ByteArrayOutputStream()
            var tail = 0
            while (tail != 0x0d0a0d0a) {
                val c = input.read()
                if (c < 0) break
                b.write(c)
                tail = (tail shl 8) or c
            }
            return b.toString(Charsets.ISO_8859_1).substringAfter(' ').substringBefore(' ').toIntOrNull() ?: 0
        }

        /** A masked text frame, as RFC 6455 section 5.1 requires of clients. */
        fun text(payload: ByteArray) {
            val h = ByteArrayOutputStream()
            h.write(0x81)
            when {
                payload.size < 126 -> h.write(0x80 or payload.size)
                else -> { h.write(0x80 or 126); h.write(payload.size shr 8); h.write(payload.size and 0xff) }
            }
            val mask = byteArrayOf(0x11, 0x22, 0x33, 0x44)
            h.write(mask)
            write(h.toByteArray() + ByteArray(payload.size) { (payload[it].toInt() xor mask[it % 4].toInt()).toByte() })
        }

        private fun frame(): Pair<Int, ByteArray> {
            val b0 = input.read()
            val b1 = input.read()
            check(b0 >= 0 && b1 >= 0) { "the server closed the connection without a close frame" }
            var len = (b1 and 0x7f).toLong()
            if (len == 126L) len = input.readNBytes(2).fold(0L) { a, x -> (a shl 8) or (x.toLong() and 0xff) }
            else if (len == 127L) len = input.readNBytes(8).fold(0L) { a, x -> (a shl 8) or (x.toLong() and 0xff) }
            return (b0 and 0x0f) to input.readNBytes(len.toInt())
        }

        fun next(why: String): JsonObject {
            while (true) {
                val (op, payload) = frame()
                if (op == 0x8) error("$why: expected a frame, the server closed with ${close(payload)}")
                if (op == 0x1) return Json.parseToJsonElement(payload.toString(Charsets.UTF_8)).jsonObject
            }
        }

        fun close(why: String): Pair<Int, String> {
            while (true) {
                val (op, payload) = frame()
                if (op == 0x8) return close(payload)
                if (op == 0x1) error("$why: wanted a close, got ${payload.toString(Charsets.UTF_8)}")
            }
        }

        private fun close(payload: ByteArray): Pair<Int, String> =
            if (payload.size < 2) 1005 to "" else (((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff)) to payload.copyOfRange(2, payload.size).toString(Charsets.UTF_8)
    }

    private fun JsonObject.req(key: String): JsonElement = this[key] ?: error("vector is missing \"$key\"")
    private fun JsonObject.str(key: String): String = req(key).jsonPrimitive.content
}
