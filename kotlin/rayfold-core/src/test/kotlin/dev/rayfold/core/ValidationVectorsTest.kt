package dev.rayfold.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The published `validation/` vectors, run against this runtime: which schemas load, and what the text that loads
 * means. `packages/schema/src/validation-vectors.test.ts` runs the same file on the TypeScript side.
 */
class ValidationVectorsTest {
    private val root = File(System.getProperty("rayfold.vectors") ?: "../conformance/vectors")
    private val known = setOf("name", "schema", "expect", "irEdit", "irHas", "sameAs", "why")

    /** The case's IR document, edited as `irEdit` says, and its error diagnostics; a syntax error counts as one. */
    private class Loaded(val ir: RayfoldSchemaIR?, val errors: List<String>)

    private fun load(c: JsonObject): Loaded {
        val parsed = try {
            SchemaText.parse(c.str("schema"))
        } catch (e: RayfoldSyntaxException) {
            return Loaded(null, listOf(e.toString()))
        }
        val ir = (c["irEdit"] as? JsonObject)?.let { edit ->
            val path = edit.req("path").jsonArray.toList()
            RayfoldSchemaIR.parse(set(IrJson.of(parsed), path, edit.req("value"), c.str("name")).toString())
        } ?: parsed
        val errors = SchemaText.validate(ir).filter { it.severity == "error" }.map { "${it.at}: ${it.message} [${it.code}]" }
        return Loaded(ir, errors)
    }

    private fun set(node: JsonElement, path: List<JsonElement>, value: JsonElement, name: String): JsonElement {
        if (path.isEmpty()) return value
        val step = path.first().jsonPrimitive
        return when (node) {
            is JsonObject -> {
                val key = step.content
                val child = node[key] ?: error("$name: irEdit names a member the IR does not have ($key)")
                JsonObject(node + (key to set(child, path.drop(1), value, name)))
            }
            is JsonArray -> {
                val i = step.content.toInt()
                require(i in node.indices) { "$name: irEdit names index $i the IR does not have" }
                JsonArray(node.mapIndexed { j, e -> if (j == i) set(e, path.drop(1), value, name) else e })
            }
            else -> error("$name: irEdit walks past a value")
        }
    }

    private fun get(node: JsonElement, path: List<JsonElement>): JsonElement? =
        path.fold(node as JsonElement?) { cur, step ->
            when (cur) {
                is JsonObject -> cur[step.jsonPrimitive.content]
                is JsonArray -> cur.getOrNull(step.jsonPrimitive.content.toInt())
                else -> null
            }
        }

    @TestFactory
    fun validation(): List<DynamicTest> {
        val doc = Json.parseToJsonElement(File(File(root, "validation"), "schemas.json").readText()).jsonObject
        val cases = doc.req("cases").jsonArray.map { it.jsonObject }
        val out = cases.map { c ->
            val name = c.str("name")
            DynamicTest.dynamicTest("validation/$name") {
                val unknown = c.keys - known
                assertTrue(unknown.isEmpty(), "$name: no runner for $unknown")
                val why = c["why"]?.jsonPrimitive?.content ?: name
                val loaded = load(c)
                when (c.str("expect")) {
                    "rejected" -> {
                        assertTrue("irHas" !in c && "sameAs" !in c, "$name: a rejected case has nothing to compare")
                        assertTrue(loaded.errors.isNotEmpty(), "$why: the schema loaded")
                    }
                    "accepted" -> {
                        assertEquals(emptyList(), loaded.errors, why)
                        val ir = loaded.ir ?: error("$name: no IR")
                        // the text path too, where there is no edit: SchemaText.load is what a server calls
                        if ("irEdit" !in c) SchemaText.load(c.str("schema"))
                        val document = IrJson.of(ir)
                        for (h in (c["irHas"] as? JsonArray) ?: JsonArray(emptyList())) {
                            val path = h.jsonObject.req("path").jsonArray.toList()
                            assertEquals(h.jsonObject.req("value"), get(document, path), "$why: $path")
                        }
                        c["sameAs"]?.jsonPrimitive?.content?.let { other ->
                            val that = cases.firstOrNull { it.str("name") == other } ?: error("$name: sameAs names no case")
                            assertEquals(SchemaText.hash(load(that).ir ?: error("$other: no IR")), SchemaText.hash(ir), why)
                        }
                    }
                    else -> error("$name: no assertion for expect=${c.str("expect")}")
                }
            }
        }
        assertTrue(out.size > 10, "no validation vectors were found under ${root.absolutePath}")
        return out
    }

    private fun JsonObject.req(key: String): JsonElement = this[key] ?: error("vector is missing \"$key\"")
    private fun JsonObject.str(key: String): String = (req(key) as JsonPrimitive).content
}
