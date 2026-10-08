package dev.rayfold.test

import dev.rayfold.client.RayfoldCache
import dev.rayfold.client.RayfoldClient
import dev.rayfold.core.RayfoldServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit

/**
 * A live query a test reads one value at a time ([RayfoldTest.live]). Each value is the whole result as a client
 * holds it after the server's frame: the first result, then the result with each change applied. A part of the result
 * the server deferred (`@defer`, a `@lazy` field) is a value of its own, the result with that part merged in.
 *
 * ```kotlin
 * shop.live("book", args("id" to "b3"), "{ id stock }").use { book ->
 *     assertEquals(7, book.next().jsonObject["stock"]?.jsonPrimitive?.int)
 *     customer.command("buy", args("bookId" to "b3", "qty" to 2))
 *     assertEquals(5, book.next().jsonObject["stock"]?.jsonPrimitive?.int)
 * }
 * ```
 */
class LiveQuery<T> internal constructor(
    scope: CoroutineScope,
    server: RayfoldServer,
    viewer: JsonElement,
    private val op: String,
    args: JsonObject,
    shape: String?,
    private val timeoutMs: Long,
    private val convert: (JsonElement) -> T,
) : AutoCloseable {
    private sealed interface Event

    private class Value(val result: JsonElement) : Event

    /** The error the server ended the query with: a live query ends no other way while its reader is there. */
    private class Failed(val error: JsonObject) : Event

    private val events = LinkedBlockingDeque<Event>()
    private val ended = CountDownLatch(1)

    @Volatile
    private var closed = false

    // The client's own batch rather than its live(): that one opens the query again after a retryable end, where a
    // test wants to see the end.
    private val job: Job = scope.launch {
        val client = RayfoldClient(LocalTransport(server) { viewer })
        val held = RayfoldCache.resultKey(op, args, shape, null)
        val batch = client.batch()
        batch.query(op, args, shape, live = true)
        batch.run { frame ->
            val error = frame["error"] as? JsonObject
            when {
                error != null -> events.add(Failed(error))
                // a deferred part ("at") is in the data case too: nothing else in a live query's frames says it came
                "data" in frame || "patch" in frame ->
                    client.cache.getResult(held)?.let { events.add(Value(client.cache.denormalize(it.data))) }
            }
        }
    }.also { it.invokeOnCompletion { ended.countDown() } }

    /** Waits for the first result, so the server holds the subscription before the test goes on. */
    internal fun opened(): LiveQuery<T> {
        when (val event = events.poll(timeoutMs, TimeUnit.MILLISECONDS)) {
            null -> {
                close()
                throw AssertionError("live $op() gave no first result within $timeoutMs ms")
            }
            is Failed -> {
                close()
                throw errorOf(event.error)
            }
            is Value -> events.addFirst(event)
        }
        return this
    }

    /**
     * The next value: the first result, then the result after each change. Waits at most [timeoutMs], the caller's
     * bound unless given, and fails with an [AssertionError] when nothing came; an error the server ended the query
     * with is thrown as its [dev.rayfold.core.RayfoldException].
     */
    @JvmOverloads
    fun next(timeoutMs: Long = this.timeoutMs): T {
        check(!closed) { "live $op() is closed" }
        return when (val event = events.poll(timeoutMs, TimeUnit.MILLISECONDS)) {
            null -> throw AssertionError("live $op() sent nothing within $timeoutMs ms")
            is Value -> convert(event.result)
            is Failed -> {
                events.addFirst(event) // the end stays the answer, however often it is asked for
                throw errorOf(event.error)
            }
        }
    }

    /** Cancels the query and returns once the server has given up its subscription. */
    override fun close() {
        closed = true
        job.cancel()
        if (!ended.await(timeoutMs, TimeUnit.MILLISECONDS)) throw AssertionError("live $op() did not end within $timeoutMs ms of being closed")
    }
}
