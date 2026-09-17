package dev.rayfold.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put
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

    @TestFactory
    fun shapes(): List<DynamicTest> {
        // no vector uses a named-view spread, so an empty schema is enough to expand against
        val empty = RayfoldSchemaIR(rayfold = "0.1", types = emptyMap(), ops = emptyMap())
        val out = mutableListOf<DynamicTest>()
        for ((file, doc) in area("shapes")) {
            for (case in doc["cases"]?.jsonArray ?: error("$file has no cases")) {
                val c = case.jsonObject
                val name = c["name"]?.jsonPrimitive?.content ?: error("$file has a case without a name")
                val text = c["shape"]?.jsonPrimitive?.content ?: error("$name has no shape")
                val why = c["why"]?.jsonPrimitive?.content ?: name
                val rejected = c["rejected"]?.jsonPrimitive?.content == "true"
                out.add(
                    DynamicTest.dynamicTest("shapes/$file: $name") {
                        if (rejected) {
                            val failed = runCatching { Shapes.canonical(Shapes.parse(text), empty) }.isFailure
                            assertTrue(failed, "the shape was accepted but the grammar does not admit it: $why")
                            return@dynamicTest
                        }
                        val canonical = Shapes.canonical(Shapes.parse(text), empty)
                        assertEquals(c["canonical"]?.jsonPrimitive?.content, canonical, why)
                        // the id in the vector is the SHA-256 of the canonical text above, taken independently
                        assertEquals(c["id"]?.jsonPrimitive?.content, Shapes.idOf(canonical), why)
                    },
                )
            }
        }
        assertTrue(out.size > 5, "no shape vectors were found under ${root.absolutePath}")
        return out
    }

    @TestFactory
    fun binary(): List<DynamicTest> {
        val out = mutableListOf<DynamicTest>()
        for ((file, doc) in area("binary")) {
            // no schema, so the dictionary is exactly the protocol keys the vector lists
            val codec = RbCodec()
            val dictionary = doc["dictionary"]?.jsonArray ?: error("$file has no dictionary")

            out.add(
                DynamicTest.dynamicTest("binary/$file: the protocol keys are those, in that order") {
                    assertEquals(40, dictionary.size, "the count is load-bearing: every schema name is offset by it")
                    dictionary.forEachIndexed { i, key ->
                        val name = key.jsonPrimitive.content
                        // encoding { key: 1 } puts the key's id on the wire as the varint 2*i, which is the id's only
                        // observable effect and the thing an independent codec has to agree about
                        val bytes = codec.encode(buildJsonObject { put(name, JsonPrimitive(1)) })
                        assertEquals("0801%02x81".format(2 * i), hex(bytes), "$name should be dictionary id $i")
                    }
                },
            )

            for (case in doc["values"]?.jsonArray ?: error("$file has no values")) {
                val c = case.jsonObject
                val name = c["name"]?.jsonPrimitive?.content ?: error("$file has a case without a name")
                val json = c["json"]?.jsonPrimitive?.content ?: error("$name has no json")
                val expected = c["bytes"]?.jsonPrimitive?.content ?: error("$name has no bytes")
                val why = c["why"]?.jsonPrimitive?.content ?: name
                out.add(
                    DynamicTest.dynamicTest("binary/$file: $name") {
                        val value = Json.parseToJsonElement(json)
                        assertEquals(expected, hex(codec.encode(value)), why)
                        assertEquals(value, codec.decode(codec.encode(value)), "reads back as what went in")
                    },
                )
            }
        }
        assertTrue(out.size > 5, "no binary vectors were found under ${root.absolutePath}")
        return out
    }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
}
