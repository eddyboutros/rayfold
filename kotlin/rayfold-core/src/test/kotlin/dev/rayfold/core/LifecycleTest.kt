package dev.rayfold.core

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.Socket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * What a load balancer and a rolling deploy need from a server (mirrors packages/server/src/lifecycle.test.ts): to be
 * told when it can take traffic, and a shutdown that finishes what is running, sends long-lived clients elsewhere,
 * and only then goes away. Driven over the real HTTP and WebSocket transports; the two waits whose length matters
 * (a readiness check that never answers, a drain that gives up) run on virtual time.
 */
class LifecycleTest {
    private val ir = SchemaText.load(
        "entity Book { id: ID stock: Int } event StockChanged { bookId: ID stock: Int } " +
            "query book(id: ID): Book? command restock(id: ID, qty: Int): Book emits StockChanged stream stockUpdates(bookIds: [ID]): StockChanged",
    ).ir
    private val key = "0123456789abcdef"
    private val viewer = obj("""{"id":"u1"}""")
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val started = mutableListOf<HttpServer>()
    private val listeners = mutableListOf<RayfoldWebSocket.Listener>()
    private val sockets = mutableListOf<Socket>()
    private val gates = mutableListOf<CountDownLatch>()
    private val unavailable = obj("""{"id":1,"error":{"code":"unavailable","message":"The server is shutting down"},"fin":true}""")
    private val opened = obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1","stock":3},"meta":{"cost":1}}""")
    private val liveBook = """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}"""

    @AfterEach
    fun stop() {
        gates.forEach { it.countDown() } // a command held for a test is let go, so its thread ends
        sockets.forEach { runCatching { it.close() } }
        listeners.forEach { it.close() }
        started.forEach { it.stop(0) }
        client.shutdownNow()
    }

    /** A server whose restock says when it is [running] and, when held, waits for the test's [release]. */
    private class Built(val server: RayfoldServer, val running: CountDownLatch, val release: CountDownLatch)

    private fun build(relay: Relay? = null, hold: Boolean = false): Built {
        val books = ConcurrentHashMap(mapOf("b1" to obj("""{"id":"b1","stock":3}""")))
        val running = CountDownLatch(1)
        val release = CountDownLatch(1).also { gates.add(it) }
        val resolvers = Resolvers(
            queries = mapOf("book" to query { args, _ -> books[args.s("id")] ?: JsonNull }),
            commands = mapOf(
                "restock" to command { args, _ ->
                    running.countDown()
                    if (hold) assertTrue(release.await(30, TimeUnit.SECONDS), "the test never released the command")
                    val id = args.s("id")
                    val book = books[id] ?: error("no book $id")
                    val next = JsonObject(book + ("stock" to JsonPrimitive(book.i("stock") + args.i("qty"))))
                    books[id] = next
                    CommandResult(next, emit = listOf("StockChanged" to buildJsonObject { put("bookId", id); put("stock", next.i("stock")) }))
                },
            ),
            streams = mapOf(
                "stockUpdates" to { args, ctx ->
                    val wanted = (args["bookIds"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }?.toSet() ?: emptySet()
                    callbackFlow<JsonElement> {
                        val off = ctx.events.on("StockChanged") { p -> if ((p["bookId"] as? JsonPrimitive)?.content in wanted) trySend(p) }
                        awaitClose { off() }
                    }
                },
            ),
        )
        return Built(RayfoldServer(ir, resolvers, relay = relay), running, release)
    }

    private class Served(val base: String, val http: HttpServer)

    private fun serve(server: RayfoldServer, options: HttpOptions = HttpOptions()): Served {
        val http = RayfoldHttp(server, options) { viewer }.start(0)
        started.add(http)
        return Served("http://127.0.0.1:${http.address.port}", http)
    }

    private fun request(method: String, url: String, body: String? = null): HttpRequest = HttpRequest.newBuilder(URI(url)).timeout(Duration.ofSeconds(5))
        .method(method, if (body == null) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(body))
        .header("Content-Type", "application/rayfold+json").build()

    private fun get(url: String): HttpResponse<String> = client.send(request("GET", url), HttpResponse.BodyHandlers.ofString())

    private fun restock(base: String, key: String): HttpResponse<String> =
        client.send(request("POST", "$base/rayfold", """{"ops":[{"id":1,"op":"restock","args":{"id":"b1","qty":1},"key":"$key"}]}"""), HttpResponse.BodyHandlers.ofString())

    private fun header(res: HttpResponse<String>, name: String): String? = res.headers().firstValue(name).orElse(null)

    /** A streaming response, its frames taken one at a time, each within 5 s. */
    private class Streamed(private val frames: LinkedBlockingQueue<JsonObject>) {
        fun next(): JsonObject = frames.poll(5, TimeUnit.SECONDS) ?: error("no frame within 5 s")
    }

    private fun stream(base: String, op: String): Streamed {
        val res = client.sendAsync(request("POST", "$base/rayfold", """{"ops":[$op]}"""), HttpResponse.BodyHandlers.ofInputStream()).get(5, TimeUnit.SECONDS)
        assertEquals(200, res.statusCode())
        val frames = LinkedBlockingQueue<JsonObject>()
        Thread.ofVirtual().start {
            res.body().bufferedReader().useLines { lines -> lines.filter { it.isNotBlank() }.forEach { frames.add(obj(it)) } }
        }
        return Streamed(frames)
    }

    // ------------------------------------------------------------------ health and readiness

    @Test
    fun `health answers while the process runs, and readiness is true for a server with nothing to wait for`() {
        val base = serve(build().server).base
        val health = get("$base/rayfold/health")
        assertEquals(200, health.statusCode())
        assertEquals("""{"status":"ok"}""", health.body())
        assertEquals("no-store", header(health, "Cache-Control"))
        val ready = get("$base/rayfold/ready")
        assertEquals(200, ready.statusCode())
        assertEquals("""{"ready":true,"reasons":[]}""", ready.body())
        assertEquals("no-store", header(ready, "Cache-Control"))
    }

    @Test
    fun `readiness waits for the relay, and says what stopped it`() {
        val listening = CompletableDeferred<Unit>()
        val slow = object : Relay {
            override suspend fun publish(message: RelayMessage) {}
            override suspend fun subscribe(onMessage: (RelayMessage) -> Unit): suspend () -> Unit { listening.await(); return {} }
        }
        val waiting = build(relay = slow).server
        val base = serve(waiting).base
        val pending = get("$base/rayfold/ready")
        assertEquals(503, pending.statusCode())
        assertEquals("""{"ready":false,"reasons":["relay: not listening yet"]}""", pending.body())
        listening.complete(Unit)
        runBlocking { withTimeout(5_000) { waiting.ready() } }
        assertEquals("""{"ready":true,"reasons":[]}""", get("$base/rayfold/ready").body())

        val broken = object : Relay {
            override suspend fun publish(message: RelayMessage) {}
            override suspend fun subscribe(onMessage: (RelayMessage) -> Unit): suspend () -> Unit = throw IllegalStateException("LISTEN failed")
        }
        val failed = build(relay = broken).server
        assertEquals("LISTEN failed", assertFailsWith<IllegalStateException> { runBlocking { withTimeout(5_000) { failed.ready() } } }.message)
        val failedBase = serve(failed).base
        val res = get("$failedBase/rayfold/ready")
        assertEquals(503, res.statusCode())
        assertEquals("""{"ready":false,"reasons":["relay: LISTEN failed"]}""", res.body())
        assertEquals(200, get("$failedBase/rayfold/health").statusCode(), "alive, just not ready")
    }

    @Test
    fun `runs the configured checks and names the one that failed`() {
        val refused = serve(build().server, HttpOptions(readiness = mapOf("db" to { throw IllegalStateException("connection refused") }, "cache" to {}))).base
        val res = get("$refused/rayfold/ready")
        assertEquals(503, res.statusCode())
        assertEquals("""{"ready":false,"reasons":["db: connection refused"]}""", res.body())

        val healthy = serve(build().server, HttpOptions(readiness = mapOf("db" to {}, "cache" to {}))).base
        assertEquals("""{"ready":true,"reasons":[]}""", get("$healthy/rayfold/ready").body(), "guard: checks that pass leave it ready")

        // the route's own wait, with a short limit so the exchange stays within its 5 s
        val stuck = serve(build().server, HttpOptions(readiness = mapOf("db" to { awaitCancellation() }), readinessTimeoutMs = 50)).base
        val late = get("$stuck/rayfold/ready")
        assertEquals(503, late.statusCode())
        assertEquals("""{"ready":false,"reasons":["db: no answer within 50 ms"]}""", late.body())
    }

    @Test
    fun `a check that never answers counts as failed exactly at the limit`() = runTest(timeout = 5.seconds) {
        val asked = CompletableDeferred<Unit>()
        val http = RayfoldHttp(build().server, HttpOptions(readiness = mapOf("db" to { asked.complete(Unit); awaitCancellation() }, "cache" to {})))
        val answer = async { http.readiness() }
        asked.await() // the limit runs only from here; advancing earlier would miss it
        advanceTimeBy(1_999)
        runCurrent()
        assertFalse(answer.isCompleted, "still waiting one millisecond before the limit")
        advanceTimeBy(1)
        runCurrent()
        assertEquals(Readiness(false, listOf("db: no answer within 2000 ms")), answer.await())
        assertEquals(2_000L, HttpOptions().readinessTimeoutMs, "the default limit is the one the route uses")
    }

    /** Waits, bounded, for the server to be down to [n] operations in flight. */
    private suspend fun inflightReaches(server: RayfoldServer, n: Int) {
        withTimeout(5_000) { while (server.inflight != n) delay(5) }
    }

    // ------------------------------------------------------------------ draining

    @Test
    fun `drain ends a live query and a stream with a retryable unavailable, lets a running command finish, and returns once it has`() = runBlocking {
        val built = build(hold = true)
        val base = serve(built.server).base
        val live = stream(base, liveBook)
        val updates = stream(base, """{"id":1,"op":"stockUpdates","args":{"bookIds":["b1"]}}""")
        assertEquals(opened, live.next())

        val command = client.sendAsync(request("POST", "$base/rayfold", """{"ops":[{"id":1,"op":"restock","args":{"id":"b1","qty":1},"key":"$key"}]}"""), HttpResponse.BodyHandlers.ofString())
        assertTrue(built.running.await(5, TimeUnit.SECONDS), "the command running")
        // only the live query's first frame was awaited above, so the stream may not be registered yet
        inflightReaches(built.server, 3)

        // on its own thread: the frame reads below block this one
        val draining = async(Dispatchers.IO) { built.server.drain(timeoutMs = 5_000) }
        assertEquals(unavailable, live.next())
        assertEquals(unavailable, updates.next())
        assertFalse(draining.isCompleted, "the command is still running: shutting down waits for it")
        // the frame reaching the client is not the server having finished with the op, so wait for the count to
        // settle rather than reading it the instant the last frame arrives
        inflightReaches(built.server, 1)

        built.release.countDown()
        val answered = command.get(5, TimeUnit.SECONDS)
        assertEquals(200, answered.statusCode())
        assertTrue(answered.body().contains(""""ok":{"${'$'}type":"Book","id":"b1","stock":4}"""), answered.body())
        withTimeout(5_000) { draining.await() }
        assertEquals(0, built.server.inflight)

        // from here the balancer is told to look elsewhere, and so is anything that still arrives
        val ready = get("$base/rayfold/ready")
        assertEquals(503, ready.statusCode())
        assertEquals("""{"ready":false,"reasons":["shutting down"]}""", ready.body())
        assertEquals("""{"status":"ok"}""", get("$base/rayfold/health").body())
        val late = restock(base, key + "2")
        assertEquals(503, late.statusCode())
        assertEquals("1", header(late, "Retry-After"))
        assertEquals("application/problem+json", header(late, "Content-Type"))
        val problem = obj(late.body())
        assertEquals(JsonPrimitive("unavailable"), problem["code"])
        assertEquals(JsonPrimitive("The server is shutting down"), problem["detail"])
    }

    @Test
    fun `drain gives up waiting for a batch that never finishes at exactly timeoutMs`() = runTest(timeout = 5.seconds) {
        val built = build(hold = true) // never released until the test ends
        val base = serve(built.server).base
        val command = client.sendAsync(request("POST", "$base/rayfold", """{"ops":[{"id":1,"op":"restock","args":{"id":"b1","qty":1},"key":"$key"}]}"""), HttpResponse.BodyHandlers.ofString())
        assertTrue(built.running.await(5, TimeUnit.SECONDS), "the command running")
        val draining = async { built.server.drain(timeoutMs = 1_000) }
        advanceTimeBy(999)
        runCurrent()
        assertFalse(draining.isCompleted)
        advanceTimeBy(1)
        runCurrent()
        assertTrue(draining.isCompleted, "given up at the timeout")
        assertEquals(1, built.server.inflight, "still running; the process is about to end regardless")
        built.release.countDown()
        assertEquals(200, command.get(5, TimeUnit.SECONDS).statusCode(), "guard: the command was not cut off, only no longer waited for")
    }

    /** A raw WebSocket client, masking what it sends as RFC 6455 requires; frames are read within 5 s or the test fails. */
    private inner class Ws(private val port: Int) {
        private val socket = Socket("127.0.0.1", port).also { it.soTimeout = 5_000; sockets.add(it) }
        private val input = BufferedInputStream(socket.getInputStream())
        private val out = socket.getOutputStream()

        fun upgrade(): Int {
            out.write(
                ("GET /rayfold/ws HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
                    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: rayfold.0.1\r\n\r\n").toByteArray(),
            )
            out.flush()
            val head = ByteArrayOutputStream()
            var tail = 0
            while (tail != 0x0d0a0d0a) {
                val c = input.read()
                if (c < 0) break
                head.write(c)
                tail = (tail shl 8) or c
            }
            return head.toString(Charsets.ISO_8859_1).substringAfter(' ').substringBefore(' ').toIntOrNull() ?: 0
        }

        fun text(s: String) {
            val payload = s.toByteArray()
            val mask = byteArrayOf(0x11, 0x22, 0x33, 0x44)
            val h = ByteArrayOutputStream()
            h.write(0x81)
            if (payload.size < 126) h.write(0x80 or payload.size) else { h.write(0x80 or 126); h.write(payload.size shr 8); h.write(payload.size and 0xff) }
            h.write(mask)
            out.write(h.toByteArray() + ByteArray(payload.size) { (payload[it].toInt() xor mask[it % 4].toInt()).toByte() })
            out.flush()
        }

        /** The next server frame as opcode and payload, or null once the server has closed. */
        fun read(): Pair<Int, ByteArray>? {
            val b0 = input.read()
            val b1 = input.read()
            if (b0 < 0 || b1 < 0) return null
            var len = (b1 and 0x7f).toLong()
            if (len == 126L) len = input.readNBytes(2).fold(0L) { a, x -> (a shl 8) or (x.toLong() and 0xff) }
            else if (len == 127L) len = input.readNBytes(8).fold(0L) { a, x -> (a shl 8) or (x.toLong() and 0xff) }
            return (b0 and 0x0f) to input.readNBytes(len.toInt())
        }
    }

    @Test
    fun `closes a WebSocket as a server going away, after the frames that end its live queries`() {
        val built = build()
        val listener = RayfoldWebSocket(built.server) { viewer }.start(0).also { listeners.add(it) }
        val ws = Ws(listener.port)
        assertEquals(101, ws.upgrade())
        ws.text("""{"ops":[$liveBook]}""")
        val (firstOp, first) = ws.read() ?: error("closed before the first frame")
        assertEquals(0x1 to opened, firstOp to obj(first.toString(Charsets.UTF_8)))

        runBlocking { withTimeout(5_000) { built.server.drain() } }
        val (endOp, end) = ws.read() ?: error("closed before the ending frame")
        assertEquals(0x1 to unavailable, endOp to obj(end.toString(Charsets.UTF_8)))
        val (closeOp, close) = ws.read() ?: error("closed without a close frame")
        assertEquals(0x8, closeOp)
        assertEquals(1001, ((close[0].toInt() and 0xff) shl 8) or (close[1].toInt() and 0xff))
        assertEquals("server shutting down", close.copyOfRange(2, close.size).toString(Charsets.UTF_8))
        assertNull(ws.read(), "and then the connection is gone")

        val late = Ws(listener.port)
        assertEquals(101, late.upgrade(), "a socket that connects while draining is accepted")
        val (lateOp, lateClose) = late.read() ?: error("closed without a close frame")
        assertEquals(0x8 to 1001, lateOp to (((lateClose[0].toInt() and 0xff) shl 8) or (lateClose[1].toInt() and 0xff)))
        assertNull(late.read(), "and closed at once, having nothing to finish")
    }

    @Test
    fun `shutdown drains, closes the port, and stops hearing the relay`() = runBlocking {
        val relay = MemoryRelay()
        val built = build(relay = relay.join())
        withTimeout(5_000) { built.server.ready() }
        assertEquals(1, relay.size)
        val served = serve(built.server)
        assertEquals(200, restock(served.base, key).statusCode())

        withTimeout(5_000) { shutdown(built.server, served.http) }
        assertEquals(0, relay.size)
        assertEquals(listOf("shutting down"), built.server.readiness().reasons)
        assertFailsWith<IOException> { get("${served.base}/rayfold/health") }
    }
}
