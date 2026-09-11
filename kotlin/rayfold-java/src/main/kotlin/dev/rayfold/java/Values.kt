package dev.rayfold.java

import dev.rayfold.core.RayfoldContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.math.BigDecimal

/**
 * The arguments of an operation, or one parent object handed to a field loader, read by name. A getter returns null
 * when the value is absent or null; `has` tells the two apart.
 */
class Values(private val json: JsonObject) {
    private fun primitive(name: String): JsonPrimitive? = (json[name] as? JsonPrimitive)?.takeUnless { it is JsonNull }

    /** True when the value is present, even if it is null. */
    fun has(name: String): Boolean = name in json

    /** The value as plain Java: String, Boolean, Long, Double, Map or List. */
    fun get(name: String): Any? = JavaJson.fromJson(json[name])

    fun getString(name: String): String? = primitive(name)?.content
    fun getInt(name: String): Int? = primitive(name)?.content?.toIntOrNull()
    fun getLong(name: String): Long? = primitive(name)?.content?.toLongOrNull()
    fun getDouble(name: String): Double? = primitive(name)?.content?.toDoubleOrNull()
    fun getBoolean(name: String): Boolean? = primitive(name)?.booleanOrNull

    /** Decimal values travel as text; this reads them exactly. */
    fun getDecimal(name: String): BigDecimal? = primitive(name)?.content?.toBigDecimalOrNull()

    /** A nested object (an input type, say). */
    fun getValues(name: String): Values? = (json[name] as? JsonObject)?.let(::Values)

    fun getList(name: String): List<Any?>? = (json[name] as? JsonArray)?.map { JavaJson.fromJson(it) }

    @Suppress("UNCHECKED_CAST")
    fun toMap(): Map<String, Any?> = JavaJson.fromJson(json) as Map<String, Any?>

    /** The JSON form, for code that works with kotlinx.serialization directly. */
    fun json(): JsonObject = json

    override fun toString(): String = json.toString()
}

/** What a resolver knows about the request it serves. */
class Context internal constructor(private val ctx: RayfoldContext) {
    /** The viewer the transport resolved (the signed-in user), or null for an anonymous request. */
    fun viewer(): Values? = (ctx.viewer as? JsonObject)?.let(::Values)

    /** The viewer's `id`, the usual owner check in a resolver. */
    fun viewerId(): String? = viewer()?.getString("id")

    /** True when the command runs as a dry run (`@simulate`): report what would happen, change nothing. */
    fun isSimulate(): Boolean = ctx.simulate

    fun opName(): String = ctx.opName

    /** True once the client went away or the deadline passed; long work should stop. */
    fun isCancelled(): Boolean = ctx.isCancelled()

    /** The runtime's context, for anything this class does not cover. */
    fun raw(): RayfoldContext = ctx
}
