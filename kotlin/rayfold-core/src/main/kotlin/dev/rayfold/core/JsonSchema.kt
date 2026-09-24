package dev.rayfold.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** JSON Schema 2020-12 for Rayfold types, shared by the MCP bridge and OpenAPI (mirrors jsonSchemaFor and withRange in mcp.ts). */
object JsonSchema {
    const val DIALECT = "https://json-schema.org/draft/2020-12/schema"

    internal fun obj(vararg pairs: Pair<String, JsonElement>): JsonObject = JsonObject(linkedMapOf(*pairs))
    internal fun str(s: String): JsonPrimitive = JsonPrimitive(s)
    private fun types(vararg t: String) = JsonArray(t.map { str(it) })

    private val SCALARS: Map<String, JsonObject> = mapOf(
        "ID" to obj("type" to str("string")),
        "String" to obj("type" to str("string")),
        "Int" to obj("type" to str("integer")),
        "Long" to obj("type" to types("integer", "string")),
        "Float" to obj("type" to str("number")),
        "Boolean" to obj("type" to str("boolean")),
        "Decimal" to obj("type" to str("string"), "pattern" to str("^-?\\d+(\\.\\d+)?$")),
        "Instant" to obj("type" to str("string"), "format" to str("date-time")),
        "Date" to obj("type" to str("string"), "format" to str("date")),
        "Duration" to obj("type" to types("string", "integer")),
        "Bytes" to obj("type" to str("string"), "contentEncoding" to str("base64url")),
        "JSON" to obj(),
    )

    /**
     * The schema of [t]. Fielded types land in [defs] (keyed by name, `Page_<T>` for pages) and are referenced as
     * `#/$defs/<key>`; [forInput] leaves out fields that take arguments. [partial] leaves every field of a fielded type
     * optional: a result projected through a shape (the default view, for an MCP tool call) may leave out fields the
     * type declares, so a schema requiring them would refuse it. [wire] names input fields as HTTP bindings read them
     * (`@http(name:)`, spec 04 section 8), for the OpenAPI document.
     */
    fun forType(ir: RayfoldSchemaIR, t: TypeRef, defs: MutableMap<String, JsonElement>, forInput: Boolean, partial: Boolean = false, wire: Boolean = false): JsonObject {
        fun nullable(s: JsonObject) = if (t.nullable) obj("anyOf" to JsonArray(listOf(s, obj("type" to str("null"))))) else s
        if (t.isList) {
            val of = t.of ?: error("list type without an element type")
            return nullable(obj("type" to str("array"), "items" to forType(ir, of, defs, forInput, partial, wire)))
        }
        val name = t.name ?: return obj()
        val def = ir.types[name] ?: return obj()
        return when (def.kind) {
            "scalar" -> nullable(SCALARS[name] ?: obj("type" to types("string", "number")))
            "enum" -> nullable(obj("type" to str("string"), "enum" to JsonArray(def.values.map { str(it.name) })))
            "union" -> nullable(obj("anyOf" to JsonArray(def.members.map { forType(ir, TypeRef("named", it), defs, forInput, partial, wire) })))
            else -> {
                val first = t.args?.firstOrNull()
                val key = if (name == "Page" && first != null) "Page_${first.baseName()}" else name
                if (key !in defs) {
                    defs[key] = obj() // placeholder for recursion
                    val params = def.typeParams
                    val targs = t.args
                    val fields = if (def.kind == "object" && !params.isNullOrEmpty() && targs != null) substitute(def.fields, params, targs) else def.fields
                    val properties = linkedMapOf<String, JsonElement>()
                    val required = mutableListOf<JsonElement>()
                    if (def.kind == "entity") properties["\$type"] = obj("const" to str(def.name))
                    for (f in fields) {
                        if (forInput && f.args.isNotEmpty()) continue
                        val s = withRange(forType(ir, f.type, defs, forInput, partial, wire), f.annotations, f.type.baseName())
                        val prop = if (wire) f.wireName else f.name
                        properties[prop] = described(s, f.description)
                        if (!partial && !f.type.nullable && f.default == null) required.add(str(prop))
                    }
                    val schema = linkedMapOf<String, JsonElement>("type" to str("object"), "properties" to JsonObject(properties), "additionalProperties" to JsonPrimitive(false))
                    if (required.isNotEmpty()) schema["required"] = JsonArray(required)
                    if (!def.description.isNullOrEmpty()) schema["description"] = str(def.description)
                    defs[key] = JsonObject(schema)
                }
                nullable(obj("\$ref" to str("#/\$defs/$key")))
            }
        }
    }

    internal fun described(s: JsonObject, description: String?): JsonObject =
        if (description.isNullOrEmpty()) s else JsonObject(s + ("description" to str(description)))

    private fun substitute(fields: List<FieldDef>, params: List<String>, args: List<TypeRef>): List<FieldDef> {
        val bind = params.zip(args).toMap()
        fun sub(t: TypeRef): TypeRef {
            if (t.isList) return TypeRef("list", of = t.of?.let { sub(it) }, nullable = t.nullable)
            val b = bind[t.name] ?: return t
            return b.copy(nullable = t.nullable || b.nullable)
        }
        return fields.map { it.copy(type = sub(it.type)) }
    }

    /**
     * `@range` as keywords a validator understands (minimum/maximum on numbers, minLength/maxLength on strings) plus
     * `x-rayfold-range`, which also covers Decimal (text on the wire). The declared type picks the keyword.
     */
    fun withRange(s: JsonObject, annotations: List<Annotation>, typeName: String): JsonObject {
        val r = annotations.find("range") ?: return s
        val min = r.args["min"]?.takeIf { isNumber(it) }
        val max = r.args["max"]?.takeIf { isNumber(it) }
        val range = linkedMapOf<String, JsonElement>()
        min?.let { range["min"] = it }
        max?.let { range["max"] = it }
        val out = LinkedHashMap<String, JsonElement>(s)
        out["x-rayfold-range"] = JsonObject(range)
        val numeric = typeName == "Int" || typeName == "Long" || typeName == "Float"
        if (numeric || typeName == "String") {
            min?.let { out[if (numeric) "minimum" else "minLength"] = it }
            max?.let { out[if (numeric) "maximum" else "maxLength"] = it }
        }
        return JsonObject(out)
    }

    private fun isNumber(v: JsonElement) = v is JsonPrimitive && v !is JsonNull && !v.isString && StrictJson.isNumber(v.content)
}
