package dev.rayfold.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * RB against the TypeScript codec: `scripts/kotlin-oracle.ts` writes `oracle/rb-cases.json` with the bytes
 * `@rayfold/rb` makes from a set of values, and what it makes of hostile and fuzzed byte strings (a seeded corpus of
 * 400 mutations of valid encodings). The Kotlin codec must produce the same bytes, the same values and the same
 * refusals. The HTTP transport's use of the codec is tested in HttpTest.
 */
class RbTest {
    private val oracle = Json.parseToJsonElement(Oracle.text("rb-cases.json")).jsonObject
    private val codec = RbCodec(Oracle.ir("bookstore.ir.json"))

    private fun cases(name: String) = (oracle[name] ?: error("oracle has no $name")).jsonArray.map { it.jsonObject }
    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.content ?: error("case has no $k: $this")
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun bytes(hex: String) = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun `the key dictionary is the one TypeScript derives from the same schema`() {
        assertEquals((oracle["keys"] ?: error("no keys")).jsonArray.map { (it as JsonPrimitive).content }, codec.keys)
        assertEquals(RbCodec.FRAME_KEYS, RbCodec().keys, "guard: without a schema only the protocol keys are known")
    }

    @Test
    fun `NaN and the infinities encode as null, as the TypeScript codec does, and a finite double stays one (guard)`() {
        for (d in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertEquals("00", hex(codec.encode(JsonPrimitive(d))), "$d")
        }
        val row = JsonObject(mapOf("score" to JsonPrimitive(Double.NaN), "ratio" to JsonPrimitive(2.5)))
        assertEquals(Json.parseToJsonElement("""{"score":null,"ratio":2.5}"""), codec.decode(codec.encode(row)))
        assertEquals("040000000000000440", hex(codec.encode(JsonPrimitive(2.5))))
    }

    @Test
    fun `every value encodes to the TypeScript bytes and decodes to what TypeScript decodes`() {
        val values = cases("values")
        assertTrue(values.size >= 12)
        for (c in values) {
            val name = c.str("name")
            assertEquals(c.str("hex"), hex(codec.encode(Json.parseToJsonElement(c.str("json")))), name)
            assertEquals(Json.parseToJsonElement(c.str("decoded")), codec.decode(bytes(c.str("hex"))), name)
        }
    }

    @Test
    fun `hostile and fuzzed bytes are refused with the TypeScript message, and the rest decode to the same values`() {
        val decode = cases("decode")
        var refused = 0
        for (c in decode) {
            val name = c.str("name")
            val input = bytes(c.str("hex"))
            val error = (c["error"] as? JsonPrimitive)?.content
            if (error != null) {
                refused++
                assertEquals(error, assertFailsWith<RbException>(name) { codec.decode(input) }.message, name)
            } else {
                assertEquals(Json.parseToJsonElement(c.str("json")), codec.decode(input), name)
            }
        }
        assertTrue(refused in 1 until decode.size, "guard: the corpus holds both refusals ($refused) and values")
    }

    @Test
    fun `frames decode whole or fed a byte at a time, skip keep-alives, and a truncated frame is refused`() {
        for (c in cases("frames")) {
            val name = c.str("name")
            val input = bytes(c.str("hex"))
            val error = (c["error"] as? JsonPrimitive)?.content
            if (error != null) {
                assertEquals(error, assertFailsWith<RbException>(name) { codec.decodeFrames(input) }.message, name)
                continue
            }
            val want = Json.parseToJsonElement(c.str("json")).jsonArray
            assertEquals(want, JsonArray(codec.decodeFrames(input)), name)
            val d = codec.decoder()
            val fed = input.flatMap { d.feed(byteArrayOf(it)) }
            assertEquals(want, JsonArray(fed), "$name, fed a byte at a time")
            assertEquals(0, d.pendingBytes)
        }
    }

    @Test
    fun `encodeFrames round-trips what the HTTP transport sends`() {
        val frames: List<JsonElement> = listOf(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1"},"meta":{"cost":1}}"""), obj("""{"id":1,"fin":true}"""))
        assertEquals(frames, codec.decodeFrames(codec.encodeFrames(frames)))
        assertEquals(emptyList(), codec.decodeFrames(byteArrayOf(0)), "a lone keep-alive holds no frame")
    }
}
