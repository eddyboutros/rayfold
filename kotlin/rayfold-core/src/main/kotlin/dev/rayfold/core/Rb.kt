package dev.rayfold.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.util.Base64
import kotlin.math.abs
import kotlin.math.floor

/** Bytes that are not valid RB. */
class RbException(message: String) : IllegalArgumentException(message)

/**
 * RB, Rayfold Binary (extension `rb`, spec/09): the JSON value model in fewer bytes. Byte for byte the same as
 * packages/rb/src/codec.ts: a schema-derived key dictionary, a per-message string table, zigzag varints, doubles only
 * for non-integers, and length-prefixed frames. Decoding bounds nesting (64 levels) and every length by the input left.
 */
class RbCodec(ir: RayfoldSchemaIR? = null) {
    /** The key dictionary: the protocol keys, then the schema's names, sorted. */
    val keys: List<String>
    private val ids: Map<String, Int>

    init {
        val list = ArrayList<String>()
        val map = HashMap<String, Int>()
        fun add(name: String) {
            if (name in map) return
            map[name] = list.size
            list.add(name)
        }
        FRAME_KEYS.forEach(::add)
        if (ir != null) {
            val names = HashSet<String>()
            for (t in ir.types.values) {
                for (f in t.fields) {
                    names.add(f.name)
                    f.args.forEach { names.add(it.name) }
                }
                if (t.kind == "enum") t.values.forEach { names.add(it.name) }
            }
            for (op in ir.ops.values) {
                names.add(op.name)
                op.args.forEach { names.add(it.name) }
            }
            names.sorted().forEach(::add)
        }
        keys = list
        ids = map
    }

    /** One value, without a length prefix. */
    fun encode(value: JsonElement): ByteArray = Writer().apply { value(value) }.bytes()

    fun decode(bytes: ByteArray): JsonElement {
        val r = Reader(bytes)
        val v = r.value(0)
        if (r.pos != bytes.size) throw RbException("RB: trailing bytes")
        return v
    }

    /** Length-prefixed frames, as they go over HTTP and WebSocket. */
    fun encodeFrames(frames: List<JsonElement>): ByteArray {
        val out = ByteArrayOutputStream()
        for (f in frames) {
            val b = encode(f)
            writeVarint(out, b.size.toLong())
            out.write(b)
        }
        return out.toByteArray()
    }

    fun decodeFrames(bytes: ByteArray): List<JsonElement> {
        val d = decoder()
        val out = d.feed(bytes)
        if (d.pendingBytes > 0) throw RbException("RB: truncated frame")
        return out
    }

    /** Incremental decoder for chunked transports: [feed] returns the frames the bytes so far complete. */
    fun decoder(): Decoder = Decoder()

    inner class Decoder internal constructor() {
        private var buf = ByteArray(0)
        val pendingBytes: Int get() = buf.size

        fun feed(chunk: ByteArray): List<JsonElement> {
            buf = buf + chunk
            val out = ArrayList<JsonElement>()
            while (true) {
                val (len, off) = frameHead(buf) ?: break
                if (buf.size - off < len) break
                // a zero-length frame is a keep-alive (spec 04 section 4)
                if (len > 0) out.add(decode(buf.copyOfRange(off, off + len.toInt())))
                buf = buf.copyOfRange(off + len.toInt(), buf.size)
            }
            return out
        }
    }

    private inner class Writer {
        private val out = ByteArrayOutputStream(1024)
        private val strings = HashMap<String, Int>()

        fun bytes(): ByteArray = out.toByteArray()

        fun value(v: JsonElement) {
            when (v) {
                is JsonNull -> out.write(T_NULL)
                is JsonObject -> {
                    out.write(T_OBJ)
                    writeVarint(out, v.size.toLong())
                    for ((k, x) in v) {
                        key(k)
                        value(x)
                    }
                }
                is JsonArray -> {
                    out.write(T_ARR)
                    writeVarint(out, v.size.toLong())
                    v.forEach(::value)
                }
                is JsonPrimitive -> when {
                    v.isString -> string(v.content)
                    v.content == "true" -> out.write(T_TRUE)
                    v.content == "false" -> out.write(T_FALSE)
                    else -> number(v.content.toDouble())
                }
            }
        }

        private fun number(d: Double) {
            if (d.isFinite() && d == floor(d) && abs(d) <= MAX_SAFE) {
                val l = d.toLong()
                if (l in 0..127) out.write(T_SMALL or l.toInt())
                else {
                    out.write(T_INT)
                    writeVarint(out, if (l >= 0) l * 2 else -l * 2 - 1)
                }
                return
            }
            out.write(T_F64)
            out.write(ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putDouble(d).array())
        }

        private fun string(s: String) {
            strings[s]?.let {
                out.write(T_STR_REF)
                writeVarint(out, it.toLong())
                return
            }
            val b = utf8(s)
            out.write(T_STR)
            writeVarint(out, b.size.toLong())
            out.write(b)
            strings[s] = strings.size
        }

        private fun key(k: String) {
            val id = ids[k]
            if (id != null) writeVarint(out, id * 2L)
            else {
                val b = utf8(k)
                writeVarint(out, b.size * 2L + 1)
                out.write(b)
            }
        }
    }

    // Lengths and varints are doubles, as in the TypeScript codec, so hostile values fail the same bounds checks.
    private inner class Reader(private val buf: ByteArray) {
        var pos = 0
        private val strings = ArrayList<String>()

        private fun byte(): Int {
            if (pos >= buf.size) throw RbException("RB: unexpected end of input")
            return buf[pos++].toInt() and 0xff
        }

        private fun varint(): Double {
            var n = 0.0
            var mul = 1.0
            while (true) {
                val b = byte()
                n += (b and 0x7f) * mul
                if (b < 0x80) return n
                mul *= 0x80
                if (mul > VARINT_LIMIT) throw RbException("RB: varint too long")
            }
        }

        /** A varint that [varint] already accepted (at most 63 bits), read exactly. */
        private fun longVarint(): Long {
            var n = 0L
            var shift = 0
            while (true) {
                val b = byte()
                n = n or ((b and 0x7f).toLong() shl shift)
                if (b < 0x80) return n
                shift += 7
            }
        }

        private fun raw(n: Double): ByteArray {
            if (pos + n > buf.size) throw RbException("RB: unexpected end of input")
            val out = buf.copyOfRange(pos, pos + n.toInt())
            pos += n.toInt()
            return out
        }

        private fun key(): String {
            val k = varint()
            if (k % 2 == 0.0) return keys.getOrNull((k / 2).takeIf { it < keys.size }?.toInt() ?: -1) ?: throw RbException("RB: unknown key id ${jsNumber(k / 2)}")
            return String(raw((k - 1) / 2), Charsets.UTF_8)
        }

        /** Element count of a list or object, checked against the nesting limit and the bytes that are left. */
        private fun count(depth: Int, minBytesEach: Int): Int {
            if (depth >= MAX_NESTING) throw RbException("RB: nested deeper than $MAX_NESTING levels")
            val n = varint()
            if (n * minBytesEach > buf.size - pos) throw RbException("RB: length exceeds the input")
            return n.toInt()
        }

        fun value(depth: Int): JsonElement {
            val t = byte()
            if (t >= T_SMALL) return JsonPrimitive(t and 0x7f)
            return when (t) {
                T_NULL -> JsonNull
                T_FALSE -> JsonPrimitive(false)
                T_TRUE -> JsonPrimitive(true)
                T_INT -> {
                    val start = pos
                    val zz = varint()
                    if (zz <= MAX_SAFE) {
                        number(if (zz % 2 == 0.0) zz / 2 else -(zz + 1) / 2)
                    } else {
                        // past 2^53 the double lost the low bit that carries the sign: read the value again exactly
                        pos = start
                        val big = longVarint()
                        number((if (big and 1L == 0L) big ushr 1 else -(big ushr 1) - 1).toDouble())
                    }
                }
                T_F64 -> {
                    if (pos + 8 > buf.size) throw RbException("RB: unexpected end of input")
                    val d = ByteBuffer.wrap(buf, pos, 8).order(ByteOrder.LITTLE_ENDIAN).double
                    pos += 8
                    number(d)
                }
                T_STR -> String(raw(varint()), Charsets.UTF_8).also { strings.add(it) }.let { JsonPrimitive(it) }
                T_STR_REF -> {
                    val i = varint()
                    JsonPrimitive(strings.getOrNull(if (i < strings.size) i.toInt() else -1) ?: throw RbException("RB: bad string reference"))
                }
                T_ARR -> {
                    val n = count(depth, 1)
                    JsonArray(List(n) { value(depth + 1) })
                }
                T_OBJ -> {
                    val n = count(depth, 2)
                    val out = LinkedHashMap<String, JsonElement>()
                    repeat(n) {
                        val k = key()
                        out[k] = value(depth + 1)
                    }
                    JsonObject(out)
                }
                // the Bytes scalar travels as base64url in JSON (spec 01)
                T_BYTES -> JsonPrimitive(Base64.getUrlEncoder().withoutPadding().encodeToString(raw(varint())))
                else -> throw RbException("RB: unknown tag 0x${t.toString(16)}")
            }
        }

        /** A number as JSON would carry it: a whole number within 2^53 exactly, anything else as JavaScript prints it. */
        private fun number(d: Double): JsonElement = if (d == floor(d) && abs(d) <= MAX_SAFE) JsonPrimitive(d.toLong()) else jsNumberElement(d)
    }

    companion object {
        const val CONTENT_TYPE = "application/rayfold"

        /** Keys every implementation knows, independent of the schema, in this order (spec 09 section 3). */
        val FRAME_KEYS = listOf(
            "id", "op", "args", "shape", "vars", "key", "live", "deadline", "simulate", "ops", "meta", "rayfold",
            "data", "ok", "item", "patch", "at", "error", "fin", "errors", "code", "type", "message", "path", "retryable",
            "set", "value", "del", "inv", "invOp", "cost", "cache", "\$type", "\$ref", "client", "replay", "cursor", "ms",
            "list", "ins",
        )

        private const val T_NULL = 0x00
        private const val T_FALSE = 0x01
        private const val T_TRUE = 0x02
        private const val T_INT = 0x03
        private const val T_F64 = 0x04
        private const val T_STR = 0x05
        private const val T_STR_REF = 0x06
        private const val T_ARR = 0x07
        private const val T_OBJ = 0x08
        private const val T_BYTES = 0x09
        private const val T_SMALL = 0x80
        private const val MAX_NESTING = 64
        private const val MAX_SAFE = 9007199254740991.0
        private const val VARINT_LIMIT = 72057594037927936.0 // 2^56

        private fun writeVarint(out: ByteArrayOutputStream, n: Long) {
            var x = n
            while (x >= 0x80) {
                out.write((x and 0x7f).toInt() or 0x80)
                x = x ushr 7
            }
            out.write(x.toInt())
        }

        /** A frame's length prefix: (length, offset after it), or null while its bytes are incomplete. */
        private fun frameHead(buf: ByteArray): Pair<Long, Int>? {
            var n = 0.0
            var mul = 1.0
            for (i in buf.indices) {
                val b = buf[i].toInt() and 0xff
                n += (b and 0x7f) * mul
                if (b < 0x80) return n.toLong() to i + 1
                mul *= 0x80
            }
            return null
        }

        /** UTF-8 as TextEncoder writes it: a lone surrogate becomes U+FFFD, where String.toByteArray would write '?'. */
        private fun utf8(s: String): ByteArray {
            val enc = Charsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPLACE)
                .onUnmappableCharacter(CodingErrorAction.REPLACE)
                .replaceWith(byteArrayOf(0xEF.toByte(), 0xBF.toByte(), 0xBD.toByte()))
            val bb = enc.encode(CharBuffer.wrap(s))
            return ByteArray(bb.remaining()).also { bb.get(it) }
        }
    }
}
