package dev.rayfold.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Argument validation and coercion at the system boundary (mirrors packages/server/src/args.ts). */
object Args {
    internal const val MAX_PAGE_FIRST = 200
    private const val MAX_FORMAT_INPUT = 10_000

    /**
     * [wire] reads each member under its wire name (`@http(name:)`, spec 04 section 8), as an HTTP binding receives it, and
     * names it that way in errors; the result is keyed by schema names either way.
     */
    fun coerce(ir: RayfoldSchemaIR, defs: List<ArgDef>, raw: JsonElement?, path: String, returns: TypeRef? = null, wire: Boolean = false): JsonObject {
        fun key(d: ArgDef) = if (wire) d.wireName else d.name
        if (raw != null && raw !is JsonNull && raw !is JsonObject) throw RayfoldException(Code.INVALID_ARGUMENT, "$path: expected an object")
        val input = raw as? JsonObject ?: JsonObject(emptyMap())
        for (k in input.keys) if (defs.none { key(it) == k }) throw RayfoldException(Code.INVALID_ARGUMENT, "$path.$k: unknown argument")
        val out = linkedMapOf<String, JsonElement>()
        for (d in defs) {
            val v = input[key(d)]
            val p = "$path.${key(d)}"
            if (v == null) {
                if (d.default != null) { out[d.name] = value(ir, d.type, d.default, p); continue }
                if (!d.type.nullable) throw RayfoldException(Code.INVALID_ARGUMENT, "$p: required")
                continue // absent stays absent, explicit null stays null: partial updates depend on the difference
            }
            if (v is JsonNull) {
                // a default fills only an absent value; it never masks an explicit null
                if (d.type.nullable) { out[d.name] = JsonNull; continue }
                throw RayfoldException(Code.INVALID_ARGUMENT, if (d.default != null) "$p: must not be null" else "$p: required")
            }
            val coerced = value(ir, d.type, v, p, wire)
            out[d.name] = coerced
            checkConstraints(ir, d.annotations, coerced, p, d.type)
        }
        // spec 01 section 6: a page may take `first` as an argument of its own rather than inside PageArgs, and is capped the same
        val first = (out["first"] as? JsonPrimitive)?.takeIf { returns?.isPage == true && !it.isString }?.contentOrNull?.toDoubleOrNull()
        if (first != null && first < 0) throw RayfoldException(Code.INVALID_ARGUMENT, "$path.first: must be >= 0")
        if (first != null && first > MAX_PAGE_FIRST) out["first"] = JsonPrimitive(MAX_PAGE_FIRST)
        return JsonObject(out)
    }

    private val NUMERIC = setOf("Int", "Long", "Float", "Decimal")

    /**
     * `@range(min, max)` on numbers and string/list lengths, `@format(pattern:)` on strings (spec 01 section 4): the
     * whole string must match, so `$` cannot be satisfied by a trailing line break.
     * Range goes by the declared type, not by how the value looks: a String "1984" is 4 characters, a Decimal "1984" is 1984.
     */
    fun checkConstraints(ir: RayfoldSchemaIR, annotations: List<Annotation>, v: JsonElement, path: String, type: TypeRef) {
        if (v is JsonNull) return
        annotations.find("range")?.let { r ->
            val min = r.args["min"].numberOrNull()
            val max = r.args["max"].numberOrNull()
            val n: Double? = when (v) {
                is JsonArray -> v.size.toDouble()
                is JsonPrimitive -> when {
                    !type.isList && type.name in NUMERIC -> v.contentOrNull?.toDoubleOrNull()
                    v.isString -> v.content.length.toDouble()
                    else -> v.contentOrNull?.toDoubleOrNull()
                }
                else -> null
            }
            if (n != null) {
                if (min != null && n < min) throw RayfoldException(Code.INVALID_ARGUMENT, "$path: must be >= ${fmtNum(min)}")
                if (max != null && n > max) throw RayfoldException(Code.INVALID_ARGUMENT, "$path: must be <= ${fmtNum(max)}")
            }
        }
        val pattern = (annotations.find("format")?.args?.get("pattern") as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (pattern != null && v is JsonPrimitive && v.isString) {
            val s = v.content
            // bounded before matching: backtracking cost and recursion depth grow with the input
            if (s.length > MAX_FORMAT_INPUT) throw RayfoldException(Code.INVALID_ARGUMENT, "$path: longer than $MAX_FORMAT_INPUT characters, too long to match $pattern")
            val ok = try {
                ir.formatRegex(pattern).matches(s)
            } catch (e: StackOverflowError) {
                throw RayfoldException(Code.INVALID_ARGUMENT, "$path: too complex to match $pattern")
            }
            if (!ok) throw RayfoldException(Code.INVALID_ARGUMENT, "$path: must match $pattern")
        }
    }

    private fun fmtNum(d: Double): String = if (d == Math.floor(d) && !d.isInfinite()) d.toLong().toString() else d.toString()

    fun value(ir: RayfoldSchemaIR, t: TypeRef, v: JsonElement, path: String, wire: Boolean = false): JsonElement {
        if (v is JsonNull) {
            if (t.nullable) return JsonNull
            throw RayfoldException(Code.INVALID_ARGUMENT, "$path: must not be null")
        }
        if (t.isList) {
            val arr = v as? JsonArray ?: throw RayfoldException(Code.INVALID_ARGUMENT, "$path: expected a list")
            return JsonArray(arr.mapIndexed { i, x -> value(ir, t.element, x, "$path.$i", wire) })
        }
        val def = ir.types[t.name] ?: throw RayfoldException(Code.INTERNAL, "$path: unknown type ${t.name}")
        return when (def.kind) {
            "scalar" -> scalar(t.typeName, v, path)
            "enum" -> {
                val s = (v as? JsonPrimitive)?.takeIf { it.isString }?.content
                if (s == null || def.values.none { it.name == s }) throw RayfoldException(Code.INVALID_ARGUMENT, "$path: expected one of ${def.values.joinToString(", ") { it.name }}")
                v
            }
            "input" -> {
                if (v !is JsonObject) throw RayfoldException(Code.INVALID_ARGUMENT, "$path: expected ${t.name}")
                val obj = coerce(ir, def.fields.map { ArgDef(it.name, it.description, it.type, it.default, it.annotations) }, v, path, wire = wire).toMutableMap()
                if (t.name == "PageArgs") {
                    val first = (obj["first"] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
                    if (first != null && first > MAX_PAGE_FIRST) obj["first"] = JsonPrimitive(MAX_PAGE_FIRST)
                    if (first != null && first < 0) throw RayfoldException(Code.INVALID_ARGUMENT, "$path.first: must be >= 0")
                    val offset = (obj["offset"] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
                    if (offset != null && offset < 0) throw RayfoldException(Code.INVALID_ARGUMENT, "$path.offset: must be >= 0")
                }
                JsonObject(obj)
            }
            else -> throw RayfoldException(Code.INVALID_ARGUMENT, "$path: $t is not an input type")
        }
    }

    private val RFC3339 = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$")
    private val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    private val DECIMAL = Regex("^-?\\d+(\\.\\d+)?$")
    private val LONG_TEXT = Regex("^-?\\d+$")

    fun scalar(name: String, v: JsonElement, path: String): JsonElement {
        val p = v as? JsonPrimitive ?: return if (name == "JSON") v else bad(path, "scalar $name")
        val str = p.takeIf { it.isString }?.content
        // strict JSON numbers only: NaN, Infinity, 1d and 01 are not numbers, whatever a lenient parser let through
        val num = if (!p.isString && StrictJson.isNumber(p.content)) p.content.toDoubleOrNull()?.takeIf { it.isFinite() } else null
        val isInt = num != null && StrictJson.integerOrNull(p) != null
        return when (name) {
            "ID" -> if (str != null && str.isNotEmpty()) p else if (isInt) JsonPrimitive(p.content) else bad(path, "ID")
            "String" -> if (str != null) p else bad(path, "String")
            "Int" -> if (isInt && p.content.toIntOrNull() != null) p else bad(path, "Int")
            "Long" -> if ((isInt && p.content.toLongOrNull() != null) || (str != null && LONG_TEXT.matches(str) && str.toLongOrNull() != null)) p else bad(path, "Long")
            "Float" -> if (num != null) p else bad(path, "Float")
            "Boolean" -> if (!p.isString && (p.content == "true" || p.content == "false")) p else bad(path, "Boolean")
            "Decimal" -> if (str != null && DECIMAL.matches(str)) p else if (num != null) JsonPrimitive(p.content) else bad(path, "Decimal")
            "Instant" -> if (str != null && RFC3339.matches(str)) p else bad(path, "Instant (RFC 3339)")
            "Date" -> if (str != null && DATE.matches(str)) p else bad(path, "Date (YYYY-MM-DD)")
            "Duration" -> if ((num != null && num >= 0) || (str != null && Regex("^\\d+(ms|s|m|h|d)$").matches(str))) p else bad(path, "Duration")
            "Bytes" -> if (str != null && Regex("^[A-Za-z0-9_-]*$").matches(str)) p else bad(path, "Bytes (base64url)")
            "JSON" -> v
            else -> p
        }
    }

    private fun bad(path: String, want: String): Nothing = throw RayfoldException(Code.INVALID_ARGUMENT, "$path: expected $want")

    /** Replace `{ "$ref": "id.path" }` with values from earlier results (spec/03 section 2). */
    fun resolveRefs(value: JsonElement, lookup: (Int, List<String>) -> JsonElement?, at: String): JsonElement = when (value) {
        is JsonArray -> JsonArray(value.mapIndexed { i, x -> resolveRefs(x, lookup, "$at.$i") })
        is JsonObject -> {
            val ref = (value["\$ref"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (ref != null && value.size == 1) {
                val parts = ref.split(".")
                val id = parts[0].toIntOrNull()
                if (id == null || id <= 0) throw RayfoldException(Code.INVALID_ARGUMENT, "$at: bad \$ref \"$ref\"")
                lookup(id, parts.drop(1)) ?: throw RayfoldException(Code.INVALID_ARGUMENT, "$at: \$ref $ref resolved to nothing")
            } else JsonObject(value.mapValues { (k, v) -> resolveRefs(v, lookup, "$at.$k") })
        }
        else -> value
    }

    /** `{ "$ref": "..." }`: a value known only once an earlier op has run. */
    fun isRef(v: JsonElement): Boolean = v is JsonObject && v.size == 1 && (v["\$ref"] as? JsonPrimitive)?.isString == true

    fun collectRefs(value: JsonElement, out: MutableSet<Int> = linkedSetOf()): Set<Int> {
        when (value) {
            is JsonArray -> value.forEach { collectRefs(it, out) }
            is JsonObject -> {
                val ref = (value["\$ref"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                if (ref != null && value.size == 1) out.add(ref.substringBefore(".").toIntOrNull() ?: -1)
                else value.values.forEach { collectRefs(it, out) }
            }
            else -> {}
        }
        return out
    }

    fun getPath(value: JsonElement?, path: List<String>): JsonElement? {
        var cur = value
        for (p in path) {
            cur = when (cur) {
                is JsonObject -> cur[p]
                is JsonArray -> cur.getOrNull(p.toIntOrNull() ?: return null)
                else -> return null
            } ?: return null
        }
        return cur
    }
}
