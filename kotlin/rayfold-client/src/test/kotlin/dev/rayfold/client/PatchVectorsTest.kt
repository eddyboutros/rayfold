package dev.rayfold.client

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertNull
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
                    val unheld = c["unheld"]?.jsonPrimitive?.boolean == true
                    // same operation, other arguments: a result the client never stored, so nothing may be found by the op name
                    val target = if (unheld) RayfoldCache.resultKey(op, buildJsonObject { put("page", 2) }, null, null) else key
                    cache.applyPatch(c.req("patch").jsonArray.map { it.jsonObject }, target)
                    val why = c["why"]?.jsonPrimitive?.content ?: name
                    val held = cache.getResult(key) ?: error("the result under $key is gone")
                    assertEquals(c.req("expect"), cache.denormalize(held.data), why)
                    if (unheld) assertNull(cache.getResult(target), "$why: a result the client did not hold was created")
                    c["stale"]?.jsonObject?.let { stale ->
                        assertEquals(stale.req("result").jsonPrimitive.boolean, held.stale, "$why: the result's staleness")
                        val marked = stale.req("entities").jsonArray.map { it.jsonPrimitive.content }
                        for (k in entityKeys(c.req("result"))) assertEquals(k in marked, cache.isStale(k), "$why: $k")
                    }
                },
            )
        }
        assertTrue(out.size > 5, "no patch vectors were found under ${root.absolutePath}")
        return out
    }

    /** Every `Type:id` the initial result mentions, at any depth. */
    private fun entityKeys(v: JsonElement): Set<String> = when (v) {
        is JsonArray -> v.flatMap { entityKeys(it) }.toSet()
        is JsonObject -> {
            val self = RayfoldCache.entityKey(v)
            v.values.flatMap { entityKeys(it) }.toSet() + listOfNotNull(self)
        }
        else -> emptySet()
    }
}
