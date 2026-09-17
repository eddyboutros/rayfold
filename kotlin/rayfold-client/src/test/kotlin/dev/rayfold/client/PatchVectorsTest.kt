package dev.rayfold.client

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

    @TestFactory
    fun patches(): List<DynamicTest> {
        val doc = Json.parseToJsonElement(File(File(root, "patch"), "apply.json").readText()).jsonObject
        val op = doc["op"]!!.jsonPrimitive.content
        val out = mutableListOf<DynamicTest>()

        for (case in doc["cases"]!!.jsonArray) {
            val c = case.jsonObject
            val name = c["name"]!!.jsonPrimitive.content
            out.add(
                DynamicTest.dynamicTest("patch/$name") {
                    val cache = RayfoldCache()
                    val key = RayfoldCache.resultKey(op, JsonObject(emptyMap()), null, null)
                    cache.putResult(key, op, c["result"]!!)
                    cache.applyPatch(c["patch"]!!.jsonArray.map { it.jsonObject }, key)
                    assertEquals(
                        c["expect"]!!,
                        cache.denormalize(cache.getResult(key)!!.data),
                        c["why"]?.jsonPrimitive?.content ?: name,
                    )
                },
            )
        }
        assertTrue(out.size > 5, "no patch vectors were found under ${root.absolutePath}")
        return out
    }
}
