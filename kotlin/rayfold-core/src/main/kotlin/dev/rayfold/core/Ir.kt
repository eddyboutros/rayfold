package dev.rayfold.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.nullable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Rayfold schema IR (spec/01 section 9), as produced by `@rayfold/schema`. */
@Serializable
data class TypeRef(
    val kind: String,
    val name: String? = null,
    val nullable: Boolean = false,
    val args: List<TypeRef>? = null,
    val of: TypeRef? = null,
) {
    val isList: Boolean get() = kind == "list"
    val isPage: Boolean get() = kind == "named" && name == "Page"

    /** Innermost named type through lists and Page<T>. */
    fun baseName(): String = when {
        isList -> element.baseName()
        isPage && !args.isNullOrEmpty() -> args[0].baseName()
        else -> typeName
    }

    /** Innermost named type through lists only (Page stays Page). */
    fun listBase(): TypeRef = if (isList) element.listBase() else this

    override fun toString(): String {
        val q = if (nullable) "?" else ""
        return when {
            isList -> "[$of]$q"
            !args.isNullOrEmpty() -> "$name<${args.joinToString(", ")}>$q"
            else -> "$name$q"
        }
    }
}

@Serializable
data class Annotation(val name: String, val args: Map<String, JsonElement> = emptyMap())

/**
 * A default as the IR JSON carries it: `"default": null` is an explicit null default, which a missing member is not,
 * so it decodes to [kotlinx.serialization.json.JsonNull] instead of to no default. The schema hash tells them apart.
 */
object DefaultValueSerializer : KSerializer<JsonElement?> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().nullable.descriptor
    override fun deserialize(decoder: Decoder): JsonElement? = (decoder as? JsonDecoder)?.decodeJsonElement()
        ?: throw IllegalStateException("the schema IR is read from JSON only")
    override fun serialize(encoder: Encoder, value: JsonElement?) = encoder.encodeNullableSerializableValue(JsonElement.serializer(), value)
}

@Serializable
data class ArgDef(
    val name: String,
    val description: String? = null,
    val type: TypeRef,
    @Serializable(with = DefaultValueSerializer::class) val default: JsonElement? = null,
    val annotations: List<Annotation> = emptyList(),
)

@Serializable
data class FieldDef(
    val name: String,
    val description: String? = null,
    val type: TypeRef,
    val args: List<ArgDef> = emptyList(),
    @Serializable(with = DefaultValueSerializer::class) val default: JsonElement? = null,
    val annotations: List<Annotation> = emptyList(),
    val ordinal: Int = 0,
)

@Serializable
data class EnumValueDef(
    val name: String,
    val description: String? = null,
    val annotations: List<Annotation> = emptyList(),
    val ordinal: Int = 0,
)

@Serializable
data class TypeDef(
    val kind: String,
    val name: String,
    val description: String? = null,
    val annotations: List<Annotation> = emptyList(),
    val builtin: Boolean = false,
    val fields: List<FieldDef> = emptyList(),
    val implements: List<String> = emptyList(),
    val typeParams: List<String>? = null,
    @SerialName("interface") val isInterface: Boolean = false,
    val values: List<EnumValueDef> = emptyList(),
    val members: List<String> = emptyList(),
) {
    val hasFields: Boolean get() = kind in FIELDED
    val isScalarLike: Boolean get() = kind == "scalar" || kind == "enum"

    companion object {
        val FIELDED = setOf("entity", "object", "input", "error", "event")
    }
}

@Serializable
data class OpDef(
    val kind: String,
    val name: String,
    val description: String? = null,
    val args: List<ArgDef> = emptyList(),
    val returns: TypeRef,
    val throws: List<String> = emptyList(),
    val emits: List<String> = emptyList(),
    val annotations: List<Annotation> = emptyList(),
)

@Serializable
data class ShapeItem(
    val kind: String,
    val name: String? = null,
    val alias: String? = null,
    val args: Map<String, JsonElement>? = null,
    val shape: Shape? = null,
    val eager: Boolean = false,
    val partial: Boolean = false,
    val type: String? = null,
    val view: String? = null,
    val label: String? = null,
)

/** The element type of a list type. */
val TypeRef.element: TypeRef get() = of ?: error("list type without an element type")

/** The name of a named type. */
val TypeRef.typeName: String get() = name ?: error("$kind type without a name")

/** The nested shape of an `on` or `defer` item. */
val ShapeItem.subShape: Shape get() = shape ?: error("$kind shape item without a nested shape")

/** The field name of a field item. */
val ShapeItem.fieldName: String get() = name ?: error("$kind shape item without a field name")

@Serializable
data class Shape(val items: List<ShapeItem> = emptyList())

@Serializable
data class ViewDef(val type: String, val name: String, val shape: Shape)

@Serializable
data class RayfoldSchemaIR(
    val rayfold: String,
    val types: Map<String, TypeDef>,
    val ops: Map<String, OpDef>,
    val views: Map<String, ViewDef> = emptyMap(),
) {
    fun type(name: String): TypeDef? = types[name]

    @kotlinx.serialization.Transient
    private val formats = java.util.concurrent.ConcurrentHashMap<String, Regex>()

    /** A `@format` pattern, compiled once per schema; throws [java.util.regex.PatternSyntaxException] for a bad one. */
    fun formatRegex(pattern: String): Regex = formats.getOrPut(pattern) { Regex(pattern) }

    /** Compiles every `@format` pattern, so a bad one is a schema error at startup instead of a 500 on some request. */
    fun checkFormats() {
        fun visit(annotations: List<Annotation>, where: String) {
            val pattern = (annotations.find("format")?.args?.get("pattern") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return
            try {
                formatRegex(pattern)
            } catch (e: IllegalArgumentException) {
                throw IllegalArgumentException("Schema error: @format pattern $pattern on $where does not compile: ${e.message?.lineSequence()?.firstOrNull()}", e)
            }
        }
        for ((name, op) in ops) for (a in op.args) visit(a.annotations, "$name(${a.name})")
        for ((name, t) in types) for (f in t.fields) {
            visit(f.annotations, "$name.${f.name}")
            for (a in f.args) visit(a.annotations, "$name.${f.name}(${a.name})")
        }
    }

    /** Fields of a type reference, with Page<T> parameters substituted. */
    fun fieldsOf(t: TypeRef): List<FieldDef>? {
        if (t.isList) return fieldsOf(t.element)
        val d = types[t.name] ?: return null
        if (d.kind == "object" && !d.typeParams.isNullOrEmpty() && t.args != null) {
            val bind = d.typeParams.zip(t.args).toMap()
            return d.fields.map { f -> f.copy(type = substitute(f.type, bind)) }
        }
        return if (d.hasFields) d.fields else null
    }

    private fun substitute(t: TypeRef, bind: Map<String, TypeRef>): TypeRef {
        if (t.isList) return t.copy(of = substitute(t.element, bind))
        val b = bind[t.name]
        if (b != null) return b.copy(nullable = t.nullable || b.nullable)
        return if (t.args != null) t.copy(args = t.args.map { substitute(it, bind) }) else t
    }

    fun isScalarLike(t: TypeRef): Boolean = types[t.baseName()]?.isScalarLike == true

    companion object {
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = false; explicitNulls = false }
        fun parse(text: String): RayfoldSchemaIR = json.decodeFromString(serializer(), text)
    }
}

fun List<Annotation>.find(name: String): Annotation? = firstOrNull { it.name == name }

/** The IR a public manifest shows: `allow` and `deny` keep their names but lose their expressions. */
fun RayfoldSchemaIR.withoutPolicies(): RayfoldSchemaIR {
    fun strip(a: List<Annotation>) = a.map { if (it.name == "allow" || it.name == "deny") Annotation(it.name) else it }
    fun args(a: List<ArgDef>) = a.map { it.copy(annotations = strip(it.annotations)) }
    return copy(
        types = types.mapValues { (_, t) ->
            t.copy(
                annotations = strip(t.annotations),
                fields = t.fields.map { f -> f.copy(annotations = strip(f.annotations), args = args(f.args)) },
                values = t.values.map { v -> v.copy(annotations = strip(v.annotations)) },
            )
        },
        ops = ops.mapValues { (_, o) -> o.copy(annotations = strip(o.annotations), args = args(o.args)) },
    )
}

/** `{ "$ident": "x" }` -> "x" */
fun JsonElement?.identOrNull(): String? = (this as? JsonObject)?.get("\$ident")?.jsonPrimitive?.contentOrNull

/** `{ "$duration": ms }` -> ms */
fun JsonElement?.durationMs(): Long? = (this as? JsonObject)?.get("\$duration")?.jsonPrimitive?.contentOrNull?.toDoubleOrNull()?.toLong()

/** `{ "$expr": {...} }` -> the expression AST */
fun JsonElement?.exprOrNull(): JsonObject? = (this as? JsonObject)?.get("\$expr")?.jsonObject

fun JsonElement?.numberOrNull(): Double? = (this as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
