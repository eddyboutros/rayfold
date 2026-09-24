package dev.rayfold.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.lang.ref.WeakReference
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The WebSocket transport over real sockets: handshake, batches, cancel, id reuse, live queries, and the spec 12
 * refusals (Origin, Host, 1009, half-open close, handshake timeout), each with a guard. Clients are raw sockets with a
 * 5 s read timeout, so a frame that never comes fails the test instead of hanging it. Every test has its own
 * bookstore and listener, closed afterwards with every socket it opened.
 */
class WebSocketTest {
    private val listeners = mutableListOf<RayfoldWebSocket.Listener>()
    private val sockets = mutableListOf<Socket>()
    private val admin = obj("""{"id":"u9","role":"admin"}""")
    private val KEY = "ws-key-0123456789"

    @AfterEach
    fun stop() {
        sockets.forEach { runCatching { it.close() } }
        listeners.forEach { it.close() }
    }

    private fun listen(bs: Bookstore, options: WsOptions = WsOptions()): RayfoldWebSocket.Listener =
        RayfoldWebSocket(bs.server, options) { viewerOf(it.header("Authorization")) }.start(0).also { listeners.add(it) }

    /** One raw client socket, masking what it sends as RFC 6455 requires of clients. */
    private inner class Ws(port: Int) {
        val socket = Socket("127.0.0.1", port).also { it.soTimeout = 5000; sockets.add(it) }
        val input = BufferedInputStream(socket.getInputStream())
        private val out = socket.getOutputStream()
        var head = ""
        val status: Int get() = head.substringAfter(' ').substringBefore(' ').toIntOrNull() ?: 0
        fun header(name: String): String? = head.split("\r\n").drop(1).firstOrNull { it.substringBefore(':').trim().equals(name, true) }?.substringAfter(':')?.trim()

        fun write(bytes: ByteArray) { out.write(bytes); out.flush() }

        fun readHead(): Ws {
            val b = ByteArrayOutputStream()
            var tail = 0
            while (tail != 0x0d0a0d0a) {
                val c = input.read()
                if (c < 0) break
                b.write(c)
                tail = (tail shl 8) or c
            }
            head = b.toString(Charsets.ISO_8859_1)
            return this
        }

        /** What the server sends until it closes: a refusal's body. */
        fun rest(): String = readAll(input).toString(Charsets.UTF_8)

        fun frame(opcode: Int, payload: ByteArray, fin: Boolean = true, announced: Long = payload.size.toLong(), masked: Boolean = true) {
            val h = ByteArrayOutputStream()
            h.write((if (fin) 0x80 else 0) or opcode)
            val m = if (masked) 0x80 else 0
            when {
                announced < 126 -> h.write(m or announced.toInt())
                announced < 65536 -> { h.write(m or 126); h.write((announced shr 8).toInt() and 0xff); h.write(announced.toInt() and 0xff) }
                else -> { h.write(m or 127); for (s in 56 downTo 0 step 8) h.write(((announced shr s) and 0xff).toInt()) }
            }
            val mask = byteArrayOf(0x11, 0x22, 0x33, 0x44)
            if (masked) h.write(mask)
            write(h.toByteArray() + if (masked) ByteArray(payload.size) { (payload[it].toInt() xor mask[it % 4].toInt()).toByte() } else payload)
        }

        fun text(s: String) = frame(0x1, s.toByteArray())

        /** The next server frame, or null once the server has closed. */
        fun read(): Pair<Int, ByteArray>? = try {
            val b0 = input.read()
            val b1 = input.read()
            if (b0 < 0 || b1 < 0) null
            else {
                var len = (b1 and 0x7f).toLong()
                if (len == 126L) len = input.readNBytes(2).fold(0L) { a, x -> (a shl 8) or (x.toLong() and 0xff) }
                else if (len == 127L) len = input.readNBytes(8).fold(0L) { a, x -> (a shl 8) or (x.toLong() and 0xff) }
                (b0 and 0x0f) to input.readNBytes(len.toInt())
            }
        } catch (e: IOException) {
            if (e is java.net.SocketTimeoutException) throw e // a missing frame fails the test
            null
        }

        /** The next text frame as JSON; control frames in between are skipped. */
        fun next(): JsonObject {
            while (true) {
                val (op, payload) = read() ?: error("socket closed before the next frame")
                if (op == 0x1) return obj(payload.toString(Charsets.UTF_8))
            }
        }

        /** Every frame until the server closes the connection. */
        fun untilClosed(): List<Pair<Int, ByteArray>> = generateSequence { read() }.toList()
    }

    private fun upgrade(port: Int, headers: Map<String, String?> = emptyMap(), target: String = "/rayfold/ws"): Ws {
        val all = linkedMapOf<String, String?>(
            "Host" to "127.0.0.1:$port", "Connection" to "Upgrade", "Upgrade" to "websocket", "Sec-WebSocket-Version" to "13",
            "Sec-WebSocket-Key" to "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Protocol" to "rayfold.0.1",
        )
        all.putAll(headers)
        val ws = Ws(port)
        ws.write(("GET $target HTTP/1.1\r\n" + all.filterValues { it != null }.entries.joinToString("") { "${it.key}: ${it.value}\r\n" } + "\r\n").toByteArray())
        return ws.readHead()
    }

    private fun command(bs: Bookstore, op: String, args: String, key: String, viewer: JsonElement) =
        runBlocking { bs.server.collect(obj("""{"ops":[{"id":1,"op":"$op","args":$args,"key":"$key"}]}"""), viewer) }.single()

    private fun closeCode(frame: Pair<Int, ByteArray>?): Int {
        val (op, payload) = frame ?: error("no close frame")
        assertEquals(0x8, op)
        return ((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff)
    }

    // ------------------------------------------------------------------ protocol

    @Test
    fun `the handshake answers 101 with the RFC 6455 accept key and the rayfold subprotocol, then a batch runs`() {
        val bs = Bookstore()
        val l = listen(bs)
        val ws = upgrade(l.port)
        assertEquals(101, ws.status, ws.head)
        assertEquals("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", ws.header("Sec-WebSocket-Accept"), "the RFC 6455 section 1.3 example")
        assertEquals("websocket", ws.header("Upgrade"))
        assertEquals(RayfoldWebSocket.SUBPROTOCOL, ws.header("Sec-WebSocket-Protocol"))
        ws.text("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id title }"}]}""")
        assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1","title":"The Dispossessed"},"meta":{"cost":1},"fin":true}"""), ws.next())
        val plain = upgrade(l.port, mapOf("Sec-WebSocket-Protocol" to null))
        assertEquals(101, plain.status)
        assertNull(plain.header("Sec-WebSocket-Protocol"), "guard: a subprotocol that was not offered is not claimed")
    }

    @Test
    fun `batches share one socket - concurrent batches, ids remapped by the client, and pipelined refs to remapped ids`() {
        val bs = Bookstore()
        val ws = upgrade(listen(bs).port, mapOf("Authorization" to "Bearer u1"))
        ws.text("""{"ops":[{"id":1,"op":"book","args":{"id":"b2"},"shape":"{ id }"}]}""")
        ws.text("""{"ops":[{"id":2,"op":"book","args":{"id":"b3"},"shape":"{ id }"}]}""")
        val two = listOf(ws.next(), ws.next()).associateBy { it.opId() }
        assertEquals(setOf(1, 2), two.keys)
        assertEquals(obj("""{"${'$'}type":"Book","id":"b3"}"""), two[2]?.get("data"))
        // a client batch 1 -> 2 remapped to 3 -> 4, the ref rewritten to the new id
        ws.text("""{"ops":[{"id":3,"op":"placeOrder","args":{"input":{"lines":[{"bookId":"b3","qty":1}]}},"key":"$KEY"},{"id":4,"op":"order","args":{"id":{"${'$'}ref":"3.id"}},"shape":"{ id total }"}]}""")
        val pipelined = listOf(ws.next(), ws.next()).associateBy { it.opId() }
        assertEquals(
            obj(
                """{"id":3,"ok":{"${'$'}type":"Order","id":"o1","status":"PLACED","total":"8.00","items":[{"qty":1,"unitPrice":"8.00","book":{"${'$'}type":"Book","id":"b3","title":"Kindred"}}]},""" +
                    """"patch":[{"set":"Order:o1","value":{"${'$'}type":"Order","id":"o1","status":"PLACED","total":"8.00","items":[{"qty":1,"unitPrice":"8.00","book":{"${'$'}ref":"Book:b3"}}]}},""" +
                    """{"set":"Book:b3","value":{"${'$'}type":"Book","id":"b3","title":"Kindred"}},{"set":"Book:b3","value":{"stock":99}}],"meta":{"cost":3},"fin":true}""",
            ),
            pipelined[3],
        )
        assertEquals(obj("""{"${'$'}type":"Order","id":"o1","total":"8.00"}"""), pipelined[4]?.get("data"))
    }

    @Test
    fun `two live ops on one socket - cancel stops exactly the op it names, and the other keeps updating`() {
        val bs = Bookstore()
        val ws = upgrade(listen(bs).port)
        ws.text("""{"ops":[{"id":5,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}]}""")
        assertEquals(obj("""{"id":5,"data":{"${'$'}type":"Book","id":"b1","stock":5},"meta":{"cost":1}}"""), ws.next())
        ws.text("""{"ops":[{"id":6,"op":"book","args":{"id":"b2"},"shape":"{ id stock }","live":true}]}""")
        assertEquals(6, ws.next().opId())
        assertEquals(2, bs.server.changes.size)
        command(bs, "restock", """{"bookId":"b1","qty":1}""", "$KEY-1", admin)
        assertEquals(obj("""{"id":5,"patch":[{"set":"Book:b1","value":{"stock":6}}]}"""), ws.next())

        ws.text("""{"cancel":5}""")
        assertEquals(obj("""{"id":5,"error":{"code":"canceled","message":"Canceled"},"fin":true}"""), ws.next())
        assertEquals(1, bs.server.changes.size, "the cancelled op let go of its subscription")
        command(bs, "restock", """{"bookId":"b2","qty":1}""", "$KEY-2", admin)
        assertEquals(obj("""{"id":6,"patch":[{"set":"Book:b2","value":{"stock":3}}]}"""), ws.next(), "guard: the other live op still updates")
    }

    @Test
    fun `of two live ops sent in one batch, cancel stops the one it names and the other keeps updating`() {
        val bs = Bookstore()
        val ws = upgrade(listen(bs).port)
        ws.text("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true},{"id":2,"op":"book","args":{"id":"b2"},"shape":"{ id stock }","live":true}]}""")
        assertEquals(setOf(1, 2), setOf(ws.next().opId(), ws.next().opId()))
        ws.text("""{"cancel":1}""")
        assertEquals(obj("""{"id":1,"error":{"code":"canceled","message":"Canceled"},"fin":true}"""), ws.next())
        assertEquals(1, bs.server.changes.size, "the cancelled op let go of its subscription, and only it")
        command(bs, "restock", """{"bookId":"b2","qty":1}""", "$KEY-b", admin)
        assertEquals(obj("""{"id":2,"patch":[{"set":"Book:b2","value":{"stock":3}}]}"""), ws.next(), "the op its batch still holds hears its change")
        ws.text("""{"cancel":2}""")
        assertEquals(obj("""{"id":2,"error":{"code":"canceled","message":"Canceled"},"fin":true}"""), ws.next(), "guard: the second cancel ends the second op")
        assertEquals(0, bs.server.changes.size)
    }

    @Test
    fun `a batch refused as a whole is answered for each of its op ids, and the socket runs the next batch (guard)`() {
        val bs = Bookstore(BatchOptions(budget = 2))
        val ws = upgrade(listen(bs).port)
        ws.text("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"},{"id":2,"op":"book","args":{"id":"b1"},"shape":"{ id }"},{"id":3,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}""")
        val over = """{"code":"resource_exhausted","message":"Batch cost 3 exceeds budget 2","data":{"cost":3,"budget":2}}"""
        assertEquals((1..3).map { obj("""{"id":$it,"error":$over,"fin":true}""") }, List(3) { ws.next() })
        ws.text("""{"ops":[{"id":4,"op":"book","args":{"id":"b1"}},{"id":5,"op":"nope"}]}""")
        val unknown = """{"code":"invalid_argument","message":"ops[1].op: unknown operation \"nope\""}"""
        assertEquals(listOf(4, 5).map { obj("""{"id":$it,"error":$unknown,"fin":true}""") }, List(2) { ws.next() })
        ws.text("""{"ops":[{"id":1,"op":"book","args":{"id":"b2"},"shape":"{ id }"}]}""")
        assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b2"},"meta":{"cost":1},"fin":true}"""), ws.next())
    }

    @Test
    fun `a session closed from its own batch as the server goes away does not wait for itself`() {
        val bs = Bookstore()
        val frames = LinkedBlockingQueue<String>()
        val closed = CountDownLatch(1)
        var session: RayfoldWsSession? = null
        // as the transports do: going away closes the session, here from the batch that saw its last op end
        val s = RayfoldWsSession(bs.server, JsonNull, { frames.add(it) }, {}, onGoingAway = { session?.close(); closed.countDown() })
        session = s
        s.onText("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }","live":true}]}""")
        assertEquals(1, frames.poll(5, TimeUnit.SECONDS)?.let { obj(it).opId() })
        runBlocking { bs.server.drain(5_000) }
        assertEquals("unavailable", frames.poll(5, TimeUnit.SECONDS)?.let { obj(it).errorCode() })
        // it waited for itself until its own 5 s bound, which stalled every connection a drain closed
        assertTrue(closed.await(3, TimeUnit.SECONDS), "close() returned without waiting out its bound")
    }

    @Test
    fun `guard - a session closed from outside still waits until its batches let go of their live subscriptions`() {
        val bs = Bookstore()
        val frames = LinkedBlockingQueue<String>()
        val session = RayfoldWsSession(bs.server, JsonNull, { frames.add(it) }, {})
        session.onText("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }","live":true}]}""")
        assertEquals(1, frames.poll(5, TimeUnit.SECONDS)?.let { obj(it).opId() })
        assertEquals(1, bs.server.changes.size)
        session.close()
        assertEquals(0, bs.server.changes.size)
    }

    /** A closed session whose send callback holds the returned object, which nothing else holds. */
    private fun closedSession(server: RayfoldServer): WeakReference<Any> {
        val held = Any()
        RayfoldWsSession(server, JsonNull, { held.hashCode() }, {}).close()
        return WeakReference(held)
    }

    @Test
    fun `a closed session is not kept alive by the server it served, and an open one still hears it go away (guard)`() {
        val bs = Bookstore()
        val ref = closedSession(bs.server)
        // bounded, no sleep: a reference only the server's drain handler kept never clears, however often this asks
        for (i in 0 until 50) {
            if (ref.get() == null) break
            System.gc()
        }
        assertNull(ref.get(), "the server's drain handler still held a closed session")
        val went = CountDownLatch(1)
        RayfoldWsSession(bs.server, JsonNull, {}, {}, onGoingAway = { went.countDown() })
        runBlocking { bs.server.drain(1_000) }
        assertTrue(went.await(5, TimeUnit.SECONDS))
    }

    @Test
    fun `an op id held by a running batch is refused, and the id is free again once its op ended (guard)`() {
        val bs = Bookstore()
        val ws = upgrade(listen(bs).port)
        ws.text("""{"ops":[{"id":7,"op":"book","args":{"id":"b1"},"shape":"{ id }","live":true}]}""")
        assertEquals(7, ws.next().opId())
        ws.text("""{"ops":[{"id":7,"op":"book","args":{"id":"b2"},"shape":"{ id }"}]}""")
        assertEquals(obj("""{"error":{"code":"invalid_argument","message":"op id 7 is already in use on this connection"},"fin":true}"""), ws.next())
        ws.text("""{"cancel":7}""")
        assertEquals("canceled", ws.next().errorCode())
        ws.text("""{"ops":[{"id":7,"op":"book","args":{"id":"b2"},"shape":"{ id }"}]}""")
        assertEquals(obj("""{"${'$'}type":"Book","id":"b2"}"""), ws.next()["data"])
        ws.text("""{"ops":[{"id":7,"op":"book","args":{"id":"b3"},"shape":"{ id }"}]}""")
        assertEquals(obj("""{"${'$'}type":"Book","id":"b3"}"""), ws.next()["data"], "a finished op's id is free at once")
    }

    @Test
    fun `a message that is not JSON or not an envelope gets an error frame, and the socket keeps serving (guard)`() {
        val bs = Bookstore()
        val ws = upgrade(listen(bs).port)
        ws.text("{nope")
        assertEquals(obj("""{"error":{"code":"invalid_argument","message":"Message is not valid JSON"},"fin":true}"""), ws.next())
        ws.text("""{"id":1,"item":1}""")
        assertEquals(obj("""{"error":{"code":"invalid_argument","message":"Expected a batch envelope or {cancel}"},"fin":true}"""), ws.next())
        ws.text("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}""")
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1"}"""), ws.next()["data"])
    }

    @Test
    fun `a ping gets a pong with its payload, and a close frame is answered and closes the connection`() {
        val bs = Bookstore()
        val ws = upgrade(listen(bs).port)
        ws.frame(0x9, "hi".toByteArray())
        val (op, payload) = ws.read() ?: error("no pong")
        assertEquals(0xA, op)
        assertEquals("hi", payload.toString(Charsets.UTF_8))
        ws.frame(0x8, byteArrayOf(0x03, 0xe8.toByte()))
        assertEquals(0x8, ws.read()?.first)
        assertNull(ws.read(), "the server closed the connection")
    }

    @Test
    fun `the viewer comes from the handshake - an anonymous socket is refused by a policy, a signed-in one is served`() {
        val bs = Bookstore()
        val l = listen(bs)
        val anon = upgrade(l.port)
        anon.text("""{"ops":[{"id":1,"op":"myOrders"}]}""")
        assertEquals("unauthenticated", anon.next().errorCode())
        val signedIn = upgrade(l.port, mapOf("Authorization" to "Bearer u1"))
        signedIn.text("""{"ops":[{"id":1,"op":"myOrders","shape":"{ total }"}]}""")
        assertEquals(obj("""{"total":0}"""), signedIn.next()["data"])
    }

    // ------------------------------------------------------------------ spec 12

    @Test
    fun `a WebSocket opened by a foreign page is refused at the handshake with 403`() {
        val bs = Bookstore()
        val l = listen(bs)
        val attack = upgrade(l.port, mapOf("Origin" to "https://evil.example"))
        assertEquals(403, attack.status)
        assertEquals("nosniff", attack.header("X-Content-Type-Options"))
        assertEquals("Origin https://evil.example is not allowed", attack.rest())
        assertEquals(0, bs.server.changes.size)
    }

    @Test
    fun `guard - a client without Origin, the same origin and an allowed origin get 101`() {
        val bs = Bookstore()
        val l = listen(bs, WsOptions(allowedOrigins = setOf("https://app.example")))
        for (origin in listOf(null, "http://127.0.0.1:${l.port}", "https://app.example")) {
            assertEquals(101, upgrade(l.port, mapOf("Origin" to origin)).status, "$origin")
        }
    }

    @Test
    fun `a loopback listener refuses a foreign or missing Host at the handshake (guard - loopback names and an allowed host get 101)`() {
        val bs = Bookstore()
        val l = listen(bs)
        val rebound = upgrade(l.port, mapOf("Host" to "evil.example:${l.port}"))
        assertEquals(403, rebound.status)
        assertEquals("Host evil.example:${l.port} is not allowed on a loopback server", rebound.rest())
        val bare = upgrade(l.port, mapOf("Host" to null))
        assertEquals(403, bare.status, bare.head)
        assertEquals("Missing Host header", bare.rest())
        assertEquals(101, upgrade(l.port, mapOf("Host" to "localhost:${l.port}")).status)
        val listed = listen(Bookstore(), WsOptions(allowedHosts = setOf("ws.example")))
        assertEquals(101, upgrade(listed.port, mapOf("Host" to "ws.example")).status)
        assertEquals(403, upgrade(listed.port).status, "an explicit list replaces the loopback rule")
    }

    @Test
    fun `a wrong path or a plain GET is 404 and a handshake without a key is 400`() {
        val bs = Bookstore()
        val l = listen(bs)
        assertEquals(404, upgrade(l.port, target = "/rayfold/other").status)
        assertEquals(404, upgrade(l.port, mapOf("Upgrade" to null, "Connection" to null)).status)
        assertEquals(400, upgrade(l.port, mapOf("Sec-WebSocket-Key" to null)).status)
        assertEquals(101, upgrade(l.port).status, "guard")
    }

    /** A handshake whose head, blank line included, is exactly [total] bytes. */
    private fun handshakeOf(port: Int, total: Int): Ws {
        fun head(pad: String) = "GET /rayfold/ws HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: rayfold.0.1\r\nX-Pad: $pad\r\n\r\n"
        val text = head("x".repeat(total - head("").length))
        assertEquals(total, text.length)
        return Ws(port).also { it.write(text.toByteArray(Charsets.ISO_8859_1)) }.readHead()
    }

    @Test
    fun `a handshake head one byte over maxHandshakeBytes is 431, and one of exactly the limit is upgraded (guard)`() {
        assertEquals(16 * 1024, WsOptions().maxHandshakeBytes)
        val l = listen(Bookstore())
        // one over: the byte that crosses the limit is the head's last, so the server has read everything it was sent
        val over = handshakeOf(l.port, 16 * 1024 + 1)
        assertEquals(431, over.status, over.head)
        assertEquals("Request head too large", over.rest())
        assertEquals(101, handshakeOf(l.port, 16 * 1024).status)
    }

    @Test
    fun `a frame announcing more than the limit is cut off with close code 1009 before it is buffered`() {
        assertEquals(1024 * 1024, WsOptions().maxMessageBytes, "spec 12 section 3 default")
        val bs = Bookstore()
        val l = listen(bs)
        val ws = upgrade(l.port)
        ws.frame(0x1, ByteArray(64 * 1024), announced = 2L * 1024 * 1024) // announces 2 MiB, sends 64 KiB
        assertEquals(1009, closeCode(ws.read()))
        assertNull(ws.read(), "then the server closes")
        val ok = upgrade(l.port)
        ok.text("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}""")
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1"}"""), ok.next()["data"], "guard: a normal message on a new socket is answered")
    }

    @Test
    fun `fragments that add up to more than the limit close with 1009, while a message of exactly the limit is answered (guard)`() {
        val bs = Bookstore()
        val l = listen(bs, WsOptions(maxMessageBytes = 1024))
        val over = upgrade(l.port)
        over.frame(0x1, ByteArray(600) { ' '.code.toByte() }, fin = false)
        over.frame(0x0, ByteArray(600) { ' '.code.toByte() })
        assertEquals(1009, closeCode(over.read()))

        val body = """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}"""
        val exact = (body + " ".repeat(1024 - body.length)).toByteArray()
        assertEquals(1024, exact.size)
        val at = upgrade(l.port)
        at.frame(0x1, exact.copyOfRange(0, 500), fin = false)
        at.frame(0x0, exact.copyOfRange(500, 1024))
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1"}"""), at.next()["data"])
    }

    @Test
    fun `an unmasked client frame closes the connection with 1002`() {
        val bs = Bookstore()
        val ws = upgrade(listen(bs).port)
        ws.frame(0x1, """{"ops":[{"id":1,"op":"book","args":{"id":"b1"}}]}""".toByteArray(), masked = false)
        assertEquals(1002, closeCode(ws.read()))
        assertNull(bs.store.calls["Query.book"])
    }

    @Test
    fun `a client that vanishes without a close frame releases its socket and live subscriptions`() {
        val bs = Bookstore()
        val ws = upgrade(listen(bs).port)
        ws.text("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}]}""")
        assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1","stock":5},"meta":{"cost":1}}"""), ws.next())
        assertEquals(1, bs.server.changes.size, "guard: while the connection is open, its live query stays subscribed")
        ws.socket.shutdownOutput() // FIN, no close frame
        ws.untilClosed() // the server closes its side once it has cancelled the connection's batches
        assertEquals(0, bs.server.changes.size)
    }

    @Test
    fun `closing the listener closes its connections and releases their live subscriptions`() {
        val bs = Bookstore()
        val l = listen(bs)
        val ws = upgrade(l.port)
        ws.text("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }","live":true}]}""")
        ws.next()
        assertEquals(1, bs.server.changes.size)
        l.close()
        ws.untilClosed()
        assertEquals(0, bs.server.changes.size)
    }

    @Test
    fun `a client that never finishes its handshake is dropped after the listener's own timeout (guard - a prompt handshake on it succeeds)`() {
        val bs = Bookstore()
        val l = listen(bs, WsOptions(handshakeTimeoutMs = 200))
        val slow = Ws(l.port)
        slow.write("GET /rayfold/ws HTTP/1.1\r\nHost: 127.0.0.1\r\n".toByteArray())
        // bounded by the 5 s socket timeout: a server that never drops the client fails here with SocketTimeoutException
        assertEquals(-1, slow.input.read(), "the server closed the stalled connection")
        assertEquals(101, upgrade(l.port).status)
    }

    @Test
    fun `a socket naming another schema is closed with 4409 and the server's hash, one naming its own is served (guard)`() {
        val bs = Bookstore()
        val port = listen(bs).port
        val stale = upgrade(port, target = "/rayfold/ws?auth=x&schema=sha256%3Astale")
        assertEquals(101, stale.status)
        val (op, payload) = stale.read() ?: error("no close frame")
        assertEquals(0x8 to 4409, op to (((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff)))
        assertEquals(bs.server.hash, payload.copyOfRange(2, payload.size).toString(Charsets.UTF_8))
        assertNull(stale.read(), "nothing follows the close")

        val same = upgrade(port, target = "/rayfold/ws?schema=${java.net.URLEncoder.encode(bs.server.hash, Charsets.UTF_8)}")
        same.text("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}""")
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1"}"""), same.next()["data"])
    }

    @Test
    fun `a binary message is RB and is answered in binary RB frames, beside text on the same socket`() {
        val bs = Bookstore()
        val rb = RbCodec(bs.server.ir)
        val ws = upgrade(listen(bs).port)
        fun binaryFrames(): List<JsonElement> {
            val (op, payload) = ws.read() ?: error("socket closed")
            assertEquals(0x2, op, "a binary message")
            return rb.decodeFrames(payload)
        }
        ws.frame(0x2, rb.encode(obj("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id title }"}]}""")))
        assertEquals(listOf(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1","title":"The Dispossessed"},"meta":{"cost":1},"fin":true}""")), binaryFrames())
        ws.text("""{"ops":[{"id":2,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}""")
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1"}"""), ws.next()["data"], "guard: text on the same socket is answered in text")
        ws.frame(0x2, byteArrayOf(0x0a))
        assertEquals(listOf(obj("""{"error":{"code":"invalid_argument","message":"Message is not valid RB"},"fin":true}""")), binaryFrames())
        // a fragmented binary message: the continuation frame keeps the first frame's type
        val bytes = rb.encode(obj("""{"ops":[{"id":3,"op":"book","args":{"id":"b2"},"shape":"{ id }"}]}"""))
        ws.frame(0x2, bytes.copyOfRange(0, 5), fin = false)
        ws.frame(0x0, bytes.copyOfRange(5, bytes.size))
        assertEquals(listOf(obj("""{"id":3,"data":{"${'$'}type":"Book","id":"b2"},"meta":{"cost":1},"fin":true}""")), binaryFrames())
    }
}
