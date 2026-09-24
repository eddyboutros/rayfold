package dev.rayfold.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

data class WsOptions(
    val path: String = "/rayfold/ws",
    /** Browser origins allowed to open a socket besides the server's own; the handshake carries the user's cookies. */
    val allowedOrigins: Set<String> = emptySet(),
    /** Host names answered; null answers any host, except that a loopback server answers loopback names only. */
    val allowedHosts: Set<String>? = null,
    /** Largest frame or assembled message accepted, in bytes (spec 12 section 3); a larger one closes with code 1009. */
    val maxMessageBytes: Int = 1024 * 1024,
    /**
     * Milliseconds a client gets to deliver its whole opening handshake before the socket is dropped. This bound is per
     * listener, unlike the JDK HTTP server's JVM-wide request timer. An open socket has no idle limit: a live query may
     * legitimately wait a long time for its next change.
     */
    val handshakeTimeoutMs: Int = 10_000,
    /** Largest request head (request line and headers) accepted in the handshake. */
    val maxHandshakeBytes: Int = 16 * 1024,
)

/** The opening handshake, as the viewer hook sees it. */
class WsRequest(
    val method: String,
    /** The request target as sent, such as `/rayfold/ws?auth=...`. */
    val target: String,
    private val headers: Map<String, String>,
    val localAddress: InetSocketAddress,
    val remoteAddress: InetSocketAddress,
) {
    val path: String get() = target.substringBefore('?')
    val rawQuery: String? get() = if ('?' in target) target.substringAfter('?') else null
    fun header(name: String): String? = headers[name.lowercase()]
}

/**
 * WebSocket transport (spec 04 section 5; mirrors packages/server/src/ws.ts): a minimal RFC 6455 server on its own
 * listener, since the JDK HTTP server cannot upgrade a connection (the Spring Boot starter serves the same protocol on
 * the application's port). Text messages carry JSON and binary messages RB; [RayfoldWsSession] runs the batches.
 *
 * Each connection reads on its own virtual thread and runs its batches as coroutines. When the client's side ends,
 * with a close frame or only a TCP FIN, the connection cancels its batches, so live queries unsubscribe, and closes.
 */
class RayfoldWebSocket(
    private val server: RayfoldServer,
    private val options: WsOptions = WsOptions(),
    private val viewer: (WsRequest) -> JsonElement = { JsonNull },
) {
    constructor(server: RayfoldServer, viewer: (WsRequest) -> JsonElement) : this(server, WsOptions(), viewer)

    /** Listens on loopback unless [host] says otherwise. */
    fun start(port: Int = 0, host: String = "127.0.0.1"): Listener {
        val socket = ServerSocket()
        socket.bind(InetSocketAddress(host, port))
        return Listener(socket).also { it.accepting.start() }
    }

    inner class Listener internal constructor(private val socket: ServerSocket) : AutoCloseable {
        val address: InetSocketAddress get() = InetSocketAddress(socket.inetAddress, socket.localPort)
        val port: Int get() = socket.localPort
        private val job = SupervisorJob()
        private val connections = ConcurrentHashMap.newKeySet<Connection>()
        internal val accepting: Thread = Thread.ofPlatform().daemon().name("rayfold-ws-accept").unstarted { accept() }

        /** Connections currently open. */
        val open: Int get() = connections.size

        private fun accept() {
            while (!socket.isClosed) {
                val s = try { socket.accept() } catch (e: IOException) { return }
                val c = Connection(s, CoroutineScope(SupervisorJob(job) + Dispatchers.IO))
                connections.add(c)
                Thread.ofVirtual().name("rayfold-ws").start {
                    try { c.run() } finally { connections.remove(c) }
                }
            }
        }

        /** Stops accepting and closes every connection, which cancels their batches and live queries. */
        override fun close() {
            runCatching { socket.close() }
            connections.forEach { it.close() }
            job.cancel()
        }
    }

    private inner class Connection(private val socket: Socket, private val scope: CoroutineScope) {
        private val out = BufferedOutputStream(socket.getOutputStream())
        private val closed = AtomicBoolean(false)

        @Volatile
        private var session: RayfoldWsSession? = null

        fun run() {
            try {
                val input = BufferedInputStream(socket.getInputStream())
                val v = handshake(input) ?: return
                socket.soTimeout = 0
                val s = RayfoldWsSession(server, v, { sendFrame(0x1, it.toByteArray(Charsets.UTF_8)) }, { sendFrame(0x2, it) }, scope, onGoingAway = ::goingAway)
                session = s
                frames(input, s)
            } catch (e: IOException) {
                // the peer went away or the handshake timed out; close() below releases everything
            } finally {
                close()
            }
        }

        /** Reads and checks the opening handshake and answers 101; null after a refusal. */
        private fun handshake(input: InputStream): JsonElement? {
            val deadline = System.nanoTime() + options.handshakeTimeoutMs * 1_000_000L
            val head = ByteArrayOutputStream()
            var tail = 0
            while (tail != 0x0d0a0d0a) {
                val left = (deadline - System.nanoTime()) / 1_000_000
                if (left <= 0) return null
                socket.soTimeout = left.toInt().coerceAtLeast(1) // each read gets only what is left of the whole budget
                val b = input.read()
                if (b < 0) return null
                head.write(b)
                tail = (tail shl 8) or b
                if (head.size() > options.maxHandshakeBytes) { respond(431, "Request Header Fields Too Large", "Request head too large"); return null }
            }
            val lines = head.toString(Charsets.ISO_8859_1).split("\r\n")
            val start = lines[0].split(" ")
            val method = start.getOrElse(0) { "" }
            val target = start.getOrElse(1) { "" }
            val headers = linkedMapOf<String, String>()
            for (line in lines.drop(1)) {
                if (line.isEmpty()) continue
                val i = line.indexOf(':')
                if (i <= 0) continue
                val name = line.substring(0, i).trim().lowercase()
                val value = line.substring(i + 1).trim()
                headers[name] = headers[name]?.let { "$it, $value" } ?: value
            }
            if (method != "GET" || target.substringBefore('?') != options.path || headers["upgrade"]?.lowercase() != "websocket") {
                respond(404, "Not Found", "No WebSocket endpoint at ${target.substringBefore('?')}")
                return null
            }
            // browsers send the page's Origin on the handshake and attach cookies: without this check any site could open a socket as the user
            val refused = Guard.hostProblem(headers["host"], socket.localAddress, options.allowedHosts)
                ?: Guard.originProblem(headers["origin"], headers["host"], options.allowedOrigins)
            if (refused != null) { respond(403, "Forbidden", refused); return null }
            val key = headers["sec-websocket-key"] ?: run { respond(400, "Bad Request", "Missing Sec-WebSocket-Key"); return null }
            val request = WsRequest(method, target, headers, socket.localSocketAddress as InetSocketAddress, socket.remoteSocketAddress as InetSocketAddress)
            val v = try { viewer(request) } catch (e: Exception) { respond(500, "Internal Server Error", "Internal error"); return null }
            val accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + GUID).toByteArray(Charsets.ISO_8859_1)))
            val offered = headers["sec-websocket-protocol"]?.split(",")?.map { it.trim() } ?: emptyList()
            val proto = if (SUBPROTOCOL in offered) "Sec-WebSocket-Protocol: $SUBPROTOCOL\r\n" else ""
            synchronized(out) {
                out.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n$proto\r\n".toByteArray(Charsets.ISO_8859_1))
                out.flush()
            }
            if (RayfoldWsSession.schemaMismatch(server, target.substringAfter('?', "").ifEmpty { null })) {
                closeWith(RayfoldWsSession.SCHEMA_MISMATCH, server.hash, input)
                return null
            }
            return v
        }

        private fun respond(status: Int, reason: String, body: String) {
            val bytes = body.toByteArray()
            val headerText = "HTTP/1.1 $status $reason\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n" +
                "Content-Length: ${bytes.size}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\n\r\n"
            synchronized(out) {
                out.write(headerText.toByteArray(Charsets.ISO_8859_1))
                out.write(bytes)
                out.flush()
            }
            runCatching { socket.shutdownOutput() } // flush the refusal, then close fully
        }

        private fun frames(input: InputStream, session: RayfoldWsSession) {
            val fragments = ByteArrayOutputStream()
            var assembled = 0L
            var binary = false
            while (!closed.get()) {
                val b0 = input.read()
                if (b0 < 0) return // the client's side ended, maybe without a close frame: close() releases its subscriptions
                val b1 = input.read()
                if (b1 < 0) return
                val fin = (b0 and 0x80) != 0
                val opcode = b0 and 0x0f
                var len = (b1 and 0x7f).toLong()
                if (len == 126L) len = number(input, 2) ?: return
                else if (len == 127L) len = number(input, 8) ?: return
                // checked before the payload is read: a frame larger than the limit is never buffered
                if (len < 0 || len > options.maxMessageBytes) return tooBig(input)
                if ((b1 and 0x80) == 0) return closeWith(1002, "client frames must be masked") // RFC 6455 section 5.1
                val mask = input.readNBytes(4)
                val payload = input.readNBytes(len.toInt())
                if (mask.size < 4 || payload.size < len) return
                for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
                when (opcode) {
                    0x8 -> { sendFrame(0x8, ByteArray(0)); return }
                    0x9 -> { sendFrame(0xA, payload); continue }
                    0xA -> continue
                }
                if (opcode == 0x1 || opcode == 0x2) binary = opcode == 0x2 // continuation frames keep the first frame's type
                assembled += len
                if (assembled > options.maxMessageBytes) return tooBig(input)
                fragments.write(payload)
                if (fin) {
                    val message = fragments.toByteArray()
                    fragments.reset()
                    assembled = 0
                    if (binary) session.onBinary(message) else session.onText(message.toString(Charsets.UTF_8))
                }
            }
        }

        private fun number(input: InputStream, bytes: Int): Long? {
            val b = input.readNBytes(bytes)
            if (b.size < bytes) return null
            return b.fold(0L) { acc, x -> (acc shl 8) or (x.toLong() and 0xff) }
        }

        private fun sendFrame(opcode: Int, payload: ByteArray) {
            try {
                synchronized(out) {
                    out.write(0x80 or opcode)
                    when {
                        payload.size < 126 -> out.write(payload.size)
                        payload.size < 65536 -> { out.write(126); out.write(payload.size shr 8); out.write(payload.size and 0xff) }
                        else -> { out.write(127); for (s in 56 downTo 0 step 8) out.write(((payload.size.toLong() shr s) and 0xff).toInt()) }
                    }
                    out.write(payload)
                    out.flush()
                }
            } catch (e: IOException) {
                runCatching { socket.close() } // the reader thread then fails its read and runs close()
            }
        }

        /** Close code 1009 (message too big), flushed to a client that may still be sending, then the connection closes. */
        private fun tooBig(input: InputStream) = closeWith(1009, "message too big", input)

        private fun closeWith(code: Int, reason: String, input: InputStream? = null) {
            cancelAll()
            sendFrame(0x8, byteArrayOf((code shr 8).toByte(), (code and 0xff).toByte()) + reason.toByteArray())
            runCatching { socket.shutdownOutput() }
            if (input == null) return
            // closing with unread input would reset the connection and could destroy the close frame in flight
            val until = System.nanoTime() + LINGER_MS * 1_000_000L
            var drained = 0L
            val sink = ByteArray(16 * 1024)
            try {
                while (drained < DRAIN_LIMIT) {
                    val left = (until - System.nanoTime()) / 1_000_000
                    if (left <= 0) break
                    socket.soTimeout = left.toInt().coerceAtLeast(1)
                    val n = input.read(sink)
                    if (n < 0) break
                    drained += n
                }
            } catch (e: IOException) {
                // timed out or reset: stop draining
            }
        }

        private fun cancelAll() {
            session?.cancelAll()
        }

        /** The server is shutting down and this connection's frames are out: close as a server going away, so the client reconnects elsewhere. */
        private fun goingAway() {
            sendFrame(0x8, byteArrayOf(0x03, 0xe9.toByte()) + "server shutting down".toByteArray())
            runCatching { socket.shutdownOutput() }
            close()
        }

        /** Cancels every batch, waits (bounded) until they let go of their live subscriptions, then releases the socket. */
        fun close() {
            if (!closed.compareAndSet(false, true)) return
            val s = session
            if (s != null) s.close() else scope.cancel()
            runCatching { socket.close() }
        }
    }

    companion object {
        const val SUBPROTOCOL = "rayfold.0.1"
        private const val GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        private const val DRAIN_LIMIT = 1024 * 1024
        private const val LINGER_MS = 2_000L
    }
}
