package dev.rayfold.core

import dev.rayfold.core.JsonSchema.obj
import dev.rayfold.core.JsonSchema.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * OpenAPI 3.2 generated from the schema and its HTTP bindings (spec 04 section 8; mirrors packages/server/src/openapi.ts).
 * The document comes from the same IR the runtime enforces, so the published contract and the rules cannot drift.
 * 3.2 is required for the QUERY operation.
 */
object OpenApi {
    fun document(ir: RayfoldSchemaIR, title: String = "Rayfold API", version: String = "0.1", prefix: String = ""): JsonObject {
        val defs = linkedMapOf<String, JsonElement>()
        fun schema(t: TypeRef, input: Boolean) = JsonSchema.forType(ir, t, defs, input)
        val paths = linkedMapOf<String, MutableMap<String, JsonElement>>()

        // calls to schema() follow the TS order, so components.schemas keeps its key order
        for (b in Bindings.of(ir)) {
            val op = b.op
            val parameters = mutableListOf<JsonElement>()
            for (name in b.params) parameters.add(param(ir, op, name, "path", true, defs))
            if (b.method == "GET") {
                for (a in op.args) if (a.name !in b.params) parameters.add(param(ir, op, a.name, "query", !a.type.nullable && a.default == null, defs))
                parameters.add(SHAPE_PARAM)
            }
            val versioned = returnsVersionedEntity(ir, op)
            if (op.kind == "command" && b.method == "POST") {
                val optOut = op.annotations.find("idempotent")?.args?.get("value") == JsonPrimitive(false)
                parameters.add(obj(
                    "name" to str("Idempotency-Key"), "in" to str("header"), "required" to JsonPrimitive(!optOut),
                    "description" to str("Replays the original response on retry"),
                    "schema" to obj("type" to str("string"), "minLength" to JsonPrimitive(16), "maxLength" to JsonPrimitive(128)),
                ))
            }
            // the binding honours If-Match on every method, so every versioned command offers it (and lists 412)
            if (op.kind == "command" && versioned) {
                parameters.add(obj(
                    "name" to str("If-Match"), "in" to str("header"), "required" to JsonPrimitive(false),
                    "description" to str("Entity version from a previous response; 412 with the current entity when stale"),
                    "schema" to obj("type" to str("string")),
                ))
            }
            val operation = linkedMapOf<String, JsonElement>("operationId" to str(op.name), "parameters" to JsonArray(parameters))
            if (!op.description.isNullOrEmpty()) operation["summary"] = str(op.description)
            b.body?.let { body ->
                val bodyArgs = if (body == "*") op.args.filter { it.name !in b.params } else op.args.filter { it.name == body }
                val bodySchema = if (body == "*") argsObject(ir, bodyArgs, defs) else bodyArgs.firstOrNull()?.let { schema(it.type, true) } ?: obj()
                val types = if (b.method == "PATCH") listOf("application/merge-patch+json", "application/json") else listOf("application/json")
                val required = bodyArgs.any { !it.type.nullable && it.default == null }
                operation["requestBody"] = obj("required" to JsonPrimitive(required), "content" to JsonObject(types.associateWith { obj("schema" to bodySchema) }))
            }
            val ok = obj(
                "description" to str("Result in the requested shape (default view when no shape is given)"),
                "content" to obj("application/json" to obj("schema" to schema(op.returns, false))),
            )
            val responses = linkedMapOf<String, JsonElement>()
            responses[if (b.method == "POST" && !b.location.isNullOrEmpty()) "201" else "200"] = ok
            if (op.kind == "query") responses["304"] = obj("description" to str("Not modified (ETag revalidation)"))
            responses["400"] = problemRef("Invalid argument, including schema constraints such as @range")
            if (guarded(op.annotations) || typeHasPolicy(ir, op.returns, mutableSetOf())) {
                responses["401"] = problemRef("Sign-in required by a policy")
                responses["403"] = problemRef("Denied by a policy")
            }
            if (op.kind == "command" && versioned) responses["412"] = problemRef("VersionConflict: data.current carries the entity as stored")
            if (op.throws.isNotEmpty()) {
                val oneOf = JsonArray(op.throws.map { t -> domainProblem(t, schema(TypeRef("named", t), false)) })
                responses["422"] = obj(
                    "description" to str("Declared domain errors: ${op.throws.joinToString(", ")}"),
                    "content" to obj("application/problem+json" to obj("schema" to obj("oneOf" to oneOf))),
                )
            }
            operation["responses"] = JsonObject(responses)
            paths.getOrPut(prefix + b.path) { linkedMapOf() }[b.method.lowercase()] = JsonObject(operation)
        }

        val schemas = LinkedHashMap(defs)
        schemas["Problem"] = PROBLEM
        val doc = obj(
            "openapi" to str("3.2.0"),
            "info" to obj("title" to str(title), "version" to str(version)),
            "paths" to JsonObject(paths.mapValues { (_, ops) -> JsonObject(ops) }),
            "components" to obj("schemas" to JsonObject(schemas)),
        )
        return rewriteRefs(doc) as JsonObject
    }

    private val SHAPE_PARAM = obj(
        "name" to str("shape"), "in" to str("query"), "required" to JsonPrimitive(false),
        "description" to str("Rayfold shape text or sha256: shape id; default view when absent"), "schema" to obj("type" to str("string")),
    )

    private val PROBLEM = obj(
        "type" to str("object"),
        "description" to str("RFC 9457 problem details; Rayfold errors keep code, type and data"),
        "properties" to obj(
            "type" to obj("type" to str("string")), "title" to obj("type" to str("string")), "status" to obj("type" to str("integer")),
            "detail" to obj("type" to str("string")), "code" to obj("type" to str("string")), "path" to obj("type" to str("string")), "data" to obj(),
        ),
        "required" to JsonArray(listOf(str("type"), str("title"), str("status"), str("code"))),
    )

    private const val DEFS = "#/\$defs/"

    /** JSON Schema's `#/$defs/X` becomes `#/components/schemas/X` everywhere in the document. */
    private fun rewriteRefs(v: JsonElement): JsonElement = when (v) {
        is JsonObject -> JsonObject(v.mapValues { (_, x) -> rewriteRefs(x) })
        is JsonArray -> JsonArray(v.map { rewriteRefs(it) })
        is JsonPrimitive -> if (v.isString && v.content.startsWith(DEFS)) str("#/components/schemas/" + v.content.removePrefix(DEFS)) else v
    }

    private fun problemRef(description: String) =
        obj("description" to str(description), "content" to obj("application/problem+json" to obj("schema" to obj("\$ref" to str("#/components/schemas/Problem")))))

    private fun domainProblem(type: String, dataSchema: JsonElement) = obj(
        "allOf" to JsonArray(listOf(
            obj("\$ref" to str("#/components/schemas/Problem")),
            obj("properties" to obj("title" to obj("const" to str(type)), "data" to dataSchema)),
        )),
    )

    private fun param(ir: RayfoldSchemaIR, op: OpDef, name: String, where: String, required: Boolean, defs: MutableMap<String, JsonElement>): JsonObject {
        val a = op.args.firstOrNull { it.name == name }
        val s = if (a != null) JsonSchema.withRange(JsonSchema.forType(ir, a.type, defs, true), a.annotations, a.type.baseName()) else obj("type" to str("string"))
        val out = linkedMapOf<String, JsonElement>("name" to str(name), "in" to str(where), "required" to JsonPrimitive(where == "path" || required), "schema" to s)
        if (!a?.description.isNullOrEmpty()) out["description"] = str(a?.description ?: "")
        return JsonObject(out)
    }

    private fun argsObject(ir: RayfoldSchemaIR, args: List<ArgDef>, defs: MutableMap<String, JsonElement>): JsonObject {
        val properties = linkedMapOf<String, JsonElement>()
        val required = mutableListOf<JsonElement>()
        for (a in args) {
            properties[a.name] = JsonSchema.withRange(JsonSchema.forType(ir, a.type, defs, true), a.annotations, a.type.baseName())
            if (!a.type.nullable && a.default == null) required.add(str(a.name))
        }
        return if (required.isNotEmpty()) obj("type" to str("object"), "properties" to JsonObject(properties), "required" to JsonArray(required))
        else obj("type" to str("object"), "properties" to JsonObject(properties))
    }

    private fun guarded(annotations: List<Annotation>) = annotations.any { it.name == "allow" || it.name == "deny" }

    /** A policy on any type the result can reach (list elements, Page<T>, nested fields), or on one of their fields, can refuse a caller. */
    private fun typeHasPolicy(ir: RayfoldSchemaIR, t: TypeRef, seen: MutableSet<String>): Boolean {
        if (t.isList) return t.of?.let { typeHasPolicy(ir, it, seen) } ?: false
        if (t.args?.any { typeHasPolicy(ir, it, seen) } == true) return true
        val name = t.name ?: return false
        if (!seen.add(name)) return false
        val def = ir.types[name] ?: return false
        if (guarded(def.annotations)) return true
        if (def.kind == "union") return def.members.any { typeHasPolicy(ir, TypeRef("named", it), seen) }
        return def.fields.any { guarded(it.annotations) || typeHasPolicy(ir, it.type, seen) }
    }

    private fun returnsVersionedEntity(ir: RayfoldSchemaIR, op: OpDef): Boolean {
        if (op.returns.kind != "named") return false
        val def = ir.types[op.returns.name] ?: return false
        return def.kind == "entity" && def.fields.any { f -> f.annotations.find("version") != null }
    }
}
