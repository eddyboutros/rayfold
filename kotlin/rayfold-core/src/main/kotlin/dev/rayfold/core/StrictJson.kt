package dev.rayfold.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Request JSON at the system boundary, read strictly (RFC 8259). kotlinx's parser accepts NaN, 1d, 01 and bare
 * words, keeps the last of two duplicate keys and recurses without a depth limit, so request bodies go through
 * [parse] and envelopes that arrive already built go through [check].
 */
object StrictJson {
    const val MAX_DEPTH = 64
    private val NUMBER = Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")
    private val INTEGER = Regex("-?(0|[1-9][0-9]*)")

    fun isNumber(text: String): Boolean = NUMBER.matches(text)

    /** The text of a JSON number written as an integer (no fraction, no exponent), else null. */
    fun integerOrNull(v: JsonElement?): String? =
        (v as? JsonPrimitive)?.takeIf { !it.isString && it !is JsonNull && INTEGER.matches(it.content) }?.content

    fun tooDeep(where: String) = RayfoldException(Code.INVALID_ARGUMENT, "$where: nested deeper than $MAX_DEPTH levels")

    /** Parses [text], or fails with invalid_argument: [invalid] for bad syntax, `<where>: nested deeper than 64 levels`. */
    fun parse(text: String, where: String, invalid: String): JsonElement {
        val p = Parser(text, where, invalid)
        val v = p.value(0)
        p.ws()
        if (p.i != text.length) p.fail()
        return v
    }

    /** Depth limit and literal check for an already-built tree; iterative, since such a tree can be arbitrarily deep. */
    fun check(root: JsonElement, where: String) {
        val stack = ArrayDeque<Pair<JsonElement, Int>>()
        stack.addLast(root to 0)
        while (stack.isNotEmpty()) {
            val (v, d) = stack.removeLast()
            when (v) {
                is JsonObject -> { if (d + 1 > MAX_DEPTH) throw tooDeep(where); for (x in v.values) stack.addLast(x to d + 1) }
                is JsonArray -> { if (d + 1 > MAX_DEPTH) throw tooDeep(where); for (x in v) stack.addLast(x to d + 1) }
                is JsonNull -> {}
                is JsonPrimitive -> if (!v.isString && v.content != "true" && v.content != "false" && !isNumber(v.content))
                    throw RayfoldException(Code.INVALID_ARGUMENT, "$where: ${v.content} is not valid JSON")
            }
        }
    }

    private class Parser(val s: String, val where: String, val invalid: String) {
        var i = 0

        fun fail(): Nothing = throw RayfoldException(Code.INVALID_ARGUMENT, invalid)

        fun ws() { while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++ }

        fun value(depth: Int): JsonElement {
            ws()
            if (i >= s.length) fail()
            return when (s[i]) {
                '{' -> obj(depth + 1)
                '[' -> arr(depth + 1)
                '"' -> JsonPrimitive(str())
                't' -> word("true", JsonPrimitive(true))
                'f' -> word("false", JsonPrimitive(false))
                'n' -> word("null", JsonNull)
                else -> num()
            }
        }

        private fun word(w: String, v: JsonElement): JsonElement {
            if (!s.startsWith(w, i)) fail()
            i += w.length
            return v
        }

        private fun num(): JsonElement {
            val start = i
            while (i < s.length && (s[i] in '0'..'9' || s[i] == '-' || s[i] == '+' || s[i] == '.' || s[i] == 'e' || s[i] == 'E')) i++
            val text = s.substring(start, i)
            if (!isNumber(text)) fail()
            return Json.parseToJsonElement(text) // a validated literal; kotlinx keeps its text, so 1.0 stays 1.0
        }

        private fun obj(depth: Int): JsonObject {
            if (depth > MAX_DEPTH) throw tooDeep(where)
            i++
            val m = LinkedHashMap<String, JsonElement>()
            ws()
            if (i < s.length && s[i] == '}') { i++; return JsonObject(m) }
            while (true) {
                ws()
                if (i >= s.length || s[i] != '"') fail()
                val k = str()
                ws()
                if (i >= s.length || s[i] != ':') fail()
                i++
                val v = value(depth)
                if (m.put(k, v) != null) throw RayfoldException(Code.INVALID_ARGUMENT, "$invalid: duplicate key ${Shapes.Json.quote(k)}")
                ws()
                if (i >= s.length) fail()
                when (s[i]) {
                    ',' -> i++
                    '}' -> { i++; return JsonObject(m) }
                    else -> fail()
                }
            }
        }

        private fun arr(depth: Int): JsonArray {
            if (depth > MAX_DEPTH) throw tooDeep(where)
            i++
            val l = ArrayList<JsonElement>()
            ws()
            if (i < s.length && s[i] == ']') { i++; return JsonArray(l) }
            while (true) {
                l.add(value(depth))
                ws()
                if (i >= s.length) fail()
                when (s[i]) {
                    ',' -> i++
                    ']' -> { i++; return JsonArray(l) }
                    else -> fail()
                }
            }
        }

        private fun str(): String {
            i++ // the opening quote
            val sb = StringBuilder()
            while (true) {
                if (i >= s.length) fail()
                val c = s[i++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        if (i >= s.length) fail()
                        when (val e = s[i++]) {
                            '"', '\\', '/' -> sb.append(e)
                            'b' -> sb.append('\b')
                            'f' -> sb.append(12.toChar())
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) fail()
                                val hex = s.substring(i, i + 4)
                                if (!hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) fail()
                                sb.append(hex.toInt(16).toChar())
                                i += 4
                            }
                            else -> fail()
                        }
                    }
                    c < ' ' -> fail()
                    else -> sb.append(c)
                }
            }
        }
    }
}
