package dev.rayfold.client

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The published `patch/` vectors under `conformance/vectors`, run against this cache.
 *
 * Each case is an initial result, a patch, and the result a client must hold afterwards. Applying a patch is a pure
 * function of the two (spec 13 section 3), so these are written from the specification rather than captured from a
 * cache, and the expectation is the materialised result - which is what lets one file check both runtimes.
 *
 * `packages/client/src/patch-vectors.test.ts` runs the identical file on the TypeScript side. The other vector areas
 * live in rayfold-core's VectorsTest; this one is here because the cache is.
 */
class PatchVectorsTest {
    private val root = File(System.getProperty("rayfold.vectors") ?: "../conformance/vectors")

    private fun JsonObject.req(key: String): JsonElement = this[key] ?: error("vector is missing \"$key\"")
    private fun JsonObject.str(key: String): String = req(key).jsonPrimitive.content

    @TestFactory
    fun patches(): List<DynamicTest> {
        val doc = Json.parseToJsonElement(File(File(root, "patch"), "apply.json").readText()).jsonObject
        val op = doc.str("op")
        val out = mutableListOf<DynamicTest>()

        for (case in doc.req("cases").jsonArray) {
            val c = case.jsonObject
            val name = c.str("name")
            out.add(
                DynamicTest.dynamicTest("patch/$name") {
                    val cache = RayfoldCache()
                    val key = RayfoldCache.resultKey(op, JsonObject(emptyMap()), null, null)
                    // the shape the result was asked with, where it matters to how the result is stored
                    cache.putResult(key, op, c.req("result"), SelectionLevel.of(c["shape"]?.jsonPrimitive?.content))
                    cache.applyPatch(c.req("patch").jsonArray.map { it.jsonObject }, key)
                    assertEquals(
                        c.req("expect"),
                        cache.denormalize((cache.getResult(key) ?: error("the result under $key is gone")).data),
                        c["why"]?.jsonPrimitive?.content ?: name,
                    )
                },
            )
        }
        assertTrue(out.size > 5, "no patch vectors were found under ${root.absolutePath}")
        return out
    }
}
