package dev.rayfold.client

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotSame
import kotlin.test.assertTrue

/** The normalized cache on its own (mirrors the cache tests of packages/client). `#` stands for `$` in the JSON below. */
class RayfoldCacheTest {
    private fun j(text: String): JsonElement = Json.parseToJsonElement(text.replace('#', '$'))
    private fun o(text: String): JsonObject = j(text).jsonObject

    @Test
    fun `entities are stored once and each result reads back with exactly the fields it selected`() {
        val c = RayfoldCache { 0 }
        val r = c.putResult("k", "books", j("""{"items":[{"#type":"Book","id":"b1","title":"T","author":{"#type":"Author","id":"a1","name":"A"}},{"#type":"Book","id":"b1","title":"T"}]}"""))
        assertEquals(2, c.size)
        assertEquals(setOf("Book:b1", "Author:a1"), r.keys)
        assertEquals(o("""{"#type":"Book","id":"b1","title":"T","author":{"#ref":"Author:a1","#sel":{"#type":true,"id":true,"name":true}}}"""), c.get("Book:b1"))
        assertEquals(
            j("""{"items":[{"#type":"Book","id":"b1","title":"T","author":{"#type":"Author","id":"a1","name":"A"}},{"#type":"Book","id":"b1","title":"T"}]}"""),
            c.denormalize(r.data),
        )
        c.applyPatch(listOf(o("""{"set":"Book:b1","value":{"title":"T2"}}""")))
        assertEquals(j("""{"items":[{"#type":"Book","id":"b1","title":"T2","author":{"#type":"Author","id":"a1","name":"A"}},{"#type":"Book","id":"b1","title":"T2"}]}"""), c.denormalize(r.data))
    }

    @Test
    fun `set, del, inv and invOp patches apply and notify the affected ops`() {
        val c = RayfoldCache { 0 }
        c.putResult("q1", "books", j("""{"items":[{"#type":"Book","id":"b1","stock":5},{"#type":"Book","id":"b2","stock":1}]}"""))
        c.putResult("q2", "author", j("""{"#type":"Author","id":"a1"}"""))
        val events = mutableListOf<Pair<Set<String>, Set<String>>>()
        c.subscribe { events.add(it.keys to it.ops) }
        c.applyPatch(listOf(o("""{"set":"Book:b1","value":{"stock":3}}"""), o("""{"del":"Book:b2"}"""), o("""{"inv":["Author:a1"]}"""), o("""{"invOp":["recommendations"]}""")))
        assertEquals(o("""{"#type":"Book","id":"b1","stock":3}"""), c.get("Book:b1"))
        assertFalse(c.has("Book:b2"))
        assertEquals(j("""{"items":[{"#type":"Book","id":"b1","stock":3}]}"""), c.getResult("q1")?.let { c.denormalize(it.data) })
        assertTrue(c.isStale("Author:a1"))
        assertEquals(listOf(setOf("Author:a1", "Book:b1", "Book:b2") to setOf("author", "books", "recommendations")), events)
    }

    @Test
    fun `deleting an entity removes it from lists held inside other entities`() {
        val c = RayfoldCache { 0 }
        val r = c.putResult("k", "author", j("""{"#type":"Author","id":"a1","books":[{"#type":"Book","id":"b1"},{"#type":"Book","id":"b2"}]}"""))
        c.applyPatch(listOf(o("""{"del":"Book:b1"}""")))
        assertEquals(j("""{"#type":"Author","id":"a1","books":[{"#type":"Book","id":"b2"}]}"""), c.getResult("k")?.let { c.denormalize(it.data) })
        // guard: the result record before the delete was not what was read
        assertNotSame(r, c.getResult("k"))
    }

    @Test
    fun `a deferred part merges into the entity at its path, and the result record is replaced`() {
        val c = RayfoldCache { 0 }
        val before = c.putResult("k", "book", j("""{"#type":"Book","id":"b1","author":{"#type":"Author","id":"a1","name":"A"}}"""))
        c.mergeAt("k", "author", j("""{"bio":"Wrote books."}"""))
        val after = c.getResult("k") ?: error("result gone")
        assertNotSame(before, after)
        assertEquals(j("""{"#type":"Book","id":"b1","author":{"#type":"Author","id":"a1","name":"A","bio":"Wrote books."}}"""), c.denormalize(after.data))
        assertEquals("Wrote books.", c.get("Author:a1")?.get("bio")?.let { (it as kotlinx.serialization.json.JsonPrimitive).content })
    }

    @Test
    fun `a transaction reports its changes once`() {
        val c = RayfoldCache { 0 }
        var calls = 0
        c.subscribe { calls++ }
        c.transaction {
            c.putResult("a", "book", j("""{"#type":"Book","id":"b1"}"""))
            c.applyPatch(listOf(o("""{"set":"Book:b1","value":{"stock":1}}""")))
        }
        assertEquals(1, calls)
        // guard: outside a transaction each change reports on its own
        c.putResult("b", "book", j("""{"#type":"Book","id":"b2"}"""))
        c.applyPatch(listOf(o("""{"set":"Book:b2","value":{"stock":1}}""")))
        assertEquals(3, calls)
    }

    @Test
    fun `threads writing at once lose nothing`() {
        val c = RayfoldCache { 0 }
        val pool = Executors.newFixedThreadPool(8)
        val done = CountDownLatch(8)
        try {
            for (t in 0 until 8) pool.execute {
                try {
                    for (i in 0 until 500) {
                        c.putResult("r$t-$i", "book", j("""{"#type":"Book","id":"t$t-$i","n":$i}"""))
                        c.applyPatch(listOf(o("""{"set":"Book:t$t-$i","value":{"n":${i + 1}}}""")))
                    }
                } finally {
                    done.countDown()
                }
            }
            assertTrue(done.await(5, TimeUnit.SECONDS), "writers did not finish within 5 s")
        } finally {
            pool.shutdownNow()
        }
        assertEquals(4000, c.size)
        assertEquals(o("""{"#type":"Book","id":"t7-499","n":500}"""), c.get("Book:t7-499"))
    }
}
