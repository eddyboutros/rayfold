package dev.rayfold.core

import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.seconds

/**
 * The server's clock (`RayfoldServer(now = ...)`), as `createRayfoldServer({ now })` has it in packages/server: one
 * clock behind `now()` in policies, the context's `now`, the default idempotency store, usage records, the start time
 * and the uptime. Every test owns its clock and its server, and nothing here reads the machine's time except the
 * guards that say a server without a clock still does.
 */
class ServerClockTest {
    private val ir = SchemaText.load(
        """
        entity Post @allow(read: this.publishedAt <= now()) {
          id: ID
          title: String
          publishedAt: Long
          opensAt: Long
          comments: String? @allow(read: now() >= this.opensAt)
        }
        object Tick { at: Long }
        query post(id: ID): Post
        query sale: Tick @allow(read: now() >= 5000)
        query time: Tick
        command publish(id: ID): Post
        command retract(id: ID): Post @allow(write: now() < 9000)
        command revise(id: ID): Post
        stream ticks: Tick @allow(read: now() >= 7000)
        """,
    ).ir

    private fun post(publishedAt: Long, opensAt: Long = 0) =
        obj("""{"id":"p1","title":"Hello","publishedAt":$publishedAt,"opensAt":$opensAt,"comments":"first"}""")

    private val u1 = obj("""{"id":"u1"}""")

    /** The server, and the commands that ran on it, in order. */
    private class Shop(val server: RayfoldServer, val ran: MutableList<String>)

    /** A server over one post; [now] is the clock it is given, and null gives it none. */
    private fun shop(post: JsonObject, now: (() -> Long)?, usage: UsageSink? = null): Shop {
        val ran = CopyOnWriteArrayList<String>()
        val resolvers = Resolvers(
            queries = mapOf(
                "post" to query { _, _ -> post },
                "sale" to query { _, _ -> obj("""{"at":0}""") },
                "time" to query { _, ctx -> obj("""{"at":${ctx.now()}}""") },
            ),
            commands = listOf("publish", "retract").associateWith { name -> command { _, _ -> ran.add(name); CommandResult(post) } } +
                // the stored post is at version 2, whatever the caller believes
                ("revise" to command { _, ctx -> ctx.checkVersion("Post:p1", JsonPrimitive(2), post); CommandResult(post) }),
            streams = mapOf("ticks" to { _, _ -> flowOf<JsonElement>(obj("""{"at":1}""")) }),
        )
        return Shop(RayfoldServer(ir, resolvers, usage = usage, now = now), ran)
    }

    private suspend fun RayfoldServer.ask(op: String) = collect(batch(op), u1)

    private fun List<JsonObject>.codes(): List<String?> = map { it.errorCode() }

    private val readPost = """{"id":1,"op":"post","args":{"id":"p1"},"shape":"{ id title }"}"""
    private val readComments = """{"id":1,"op":"post","args":{"id":"p1"},"shape":"{ id comments }"}"""
    private val publish = """{"id":1,"op":"publish","args":{"id":"p1"},"shape":"{ id }","key":"publish-key-0000001"}"""
    private val retract = """{"id":1,"op":"retract","args":{"id":"p1"},"shape":"{ id }","key":"retract-key-0000001"}"""

    @Test
    fun `an entity's read policy is decided by the server's clock - refused before the hour, allowed from it`() = runTest(timeout = 5.seconds) {
        var clock = 999L
        val s = shop(post(publishedAt = 1_000), { clock }).server
        val refused = s.ask(readPost).single()
        assertEquals("permission_denied", refused.errorCode())
        assertEquals("Not allowed to access Post at result", refused.errorMessage())

        clock = 1_000
        assertEquals(listOf(obj("""{"id":1,"data":{"${'$'}type":"Post","id":"p1","title":"Hello"},"fin":true,"meta":{"cost":1}}""")), s.ask(readPost))
    }

    @Test
    fun `a field's read policy is decided by the server's clock`() = runTest(timeout = 5.seconds) {
        var clock = 1_999L
        val s = shop(post(publishedAt = 0, opensAt = 2_000), { clock }).server
        val refused = s.ask(readComments).single()
        assertEquals("permission_denied", refused.errorCode())
        assertEquals(JsonPrimitive("comments"), (refused["error"] as JsonObject)["path"])
        // guard: it is the field the clock closed, not the post
        assertEquals(listOf<String?>(null), s.ask(readPost).codes())

        clock = 2_000
        assertEquals(JsonPrimitive("first"), (s.ask(readComments).single()["data"] as JsonObject)["comments"])
    }

    @Test
    fun `a query's own policy is decided by the server's clock`() = runTest(timeout = 5.seconds) {
        var clock = 4_999L
        val s = shop(post(0), { clock }).server
        val sale = """{"id":1,"op":"sale","shape":"{ at }"}"""
        assertEquals(listOf<String?>("permission_denied"), s.ask(sale).codes())

        clock = 5_000
        assertEquals(obj("""{"at":0}"""), s.ask(sale).single()["data"])
    }

    @Test
    fun `a command's policy is decided by the server's clock, and a refused command does not run`() = runTest(timeout = 5.seconds) {
        var clock = 9_000L
        val shop = shop(post(0), { clock })
        assertEquals(listOf<String?>("permission_denied"), shop.server.ask(retract).codes())
        assertEquals(emptyList(), shop.ran.toList())

        clock = 8_999
        assertEquals(listOf<String?>(null), shop.server.ask(retract).codes())
        assertEquals(listOf("retract"), shop.ran.toList())
    }

    @Test
    fun `a stream's policy is decided by the server's clock`() = runTest(timeout = 5.seconds) {
        var clock = 6_999L
        val s = shop(post(0), { clock }).server
        val ticks = """{"id":1,"op":"ticks","shape":"{ at }"}"""
        assertEquals(listOf<String?>("permission_denied"), s.ask(ticks).codes())

        clock = 7_000
        assertEquals(listOf(JsonPrimitive(1)), s.ask(ticks).mapNotNull { (it["item"] as? JsonObject)?.get("at") })
    }

    @Test
    fun `a compact live query is decided by the server's clock like any other`() = runTest(timeout = 5.seconds) {
        var clock = 999L
        val s = shop(post(publishedAt = 1_000), { clock }).server
        val live = """{"id":1,"op":"post","args":{"id":"p1"},"shape":"{ id title }","live":true,"compact":true}"""
        assertEquals(listOf<String?>("permission_denied"), s.ask(live).codes())

        clock = 1_000
        val stop = Job()
        val first = withTimeout(5_000) { s.execute(batch(live), ExecuteOptions(u1, cancel = stop)).first() }
        assertEquals(obj("""{"id":"p1","title":"Hello"}"""), first["data"])
        stop.complete()
        assertEquals(0, s.changes.size, "the query gave its subscription back")
    }

    @Test
    fun `the current value a version conflict carries is read by the server's clock`() = runTest(timeout = 5.seconds) {
        var clock = 999L
        val s = shop(post(publishedAt = 1_000), { clock }).server
        val revise = """{"id":1,"op":"revise","args":{"id":"p1"},"shape":"{ id title }","ifVersion":1,"key":"revise-key-00000001"}"""
        fun JsonObject.current() = ((this["error"] as JsonObject)["data"] as JsonObject)["current"]

        val before = s.ask(revise).single()
        assertEquals("VersionConflict", ((before["error"] as JsonObject)["type"] as JsonPrimitive).content)
        assertEquals(JsonNull, before.current(), "not published yet: the conflict does not show it")

        clock = 1_000
        assertEquals(obj("""{"${'$'}type":"Post","id":"p1","title":"Hello"}"""), s.ask(revise).single().current())
    }

    @Test
    fun `a resolver reads the server's clock from its context`() = runTest(timeout = 5.seconds) {
        var clock = 1_234L
        val s = shop(post(0), { clock }).server
        val time = """{"id":1,"op":"time","shape":"{ at }"}"""
        assertEquals(obj("""{"at":1234}"""), s.ask(time).single()["data"])
        clock = 5_678
        assertEquals(obj("""{"at":5678}"""), s.ask(time).single()["data"])
    }

    @Test
    fun `guard - a server given no clock decides by the system's`() = runTest(timeout = 5.seconds) {
        // a millisecond into 1970 is behind any machine's clock, and the last one a Long holds is ahead of it
        assertEquals(listOf<String?>(null), shop(post(publishedAt = 1), null).server.ask(readPost).codes())
        assertEquals(listOf<String?>("permission_denied"), shop(post(publishedAt = Long.MAX_VALUE), null).server.ask(readPost).codes())
    }

    @Test
    fun `the default idempotency store expires by the server's clock`() = runTest(timeout = 5.seconds) {
        val day = 24 * 60 * 60 * 1000L
        var clock = 1_000_000L
        val shop = shop(post(0), { clock })
        fun JsonObject.replayed() = (this["meta"] as? JsonObject)?.get("replay") == JsonPrimitive(true)

        assertEquals(false, shop.server.ask(publish).single().replayed())
        clock = 1_000_000 + day - 1
        assertEquals(true, shop.server.ask(publish).single().replayed(), "guard: a millisecond short of a day the record answers")
        assertEquals(listOf("publish"), shop.ran.toList())

        clock = 1_000_000 + day
        assertEquals(false, shop.server.ask(publish).single().replayed())
        assertEquals(listOf("publish", "publish"), shop.ran.toList())
    }

    @Test
    fun `guard - a store the server is given keeps its own clock`() = runTest(timeout = 5.seconds) {
        var serverClock = 0L
        var storeClock = 0L
        val ran = CopyOnWriteArrayList<String>()
        val server = RayfoldServer(
            ir,
            Resolvers(commands = mapOf("publish" to command { _, _ -> ran.add("publish"); CommandResult(post(0)) })),
            idempotency = MemoryIdempotencyStore(ttlMs = 100, now = { storeClock }),
            now = { serverClock },
        )
        server.ask(publish)
        serverClock = 100
        server.ask(publish)
        assertEquals(listOf("publish"), ran.toList(), "the server's clock passed the time to live, the store's did not")

        storeClock = 100
        server.ask(publish)
        assertEquals(listOf("publish", "publish"), ran.toList())
    }

    @Test
    fun `usage is recorded at the server's clock, for the operation and for each member`() = runTest(timeout = 5.seconds) {
        var clock = 42L
        val seen = CopyOnWriteArrayList<String>()
        val s = shop(post(0), { clock }, usage = { event, at -> seen.add("${event.path.ifEmpty { event.op }}@$at") }).server
        s.ask(readPost)
        assertEquals(listOf("post@42", "Post.id@42", "Post.title@42"), seen.toList())

        clock = 43
        s.ask(readPost)
        assertEquals(listOf("post@43", "Post.id@43", "Post.title@43"), seen.drop(3))
    }

    @Test
    fun `the server started and has been up by its own clock, whatever the identity it was given says`() {
        var clock = 1_000L
        val server = RayfoldServer(ir, Resolvers(), identity = ServerIdentity(name = "bookshop", instance = "i1"), now = { clock })
        clock = 3_500
        assertEquals(ServerIdentity(name = "bookshop", instance = "i1", startedAt = 1_000), server.identity)
        assertEquals(2_500, server.uptimeMs)
        assertEquals(3_500, server.now())
    }

    @Test
    fun `guard - without a clock the identity's own start time is kept`() {
        val identity = ServerIdentity(name = "bookshop", instance = "i1", startedAt = 42)
        assertEquals(identity, RayfoldServer(ir, Resolvers(), identity = identity).identity)
    }
}
