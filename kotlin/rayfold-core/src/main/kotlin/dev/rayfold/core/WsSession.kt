package dev.rayfold.core

import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * The protocol side of one WebSocket connection (spec 04 section 5), whatever server carries the socket: batch
 * envelopes, `{ "cancel": id }`, and RB in binary messages (spec 09 section 4). A batch is answered in the form it came
 * in: text frames for JSON, binary messages of one length-prefixed RB frame each for RB. [RayfoldWebSocket] drives it
 * from its own RFC 6455 listener; the Spring Boot starter drives it from a Spring WebSocket handler on the
 * application's own port.
 *
 * Several batches share a connection; an op id must not be in use by another running batch, which is why clients remap
 * their ids per socket. [sendText] and [sendBinary] may be called from several coroutines at once.
 *
 * Once the server drains, the runtime ends this connection's live queries and streams with `unavailable`; as soon as
 * those frames are out, and nothing else runs here, [onGoingAway] is called for the transport to close the socket as a
 * server going away (1001), so the client reconnects elsewhere. A connection opened while draining goes away at once.
 */
class RayfoldWsSession(
    private val server: RayfoldServer,
    private val viewer: JsonElement,
    private val sendText: (String) -> Unit,
    private val sendBinary: (ByteArray) -> Unit,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val onGoingAway: () -> Unit = {},
) {
    /** Running op ids, each mapped to the cancel job of the batch that holds it. */
    private val ops = ConcurrentHashMap<Int, CompletableJob>()

    /** Batches running: their last frames are out once this is zero. */
    private val running = AtomicInteger()
    private val closed = AtomicBoolean(false)
    private val goneAway = AtomicBoolean(false)
    private val rb by lazy { RbCodec(server.ir) }

    init {
        server.draining.invokeOnCompletion { goingAway() }
    }

    fun onText(text: String) {
        val msg = try {
            StrictJson.parse(text, "message", "Message is not valid JSON")
        } catch (e: RayfoldException) {
            return send(batchError(e.message), binary = false)
        }
        onMessage(msg, binary = false)
    }

    fun onBinary(bytes: ByteArray) {
        val msg = try {
            rb.decode(bytes)
        } catch (e: RbException) {
            return send(batchError("Message is not valid RB"), binary = true)
        }
        onMessage(msg, binary = true)
    }

    private fun onMessage(msg: JsonElement, binary: Boolean) {
        val m = msg as? JsonObject
        val cancel = m?.get("cancel") as? JsonPrimitive
        if (cancel != null && cancel !is JsonNull && !cancel.isString && StrictJson.isNumber(cancel.content)) {
            StrictJson.integerOrNull(cancel)?.toIntOrNull()?.let { ops[it]?.complete() }
            return
        }
        if (m == null || m["ops"] !is JsonArray) return send(batchError("Expected a batch envelope or {cancel}"), binary)
        val env = RequestEnvelope.from(m)
        for (o in env.ops) if (o.id > 0 && ops.containsKey(o.id)) return send(batchError("op id ${o.id} is already in use on this connection"), binary)
        val cancelJob = Job()
        val ids = env.ops.map { it.id }.filter { it > 0 }
        for (id in ids) ops[id] = cancelJob
        running.incrementAndGet()
        scope.launch {
            try {
                server.execute(env, ExecuteOptions(viewer, cancel = cancelJob)).collect { f ->
                    // free the id before the final frame goes out: messages are read on another thread, and a client may
                    // reuse the id as soon as it sees that frame
                    if (f["fin"] == JsonPrimitive(true)) (f["id"] as? JsonPrimitive)?.content?.toIntOrNull()?.let { ops.remove(it, cancelJob) }
                    send(f, binary)
                }
            } finally {
                for (id in ids) ops.remove(id, cancelJob)
                running.decrementAndGet()
                if (server.draining.isCompleted) goingAway()
            }
        }
    }

    private fun goingAway() {
        if (running.get() > 0 || closed.get()) return
        if (goneAway.compareAndSet(false, true)) onGoingAway()
    }

    private fun batchError(message: String) = buildJsonObject {
        put("error", buildJsonObject { put("code", Code.INVALID_ARGUMENT.wire); put("message", message) })
        put("fin", true)
    }

    private fun send(f: JsonObject, binary: Boolean) = if (binary) sendBinary(rb.encodeFrames(listOf(f))) else sendText(f.toString())

    /** Cancels every running batch; the connection stays usable. */
    fun cancelAll() {
        ops.values.toSet().forEach { it.complete() }
        ops.clear()
    }

    /** Cancels every batch and waits (bounded) until they let go of their live subscriptions. */
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        cancelAll()
        val job = scope.coroutineContext[Job]
        scope.cancel()
        if (job != null) runBlocking { withTimeoutOrNull(5_000) { job.join() } }
    }
}
