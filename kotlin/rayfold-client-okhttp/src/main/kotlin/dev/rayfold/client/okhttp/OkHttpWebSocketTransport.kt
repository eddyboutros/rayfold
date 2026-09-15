package dev.rayfold.client.okhttp

import dev.rayfold.client.WebSocketTransportBase
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.CompletableFuture

/**
 * The Rayfold WebSocket transport on OkHttp, for Android apps (and any JVM app that already uses OkHttp). One socket
 * carries every batch; live queries stay subscribed until their collection is cancelled, which sends `{ "cancel": id }`.
 * [url] is the socket's `ws://` or `wss://` address, such as `wss://api.example/rayfold/ws`; [headers] go on the
 * handshake, for example an `Authorization` token. Pass the app's own [client] to share its connection pool, TLS and
 * interceptors.
 *
 * ```kotlin
 * val client = RayfoldClient(OkHttpWebSocketTransport("wss://api.example/rayfold/ws", mapOf("Authorization" to "Bearer $token")))
 * ```
 */
class OkHttpWebSocketTransport @JvmOverloads constructor(
    private val url: String,
    private val headers: Map<String, String> = emptyMap(),
    private val client: OkHttpClient = OkHttpClient(),
) : WebSocketTransportBase() {
    @Volatile
    private var ws: WebSocket? = null

    override fun connect(): CompletableFuture<out Connection> {
        val opened = CompletableFuture<Connection>()
        val request = Request.Builder().url(url).header("Sec-WebSocket-Protocol", SUBPROTOCOL).apply { for ((k, v) in headers) header(k, v) }.build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            // OkHttp's send queues the message and is safe to call from any thread
            override fun onOpen(webSocket: WebSocket, response: Response) {
                opened.complete(Connection { webSocket.send(it) })
            }

            override fun onMessage(webSocket: WebSocket, text: String) = receive(text)

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(NORMAL_CLOSURE, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) =
                closed("Connection closed ($code${if (reason.isNotEmpty()) " $reason" else ""})")

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // A socket that never opened (a refused handshake) fails the batches waiting for it, and each reports that
                // itself. Ending them here too raced that report and could close a batch's channel under it.
                if (opened.completeExceptionally(t)) return
                closed("Connection failed: ${t.message}")
            }
        })
        return opened
    }

    override fun close() {
        ws?.close(NORMAL_CLOSURE, null)
    }

    private companion object {
        const val SUBPROTOCOL = "rayfold.0.1"
        const val NORMAL_CLOSURE = 1000
    }
}
