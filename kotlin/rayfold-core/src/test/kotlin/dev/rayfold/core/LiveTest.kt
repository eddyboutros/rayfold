package dev.rayfold.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Test
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * Live queries (spec 08), mirroring packages/server/src/live.test.ts, driven through RayfoldServer.execute on virtual
 * time: every wait is `withTimeout` on the test scheduler (a missed frame fails at virtual 5 s), and
 * `advanceUntilIdle` lets a re-run finish before the next change, so re-run counts are exact. Each test has its own
 * bookstore; every test checks that the change bus is empty once its live ops ended.
 */
class LiveTest {
    private val KEY = "0123456789abcdef"
    private val admin = obj("""{"id":"u9","role":"admin"}""")
    private val u1 = obj("""{"id":"u1","role":"customer"}""")
    private val ebook = obj("""{"id":"b9","title":"New","format":"EBOOK","price":"1.00","stock":1,"authorId":"a1","costPrice":null,"ownerId":"u1"}""")

    /** A running live batch: [next] takes the next frame (bounded), [stop] completes the cancel job and returns the frames after it. */
    private class LiveRun(scope: CoroutineScope, server: RayfoldServer, ops: String, viewer: JsonElement = JsonNull) {
        val cancel = Job()
        private val channel = Channel<JsonObject>(Channel.UNLIMITED)
        val job = scope.launch {
            try {
                server.execute(obj("""{"ops":[$ops]}"""), ExecuteOptions(viewer, cancel = cancel)).collect { channel.send(it) }
            } finally {
                channel.close()
            }
        }

        suspend fun next(): JsonObject = withTimeout(5_000) { channel.receive() }

        suspend fun stop(): List<JsonObject> {
            cancel.complete()
            val rest = mutableListOf<JsonObject>()
            withTimeout(5_000) { for (f in channel) rest.add(f) }
            return rest
        }
    }

    private suspend fun command(server: RayfoldServer, op: String, args: String, key: String, viewer: JsonElement) =
        server.collect(obj("""{"ops":[{"id":1,"op":"$op","args":$args,"key":"$key"}]}"""), viewer).single()

    private val canceled = obj("""{"id":1,"error":{"code":"canceled","message":"Canceled"},"fin":true}""")

    @Test
    fun `diffResults emits a patch when only entity fields changed, data when the structure changed, and null when equal`() {
        val a = obj("""{"items":[{"${'$'}type":"Book","id":"b1","stock":5},{"${'$'}type":"Book","id":"b2","stock":1}]}""")
        assertEquals(null, Live.diffResults(a, a))
        val patch = Live.diffResults(a, obj("""{"items":[{"${'$'}type":"Book","id":"b1","stock":3},{"${'$'}type":"Book","id":"b2","stock":1}]}"""))
        assertEquals(listOf(obj("""{"set":"Book:b1","value":{"stock":3}}""")), (patch as Live.Diff.Patch).patch)
        val reordered = obj("""{"items":[{"${'$'}type":"Book","id":"b2","stock":1},{"${'$'}type":"Book","id":"b1","stock":5}]}""")
        assertEquals(reordered, (Live.diffResults(a, reordered) as Live.Diff.Data).data)
    }

    @Test
    fun `changeFromPatch reads set, del and inv keys and invOp operations`() {
        val c = Live.changeFromPatch(listOf(obj("""{"set":"Book:b1","value":{}}"""), obj("""{"del":"Review:r1"}"""), obj("""{"inv":["Author:a1"]}"""), obj("""{"invOp":["books"]}""")))
        assertEquals(Change(setOf("Book:b1", "Review:r1", "Author:a1"), setOf("books")), c)
    }

    @Test
    fun `re-runs on a command patch touching its read set and sends a minimal patch`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val live = LiveRun(this, bs.server, """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}""")
        assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1","stock":5},"meta":{"cost":1}}"""), live.next(), "no fin: still open")
        command(bs.server, "restock", """{"bookId":"b2","qty":1}""", KEY + "x", admin) // same type, other row: re-run, no frame
        advanceUntilIdle()
        command(bs.server, "placeOrder", """{"input":{"lines":[{"bookId":"b1","qty":2}]}}""", KEY, u1)
        // the b1 patch is the very next frame, so the b2 re-run sent nothing
        assertEquals(obj("""{"id":1,"patch":[{"set":"Book:b1","value":{"stock":3}}]}"""), live.next())
        assertEquals(3, bs.store.calls["Query.book"])
        assertEquals(1, bs.server.changes.size, "guard: the open op holds its subscription")
        assertEquals(listOf(canceled), live.stop())
        assertEquals(0, bs.server.changes.size)
    }

    @Test
    fun `sends nothing when a re-run gives the same result, a full data frame when membership changes, and honours invOp`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val live = LiveRun(this, bs.server, """{"id":1,"op":"books","args":{"filter":{"format":"EBOOK"},"page":{"first":5}},"shape":"{ items { id } }","live":true}""")
        assertEquals(obj("""{"id":1,"data":{"items":[{"${'$'}type":"Book","id":"b3"}]},"meta":{"cost":11}}"""), live.next())
        // addReview patches invOp ["books"], so the query re-runs; its result is unchanged, which must produce no frame
        command(bs.server, "addReview", """{"input":{"bookId":"b3","rating":5,"body":"!"}}""", KEY, u1)
        advanceUntilIdle()
        bs.store.books["b9"] = ebook
        bs.server.changes.publish(Change(emptySet(), setOf("books")))
        assertEquals(obj("""{"id":1,"data":{"items":[{"${'$'}type":"Book","id":"b3"},{"${'$'}type":"Book","id":"b9"}]},"meta":{"cost":11}}"""), live.next(), "the planned cost, as in the first frame")
        assertEquals(3, bs.store.calls["Query.books"], "initial, the silent re-run after addReview, the membership re-run")
        assertEquals(listOf(canceled), live.stop())
        assertEquals(0, bs.server.changes.size)
    }

    @Test
    fun `live queries respect policies and coexist with commands in the same batch`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        assertEquals(listOf(obj("""{"id":1,"error":{"code":"unauthenticated","message":"Sign in to access myOrders()"},"fin":true}""")),
            bs.server.collect(obj("""{"ops":[{"id":1,"op":"myOrders","live":true}]}""")))
        assertEquals(0, bs.server.changes.size, "a refused live op never subscribes")
        val live = LiveRun(this, bs.server, """{"id":1,"op":"placeOrder","args":{"input":{"lines":[{"bookId":"b3","qty":1}]}},"key":"$KEY"},{"id":2,"op":"myOrders","shape":"{ items { id status } }","live":true}""", u1)
        val seen = mutableListOf(live.next(), live.next())
        assertEquals(listOf("data", "ok"), seen.map { if ("ok" in it) "ok" else if ("data" in it) "data" else "?" }.sorted(), "independent ops may interleave")
        // whether the live query saw the order at once or through a membership re-run, it converges on [o1]
        while (seen.none { it.opId() == 2 && "data" in it && "o1" in it.toString() }) seen.add(live.next())
        advanceUntilIdle()
        command(bs.server, "cancelOrder", """{"id":"o1"}""", KEY + "c", u1)
        assertEquals(obj("""{"id":2,"patch":[{"set":"Order:o1","value":{"status":"CANCELLED"}}]}"""), live.next())
        assertEquals(listOf(obj("""{"id":2,"error":{"code":"canceled","message":"Canceled"},"fin":true}""")), live.stop())
        assertEquals(0, bs.server.changes.size)
    }

    @Test
    fun `compact live queries send a compact first frame and then minimal patches, since reads are tracked on the typed result`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val live = LiveRun(this, bs.server, """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock author { id name } }","live":true,"compact":true}""")
        assertEquals(obj("""{"id":1,"data":{"id":"b1","stock":5,"author":{"id":"a1","name":"Ursula K. Le Guin"}}}"""), live.next())
        command(bs.server, "restock", """{"bookId":"b1","qty":2}""", KEY, admin)
        assertEquals(obj("""{"id":1,"patch":[{"set":"Book:b1","value":{"stock":7}}]}"""), live.next())
        assertEquals(listOf(canceled), live.stop())
        assertEquals(0, bs.server.changes.size)
    }

    @Test
    fun `compact live queries re-send a list in compact form after a membership change (no type, no meta)`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val live = LiveRun(this, bs.server, """{"id":1,"op":"books","args":{"filter":{"format":"EBOOK"},"page":{"first":5}},"shape":"{ items { id } }","live":true,"compact":true}""")
        assertEquals(obj("""{"id":1,"data":{"items":[{"id":"b3"}]}}"""), live.next())
        bs.store.books["b9"] = ebook
        bs.server.changes.publish(Change(emptySet(), setOf("books")))
        assertEquals(obj("""{"id":1,"data":{"items":[{"id":"b3"},{"id":"b9"}]}}"""), live.next())
        live.stop()
        assertEquals(0, bs.server.changes.size)
    }

    @Test
    fun `changes that arrive before a re-run runs are coalesced into exactly one re-run`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val live = LiveRun(this, bs.server, """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}""")
        live.next()
        repeat(3) { bs.server.changes.publish(Change(setOf("Book:b1"), emptySet())) }
        advanceUntilIdle()
        assertEquals(2, bs.store.calls["Query.book"], "three changes, one re-run")
        bs.server.changes.publish(Change(setOf("Book:b1"), emptySet()))
        advanceUntilIdle()
        assertEquals(3, bs.store.calls["Query.book"], "guard: a change after that re-run schedules another")
        bs.server.changes.publish(Change(setOf("Author:a2"), setOf("author")))
        advanceUntilIdle()
        assertEquals(4, bs.store.calls["Query.book"], "Author is reachable from Book, so a change to any author re-runs (spec 08 section 3)")
        bs.server.changes.publish(Change(setOf("Order:o7"), setOf("myOrders")))
        advanceUntilIdle()
        assertEquals(4, bs.store.calls["Query.book"], "guard: a change to an unreachable type and another op does not")
        live.stop()
    }

    @Test
    fun `a dry run publishes no change, so a live query does not re-run - the real command does (guard)`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val live = LiveRun(this, bs.server, """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}""")
        live.next()
        val sim = bs.server.collect(obj("""{"ops":[{"id":1,"op":"placeOrder","args":{"input":{"lines":[{"bookId":"b1","qty":2}]}},"key":"$KEY","simulate":true}]}"""), u1).single()
        assertTrue("ok" in sim, sim.toString())
        advanceUntilIdle()
        assertEquals(1, bs.store.calls["Query.book"])
        command(bs.server, "placeOrder", """{"input":{"lines":[{"bookId":"b1","qty":2}]}}""", KEY, u1)
        assertEquals(obj("""{"id":1,"patch":[{"set":"Book:b1","value":{"stock":3}}]}"""), live.next())
        live.stop()
    }

    @Test
    fun `a re-run that fails ends the live op with its error and releases the subscription`() = runTest(timeout = 5.seconds) {
        val store = BookstoreStore()
        val base = bookstoreResolvers(store)
        var runs = 0
        val resolvers = Resolvers(
            queries = base.queries + ("book" to { args, ctx -> if (++runs > 1) throw RayfoldException(Code.UNAVAILABLE, "store offline"); base.queries.getValue("book")(args, ctx) }),
            commands = base.commands, fields = base.fields,
        )
        val server = RayfoldServer(Oracle.ir("bookstore.ir.json"), resolvers)
        val live = LiveRun(this, server, """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}""")
        assertTrue("data" in live.next(), "guard: the first run succeeds")
        server.changes.publish(Change(setOf("Book:b1"), emptySet()))
        assertEquals(obj("""{"id":1,"error":{"code":"unavailable","message":"store offline"},"fin":true}"""), live.next())
        live.job.join()
        assertEquals(0, server.changes.size)
    }

    @Test
    fun `a batch deadline ends a live query with deadline_exceeded and unsubscribes it`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val frames = Channel<JsonObject>(Channel.UNLIMITED)
        val job = launch {
            bs.server.execute(obj("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }","live":true}],"meta":{"deadline":100}}""")).collect { frames.send(it) }
            frames.close()
        }
        assertTrue("data" in withTimeout(5_000) { frames.receive() })
        assertEquals(1, bs.server.changes.size, "guard: subscribed until the deadline")
        assertEquals(obj("""{"id":1,"error":{"code":"deadline_exceeded","message":"Batch deadline exceeded"},"fin":true}"""), withTimeout(5_000) { frames.receive() })
        job.join()
        assertEquals(0, bs.server.changes.size)
    }

    @Test
    fun `a collector that stops collecting cancels the live query and unsubscribes it`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val first = Channel<JsonObject>(1)
        val job = launch { bs.server.execute(obj("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"live":true}]}""")).collect { first.trySend(it) } }
        assertTrue("data" in withTimeout(5_000) { first.receive() })
        assertEquals(1, bs.server.changes.size)
        job.cancel()
        job.join()
        assertEquals(0, bs.server.changes.size)
    }

    @Test
    fun `deferred parts take part in the read set and diffs - a change to a lazy field is a patch`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val live = LiveRun(this, bs.server, """{"id":1,"op":"author","args":{"id":"a1"},"shape":"{ id name bio }","live":true}""")
        val first = live.next()
        assertEquals(obj("""{"${'$'}type":"Author","id":"a1","name":"Ursula K. Le Guin"}"""), first["data"])
        assertEquals(null, first["fin"], "still open")
        assertEquals(obj("""{"id":1,"at":"","data":{"bio":"American author of speculative fiction."}}"""), live.next())
        bs.store.authors["a1"] = JsonObject(bs.store.authors.getValue("a1") + ("bio" to JsonPrimitive("Wrote Earthsea.")))
        bs.server.changes.publish(Change(setOf("Author:a1"), emptySet()))
        assertEquals(obj("""{"id":1,"patch":[{"set":"Author:a1","value":{"bio":"Wrote Earthsea."}}]}"""), live.next(), "the first run's closing fin was held back, so the patch comes next")
        assertEquals(listOf(canceled), live.stop())
    }

    @Test
    fun `a compact live query over a union keeps the members' type in its first frame and after a membership change`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer("core/11-unions.json")
        val live = LiveRun(this, fx.server, """{"id":1,"op":"search","shape":"{ ...on Book { id title } ...on Author { name } }","live":true,"compact":true}""")
        assertEquals(obj("""{"id":1,"data":[{"${'$'}type":"Book","id":"b1","title":"T1"},{"${'$'}type":"Author","name":"Ann"}]}"""), live.next(),
            "a union member's type is the only way to know it, so compaction keeps it (the Book-with-author test shows other types lose it)")
        fx.store.table("Hit").add(mutableMapOf("\$type" to JsonPrimitive("Book"), "id" to JsonPrimitive("b2"), "title" to JsonPrimitive("T2")))
        fx.server.changes.publish(Change(setOf("Book:b2"), emptySet()))
        assertEquals(obj("""{"id":1,"data":[{"${'$'}type":"Book","id":"b1","title":"T1"},{"${'$'}type":"Author","name":"Ann"},{"${'$'}type":"Book","id":"b2","title":"T2"}]}"""), live.next())
        live.stop()
        assertEquals(0, fx.server.changes.size)
    }

    /** A live book query over RayfoldHttp with 20 ms keep-alives, read as it streams; [accept] picks NDJSON or RB. */
    private fun liveOverHttp(bs: Bookstore, accept: String, check: (HttpResponse<java.io.InputStream>) -> Unit) {
        val http = RayfoldHttp(bs.server, HttpOptions(keepAliveMs = 20)).start(0)
        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
        try {
            val req = HttpRequest.newBuilder(URI("http://127.0.0.1:${http.address.port}/rayfold")).timeout(Duration.ofSeconds(5))
                .header("Content-Type", "application/rayfold+json").header("Accept", accept)
                .POST(HttpRequest.BodyPublishers.ofString("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}]}""")).build()
            check(client.send(req, HttpResponse.BodyHandlers.ofInputStream()))
        } finally {
            http.stop(0)
            client.shutdownNow()
        }
    }

    /** Bounded: a missed release fails the test instead of hanging it. */
    private fun untilReleased(bs: Bookstore) {
        val deadline = System.nanoTime() + 5_000_000_000L
        while (bs.server.changes.size > 0) {
            check(System.nanoTime() < deadline) { "the live query still holds its subscription" }
            Thread.onSpinWait()
        }
    }

    @Test
    fun `a live query over HTTP streams its patches between keep-alive lines, and a client that leaves releases it`() {
        val bs = Bookstore()
        liveOverHttp(bs, "application/rayfold-frames+json") { res ->
            assertEquals(200, res.statusCode())
            assertEquals("no-store", res.headers().firstValue("Cache-Control").orElse(null))
            val lines = res.body().bufferedReader()
            fun line(): String = CompletableFuture.supplyAsync { lines.readLine() }.get(5, TimeUnit.SECONDS) ?: error("the stream ended")
            assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1","stock":5},"meta":{"cost":1}}"""), obj(line()), "no fin: still open")
            assertEquals("", line(), "nothing changed, so a keep-alive comes next")
            assertEquals(1, bs.server.changes.size, "guard: the open stream holds its subscription")
            runBlocking { command(bs.server, "placeOrder", """{"input":{"lines":[{"bookId":"b1","qty":2}]}}""", KEY, u1) }
            assertEquals(obj("""{"id":1,"patch":[{"set":"Book:b1","value":{"stock":3}}]}"""), obj(generateSequence { line() }.first { it.isNotEmpty() }))
            res.body().close() // the client leaves; the next keep-alive fails to write, which cancels the batch
            untilReleased(bs)
        }
    }

    @Test
    fun `a live query over RB gets zero-length frames as keep-alives`() {
        val bs = Bookstore()
        val rb = RbCodec(bs.server.ir)
        liveOverHttp(bs, "application/rayfold") { res ->
            assertEquals("application/rayfold", res.headers().firstValue("Content-Type").orElse(null))
            val input = res.body()
            fun byte(): Int = CompletableFuture.supplyAsync { input.read() }.get(5, TimeUnit.SECONDS)
            val d = rb.decoder()
            val first = generateSequence { d.feed(byteArrayOf(byte().toByte())) }.first { it.isNotEmpty() }
            assertEquals(listOf(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1","stock":5},"meta":{"cost":1}}""")), first)
            assertEquals(0, byte(), "a zero-length frame")
            assertEquals(0, byte(), "and another, while nothing changes")
            input.close()
            untilReleased(bs)
        }
    }
}
