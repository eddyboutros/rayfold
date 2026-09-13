package dev.rayfold.client

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Per-field conflict policy (spec 08 section 5), case for case with packages/client/src/merge.test.ts: what happens
 * when the server speaks for a field a prediction also set.
 */
class MergePolicyTest {
    private val policies = mapOf("Doc.title" to "serverWins", "Doc.body" to "crdtText")

    private fun cache() = RayfoldCache(now = { 0 }, mergePolicies = policies)

    private fun fields(vararg pairs: Pair<String, String>): JsonObject = buildJsonObject { for ((k, v) in pairs) put(k, v) }

    private fun value(c: RayfoldCache, field: String): String? = (c.get("Doc:d1")?.get(field) as? JsonPrimitive)?.content

    @Test
    fun `a field the server speaks for leaves the prediction, one without a policy keeps it`() {
        val c = cache()
        c.merge("Doc:d1", fields("title" to "server", "notes" to "server note"))
        c.addLayer("cmd-1", listOf(OptimisticOp("Doc:d1", fields("title" to "mine", "notes" to "my note"))))
        assertEquals("mine", value(c, "title"))
        assertEquals("my note", value(c, "notes"))

        // the server writes both fields while the command is still in flight
        c.merge("Doc:d1", fields("title" to "theirs", "notes" to "their note"))
        assertEquals("theirs", value(c, "title"), "serverWins drops the predicted title at once")
        assertEquals("my note", value(c, "notes"), "a field with no policy keeps its prediction")

        // and when the command settles, what is left is exactly what the server said
        c.removeLayer("cmd-1")
        assertEquals("theirs", value(c, "title"))
        assertEquals("their note", value(c, "notes"))
    }

    @Test
    fun `refuses to predict a field whose policy it cannot carry out`() {
        val c = cache()
        val refused = assertFailsWith<IllegalArgumentException> {
            c.addLayer("cmd-2", listOf(OptimisticOp("Doc:d1", fields("body" to "typed locally"))))
        }
        assertEquals(true, refused.message?.contains("crdtText"), refused.message)

        // guard: the same prediction on a field it can carry out is accepted
        c.addLayer("cmd-3", listOf(OptimisticOp("Doc:d1", fields("title" to "typed locally"))))
        assertEquals("typed locally", value(c, "title"))
    }

    @Test
    fun `a cache given no policies behaves as it always has`() {
        val plain = RayfoldCache(now = { 0 })
        plain.merge("Doc:d1", fields("title" to "server"))
        plain.addLayer("cmd-4", listOf(OptimisticOp("Doc:d1", fields("title" to "mine"))))
        plain.merge("Doc:d1", fields("title" to "theirs"))
        assertEquals("mine", value(plain, "title"))
    }
}
