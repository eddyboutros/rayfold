package dev.rayfold.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The published vectors under `conformance/vectors`, run against this runtime.
 *
 * A vector is not a fixture: a fixture is a request and the frames it must produce, a vector is a pure function and
 * the answer the specification says it has. They are written from the specification rather than captured from a
 * runtime, because a vector taken from an implementation proves only that the implementations agree - and two
 * implementations can agree on the same wrong answer.
 *
 * `packages/schema/src/vectors.test.ts` runs the identical files on the TypeScript side.
 */
class VectorsTest {
    private val root = File(System.getProperty("rayfold.vectors") ?: "../conformance/vectors")

    private fun area(name: String): List<Pair<String, JsonObject>> {
        val dir = File(root, name)
        val files = dir.listFiles()?.filter { it.name.endsWith(".json") }?.sortedBy { it.name }
            ?: error("no vector directory at ${dir.absolutePath}")
        return files.map { it.name to Json.parseToJsonElement(it.readText()).jsonObject }
    }

    @TestFactory
    fun numbers(): List<DynamicTest> {
        val out = mutableListOf<DynamicTest>()
        for ((file, doc) in area("numbers")) {
            for (case in doc["cases"]?.jsonArray ?: error("$file has no cases")) {
                val c = case.jsonObject
                val name = c["name"]?.jsonPrimitive?.content ?: error("$file has a case without a name")
                val literal = c["literal"]?.jsonPrimitive?.content ?: error("$name has no literal")
                val expected = c["canonical"]?.jsonPrimitive?.content ?: error("$name has no canonical form")
                out.add(
                    DynamicTest.dynamicTest("numbers/$file: $name") {
                        // the literal is text so the vector keeps it exactly as a client would send it; parsing is
                        // part of what is under test, since it is where 2.50 and 2.5 become one number
                        val parsed = Json.parseToJsonElement(literal).jsonPrimitive.content
                        assertEquals(expected, Canonical.number(parsed), c["why"]?.jsonPrimitive?.content ?: name)
                    },
                )
            }
        }
        assertTrue(out.size > 10, "no number vectors were found under ${root.absolutePath}")
        return out
    }
}
