package dev.rayfold.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.security.MessageDigest

/** A syntax error in `.rayfold` text. The message ends with "(line:col)", as in `@rayfold/schema`. */
class RayfoldSyntaxException(message: String, val line: Int, val col: Int) : RuntimeException("$message ($line:$col)")

/** A validation finding (spec 01 section 8). [at] is a schema coordinate: Type, Type.field, op(), Type.view. */
data class Diagnostic(val severity: String, val code: String, val message: String, val at: String)

class RayfoldSchemaException(val diagnostics: List<Diagnostic>) : RuntimeException(
    "Invalid schema:\n" + diagnostics.filter { it.severity == "error" }.joinToString("\n") { "  ${it.at}: ${it.message} [${it.code}]" },
)

/** A parsed, valid schema: the IR, its hash (spec 01 section 9) and the warnings validation found. */
data class LoadedSchema(val ir: RayfoldSchemaIR, val hash: String, val warnings: List<Diagnostic>)

/**
 * Reads `.rayfold` schema text (spec 01) into the IR, so a Kotlin or Java service needs no Node.js step. It produces
 * the same IR, diagnostics, error messages and hash as `@rayfold/schema` (SchemaTextTest compares the two on every
 * case the TypeScript oracle records). Mirrors packages/schema/src/{lexer,parser,expr,shape,validate,load}.ts.
 */
object SchemaText {
    /** Parse, validate and hash. Throws [RayfoldSyntaxException] or [RayfoldSchemaException]. */
    fun load(text: String): LoadedSchema {
        val ir = parse(text)
        val diagnostics = validate(ir)
        if (diagnostics.any { it.severity == "error" }) throw RayfoldSchemaException(diagnostics)
        return LoadedSchema(ir, hash(ir), diagnostics)
    }

    /** The IR of [text], unvalidated. Throws [RayfoldSyntaxException]. */
    fun parse(text: String): RayfoldSchemaIR = SchemaParser(TokenStream(Lexer.tokenize(text))).document()

    fun validate(ir: RayfoldSchemaIR): List<Diagnostic> = SchemaValidator.validate(ir)

    /** sha256 hex of the canonical IR: the same value `@rayfold/schema` computes for the same schema. */
    fun hash(ir: RayfoldSchemaIR): String =
        MessageDigest.getInstance("SHA-256").digest(Canonical.json(IrJson.of(ir)).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}

// ------------------------------------------------------------------ JavaScript-compatible text

/** JSON.stringify of a string: the short escapes, \u00XX for other control characters and for lone surrogates. */
internal fun jsJson(s: String): String = buildString {
    append('"')
    var i = 0
    while (i < s.length) {
        val c = s[i]
        when {
            c == '"' -> append("\\\"")
            c == '\\' -> append("\\\\")
            c == '\b' -> append("\\b")
            c == '\u000C' -> append("\\f")
            c == '\n' -> append("\\n")
            c == '\r' -> append("\\r")
            c == '\t' -> append("\\t")
            c < ' ' -> append("\\u%04x".format(c.code))
            c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate() -> {
                append(c)
                append(s[i + 1])
                i++
            }
            c.isSurrogate() -> append("\\u%04x".format(c.code))
            else -> append(c)
        }
        i++
    }
    append('"')
}

/** Number::toString, as JSON.stringify writes a number: shortest digits, exponent only below 1e-6 and from 1e21. */
internal fun jsNumber(d: Double): String {
    if (d == 0.0) return "0"
    val abs = Math.abs(d)
    var shortest = BigDecimal(java.lang.Double.toString(abs)).stripTrailingZeros()
    // Double.toString keeps two digits in scientific notation (4.9E-324) where one round-trips (5e-324)
    if (shortest.precision() == 2) {
        val one = BigDecimal(abs).round(MathContext(1, RoundingMode.HALF_EVEN))
        if (one.toDouble() == abs) shortest = one.stripTrailingZeros()
    }
    val digits = shortest.unscaledValue().toString()
    val k = digits.length
    val n = k - shortest.scale()
    val body = when {
        n in k..21 -> digits + "0".repeat(n - k)
        n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
        n in -5..0 -> "0." + "0".repeat(-n) + digits
        else -> {
            val e = n - 1
            (if (k == 1) digits else digits[0] + "." + digits.substring(1)) + "e" + (if (e < 0) "-" else "+") + Math.abs(e)
        }
    }
    return if (d < 0) "-$body" else body
}

/** A number as JSON would carry it from JavaScript; JSON.stringify writes Infinity and NaN as null. */
internal fun jsNumberElement(d: Double): JsonElement = if (!d.isFinite()) JsonNull else Json.parseToJsonElement(jsNumber(d))

/** String.prototype.trim's white space and line terminators. */
private fun isJsSpace(c: Char): Boolean =
    c == '\t' || c == '\n' || c == '\u000B' || c == '\u000C' || c == '\r' || c == ' ' || c == '\u00A0' ||
        c == '\u1680' || c in '\u2000'..'\u200A' || c == '\u2028' || c == '\u2029' || c == '\u202F' ||
        c == '\u205F' || c == '\u3000' || c == '\uFEFF'

private fun jsTrimStart(s: String) = s.trimStart(::isJsSpace)
private fun jsTrim(s: String) = s.trim(::isJsSpace)

/** JavaScript truthiness of an annotation argument (null, false, 0 and "" are false). */
private fun jsTruthy(v: JsonElement?): Boolean = when (v) {
    null, JsonNull -> false
    is JsonPrimitive -> if (v.isString) v.content.isNotEmpty() else v.booleanOrNull ?: (v.content.toDoubleOrNull()?.let { it != 0.0 && !it.isNaN() } ?: true)
    else -> true
}

// ------------------------------------------------------------------ lexer

internal enum class TokenKind(val wire: String) { NAME("name"), INT("int"), FLOAT("float"), STRING("string"), BLOCKSTRING("blockstring"), DURATION("duration"), PUNCT("punct"), EOF("eof") }

/** [num] holds the value of numbers and the milliseconds of durations. */
internal class Token(val kind: TokenKind, val value: String, val line: Int, val col: Int, val num: Double = 0.0)

internal object Lexer {
    private val PUNCT3 = listOf("...")
    private val PUNCT2 = listOf("==", "!=", "<=", ">=", "&&", "||")
    private const val PUNCT1 = "{}()[]:=,.<>|?@!$"
    private val DURATION_UNITS = linkedMapOf("ms" to 1.0, "s" to 1000.0, "m" to 60_000.0, "h" to 3_600_000.0, "d" to 86_400_000.0)
    private val HEX4 = Regex("^[0-9a-fA-F]{4}$")

    private fun isDigit(c: Char?) = c != null && c in '0'..'9'
    private fun isNameStart(c: Char) = c in 'a'..'z' || c in 'A'..'Z' || c == '_'
    private fun isNameChar(c: Char) = isNameStart(c) || isDigit(c)

    /** The unit a number is followed by, judged on the next three characters as the TypeScript lexer does. */
    private fun durationUnit(next3: String): String? = DURATION_UNITS.keys.firstOrNull { u ->
        next3.startsWith(u) && (next3.length == u.length || !isNameChar(next3[u.length]))
    }

    fun tokenize(src: String): List<Token> {
        val out = mutableListOf<Token>()
        val n = src.length
        var i = 0
        var line = 1
        var lineStart = 0
        fun at(k: Int): Char? = if (k < n) src[k] else null
        fun push(kind: TokenKind, value: String, start: Int, num: Double = 0.0) {
            out.add(Token(kind, value, line, start - lineStart + 1, num))
        }
        // 1e999 reads as Infinity, which JSON cannot carry: refuse it here so it never reaches the IR
        fun finite(num: Double, text: String, start: Int): Double {
            if (!num.isFinite()) throw RayfoldSyntaxException("Number out of range: $text", line, start - lineStart + 1)
            return num
        }

        while (i < n) {
            val c = src[i]
            if (c == '\n') {
                line++
                i++
                lineStart = i
                continue
            }
            if (c == ' ' || c == '\t' || c == '\r' || c == ',') {
                i++
                continue
            }
            if (c == '/' && at(i + 1) == '/') {
                while (i < n && src[i] != '\n') i++
                continue
            }
            if (c == '/' && at(i + 1) == '*') {
                val end = src.indexOf("*/", i + 2)
                if (end < 0) throw RayfoldSyntaxException("Unterminated block comment", line, i - lineStart + 1)
                for (j in i until end) if (src[j] == '\n') { line++; lineStart = j + 1 }
                i = end + 2
                continue
            }
            if (src.startsWith("\"\"\"", i)) {
                val start = i
                // \""" is the one escape a block string has (as in GraphQL): it is how a description holds its own fence
                var end = i + 3
                while (end < n && !src.startsWith("\"\"\"", end)) end += if (src.startsWith("\\\"\"\"", end)) 4 else 1
                if (end >= n) throw RayfoldSyntaxException("Unterminated block string", line, i - lineStart + 1)
                push(TokenKind.BLOCKSTRING, dedent(src.substring(i + 3, end).replace("\\\"\"\"", "\"\"\"")), start)
                for (j in i until end + 3) if (src[j] == '\n') { line++; lineStart = j + 1 }
                i = end + 3
                continue
            }
            if (c == '"') {
                val start = i
                i++
                val s = StringBuilder()
                while (i < n && src[i] != '"') {
                    val ch = src[i]
                    if (ch == '\n') throw RayfoldSyntaxException("Unterminated string", line, start - lineStart + 1)
                    if (ch == '\\') {
                        val e = at(i + 1)
                        i += 2
                        when (e) {
                            'n' -> s.append('\n')
                            't' -> s.append('\t')
                            'r' -> s.append('\r')
                            '"' -> s.append('"')
                            '\\' -> s.append('\\')
                            '/' -> s.append('/')
                            'b' -> s.append('\b')
                            'f' -> s.append('\u000C')
                            'u' -> {
                                val hex = src.substring(i, minOf(i + 4, n))
                                if (!HEX4.matches(hex)) throw RayfoldSyntaxException("Bad unicode escape", line, i - lineStart + 1)
                                s.append(hex.toInt(16).toChar())
                                i += 4
                            }
                            else -> throw RayfoldSyntaxException("Bad escape \\${e ?: ""}", line, i - lineStart + 1)
                        }
                        continue
                    }
                    s.append(ch)
                    i++
                }
                if (i >= n) throw RayfoldSyntaxException("Unterminated string", line, start - lineStart + 1)
                i++
                push(TokenKind.STRING, s.toString(), start)
                continue
            }
            if (isDigit(c) || (c == '-' && isDigit(at(i + 1)))) {
                val start = i
                i++
                while (i < n && isDigit(src[i])) i++
                var isFloat = false
                if (at(i) == '.' && isDigit(at(i + 1))) {
                    isFloat = true
                    i++
                    while (i < n && isDigit(src[i])) i++
                }
                if (at(i) == 'e' || at(i) == 'E') {
                    val save = i
                    i++
                    if (at(i) == '+' || at(i) == '-') i++
                    if (isDigit(at(i))) {
                        isFloat = true
                        while (i < n && isDigit(src[i])) i++
                    } else i = save
                }
                val text = src.substring(start, i)
                val unit = if (isFloat) null else durationUnit(src.substring(i, minOf(i + 3, n)))
                if (unit != null) {
                    i += unit.length
                    push(TokenKind.DURATION, text + unit, start, finite(text.toDouble() * DURATION_UNITS.getValue(unit), text + unit, start))
                    continue
                }
                push(if (isFloat) TokenKind.FLOAT else TokenKind.INT, text, start, finite(text.toDouble(), text, start))
                continue
            }
            if (isNameStart(c)) {
                val start = i
                i++
                while (i < n && isNameChar(src[i])) i++
                push(TokenKind.NAME, src.substring(start, i), start)
                continue
            }
            val three = src.substring(i, minOf(i + 3, n))
            if (three in PUNCT3) {
                push(TokenKind.PUNCT, three, i)
                i += 3
                continue
            }
            val two = src.substring(i, minOf(i + 2, n))
            if (two in PUNCT2) {
                push(TokenKind.PUNCT, two, i)
                i += 2
                continue
            }
            if (PUNCT1.indexOf(c) >= 0) {
                push(TokenKind.PUNCT, c.toString(), i)
                i++
                continue
            }
            throw RayfoldSyntaxException("Unexpected character ${jsJson(c.toString())}", line, i - lineStart + 1)
        }
        out.add(Token(TokenKind.EOF, "", line, i - lineStart + 1))
        return out
    }

    /** GraphQL-style block string dedent: strip common indentation and leading/trailing blank lines. */
    private fun dedent(raw: String): String {
        val lines = raw.split(Regex("\r?\n"))
        var common: Int? = null
        for (l in lines.drop(1)) {
            val indent = l.length - jsTrimStart(l).length
            if (jsTrim(l).isEmpty()) continue
            val c = common
            if (c == null || indent < c) common = indent
        }
        val shift = common
        val out = lines.mapIndexed { idx, l -> if (idx == 0 || shift == null) l else l.substring(minOf(shift, l.length - jsTrimStart(l).length)) }.toMutableList()
        while (out.isNotEmpty() && jsTrim(out.first()).isEmpty()) out.removeAt(0)
        while (out.isNotEmpty() && jsTrim(out.last()).isEmpty()) out.removeAt(out.size - 1)
        return jsTrim(out.joinToString("\n"))
    }
}

/** Cursor over a token list with the helpers every parser needs. */
internal class TokenStream(private val tokens: List<Token>) {
    private var pos = 0

    fun peek(ahead: Int = 0): Token = tokens[minOf(pos + ahead, tokens.size - 1)]
    fun next(): Token = peek().also { if (it.kind != TokenKind.EOF) pos++ }
    fun at(kind: TokenKind, value: String? = null): Boolean = peek().let { it.kind == kind && (value == null || it.value == value) }
    fun atPunct(value: String) = at(TokenKind.PUNCT, value)
    fun atName(value: String? = null) = at(TokenKind.NAME, value)
    fun accept(kind: TokenKind, value: String? = null): Token? = if (at(kind, value)) next() else null
    fun expect(kind: TokenKind, value: String? = null): Token {
        val t = peek()
        if (!at(kind, value)) {
            val want = if (value != null) jsJson(value) else kind.wire
            val got = if (t.kind == TokenKind.EOF) "end of input" else jsJson(t.value)
            throw RayfoldSyntaxException("Expected $want but found $got", t.line, t.col)
        }
        return next()
    }
    fun expectPunct(value: String) = expect(TokenKind.PUNCT, value)
    fun expectName(): String = expect(TokenKind.NAME).value
    fun error(message: String, t: Token = peek()) = RayfoldSyntaxException(message, t.line, t.col)
}

// ------------------------------------------------------------------ expressions, shapes and literals

/** Policy expressions (spec 01 section 5) as the JSON AST the IR stores under `$expr`. */
internal object ExprParser {
    private val BUILTIN_FNS = setOf("has", "len", "now")
    private val CMP_OPS = setOf("==", "!=", "<", "<=", ">", ">=")

    private fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(linkedMapOf(*pairs))
    private fun lit(v: JsonElement) = obj("k" to JsonPrimitive("lit"), "v" to v)
    private fun bin(op: String, l: JsonObject, r: JsonObject) = obj("k" to JsonPrimitive("bin"), "op" to JsonPrimitive(op), "l" to l, "r" to r)

    /** [bare] is the root a bare name resolves to: "this" on types, "args" on operations and arguments. */
    fun parse(ts: TokenStream, bare: String): JsonObject = or(ts, bare)

    private fun or(ts: TokenStream, r: String): JsonObject {
        var l = and(ts, r)
        while (ts.accept(TokenKind.PUNCT, "||") != null) l = bin("||", l, and(ts, r))
        return l
    }

    private fun and(ts: TokenStream, r: String): JsonObject {
        var l = not(ts, r)
        while (ts.accept(TokenKind.PUNCT, "&&") != null) l = bin("&&", l, not(ts, r))
        return l
    }

    private fun not(ts: TokenStream, r: String): JsonObject =
        if (ts.accept(TokenKind.PUNCT, "!") != null) obj("k" to JsonPrimitive("not"), "e" to not(ts, r)) else cmp(ts, r)

    private fun cmp(ts: TokenStream, r: String): JsonObject {
        val l = primary(ts, r)
        val t = ts.peek()
        if (t.kind == TokenKind.PUNCT && t.value in CMP_OPS) {
            ts.next()
            return bin(t.value, l, primary(ts, r))
        }
        if (t.kind == TokenKind.NAME && t.value == "in") {
            ts.next()
            return bin("in", l, primary(ts, r))
        }
        return l
    }

    private fun primary(ts: TokenStream, r: String): JsonObject {
        val t = ts.peek()
        when (t.kind) {
            TokenKind.STRING -> { ts.next(); return lit(JsonPrimitive(t.value)) }
            TokenKind.INT, TokenKind.FLOAT, TokenKind.DURATION -> { ts.next(); return lit(jsNumberElement(t.num)) }
            TokenKind.PUNCT -> {
                if (t.value == "(") {
                    ts.next()
                    val e = parse(ts, r)
                    ts.expectPunct(")")
                    return e
                }
                if (t.value == "[") {
                    ts.next()
                    val items = mutableListOf<JsonElement>()
                    while (!ts.atPunct("]")) items.add(parse(ts, r))
                    ts.expectPunct("]")
                    return obj("k" to JsonPrimitive("list"), "items" to JsonArray(items))
                }
                throw ts.error("Unexpected ${jsJson(t.value)} in expression")
            }
            TokenKind.NAME -> {
                ts.next()
                when (t.value) {
                    "true" -> return lit(JsonPrimitive(true))
                    "false" -> return lit(JsonPrimitive(false))
                    "null" -> return lit(JsonNull)
                }
                if (ts.atPunct("(")) {
                    ts.next()
                    val args = mutableListOf<JsonElement>()
                    while (!ts.atPunct(")")) args.add(parse(ts, r))
                    ts.expectPunct(")")
                    if (t.value !in BUILTIN_FNS) throw ts.error("Unknown function ${t.value}()", t)
                    return obj("k" to JsonPrimitive("call"), "fn" to JsonPrimitive(t.value), "args" to JsonArray(args))
                }
                val path = mutableListOf<String>()
                while (ts.accept(TokenKind.PUNCT, ".") != null) path.add(ts.expectName())
                val root: String
                val full: List<String>
                if (t.value == "viewer" || t.value == "args" || t.value == "this") {
                    root = t.value
                    full = path
                } else {
                    root = r
                    full = listOf(t.value) + path
                }
                return obj("k" to JsonPrimitive("path"), "root" to JsonPrimitive(root), "path" to JsonArray(full.map { JsonPrimitive(it) }))
            }
            else -> throw ts.error("Expected expression")
        }
    }
}

/** Shapes (spec 02) inside schema text, i.e. in views. Nesting is limited while parsing, as in the TypeScript parser. */
internal class ShapeParser(private val ts: TokenStream) {
    private var nesting = 0

    private inline fun <T> nested(block: () -> T): T {
        if (nesting >= MAX_NESTING) throw ts.error("Shape nested deeper than $MAX_NESTING levels")
        nesting++
        try {
            return block()
        } finally {
            nesting--
        }
    }

    fun shape(): Shape = nested {
        ts.expectPunct("{")
        val items = mutableListOf<ShapeItem>()
        while (!ts.atPunct("}")) {
            if (ts.at(TokenKind.EOF)) throw ts.error("Unterminated shape")
            items.add(item())
        }
        ts.expectPunct("}")
        Shape(items)
    }

    private fun item(): ShapeItem {
        if (ts.accept(TokenKind.PUNCT, "...") != null) {
            if (ts.accept(TokenKind.NAME, "on") != null) {
                val type = ts.expectName()
                return ShapeItem(kind = "on", type = type, shape = shape())
            }
            val type = ts.expectName()
            ts.expectPunct(".")
            return ShapeItem(kind = "spread", type = type, view = ts.expectName())
        }
        if (ts.atPunct("@")) {
            ts.next()
            val d = ts.expectName()
            if (d != "defer") throw ts.error("Unknown shape directive @$d")
            var label: String? = null
            if (ts.accept(TokenKind.PUNCT, "(") != null) {
                if (ts.expectName() != "label") throw ts.error("@defer accepts only label:")
                ts.expectPunct(":")
                label = ts.expect(TokenKind.STRING).value
                ts.expectPunct(")")
            }
            return ShapeItem(kind = "defer", label = label, shape = shape())
        }
        val first = ts.expectName()
        var alias: String? = null
        var name = first
        if (ts.accept(TokenKind.PUNCT, ":") != null) {
            alias = first
            name = ts.expectName()
        }
        var args: Map<String, JsonElement>? = null
        if (ts.accept(TokenKind.PUNCT, "(") != null) {
            val a = linkedMapOf<String, JsonElement>()
            while (!ts.atPunct(")")) {
                val k = ts.expectName()
                ts.expectPunct(":")
                a[k] = value()
            }
            ts.expectPunct(")")
            args = a
        }
        val sub = if (ts.atPunct("{")) shape() else null
        var eager = false
        var partial = false
        // modifiers belong to this field; anything else after "@" (like @defer) is the next item
        while (ts.atPunct("@") && ts.peek(1).kind == TokenKind.NAME) {
            when (ts.peek(1).value) {
                "eager" -> eager = true
                "partial" -> partial = true
                "defer" -> break
                else -> throw ts.error("Unknown field modifier @${ts.peek(1).value}", ts.peek(1))
            }
            ts.next()
            ts.next()
        }
        return ShapeItem(kind = "field", name = name, alias = alias, args = args, shape = sub, eager = eager, partial = partial)
    }

    /** A literal in which `$name` stands for a variable, at any depth up to the nesting limit. */
    private fun value(): JsonElement = nested {
        val t = ts.peek()
        when {
            t.kind == TokenKind.PUNCT && t.value == "$" -> {
                ts.next()
                JsonObject(mapOf("\$var" to JsonPrimitive(ts.expectName())))
            }
            t.kind == TokenKind.PUNCT && t.value == "[" -> {
                ts.next()
                val out = mutableListOf<JsonElement>()
                while (!ts.atPunct("]")) out.add(value())
                ts.expectPunct("]")
                JsonArray(out)
            }
            t.kind == TokenKind.PUNCT && t.value == "{" -> {
                ts.next()
                val out = linkedMapOf<String, JsonElement>()
                while (!ts.atPunct("}")) {
                    val k = ts.expectName()
                    ts.expectPunct(":")
                    out[k] = value()
                }
                ts.expectPunct("}")
                JsonObject(out)
            }
            else -> Literals.parse(ts)
        }
    }

    companion object {
        const val MAX_NESTING = 64
    }
}

/** JSON-like literals: scalars, lists and objects; an identifier other than true/false/null becomes a string. */
internal object Literals {
    fun parse(ts: TokenStream): JsonElement {
        val t = ts.peek()
        return when (t.kind) {
            TokenKind.STRING -> { ts.next(); JsonPrimitive(t.value) }
            TokenKind.INT, TokenKind.FLOAT, TokenKind.DURATION -> { ts.next(); jsNumberElement(t.num) }
            TokenKind.NAME -> {
                ts.next()
                when (t.value) {
                    "true" -> JsonPrimitive(true)
                    "false" -> JsonPrimitive(false)
                    "null" -> JsonNull
                    else -> JsonPrimitive(t.value)
                }
            }
            TokenKind.PUNCT -> when (t.value) {
                "[" -> {
                    ts.next()
                    val out = mutableListOf<JsonElement>()
                    while (!ts.atPunct("]")) out.add(parse(ts))
                    ts.expectPunct("]")
                    JsonArray(out)
                }
                "{" -> {
                    ts.next()
                    val out = linkedMapOf<String, JsonElement>()
                    while (!ts.atPunct("}")) {
                        // a quoted key is how a default holds a key that is not a name, such as { "content-type": "text/plain" }
                        val k = ts.accept(TokenKind.STRING)?.value ?: ts.expectName()
                        ts.expectPunct(":")
                        out[k] = parse(ts)
                    }
                    ts.expectPunct("}")
                    JsonObject(out)
                }
                else -> throw ts.error("Unexpected ${jsJson(t.value)} in literal")
            }
            else -> throw ts.error("Expected literal")
        }
    }
}

// ------------------------------------------------------------------ schema parser

private val DEF_KEYWORDS = setOf("entity", "object", "input", "enum", "union", "scalar", "error", "event", "view", "query", "command", "stream")

/** Annotations whose arguments are policy expressions, and those whose argument is a type reference. */
private val EXPR_ANNOTATIONS = setOf("allow", "deny")
private val TYPE_ANNOTATIONS = setOf("input")

/** The built-in definitions present in every IR. */
internal fun builtinTypes(): LinkedHashMap<String, TypeDef> {
    val out = linkedMapOf<String, TypeDef>()
    for (s in listOf("ID", "String", "Int", "Long", "Float", "Boolean", "Decimal", "Instant", "Date", "Duration", "Bytes", "JSON")) {
        out[s] = TypeDef(kind = "scalar", name = s, builtin = true)
    }
    fun named(name: String, nullable: Boolean = false) = TypeRef(kind = "named", name = name, nullable = nullable)
    out["Page"] = TypeDef(
        kind = "object", name = "Page", builtin = true, typeParams = listOf("T"),
        fields = listOf(
            FieldDef(name = "items", type = TypeRef(kind = "list", of = named("T"), nullable = false), ordinal = 1),
            FieldDef(name = "cursor", type = named("String", true), ordinal = 2),
            FieldDef(name = "hasMore", type = named("Boolean"), ordinal = 3),
            FieldDef(name = "total", type = named("Int", true), ordinal = 4),
        ),
    )
    out["PageArgs"] = TypeDef(
        kind = "input", name = "PageArgs", builtin = true,
        fields = listOf(
            FieldDef(name = "first", type = named("Int"), default = JsonPrimitive(20), ordinal = 1),
            FieldDef(name = "after", type = named("String", true), ordinal = 2),
            FieldDef(name = "offset", type = named("Int", true), ordinal = 3),
        ),
    )
    return out
}

internal class SchemaParser(private val ts: TokenStream) {
    private val types = builtinTypes()
    private val ops = linkedMapOf<String, OpDef>()
    private val views = linkedMapOf<String, ViewDef>()
    private val shapes = ShapeParser(ts)

    fun document(): RayfoldSchemaIR {
        while (!ts.at(TokenKind.EOF)) definition()
        return RayfoldSchemaIR(rayfold = "0.1", types = types, ops = ops, views = views)
    }

    private fun definition() {
        val doc = ts.accept(TokenKind.BLOCKSTRING)?.value
        val kw = ts.peek()
        if (kw.kind != TokenKind.NAME || kw.value !in DEF_KEYWORDS) {
            throw ts.error("Expected a definition keyword (entity, query, ...) but found ${jsJson(kw.value)}")
        }
        ts.next()
        when (kw.value) {
            "entity", "object", "input", "error", "event" -> fieldedType(kw.value, doc, kw)
            "enum" -> enumType(doc, kw)
            "union" -> unionType(doc, kw)
            "scalar" -> scalarType(doc, kw)
            "view" -> view(kw)
            else -> op(kw.value, doc)
        }
    }

    private fun defineType(def: TypeDef, at: Token) {
        val existing = types[def.name]
        if (existing != null) {
            val why = if (existing.builtin) "is a built-in type" else "is already defined"
            throw RayfoldSyntaxException("Type ${def.name} $why", at.line, at.col)
        }
        types[def.name] = def
    }

    private fun fieldedType(kind: String, doc: String?, at: Token) {
        val name = ts.expectName()
        val implementsList = mutableListOf<String>()
        if (kind == "entity" && ts.accept(TokenKind.NAME, "implements") != null) {
            implementsList.add(ts.expectName())
            while (ts.atName() && !ts.atPunct("{") && !ts.atPunct("@")) implementsList.add(ts.expectName())
        }
        val annotations = annotations("this")
        val fields = fieldBlock(if (kind == "input") "args" else "this", kind == "input")
        defineType(
            TypeDef(
                kind = kind, name = name, description = doc, annotations = annotations, fields = fields, implements = implementsList,
                isInterface = kind == "object" && annotations.any { it.name == "interface" },
            ),
            at,
        )
    }

    private fun fieldBlock(bare: String, allowDefaults: Boolean): List<FieldDef> {
        ts.expectPunct("{")
        val fields = mutableListOf<FieldDef>()
        val seen = mutableSetOf<String>()
        while (!ts.atPunct("}")) {
            val doc = ts.accept(TokenKind.BLOCKSTRING)?.value
            val nameTok = ts.expect(TokenKind.NAME)
            if (!seen.add(nameTok.value)) throw ts.error("Duplicate field ${nameTok.value}", nameTok)
            val args = if (ts.atPunct("(")) args() else emptyList()
            ts.expectPunct(":")
            val type = typeRef()
            var default: JsonElement? = null
            if (ts.accept(TokenKind.PUNCT, "=") != null) {
                if (!allowDefaults) throw ts.error("Defaults are only allowed on input fields and arguments", nameTok)
                default = Literals.parse(ts)
            }
            val annotations = annotations(bare)
            fields.add(FieldDef(name = nameTok.value, description = doc, type = type, args = args, default = default, annotations = annotations, ordinal = ordinalOf(annotations, fields.size + 1)))
        }
        ts.expectPunct("}")
        return fields
    }

    private fun args(): List<ArgDef> {
        ts.expectPunct("(")
        val out = mutableListOf<ArgDef>()
        val seen = mutableSetOf<String>()
        while (!ts.atPunct(")")) {
            val doc = ts.accept(TokenKind.BLOCKSTRING)?.value
            val nameTok = ts.expect(TokenKind.NAME)
            if (!seen.add(nameTok.value)) throw ts.error("Duplicate argument ${nameTok.value}", nameTok)
            ts.expectPunct(":")
            val type = typeRef()
            val default = if (ts.accept(TokenKind.PUNCT, "=") != null) Literals.parse(ts) else null
            out.add(ArgDef(name = nameTok.value, description = doc, type = type, default = default, annotations = annotations("args")))
        }
        ts.expectPunct(")")
        return out
    }

    private fun typeRef(): TypeRef {
        if (ts.accept(TokenKind.PUNCT, "[") != null) {
            val of = typeRef()
            ts.expectPunct("]")
            return TypeRef(kind = "list", of = of, nullable = ts.accept(TokenKind.PUNCT, "?") != null)
        }
        val name = ts.expectName()
        var args: MutableList<TypeRef>? = null
        if (ts.accept(TokenKind.PUNCT, "<") != null) {
            val a = mutableListOf(typeRef())
            while (!ts.atPunct(">")) a.add(typeRef())
            ts.expectPunct(">")
            args = a
        }
        return TypeRef(kind = "named", name = name, nullable = ts.accept(TokenKind.PUNCT, "?") != null, args = args)
    }

    private fun annotations(bare: String): List<Annotation> {
        val out = mutableListOf<Annotation>()
        while (ts.atPunct("@")) {
            val at = ts.next()
            var name = ts.expectName()
            while (ts.atPunct(".") && ts.peek(1).kind == TokenKind.NAME) {
                ts.next()
                name += "." + ts.expectName()
            }
            val args = linkedMapOf<String, JsonElement>()
            if (ts.accept(TokenKind.PUNCT, "(") != null) {
                var positional = 0
                while (!ts.atPunct(")")) {
                    val key = if (ts.atName() && ts.peek(1).kind == TokenKind.PUNCT && ts.peek(1).value == ":") {
                        ts.expectName().also { ts.expectPunct(":") }
                    } else {
                        (if (positional == 0) "value" else "value$positional").also { positional++ }
                    }
                    args[key] = annotationValue(name, bare)
                }
                ts.expectPunct(")")
            }
            if (out.any { it.name == name }) throw ts.error("Duplicate annotation @$name", at)
            out.add(Annotation(name, args))
        }
        return out
    }

    private fun annotationValue(annotation: String, bare: String): JsonElement {
        if (annotation in EXPR_ANNOTATIONS) return JsonObject(mapOf("\$expr" to ExprParser.parse(ts, bare)))
        if (annotation in TYPE_ANNOTATIONS) return JsonObject(mapOf("\$type" to IrJson.typeRef(typeRef())))
        val t = ts.peek()
        if (t.kind == TokenKind.DURATION) {
            ts.next()
            return JsonObject(mapOf("\$duration" to jsNumberElement(t.num)))
        }
        if (t.kind == TokenKind.NAME && t.value !in setOf("true", "false", "null")) {
            ts.next()
            return JsonObject(mapOf("\$ident" to JsonPrimitive(t.value)))
        }
        return Literals.parse(ts)
    }

    private fun enumType(doc: String?, at: Token) {
        val name = ts.expectName()
        val annotations = annotations("this")
        ts.expectPunct("{")
        val values = mutableListOf<EnumValueDef>()
        while (!ts.atPunct("}")) {
            val vdoc = ts.accept(TokenKind.BLOCKSTRING)?.value
            val vt = ts.expect(TokenKind.NAME)
            if (values.any { it.name == vt.value }) throw ts.error("Duplicate enum value ${vt.value}", vt)
            val vann = annotations("this")
            values.add(EnumValueDef(name = vt.value, description = vdoc, annotations = vann, ordinal = ordinalOf(vann, values.size + 1)))
        }
        ts.expectPunct("}")
        defineType(TypeDef(kind = "enum", name = name, description = doc, annotations = annotations, values = values), at)
    }

    private fun unionType(doc: String?, at: Token) {
        val name = ts.expectName()
        val annotations = annotations("this")
        ts.expectPunct("=")
        val members = mutableListOf(ts.expectName())
        while (ts.accept(TokenKind.PUNCT, "|") != null) members.add(ts.expectName())
        defineType(TypeDef(kind = "union", name = name, description = doc, annotations = annotations, members = members), at)
    }

    private fun scalarType(doc: String?, at: Token) {
        val name = ts.expectName()
        defineType(TypeDef(kind = "scalar", name = name, description = doc, annotations = annotations("this")), at)
    }

    private fun view(at: Token) {
        val type = ts.expectName()
        ts.expectPunct(".")
        val name = ts.expectName()
        ts.expectPunct("=")
        val shape = shapes.shape()
        val key = "$type.$name"
        if (views.containsKey(key)) throw RayfoldSyntaxException("View $key is already defined", at.line, at.col)
        views[key] = ViewDef(type, name, shape)
    }

    private fun op(kind: String, doc: String?) {
        val nameTok = ts.expect(TokenKind.NAME)
        if (ops.containsKey(nameTok.value)) throw ts.error("Operation ${nameTok.value} is already defined", nameTok)
        val args = if (ts.atPunct("(")) args() else emptyList()
        ts.expectPunct(":")
        val returns = typeRef()
        val throws = mutableListOf<String>()
        val emits = mutableListOf<String>()
        val annotations = mutableListOf<Annotation>()
        while (true) {
            if (ts.accept(TokenKind.NAME, "throws") != null) {
                throws.add(throwsItem(nameTok.value))
                while (ts.accept(TokenKind.PUNCT, "|") != null) throws.add(throwsItem(nameTok.value))
            } else if (ts.accept(TokenKind.NAME, "emits") != null) {
                emits.add(ts.expectName())
                while (ts.atName() && !keywordAhead()) emits.add(ts.expectName())
            } else if (ts.atPunct("@")) {
                annotations.addAll(annotations("args"))
            } else break
        }
        ops[nameTok.value] = OpDef(kind = kind, name = nameTok.value, description = doc, args = args, returns = returns, throws = throws, emits = emits, annotations = annotations)
    }

    private fun keywordAhead(): Boolean = ts.peek().let { it.kind == TokenKind.NAME && (it.value in DEF_KEYWORDS || it.value == "throws" || it.value == "emits") }

    /** `Name` or `Name { fields }`; the inline form is hoisted into a named error type. */
    private fun throwsItem(opName: String): String {
        val nameTok = ts.expect(TokenKind.NAME)
        if (ts.atPunct("{")) {
            val fields = fieldBlock("this", false)
            val existing = types[nameTok.value]
            if (existing != null) {
                if (existing.kind != "error") throw ts.error("${nameTok.value} is already a ${existing.kind}", nameTok)
                if (!sameFields(existing.fields, fields)) throw ts.error("Inline error ${nameTok.value} in $opName conflicts with an earlier definition", nameTok)
                return nameTok.value
            }
            types[nameTok.value] = TypeDef(kind = "error", name = nameTok.value, fields = fields)
        }
        return nameTok.value
    }

    private fun ordinalOf(annotations: List<Annotation>, fallback: Int): Int {
        val v = annotations.find("ordinal")?.args?.get("value") as? JsonPrimitive ?: return fallback
        if (v is JsonNull || v.isString || v.booleanOrNull != null) return fallback
        return v.content.toDoubleOrNull()?.toInt() ?: fallback
    }

    private fun sameFields(a: List<FieldDef>, b: List<FieldDef>): Boolean {
        fun strip(f: FieldDef) = JsonObject(IrJson.field(f) - "ordinal")
        return a.size == b.size && a.zip(b).all { (x, y) -> strip(x) == strip(y) }
    }
}

// ------------------------------------------------------------------ validation

/** IR validation (spec 01 section 8), message for message the checks of packages/schema/src/validate.ts. */
internal object SchemaValidator {
    private val ALL_TYPE_KINDS = setOf("entity", "object", "input", "enum", "union", "scalar", "error", "event")
    private val KNOWN_ANNOTATIONS: Map<String, Set<String>> = mapOf(
        "cache" to setOf("entity", "query"),
        "allow" to setOf("entity", "object", "field", "query", "command", "stream"),
        "deny" to setOf("entity", "object", "field", "query", "command", "stream"),
        "load" to setOf("field"),
        "page" to setOf("field", "query"),
        "cost" to setOf("field", "query", "stream", "command"),
        "deprecated" to ALL_TYPE_KINDS + setOf("field", "arg", "enumValue", "query", "command", "stream"),
        "lazy" to setOf("field"),
        "partial" to setOf("field"),
        "live" to setOf("query"),
        "input" to setOf("stream"),
        "interface" to setOf("object"),
        "idempotent" to setOf("command"),
        "format" to setOf("scalar", "field", "arg"),
        "unit" to setOf("scalar", "field", "arg"),
        "range" to setOf("scalar", "field", "arg"),
        "example" to setOf("scalar", "field", "arg", "query", "command", "stream", "entity", "object", "input"),
        "ordinal" to setOf("field", "enumValue"),
        "version" to setOf("field"),
        // on an argument or an input field it only renames the member in HTTP bindings (spec 04 section 8)
        "http" to setOf("query", "command", "arg", "field"),
        "simulate" to setOf("command"),
        "merge" to setOf("field"),
    )
    /** How a field settles when a prediction and the server disagree (spec 08 section 5). */
    private val MERGE_POLICIES = setOf("serverWins", "keepLocal", "lww", "crdtText", "custom")
    private val INPUT_KINDS = setOf("scalar", "enum", "input")
    private val OUTPUT_KINDS = setOf("scalar", "enum", "entity", "object", "union")
    private val STREAM_KINDS = OUTPUT_KINDS + "event"
    private val EVENT_FIELD_KINDS = setOf("scalar", "enum", "object")
    private val RESERVED_OP_NAMES = setOf("subscribe", "manifest", "simulate", "sync")
    private val HTTP_PARAM = Regex("""\{([A-Za-z_][A-Za-z0-9_]*)\}""")
    private val NAME = Regex("^[A-Za-z_][A-Za-z0-9_]*$")

    private fun stringOrIdent(v: JsonElement?): String? =
        v.identOrNull() ?: (v as? JsonPrimitive)?.takeIf { it.isString }?.content

    fun validate(ir: RayfoldSchemaIR): List<Diagnostic> {
        val out = mutableListOf<Diagnostic>()
        fun err(code: String, at: String, message: String) { out.add(Diagnostic("error", code, message, at)) }
        fun warn(code: String, at: String, message: String) { out.add(Diagnostic("warning", code, message, at)) }

        /** [scope] holds the type parameters in scope: those of the generic object whose fields these are. */
        fun checkRef(t: TypeRef, at: String, allowed: Set<String>, ctx: String, scope: List<String> = emptyList()) {
            if (t.isList) return checkRef(t.element, at, allowed, ctx, scope)
            if (t.typeName in scope) return
            val def = ir.types[t.typeName] ?: return err("unknown-type", at, "Unknown type ${t.name}")
            val params = def.typeParams
            if (def.kind == "object" && !params.isNullOrEmpty()) {
                val targs = t.args
                if (targs == null || targs.size != params.size) return err("generic-arity", at, "${t.name} takes ${params.size} type argument(s)")
                if (def.kind !in allowed) return err("bad-type-position", at, "${def.kind} ${t.name} cannot be used as $ctx")
                for (a in targs) checkRef(a, at, allowed, ctx, scope)
                return
            }
            if (!t.args.isNullOrEmpty()) return err("not-generic", at, "${t.name} is not generic")
            if (def.kind !in allowed) err("bad-type-position", at, "${def.kind} ${t.name} cannot be used as $ctx")
        }

        // The text parser only reads names, but an IR also comes from importers, the builder and lock files; a name no
        // parser would read back is one no schema file can hold.
        fun checkName(name: String, what: String, at: String) {
            if (!NAME.matches(name)) err("bad-name", at, "$what ${jsJson(name)} is not a name ([A-Za-z_][A-Za-z0-9_]*)")
        }
        fun checkUnique(names: List<String>, what: String, at: String) {
            val seen = mutableSetOf<String>()
            for (n in names) if (!seen.add(n)) err("duplicate-name", at, "Duplicate $what $n")
        }

        fun checkAnnotations(anns: List<Annotation>, on: String, at: String) {
            for (a in anns) {
                if (a.name.contains(".")) continue // namespaced extension
                val allowed = KNOWN_ANNOTATIONS[a.name]
                if (allowed == null) {
                    err("unknown-annotation", at, "Unknown annotation @${a.name} (namespace it as @vendor.${a.name} to keep it)")
                    continue
                }
                if (on !in allowed) err("annotation-position", at, "@${a.name} is not allowed on $on")
                // an unquoted date lexes as three numbers, and a non-string sunset is one sunsetPassed can never
                // read, so the member could never be removed
                a.args["sunset"]?.let { sunset ->
                    if (a.name == "deprecated" && (sunset as? JsonPrimitive)?.isString != true) {
                        err("bad-sunset", at, "@deprecated sunset must be a quoted date, as in @deprecated(sunset: \"2027-06-30\")")
                    }
                }
                if (a.name == "allow" || a.name == "deny") {
                    for ((k, v) in a.args) {
                        if (k != "read" && k != "write") err("bad-policy-arg", at, "@${a.name} accepts read: and write:, not $k:")
                        val e = v.exprOrNull() ?: continue
                        if (on != "field" && on != "entity" && on != "object") {
                            for (root in Expr.paths(e)) if (root == "this") err("policy-this-on-op", at, "'this' is not available in operation-level policies")
                        }
                    }
                }
                if (a.name == "cache") {
                    val scope = a.args["scope"]
                    if (jsTruthy(scope) && scope.identOrNull() !in setOf("public", "private")) err("bad-cache-scope", at, "@cache scope must be public or private")
                    val maxAge = a.args["maxAge"]
                    if (a.args.containsKey("maxAge") && !(maxAge is JsonObject && maxAge.containsKey("\$duration"))) err("bad-cache-maxage", at, "@cache maxAge must be a duration like 60s")
                }
                if (a.name == "input" && on == "stream") {
                    for (v in a.args.values) {
                        val ref = (v as? JsonObject)?.get("\$type") as? JsonObject
                        if (ref != null) checkRef(RayfoldSchemaIR.json.decodeFromJsonElement(TypeRef.serializer(), ref), at, INPUT_KINDS, "a stream input")
                        else err("bad-input", at, "@input takes the type of what a client sends, as in @input(ChatMessage)")
                    }
                }
                if (a.name == "http" && (on == "arg" || on == "field")) {
                    val name = (a.args["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                    if (a.args.size != 1 || name.isNullOrEmpty()) {
                        err("bad-http-name", at, "@http on an argument or input field takes exactly one argument, name: \"<wire name>\", a non-empty string")
                    }
                }
                if (a.name == "load" && a.args["value"].identOrNull() !in setOf("batch", "single")) err("bad-load", at, "@load must be batch or single")
                if (a.name == "merge" && a.args["value"].identOrNull() !in MERGE_POLICIES) err("bad-merge", at, "@merge takes one of " + MERGE_POLICIES.joinToString(", "))
            }
        }

        /** A binding reads a member by its wire name, so within one operation or input type a wire name stands for one member only. */
        fun checkWireNames(members: List<Pair<String, List<Annotation>>>, at: (String) -> String) {
            for ((i, m) in members.withIndex()) {
                val w = (m.second.find("http")?.args?.get("name") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: continue
                val other = members.withIndex().firstOrNull { (j, o) -> j != i && (o.first == w || o.second.wireName(o.first) == w) }?.value ?: continue
                err("http-name-collision", at(m.first), "@http name ${jsJson(w)} of ${m.first} is also the ${if (other.first == w) "name" else "wire name"} of ${other.first}")
            }
        }

        fun checkArg(a: ArgDef, at: String) {
            if (a.name.startsWith("__") || a.name.startsWith("$")) err("reserved-name", at, "Argument name ${a.name} is reserved")
            checkName(a.name, "Argument name", at)
            checkRef(a.type, at, INPUT_KINDS, "an argument")
            checkAnnotations(a.annotations, "arg", at)
        }

        fun checkFields(fields: List<FieldDef>, owner: TypeDef, allowed: Set<String>, ctx: String) {
            checkUnique(fields.map { it.name }, "field", owner.name)
            val scope = if (owner.kind == "object") owner.typeParams.orEmpty() else emptyList()
            for (f in fields) {
                val at = "${owner.name}.${f.name}"
                if (f.name == "\$type" || f.name.startsWith("__") || f.name.startsWith("$")) err("reserved-name", at, "Field name ${f.name} is reserved")
                checkName(f.name, "Field name", at)
                checkRef(f.type, at, allowed, ctx, scope)
                checkAnnotations(f.annotations, "field", at)
                if (owner.kind != "input" && f.annotations.find("http") != null) {
                    err("annotation-position", at, "@http is not allowed on a field of ${owner.kind} ${owner.name}; only input fields take a wire name")
                }
                checkUnique(f.args.map { it.name }, "argument", at)
                for (a in f.args) {
                    checkArg(a, "$at(${a.name})")
                    if (a.annotations.find("http") != null) err("annotation-position", "$at(${a.name})", "@http is not allowed on a field argument; only operation arguments take a wire name")
                }
                if (owner.kind != "entity" && owner.kind != "object" && f.args.isNotEmpty()) err("args-not-allowed", at, "Only entity and object fields take arguments")
                if (f.annotations.any { it.name == "version" }) {
                    val vt = f.type
                    if (vt.isList || vt.name !in setOf("Int", "Long", "String", "Instant") || vt.nullable) err("bad-version-field", at, "@version fields must be non-null Int, Long, String or Instant")
                }
                if (f.annotations.any { it.name == "page" } && !f.type.isPage) err("page-on-non-page", at, "@page requires a Page<T> field")
                if (f.type.isPage && f.args.none { (!it.type.isList && it.type.name == "PageArgs") || it.name == "first" }) {
                    err("page-args", at, "A field returning Page<T> must accept page: PageArgs (or first/after)")
                }
                if (f.annotations.any { it.name == "partial" } && !f.type.nullable) err("partial-non-null", at, "@partial fields must be nullable (they become null on failure)")
            }
        }

        // --- types
        for (t in ir.types.values) {
            if (t.builtin) continue
            val at = t.name
            if (t.name.startsWith("__") || t.name.startsWith("$")) err("reserved-name", at, "Type name ${t.name} is reserved")
            checkName(t.name, "Type name", at)
            checkAnnotations(t.annotations, t.kind, at)
            when (t.kind) {
                "entity" -> {
                    val id = t.fields.find { it.name == "id" }
                    if (id == null || id.type.isList || id.type.name != "ID" || id.type.nullable) err("entity-id", at, "entity ${t.name} must declare id: ID")
                    for (i in t.implements) {
                        val iface = ir.types[i]
                        if (iface == null || iface.kind != "object" || !iface.isInterface) {
                            err("bad-interface", at, "$i is not an @interface object")
                            continue
                        }
                        for (f in iface.fields) if (t.fields.none { it.name == f.name }) err("missing-interface-field", at, "${t.name} must implement $i.${f.name}")
                    }
                    checkFields(t.fields, t, OUTPUT_KINDS, "a result field")
                }
                "object", "error", "event" -> checkFields(t.fields, t, if (t.kind == "object") OUTPUT_KINDS else EVENT_FIELD_KINDS, "a field")
                "input" -> {
                    checkFields(t.fields, t, INPUT_KINDS, "an input field")
                    checkWireNames(t.fields.map { it.name to it.annotations }) { "${t.name}.$it" }
                }
                "union" -> {
                    checkUnique(t.members, "union member", at)
                    for (m in t.members) {
                        val md = ir.types[m]
                        if (md == null) err("unknown-type", at, "Unknown union member $m")
                        else if (md.kind != "entity" && md.kind != "object") err("bad-union-member", at, "Union members must be entities or objects ($m is ${md.kind})")
                    }
                }
                "enum" -> {
                    checkUnique(t.values.map { it.name }, "enum value", at)
                    for (v in t.values) {
                        if (v.name.startsWith("__")) err("reserved-name", "$at.${v.name}", "Enum value ${v.name} is reserved")
                        checkName(v.name, "Enum value", "$at.${v.name}")
                        checkAnnotations(v.annotations, "enumValue", "$at.${v.name}")
                    }
                }
            }
        }

        // --- ops
        for (op in ir.ops.values) {
            val at = "${op.name}()"
            if (op.name in RESERVED_OP_NAMES || op.name.startsWith("__") || op.name.startsWith("$")) err("reserved-name", at, "Operation name ${op.name} is reserved")
            checkName(op.name, "Operation name", at)
            ir.types[op.name]?.let { if (!it.builtin) warn("shadowed-name", at, "Operation ${op.name} shares its name with a type") }
            checkUnique(op.args.map { it.name }, "argument", at)
            for (a in op.args) checkArg(a, "$at.${a.name}")
            checkWireNames(op.args.map { it.name to it.annotations }) { "$at.$it" }
            checkRef(op.returns, at, if (op.kind == "stream") STREAM_KINDS else OUTPUT_KINDS, "a result")
            checkAnnotations(op.annotations, op.kind, at)
            for (e in op.throws) {
                val d = ir.types[e]
                if (d == null) err("unknown-type", at, "Unknown error $e") else if (d.kind != "error") err("bad-throws", at, "throws $e: not an error type")
            }
            for (e in op.emits) {
                val d = ir.types[e]
                if (d == null) err("unknown-type", at, "Unknown event $e") else if (d.kind != "event") err("bad-emits", at, "emits $e: not an event type")
            }
            if (op.kind != "command" && op.emits.isNotEmpty()) err("emits-on-non-command", at, "Only commands emit events")
            val http = op.annotations.find("http")
            if (http != null) {
                val method = stringOrIdent(http.args["method"])?.uppercase() ?: ""
                val allowed = when (op.kind) {
                    "query" -> listOf("GET", "QUERY")
                    "command" -> listOf("POST", "PUT", "PATCH", "DELETE")
                    else -> emptyList()
                }
                if (method !in allowed) err("bad-http-method", at, "@http method must be one of ${allowed.joinToString(", ").ifEmpty { "(none for streams)" }}")
                val path = (http.args["path"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                if (path == null || !path.startsWith("/")) err("bad-http-path", at, "@http path must be a string starting with \"/\"")
                else for (m in HTTP_PARAM.findAll(path)) {
                    val name = m.groupValues[1]
                    if (op.args.none { it.name == name }) err("bad-http-param", at, "@http path parameter {$name} is not an argument")
                }
                val bodyName = stringOrIdent(http.args["body"])
                if (bodyName != null && bodyName != "*" && op.args.none { it.name == bodyName }) err("bad-http-body", at, "@http body $bodyName is not an argument")
                if (bodyName != null && method == "GET") err("bad-http-body", at, "GET bindings cannot take a body")
            }
            if (op.returns.isPage) {
                val hasPageArg = op.args.any { !it.type.isList && it.type.name == "PageArgs" } || op.args.any { it.name == "first" }
                if (!hasPageArg) err("page-args", at, "An operation returning Page<T> must accept page: PageArgs (or first/after)")
            } else if (op.annotations.any { it.name == "page" }) {
                err("page-on-non-page", at, "@page requires a Page<T> result")
            }
        }

        // --- views
        for (v in ir.views.values) {
            val at = "${v.type}.${v.name}"
            checkName(v.name, "View name", at)
            val t = ir.types[v.type]
            if (t == null) {
                err("unknown-type", at, "View on unknown type ${v.type}")
                continue
            }
            if (t.kind != "entity" && t.kind != "object" && t.kind != "union") {
                err("view-on-non-object", at, "Views apply to entities, objects and unions")
                continue
            }
            checkShape(ir, v.shape, TypeRef(kind = "named", name = t.name, nullable = false), at, ::err, setOf(at))
        }

        // --- reachability (warning)
        val reachable = mutableSetOf<String>()
        fun visit(t: TypeRef) {
            val n = t.baseName()
            if (n in reachable) return
            val d = ir.types[n] ?: return
            reachable.add(n)
            if (d.hasFields) for (f in d.fields) visit(f.type)
            if (d.kind == "union") for (m in d.members) visit(TypeRef(kind = "named", name = m, nullable = false))
            // An interface reaches its implementors: they are what a field of that type actually returns.
            if (d.kind == "object" && d.isInterface) {
                for (e in ir.types.values) if (e.kind == "entity" && n in e.implements) visit(TypeRef(kind = "named", name = e.name, nullable = false))
            }
            if (!t.isList) t.args?.forEach { visit(it) }
        }
        for (op in ir.ops.values) {
            visit(op.returns)
            // an error's payload is part of what the operation answers with
            for (e in op.throws) visit(TypeRef(kind = "named", name = e, nullable = false))
            for (e in op.emits) visit(TypeRef(kind = "named", name = e, nullable = false))
        }
        // rule 9 counts views, so a type reached only through one is not unreachable
        for (v in ir.views.values) visit(TypeRef(kind = "named", name = v.type, nullable = false))
        for (t in ir.types.values) {
            if (t.builtin || t.name in reachable) continue
            if (t.kind == "entity" || t.kind == "object" || t.kind == "union") warn("unreachable", t.name, "${t.kind} ${t.name} is not reachable from any operation")
        }
        return out
    }

    private fun checkShape(ir: RayfoldSchemaIR, shape: Shape, ref: TypeRef, at: String, err: (String, String, String) -> Unit, seenViews: Set<String>) {
        val typeName = ref.listBase().typeName
        val t = ir.types[typeName] ?: return
        val fields = if (t.kind == "union") emptyList() else ir.fieldsOf(ref) ?: emptyList()
        for (item in shape.items) {
            when (item.kind) {
                "field" -> {
                    val f = fields.find { it.name == item.name }
                    if (f == null) {
                        err("unknown-field", at, "${t.name} has no field ${item.name}")
                        continue
                    }
                    val sub = item.shape ?: continue
                    val subDef = ir.types[f.type.listBase().typeName]
                    if (subDef == null || !(subDef.hasFields || subDef.kind == "union")) err("shape-on-scalar", at, "${item.name} is scalar; it cannot have a sub-shape")
                    else checkShape(ir, sub, f.type, at, err, seenViews)
                }
                "spread" -> {
                    val key = "${item.type}.${item.view}"
                    val view = ir.views[key]
                    when {
                        view == null -> err("unknown-view", at, "Unknown view $key")
                        key in seenViews -> err("view-cycle", at, "View spread cycle through $key")
                        item.type != t.name && t.kind != "union" -> err("spread-type-mismatch", at, "Cannot spread $key into ${t.name}")
                        else -> checkShape(ir, view.shape, ref, at, err, seenViews + key)
                    }
                }
                "on" -> {
                    val cond = item.type ?: continue
                    val sub = ir.types[cond]
                    when {
                        sub == null -> err("unknown-type", at, "Unknown type $cond in ...on")
                        t.kind == "union" && cond !in t.members -> err("bad-type-condition", at, "$cond is not a member of ${t.name}")
                        t.kind == "object" && t.isInterface && !(sub.kind == "entity" && t.name in sub.implements) ->
                            err("bad-type-condition", at, "$cond does not implement ${t.name}")
                        else -> checkShape(ir, item.subShape, TypeRef(kind = "named", name = cond, nullable = false), at, err, seenViews)
                    }
                }
                "defer" -> checkShape(ir, item.subShape, ref, at, err, seenViews)
            }
        }
    }
}

// ------------------------------------------------------------------ IR as JSON

/**
 * The IR in the JSON form `@rayfold/schema` writes: the input of the schema hash, and what the manifest serves.
 * Keys present exactly when the TypeScript IR has them (optional fields only when set, flags only when true).
 */
object IrJson {
    /** The hashed form: every document member of spec 01 section 9.1 except `extensions`, which is excluded by rule. */
    fun of(ir: RayfoldSchemaIR): JsonObject = buildJsonObject {
        put("rayfold", ir.rayfold)
        put("types", JsonObject(ir.types.mapValues { type(it.value) }))
        put("ops", JsonObject(ir.ops.mapValues { op(it.value) }))
        put("views", JsonObject(ir.views.mapValues { view(it.value) }))
    }

    fun typeRef(t: TypeRef): JsonObject = buildJsonObject {
        put("kind", t.kind)
        if (t.isList) {
            put("of", typeRef(t.element))
            put("nullable", t.nullable)
        } else {
            put("name", t.typeName)
            put("nullable", t.nullable)
            t.args?.let { a -> put("args", JsonArray(a.map(::typeRef))) }
        }
    }

    private fun annotations(list: List<Annotation>) = JsonArray(list.map { a -> buildJsonObject { put("name", a.name); put("args", JsonObject(a.args)) } })

    private fun arg(a: ArgDef): JsonObject = buildJsonObject {
        put("name", a.name)
        a.description?.let { put("description", it) }
        put("type", typeRef(a.type))
        a.default?.let { put("default", it) }
        put("annotations", annotations(a.annotations))
    }

    internal fun field(f: FieldDef): JsonObject = buildJsonObject {
        put("name", f.name)
        f.description?.let { put("description", it) }
        put("type", typeRef(f.type))
        put("args", JsonArray(f.args.map(::arg)))
        f.default?.let { put("default", it) }
        put("annotations", annotations(f.annotations))
        put("ordinal", f.ordinal)
    }

    private fun type(t: TypeDef): JsonObject = buildJsonObject {
        put("kind", t.kind)
        put("name", t.name)
        t.description?.let { put("description", it) }
        put("annotations", annotations(t.annotations))
        if (t.builtin) put("builtin", true)
        when (t.kind) {
            "entity" -> {
                put("fields", JsonArray(t.fields.map(::field)))
                put("implements", JsonArray(t.implements.map { JsonPrimitive(it) }))
            }
            "object" -> {
                put("fields", JsonArray(t.fields.map(::field)))
                t.typeParams?.let { p -> put("typeParams", JsonArray(p.map { JsonPrimitive(it) })) }
                if (t.isInterface) put("interface", true)
            }
            "input", "error", "event" -> put("fields", JsonArray(t.fields.map(::field)))
            "enum" -> put("values", JsonArray(t.values.map { v ->
                buildJsonObject {
                    put("name", v.name)
                    v.description?.let { put("description", it) }
                    put("annotations", annotations(v.annotations))
                    put("ordinal", v.ordinal)
                }
            }))
            "union" -> put("members", JsonArray(t.members.map { JsonPrimitive(it) }))
        }
    }

    private fun op(o: OpDef): JsonObject = buildJsonObject {
        put("kind", o.kind)
        put("name", o.name)
        o.description?.let { put("description", it) }
        put("args", JsonArray(o.args.map(::arg)))
        put("returns", typeRef(o.returns))
        put("throws", JsonArray(o.throws.map { JsonPrimitive(it) }))
        put("emits", JsonArray(o.emits.map { JsonPrimitive(it) }))
        put("annotations", annotations(o.annotations))
    }

    private fun view(v: ViewDef): JsonObject = buildJsonObject {
        put("type", v.type)
        put("name", v.name)
        put("shape", shape(v.shape))
    }

    fun shape(s: Shape): JsonObject = buildJsonObject { put("items", JsonArray(s.items.map(::item))) }

    private fun item(i: ShapeItem): JsonObject = buildJsonObject {
        put("kind", i.kind)
        when (i.kind) {
            "field" -> {
                put("name", i.fieldName)
                i.alias?.let { put("alias", it) }
                i.args?.let { put("args", JsonObject(it)) }
                i.shape?.let { put("shape", shape(it)) }
                if (i.eager) put("eager", true)
                if (i.partial) put("partial", true)
            }
            "spread" -> {
                i.type?.let { put("type", it) }
                i.view?.let { put("view", it) }
            }
            "on" -> {
                i.type?.let { put("type", it) }
                put("shape", shape(i.subShape))
            }
            "defer" -> {
                i.label?.let { put("label", it) }
                put("shape", shape(i.subShape))
            }
        }
    }
}
