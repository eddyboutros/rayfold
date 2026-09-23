package dev.rayfold.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.MessageDigest

/** Shape text parser, canonical form and ids (spec/02). Mirrors packages/schema/src/shape.ts. */
object Shapes {
    private sealed class Tok {
        data class Name(val v: String) : Tok()
        data class Str(val v: String) : Tok()
        data class Num(val v: String) : Tok()
        data class Punct(val v: String) : Tok()
        object Eof : Tok()
    }

    private fun tokenize(src: String): List<Tok> {
        val out = mutableListOf<Tok>()
        var i = 0
        while (i < src.length) {
            val c = src[i]
            when {
                c.isWhitespace() || c == ',' -> i++
                // comments, as the TypeScript lexer reads them: a shape file may carry them, and both runtimes must
                // read it to the same shape and so the same id
                src.startsWith("//", i) -> while (i < src.length && src[i] != '\n') i++
                src.startsWith("/*", i) -> {
                    val end = src.indexOf("*/", i + 2)
                    if (end < 0) throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: unterminated block comment")
                    i = end + 2
                }
                c == '"' -> {
                    val sb = StringBuilder(); i++
                    while (i < src.length && src[i] != '"') {
                        if (src[i] == '\\' && i + 1 < src.length) {
                            i++
                            // JSON escapes, read as the TS lexer reads them; anything else is an error, not a silently different string
                            when (val e = src[i]) {
                                'n' -> sb.append('\n'); 't' -> sb.append('\t'); 'r' -> sb.append('\r'); 'b' -> sb.append('\b'); 'f' -> sb.append('\u000c')
                                '"', '\\', '/' -> sb.append(e)
                                'u' -> {
                                    val hex = src.substring(i + 1, minOf(i + 5, src.length))
                                    if (hex.length != 4 || !hex.all { it in "0123456789abcdefABCDEF" }) throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: bad unicode escape")
                                    sb.append(hex.toInt(16).toChar()); i += 4
                                }
                                else -> throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: bad escape \\$e")
                            }
                        } else sb.append(src[i])
                        i++
                    }
                    if (i >= src.length) throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: unterminated string")
                    i++; out.add(Tok.Str(sb.toString()))
                }
                c.isDigit() || (c == '-' && i + 1 < src.length && src[i + 1].isDigit()) -> {
                    // the TypeScript lexer's grammar: digits, a fraction only when digits follow the point, an exponent
                    // only when digits follow the e; then a duration suffix on a whole number counts in milliseconds
                    val s = i; i++
                    fun digitAt(k: Int) = k < src.length && src[k] in '0'..'9'
                    while (digitAt(i)) i++
                    var fractional = false
                    if (i < src.length && src[i] == '.' && digitAt(i + 1)) { fractional = true; i++; while (digitAt(i)) i++ }
                    if (i < src.length && (src[i] == 'e' || src[i] == 'E')) {
                        var k = i + 1
                        if (k < src.length && (src[k] == '+' || src[k] == '-')) k++
                        if (digitAt(k)) { fractional = true; i = k; while (digitAt(i)) i++ }
                    }
                    val text = src.substring(s, i)
                    val unit = Regex("^(ms|s|m|h|d)(?![A-Za-z0-9_])").find(src.substring(i, minOf(i + 3, src.length)))?.value
                    if (unit != null && !fractional) {
                        i += unit.length
                        out.add(Tok.Num(jsNumber(text.toDouble() * DURATION_MS.getValue(unit))))
                    } else out.add(Tok.Num(text))
                }
                c.isLetter() || c == '_' -> {
                    val s = i; i++
                    while (i < src.length && (src[i].isLetterOrDigit() || src[i] == '_')) i++
                    out.add(Tok.Name(src.substring(s, i)))
                }
                src.startsWith("...", i) -> { out.add(Tok.Punct("...")); i += 3 }
                c in "{}()[]:@$." -> { out.add(Tok.Punct(c.toString())); i++ }
                else -> throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: unexpected '$c'")
            }
        }
        out.add(Tok.Eof)
        return out
    }

    private class P(val toks: List<Tok>) {
        var pos = 0
        private var depth = 0

        /** Every `{` and `[` is one level; the limit is checked before recursing, so deep text cannot overflow the stack. */
        private fun nest() {
            if (++depth > StrictJson.MAX_DEPTH) throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: nested deeper than ${StrictJson.MAX_DEPTH} levels")
        }
        fun peek(n: Int = 0): Tok = toks[minOf(pos + n, toks.size - 1)]
        fun next(): Tok = peek().also { if (it !is Tok.Eof) pos++ }
        fun atPunct(v: String) = (peek() as? Tok.Punct)?.v == v
        fun expectPunct(v: String) { if (!atPunct(v)) throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: expected '$v'"); next() }
        fun expectName(): String = (next() as? Tok.Name)?.v ?: throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: expected a name")

        fun shape(): Shape {
            expectPunct("{")
            nest()
            val items = mutableListOf<ShapeItem>()
            while (!atPunct("}")) {
                if (peek() is Tok.Eof) throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: unterminated shape")
                items.add(item())
            }
            expectPunct("}")
            depth--
            return Shape(items)
        }

        fun item(): ShapeItem {
            if (atPunct("...")) {
                next()
                if ((peek() as? Tok.Name)?.v == "on") { next(); val t = expectName(); return ShapeItem(kind = "on", type = t, shape = shape()) }
                val t = expectName(); expectPunct("."); val v = expectName()
                return ShapeItem(kind = "spread", type = t, view = v)
            }
            if (atPunct("@")) {
                next()
                val d = expectName()
                if (d != "defer") throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: unknown directive @$d")
                var label: String? = null
                if (atPunct("(")) {
                    next()
                    // strictly, because a shape's identity is the hash of its canonical text: reading the key and
                    // discarding it, or letting a non-string label become null, accepts shapes another implementation
                    // refuses and gives one of them a different id for the same text
                    val k = expectName()
                    if (k != "label") throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: @defer accepts only label:")
                    expectPunct(":")
                    label = (next() as? Tok.Str)?.v ?: throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: @defer label must be a string")
                    expectPunct(")")
                }
                return ShapeItem(kind = "defer", label = label, shape = shape())
            }
            val first = expectName()
            var alias: String? = null
            var name = first
            if (atPunct(":")) { next(); alias = first; name = expectName() }
            var args: Map<String, JsonElement>? = null
            if (atPunct("(")) {
                next()
                val m = linkedMapOf<String, JsonElement>()
                while (!atPunct(")")) { val k = expectName(); expectPunct(":"); m[k] = value() }
                expectPunct(")")
                // `field()` selects exactly what `field` selects, and the canonical form prints it without the
                // parentheses, so an empty map here would make the parsed shape disagree with a re-parse of its own
                // printed text.
                if (m.isNotEmpty()) args = m
            }
            val sub = if (atPunct("{")) shape() else null
            var eager = false; var partial = false
            while (atPunct("@") && peek(1) is Tok.Name) {
                when ((peek(1) as Tok.Name).v) {
                    "eager" -> eager = true
                    "partial" -> partial = true
                    "defer" -> break
                    else -> throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: unknown modifier")
                }
                next(); next()
            }
            return ShapeItem(kind = "field", name = name, alias = alias, args = args, shape = sub, eager = eager, partial = partial)
        }

        fun value(): JsonElement {
            if (atPunct("$")) { next(); return JsonObject(mapOf("\$var" to JsonPrimitive(expectName()))) }
            if (atPunct("[")) { next(); nest(); val l = mutableListOf<JsonElement>(); while (!atPunct("]")) l.add(value()); next(); depth--; return JsonArray(l) }
            if (atPunct("{")) { next(); nest(); val m = linkedMapOf<String, JsonElement>(); while (!atPunct("}")) { val k = expectName(); expectPunct(":"); m[k] = value() }; next(); depth--; return JsonObject(m) }
            return when (val t = next()) {
                is Tok.Str -> JsonPrimitive(t.v)
                is Tok.Num -> Shapes.number(t.v)
                is Tok.Name -> when (t.v) { "true" -> JsonPrimitive(true); "false" -> JsonPrimitive(false); "null" -> JsonNull; else -> JsonPrimitive(t.v) }
                else -> throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: expected a value")
            }
        }
    }

    fun parse(text: String): Shape {
        val p = P(tokenize(text))
        val s = p.shape()
        if (p.peek() !is Tok.Eof) throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: trailing input")
        return s
    }

    private const val MAX_SAFE_INTEGER = 9007199254740991.0
    private val DURATION_MS = mapOf("ms" to 1.0, "s" to 1_000.0, "m" to 60_000.0, "h" to 3_600_000.0, "d" to 86_400_000.0)

    /** Literals are JSON numbers: an integral value has no fraction (1.0 and 1e3 are 1 and 1000), as in the TS runtime, so shape ids agree. */
    private fun number(text: String): JsonPrimitive {
        // 1e999 reads as Infinity, which JSON cannot carry: refused, as the TypeScript lexer refuses it
        val d = text.toDoubleOrNull()?.takeIf { it.isFinite() } ?: throw RayfoldException(Code.INVALID_ARGUMENT, "Bad shape: bad number $text")
        return if (d == Math.floor(d) && Math.abs(d) <= MAX_SAFE_INTEGER) JsonPrimitive(d.toLong()) else JsonPrimitive(d)
    }

    fun isShapeId(s: String) = Regex("^sha256:[0-9a-f]{64}$").matches(s)

    /**
     * One level of a shape as a cache sees it (spec 07 section 3), mirroring `shapeLevel` in shape.ts: the selection
     * under each output name, and which output names belong to the selection rather than to the entity. An alias, or a
     * field asked for with arguments, does: its value is what this selection asked for, so it is neither written to
     * the shared entity nor carried in a `set` patch under that name. Without a shape, nothing does.
     */
    data class Level(val bySelection: Set<String>, val child: Map<String, Shape?>)

    fun level(shape: Shape?, views: (String, String) -> Shape? = { _, _ -> null }): Level {
        val bySelection = mutableSetOf<String>()
        val child = mutableMapOf<String, Shape?>()
        fun visit(items: List<ShapeItem>, seen: Set<String>) {
            for (it in items) when (it.kind) {
                "field" -> {
                    val out = it.alias ?: it.name ?: continue
                    if ((it.alias != null && it.alias != it.name) || !it.args.isNullOrEmpty()) bySelection.add(out)
                    child[out] = it.shape
                }
                "on", "defer" -> it.shape?.let { s -> visit(s.items, seen) }
                else -> {
                    val key = "${it.type}.${it.view}"
                    if (key !in seen) views(it.type ?: "", it.view ?: "")?.let { v -> visit(v.items, seen + key) }
                }
            }
        }
        if (shape != null) visit(shape.items, emptySet())
        return Level(bySelection, child)
    }

    /** Canonical text: views expanded, sorted items, canonical args (spec/02 section 3). */
    fun canonical(shape: Shape, ir: RayfoldSchemaIR): String = canon(expand(shape, ir, emptySet()))

    fun idOf(canonical: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
        return "sha256:" + d.joinToString("") { "%02x".format(it) }
    }

    private fun expand(s: Shape, ir: RayfoldSchemaIR, seen: Set<String>): Shape = Shape(s.items.flatMap { it ->
        when (it.kind) {
            "spread" -> {
                val key = "${it.type}.${it.view}"
                if (key in seen) throw RayfoldException(Code.INVALID_ARGUMENT, "View spread cycle at $key")
                val v = ir.views[key] ?: throw RayfoldException(Code.INVALID_ARGUMENT, "Unknown view $key")
                expand(v.shape, ir, seen + key).items
            }
            "on" -> listOf(it.copy(shape = expand(it.subShape, ir, seen)))
            "defer" -> listOf(it.copy(shape = expand(it.subShape, ir, seen)))
            else -> listOf(if (it.shape != null) it.copy(shape = expand(it.shape, ir, seen)) else it)
        }
    })

    private fun canon(s: Shape): String {
        val parts = s.items.map { sortKey(it) to canonItem(it) }.sortedBy { it.first }
        return "{ " + parts.joinToString(" ") { it.second } + " }"
    }

    private fun sortKey(i: ShapeItem): String = when (i.kind) {
        "field" -> "0:${i.alias ?: i.name}:${i.args?.let { argsText(it) } ?: ""}"
        "on" -> "1:${i.type}"
        "defer" -> "2:${i.label ?: ""}"
        else -> "3:${i.type}.${i.view}"
    }

    private fun canonItem(i: ShapeItem): String = when (i.kind) {
        "field" -> buildString {
            append(if (i.alias != null) "${i.alias}: ${i.name}" else i.name)
            if (!i.args.isNullOrEmpty()) append("(${argsText(i.args)})")
            if (i.shape != null) append(" ${canon(i.shape)}")
            if (i.eager) append(" @eager")
            if (i.partial) append(" @partial")
        }
        "on" -> "...on ${i.type} ${canon(i.subShape)}"
        "defer" -> "@defer" + (if (i.label != null) "(label: ${Json.quote(i.label)})" else "") + " ${canon(i.subShape)}"
        else -> "...${i.type}.${i.view}"
    }

    private fun argsText(args: Map<String, JsonElement>): String = args.keys.sorted().joinToString(" ") { "$it: ${valueText(args.getValue(it))}" }

    private fun valueText(v: JsonElement): String = when (v) {
        is JsonNull -> "null"
        // numbers in the ECMAScript form the TypeScript runtime prints (0.0001, 1e+21, not 1.0E-4 or 1.0E21): the
        // canonical text is what the shape id hashes, so the two runtimes must print it byte for byte alike
        is JsonPrimitive -> if (v.isString) Json.quote(v.content) else v.content.toDoubleOrNull()?.let { jsNumber(it) } ?: v.content
        is JsonArray -> "[" + v.joinToString(",") { valueText(it) } + "]"
        is JsonObject -> {
            val varName = (v["\$var"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (varName != null && v.size == 1) "\$$varName"
            else "{" + v.keys.sorted().joinToString(",") { "${Json.quote(it)}:${valueText(v.getValue(it))}" } + "}"
        }
    }

    object Json {
        fun quote(s: String): String = buildString {
            append('"')
            var i = 0
            while (i < s.length) {
                val c = s[i]
                when {
                    c == '"' -> append("\\\"")
                    c == '\\' -> append("\\\\")
                    c == '\n' -> append("\\n")
                    c == '\r' -> append("\\r")
                    c == '\t' -> append("\\t")
                    c == '\b' -> append("\\b")
                    c == '\u000c' -> append("\\f") // JSON.stringify's short forms
                    c < ' ' -> append(String.format("\\u%04x", c.code))
                    // A surrogate that is not half of a pair has no UTF-8 encoding, so writing it through would
                    // contradict the encoding canonical JSON is defined in (spec 01 section 9): the JVM puts a '?'
                    // in its place on the way to bytes, and the hash stops being a function of the value.
                    c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate() -> { append(c); append(s[++i]) }
                    c.isHighSurrogate() || c.isLowSurrogate() -> append(String.format("\\u%04x", c.code))
                    else -> append(c)
                }
                i++
            }
            append('"')
        }
    }
}
