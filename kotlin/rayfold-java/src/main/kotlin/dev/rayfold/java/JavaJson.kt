package dev.rayfold.java

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.lang.reflect.Modifier
import java.math.BigDecimal
import java.math.BigInteger
import java.net.URI
import java.net.URL
import java.time.temporal.TemporalAccessor
import java.util.Optional
import java.util.UUID

/** Conversions between Java values and the JSON model the runtime works in. */
internal object JavaJson {
    private const val MAX_DEPTH = 64

    /**
     * JSON for a Java value: null, strings, booleans, numbers, enums by name, maps, iterables, arrays, streams,
     * Optional, records by component, java.time values, UUIDs and URIs as text, Duration as milliseconds, and the
     * public getters (getX, isX) of any other object. BigDecimal and BigInteger become exact text, which is how
     * Decimal and large Long values travel. A JsonElement passes through.
     */
    fun toJson(value: Any?): JsonElement = toJson(value, 0)

    private fun toJson(v: Any?, depth: Int): JsonElement {
        require(depth < MAX_DEPTH) { "Value nested deeper than $MAX_DEPTH levels (does it refer to itself?)" }
        return when (v) {
            null -> JsonNull
            is JsonElement -> v
            is String -> JsonPrimitive(v)
            is Char -> JsonPrimitive(v.toString())
            is Boolean -> JsonPrimitive(v)
            is BigDecimal -> JsonPrimitive(v.toPlainString())
            is BigInteger -> JsonPrimitive(v.toString())
            is Double, is Float -> JsonPrimitive((v as Number).toDouble())
            is Number -> JsonPrimitive(v.toLong())
            is Enum<*> -> JsonPrimitive(v.name)
            is Optional<*> -> toJson(v.orElse(null), depth + 1)
            is Map<*, *> -> JsonObject(v.entries.associate { (k, x) -> k.toString() to toJson(x, depth + 1) })
            is Iterable<*> -> JsonArray(v.map { toJson(it, depth + 1) })
            is java.util.stream.BaseStream<*, *> -> v.use { s -> JsonArray(s.iterator().asSequence().map { toJson(it, depth + 1) }.toList()) }
            is java.time.Duration -> JsonPrimitive(v.toMillis())
            is TemporalAccessor, is UUID, is URI, is URL -> JsonPrimitive(v.toString())
            is java.lang.Record -> JsonObject(v.javaClass.recordComponents.associate { c ->
                c.name to toJson(c.accessor.also { it.trySetAccessible() }.invoke(v), depth + 1)
            })
            else -> if (v.javaClass.isArray) {
                JsonArray((0 until java.lang.reflect.Array.getLength(v)).map { toJson(java.lang.reflect.Array.get(v, it), depth + 1) })
            } else bean(v, depth)
        }
    }

    /** The public getters of an object, as a JSON object with the property names (getTitle -> title). */
    private fun bean(v: Any, depth: Int): JsonObject {
        val out = sortedMapOf<String, JsonElement>()
        for (m in v.javaClass.methods) {
            if (m.parameterCount != 0 || Modifier.isStatic(m.modifiers) || m.declaringClass == Any::class.java) continue
            val bool = m.returnType == java.lang.Boolean.TYPE || m.returnType == java.lang.Boolean::class.java
            val property = when {
                m.name.startsWith("get") && m.name.length > 3 -> m.name.substring(3)
                m.name.startsWith("is") && m.name.length > 2 && bool -> m.name.substring(2)
                else -> continue
            }
            out[property.replaceFirstChar { it.lowercase() }] = toJson(m.also { it.trySetAccessible() }.invoke(v), depth + 1)
        }
        return JsonObject(out)
    }

    /** Java for JSON: null, String, Boolean, Long (whole numbers that fit), Double, LinkedHashMap and ArrayList. */
    fun fromJson(e: JsonElement?): Any? = when (e) {
        null, JsonNull -> null
        is JsonObject -> LinkedHashMap<String, Any?>().apply { for ((k, v) in e) put(k, fromJson(v)) }
        is JsonArray -> ArrayList<Any?>(e.size).apply { for (v in e) add(fromJson(v)) }
        is JsonPrimitive -> when {
            e.isString -> e.content
            e.booleanOrNull != null -> e.booleanOrNull
            else -> e.content.toLongOrNull() ?: e.content.toDouble()
        }
    }
}
