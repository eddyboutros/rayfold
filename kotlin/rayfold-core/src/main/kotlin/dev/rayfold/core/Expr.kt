package dev.rayfold.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.math.BigDecimal

/** Policy expression evaluation over the IR's JSON AST (spec/01 section 5). Missing paths are null; ordering values that do not order throws [ExprError]. */
class ExprEnv(val viewer: JsonElement, val args: JsonElement, val self: JsonElement, val now: () -> Long = System::currentTimeMillis)

/** An expression that cannot be evaluated, such as `"high" > 3`; [Policy] fails closed on it. */
class ExprError(message: String) : RuntimeException(message)

object Expr {
    fun eval(e: JsonObject, env: ExprEnv): JsonElement {
        return when (e["k"]?.jsonPrimitive?.content) {
            "lit" -> e["v"] ?: JsonNull
            "path" -> {
                var cur: JsonElement = when (e["root"]?.jsonPrimitive?.content) {
                    "viewer" -> env.viewer
                    "args" -> env.args
                    else -> env.self
                }
                for (p in (e["path"] as JsonArray)) {
                    val o = cur as? JsonObject ?: return JsonNull
                    cur = o[p.jsonPrimitive.content] ?: return JsonNull
                }
                cur
            }
            "not" -> JsonPrimitive(!truthy(eval(e["e"] as JsonObject, env)))
            "list" -> JsonArray((e["items"] as JsonArray).map { eval(it as JsonObject, env) })
            "call" -> {
                val a = (e["args"] as JsonArray).map { eval(it as JsonObject, env) }
                when (e["fn"]?.jsonPrimitive?.content) {
                    "has" -> JsonPrimitive((a.getOrNull(0) as? JsonArray)?.any { looseEq(it, a.getOrNull(1) ?: JsonNull) } == true)
                    "len" -> when (val x = a.getOrNull(0)) {
                        is JsonArray -> JsonPrimitive(x.size)
                        is JsonPrimitive -> if (x.isString) JsonPrimitive(x.content.length) else JsonNull
                        else -> JsonNull
                    }
                    "now" -> JsonPrimitive(env.now())
                    else -> JsonNull
                }
            }
            "bin" -> {
                val op = e["op"]?.jsonPrimitive?.content
                if (op == "&&") return JsonPrimitive(truthy(eval(e["l"] as JsonObject, env)) && truthy(eval(e["r"] as JsonObject, env)))
                if (op == "||") return JsonPrimitive(truthy(eval(e["l"] as JsonObject, env)) || truthy(eval(e["r"] as JsonObject, env)))
                val l = eval(e["l"] as JsonObject, env)
                val r = eval(e["r"] as JsonObject, env)
                when (op) {
                    "==" -> JsonPrimitive(looseEq(l, r))
                    "!=" -> JsonPrimitive(!looseEq(l, r))
                    "in" -> JsonPrimitive((r as? JsonArray)?.any { looseEq(l, it) } == true)
                    else -> JsonPrimitive(order(l, r)?.let { cmp(op, it) } ?: false)
                }
            }
            else -> JsonNull
        }
    }

    private fun cmp(op: String?, c: Int): Boolean = when (op) {
        "<" -> c < 0; "<=" -> c <= 0; ">" -> c > 0; ">=" -> c >= 0; else -> false
    }

    fun truthy(v: JsonElement): Boolean = when (v) {
        is JsonNull -> false
        is JsonPrimitive -> !(v.content == "false" && !v.isString)
        else -> true
    }

    /**
     * null == null only. A number equals a number or a numeric string of the same exact value (Decimal and Long travel
     * as strings, ids may come as numbers); other scalars compare by text.
     */
    fun looseEq(a: JsonElement, b: JsonElement): Boolean {
        if (a is JsonNull) return b is JsonNull
        if (b is JsonNull) return false
        if (a !is JsonPrimitive || b !is JsonPrimitive) return false
        if (!a.isString || !b.isString) {
            val an = decimal(a)
            val bn = decimal(b)
            if (an != null && bn != null) return an.compareTo(bn) == 0
        }
        return a.content == b.content
    }

    /** Plain decimal text, as Decimal and Long are written on the wire (the same rule as the TypeScript runtime). */
    private val NUMERIC_STRING = Regex("-?[0-9]+(\\.[0-9]+)?")

    /**
     * Sign of l - r, or null when either side is null (every comparison with null is false). Numbers and numeric
     * strings order by exact value, other strings lexically; anything else does not order and throws [ExprError].
     */
    private fun order(l: JsonElement, r: JsonElement): Int? {
        if (l is JsonNull || r is JsonNull) return null
        val a = l as? JsonPrimitive
        val b = r as? JsonPrimitive
        if (a != null && b != null) {
            // Decimal and Long travel as text, so two numeric strings order by value too ("900" < "1000").
            val an = decimal(a)
            val bn = decimal(b)
            if (an != null && bn != null) return an.compareTo(bn)
            if (a.isString && b.isString) return a.content.compareTo(b.content)
        }
        throw ExprError("cannot order ${describe(l)} and ${describe(r)}")
    }

    /** A JSON number, or a string holding one, as an exact decimal (no rounding past 2^53); null for anything else. */
    private fun decimal(p: JsonPrimitive): BigDecimal? {
        val numeric = if (p.isString) NUMERIC_STRING.matches(p.content) else StrictJson.isNumber(p.content)
        return if (numeric) p.content.toBigDecimalOrNull() else null
    }

    private fun describe(v: JsonElement): String = when (v) {
        is JsonNull -> "null"
        is JsonArray -> "a list"
        is JsonObject -> "an object"
        is JsonPrimitive -> if (v.isString) "a string" else if (v.content == "true" || v.content == "false") "a boolean" else "a number"
    }

    fun referencesViewer(e: JsonObject): Boolean = paths(e).any { it == "viewer" }

    fun paths(e: JsonObject, out: MutableList<String> = mutableListOf()): List<String> {
        when (e["k"]?.jsonPrimitive?.content) {
            "path" -> out.add((e["root"] ?: error("path expression without a root")).jsonPrimitive.content)
            "bin" -> { paths(e["l"] as JsonObject, out); paths(e["r"] as JsonObject, out) }
            "not" -> paths(e["e"] as JsonObject, out)
            "call" -> (e["args"] as JsonArray).forEach { paths(it as JsonObject, out) }
            "list" -> (e["items"] as JsonArray).forEach { paths(it as JsonObject, out) }
        }
        return out
    }
}
