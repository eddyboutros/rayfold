package dev.rayfold.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Every field's conflict policy (spec 08 section 5), keyed `Type.field`: what should happen when a prediction and
 * the server disagree about that field.
 *
 * The client module deliberately does not depend on the schema types, so a server hands it this map instead of the
 * IR: `RayfoldClient(transport, ClientOptions(mergePolicies = mergePolicies(server.ir)))`.
 */
fun mergePolicies(ir: RayfoldSchemaIR): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for (type in ir.types.values) {
        if (!type.hasFields) continue
        for (field in type.fields) {
            val merge = field.annotations.firstOrNull { it.name == "merge" } ?: continue
            val policy = ((merge.args["value"] as? JsonObject)?.get("\$ident") as? JsonPrimitive)?.content ?: continue
            out["${type.name}.${field.name}"] = policy
        }
    }
    return out
}
