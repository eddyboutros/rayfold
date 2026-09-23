package dev.rayfold.client

import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * A live query outlives the server it was opened on, as in packages/client/src/live-reconnect.test.ts: a rolling deploy
 * ends it with a retryable error, and the client opens it again without the application doing anything.
 */
class LiveReconnectTest {
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private fun book(stock: Int) = obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1","stock":$stock},"meta":{"cost":1}}""")
    private fun ended(code: String) = obj("""{"id":1,"error":{"code":"$code","message":"$code"},"fin":true}""")
    private fun refused(code: String) = obj("""{"error":{"code":"$code","message":"$code"},"fin":true}""")

    /** Each open gets the next script: its frames, then held open until the client goes away, or [dropped] ends bare. */
    private class Scripted(private val runs: List<Pair<List<JsonObject>, Boolean>>) : Transport {
        var opened = 0
        override fun send(envelope: JsonObject, safe: Boolean): Flow<JsonObject> {
            val (frames, dropped) = runs.getOrElse(opened++) { emptyList<JsonObject>() to false }
            return flow {
                frames.forEach { emit(it) }
                if (dropped || frames.any { it["fin"] != null }) return@flow
                awaitCancellation()
            }
        }
    }

    private fun held(vararg frames: JsonObject) = frames.toList() to false
    private fun dropped(vararg frames: JsonObject) = frames.toList() to true

    private class Seen {
        val stock = CopyOnWriteArrayList<Int>()
        val errors = CopyOnWriteArrayList<String>()
    }

    private fun kotlinx.coroutines.CoroutineScope.watch(client: RayfoldClient, seen: Seen, failed: CopyOnWriteArrayList<Throwable> = CopyOnWriteArrayList()) = launch {
        try {
            client.live("book", onError = { e, retrying -> seen.errors.add("${(e as? RayfoldClientException)?.code}:$retrying") })
                .collect { seen.stock.add(it.jsonObject.getValue("stock").jsonPrimitive.int) }
        } catch (e: RayfoldClientException) {
            failed.add(e)
        }
    }

    @Test
    fun `a server going away is reported and the query opened again half a second later`() = runTest(timeout = 5.seconds) {
        val t = Scripted(listOf(held(book(3), ended("unavailable")), held(book(4))))
        val seen = Seen()
        val job = watch(RayfoldClient(t), seen)
        runCurrent()
        assertEquals(listOf(3), seen.stock)
        assertEquals(listOf("unavailable:true"), seen.errors)
        advanceTimeBy(499); runCurrent()
        assertEquals(1, t.opened)
        advanceTimeBy(1); runCurrent()
        assertEquals(2, t.opened)
        assertEquals(listOf(3, 4), seen.stock)
        job.cancel()
    }

    @Test
    fun `a refusal of the whole batch is this query's too, and the wait doubles while it keeps failing`() = runTest(timeout = 5.seconds) {
        val t = Scripted(listOf(held(book(3), ended("unavailable")), held(refused("unavailable")), held(book(4))))
        val seen = Seen()
        val job = watch(RayfoldClient(t), seen)
        runCurrent()
        advanceTimeBy(500); runCurrent()
        assertEquals(2, t.opened)
        assertEquals(listOf("unavailable:true", "unavailable:true"), seen.errors)
        advanceTimeBy(999); runCurrent()
        assertEquals(2, t.opened, "twice the wait the second time")
        advanceTimeBy(1); runCurrent()
        assertEquals(3, t.opened)
        assertEquals(listOf(3, 4), seen.stock)
        job.cancel()
    }

    @Test
    fun `a response that ends without an error is a dropped connection, opened again`() = runTest(timeout = 5.seconds) {
        val t = Scripted(listOf(dropped(book(3)), held(book(4))))
        val seen = Seen()
        val job = watch(RayfoldClient(t), seen)
        runCurrent()
        advanceTimeBy(500); runCurrent()
        assertEquals(listOf("unavailable:true"), seen.errors)
        assertEquals(listOf(3, 4), seen.stock)
        job.cancel()
    }

    @Test
    fun `guard - an error that would recur, for the op or for the batch, ends the flow with it`() = runTest(timeout = 5.seconds) {
        for (end in listOf(ended("permission_denied"), refused("invalid_argument"))) {
            val t = Scripted(listOf(held(end), held(book(1))))
            val seen = Seen()
            val failed = CopyOnWriteArrayList<Throwable>()
            watch(RayfoldClient(t), seen, failed)
            runCurrent()
            advanceTimeBy(30_000); runCurrent()
            val code = end.getValue("error").jsonObject.getValue("code").jsonPrimitive.content
            assertEquals(listOf("$code:false"), seen.errors)
            assertEquals(listOf(code), failed.map { (it as RayfoldClientException).code })
            assertEquals(1, t.opened)
        }
    }

    @Test
    fun `guard - cancelling it while it waits to reconnect cancels the reconnect`() = runTest(timeout = 5.seconds) {
        val t = Scripted(listOf(held(book(3), ended("unavailable")), held(book(4))))
        val seen = Seen()
        val job = watch(RayfoldClient(t), seen)
        runCurrent()
        job.cancel()
        advanceTimeBy(30_000); runCurrent()
        assertEquals(1, t.opened)
        assertTrue(job.isCancelled)
    }
}
