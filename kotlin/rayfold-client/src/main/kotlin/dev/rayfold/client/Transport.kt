package dev.rayfold.client

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.SendChannel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.future.await
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.http.HttpClient
import java.net.http.WebSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Delivers one batch envelope and yields its frames (spec 04). The flow ends after the last frame; cancelling its
 * collection abandons the request, which stops the batch on the server.
 */
fun interface Transport {
    /** [safe] is true when every op is a query, so the request may go out as a safe (cacheable, cross-site readable) read. */
    fun send(envelope: JsonObject, safe: Boolean): Flow<JsonObject>
}

private fun batchError(code: String, message: String): JsonObject = buildJsonObject {
    putJsonObject("error") { put("code", code); put("message", message) }
    put("fin", true)
}

/**
 * HTTP transport: POST {url} with the batch, NDJSON frames back as they arrive. Built on HttpURLConnection, which
 * exists on the JVM and on Android. [headers] runs per request, for tokens that expire.
 */
class HttpTransport @JvmOverloads constructor(
    private val url: String,
    private val headers: suspend () -> Map<String, String> = { emptyMap() },
    private val connectTimeoutMs: Int = 10_000,
    /** 0 waits forever, which live queries and streams need. */
    private val readTimeoutMs: Int = 0,
) : Transport {
    override fun send(envelope: JsonObject, safe: Boolean): Flow<JsonObject> = callbackFlow {
        val extra = headers()
        val body = envelope.toString().toByteArray(Charsets.UTF_8)
        val conn = URI(url).toURL().openConnection() as HttpURLConnection
        launch(Dispatchers.IO) {
            try {
                conn.requestMethod = "POST"
                conn.connectTimeout = connectTimeoutMs
                conn.readTimeout = readTimeoutMs
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(body.size)
                conn.setRequestProperty("Content-Type", "application/rayfold+json")
                conn.setRequestProperty("Accept", "application/rayfold-frames+json")
                if (safe) conn.setRequestProperty("Rayfold-Safe", "true")
                for ((k, v) in extra) conn.setRequestProperty(k, v)
                conn.outputStream.use { it.write(body) }
                val status = conn.responseCode
                val type = conn.contentType ?: ""
                if (status !in 200..299 && !type.startsWith("application/rayfold-frames+json")) {
                    val text = (conn.errorStream ?: conn.inputStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                    val problem = runCatching { Json.parseToJsonElement(text).jsonObject }.getOrNull()
                    val code = (problem?.get("code") as? JsonPrimitive)?.contentOrNull ?: "unavailable"
                    val detail = (problem?.get("detail") as? JsonPrimitive)?.contentOrNull ?: "HTTP $status"
                    send(batchError(code, detail))
                } else {
                    (if (status in 200..299) conn.inputStream else conn.errorStream).bufferedReader(Charsets.UTF_8).use { reader ->
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isNotBlank()) send(Json.parseToJsonElement(line).jsonObject)
                        }
                    }
                }
                channel.close()
            } catch (e: Throwable) {
                channel.close(e)
            }
        }
        // cancelling the collection lands here: dropping the connection unblocks the reader and ends the batch
        awaitClose { conn.disconnect() }
    }
}

/**
 * The socket-independent half of a WebSocket transport (spec 04 section 5). One socket carries many batches, so op ids
 * are remapped per socket and frames routed back to their batch; cancelling a batch's collection sends
 * `{ "cancel": id }` for its ops, which is how a live query unsubscribes; a socket that ends ends every batch on it with
 * `unavailable`, and the next batch opens a new one. [JdkWebSocketTransport] and `OkHttpWebSocketTransport` (module
 * rayfold-client-okhttp, for Android) supply the socket.
 */
abstract class WebSocketTransportBase : Transport, AutoCloseable {
    /** An open socket as the transport uses it. [sendText] may be called from several coroutines at once. */
    fun interface Connection {
        fun sendText(text: String)
    }

    private class Pending(val channel: SendChannel<JsonObject>) {
        /** socket op id -> the batch's own op id */
        val ids = ConcurrentHashMap<Int, Int>()
    }

    private val lock = Any()
    private var socket: CompletableFuture<out Connection>? = null
    private val nextId = AtomicInteger(1)
    private val pending = ConcurrentHashMap.newKeySet<Pending>()

    /** Opens a socket; the implementation hands every whole text message to [receive] and the socket's end to [closed]. */
    protected abstract fun connect(): CompletableFuture<out Connection>

    /** A whole text message from the server. */
    protected fun receive(text: String) {
        val frame = runCatching { Json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        val id = (frame["id"] as? JsonPrimitive)?.intOrNull
        if (id == null) {
            for (p in pending) p.channel.trySend(frame)
            return
        }
        for (p in pending) {
            val own = p.ids[id] ?: continue
            p.channel.trySend(JsonObject(frame + ("id" to JsonPrimitive(own))))
            if ((frame["fin"] as? JsonPrimitive)?.contentOrNull == "true") {
                p.ids.remove(id)
                if (p.ids.isEmpty()) p.channel.close()
            }
        }
    }

    /** The socket ended: every batch still on it gets `unavailable`, and the next batch opens a new socket. */
    protected fun closed(message: String) {
        synchronized(lock) { socket = null }
        for (p in pending) {
            for (own in p.ids.values) p.channel.trySend(JsonObject(batchError("unavailable", message) + ("id" to JsonPrimitive(own))))
            p.channel.close()
        }
        pending.clear()
    }

    private fun socket(): CompletableFuture<out Connection> = synchronized(lock) { socket ?: connect().also { socket = it } }

    override fun send(envelope: JsonObject, safe: Boolean): Flow<JsonObject> = callbackFlow {
        val p = Pending(channel)
        val ops = envelope["ops"]?.jsonArray ?: JsonArray(emptyList())
        val remap = HashMap<Int, Int>() // the batch's op id -> socket op id
        for (op in ops) (op.jsonObject["id"] as? JsonPrimitive)?.intOrNull?.let { own -> nextId.getAndIncrement().also { remap[own] = it; p.ids[it] = own } }
        val remapped = JsonObject(envelope + ("ops" to JsonArray(ops.map { op ->
            val o = op.jsonObject
            val own = (o["id"] as? JsonPrimitive)?.intOrNull
            JsonObject(o + ("id" to JsonPrimitive(own?.let { remap[it] } ?: 0)) + ("args" to remapRefs(o["args"] ?: JsonObject(emptyMap()), remap)))
        })))
        pending.add(p)
        val conn = try {
            socket().await().also { it.sendText(remapped.toString()) }
        } catch (e: Exception) {
            synchronized(lock) { socket = null }
            send(batchError("unavailable", "WebSocket connection failed: ${e.message}"))
            null
        }
        if (conn == null) channel.close()
        awaitClose {
            pending.remove(p)
            // the batch is still running when its collector leaves early: stop it on the server
            for (id in p.ids.keys) conn?.sendText("{\"cancel\":$id}")
        }
    }

    /** Rewrites `{ "$ref": "<id>.path" }` for the remapped ids. */
    private fun remapRefs(v: JsonElement, remap: Map<Int, Int>): JsonElement = when (v) {
        is JsonArray -> JsonArray(v.map { remapRefs(it, remap) })
        is JsonObject -> {
            val ref = (v["\$ref"] as? JsonPrimitive)?.takeIf { it.isString && v.size == 1 }?.content
            if (ref != null) {
                val id = ref.substringBefore('.').toIntOrNull()
                JsonObject(mapOf("\$ref" to JsonPrimitive("${id?.let { remap[it] } ?: ref.substringBefore('.')}.${ref.substringAfter('.', "")}")))
            } else JsonObject(v.mapValues { remapRefs(it.value, remap) })
        }
        else -> v
    }
}

/**
 * WebSocket transport on the JDK's java.net.http client, so the JVM only; Android apps use `OkHttpWebSocketTransport`
 * from rayfold-client-okhttp.
 */
class JdkWebSocketTransport @JvmOverloads constructor(
    private val uri: URI,
    private val headers: Map<String, String> = emptyMap(),
    private val http: HttpClient = HttpClient.newHttpClient(),
) : WebSocketTransportBase() {
    @Volatile
    private var ws: WebSocket? = null

    private val listener = object : WebSocket.Listener {
        private val text = StringBuilder()

        override fun onText(ws: WebSocket, data: CharSequence, last: Boolean): CompletionStage<*>? {
            text.append(data)
            if (last) {
                val message = text.toString()
                text.setLength(0)
                receive(message)
            }
            ws.request(1)
            return null
        }

        override fun onClose(ws: WebSocket, statusCode: Int, reason: String): CompletionStage<*>? {
            closed("Connection closed ($statusCode${if (reason.isNotEmpty()) " $reason" else ""})")
            return null
        }

        override fun onError(ws: WebSocket, error: Throwable) = closed("Connection failed: ${error.message}")
    }

    override fun connect(): CompletableFuture<out Connection> = http.newWebSocketBuilder()
        .subprotocols("rayfold.0.1")
        .apply { for ((k, v) in headers) header(k, v) }
        .buildAsync(uri, listener)
        .thenApply { socket -> ws = socket; Chained(socket) }

    override fun close() {
        ws?.sendClose(WebSocket.NORMAL_CLOSURE, "")
    }

    /** The JDK socket refuses a send while another is still in flight, so sends queue one after another. */
    private class Chained(private val ws: WebSocket) : Connection {
        private var tail: CompletableFuture<*> = CompletableFuture.completedFuture(null)

        override fun sendText(text: String) {
            synchronized(this) { tail = tail.handle { _, _ -> null }.thenCompose { ws.sendText(text, true) } }
        }
    }
}
