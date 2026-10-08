package dev.rayfold.test

import dev.rayfold.client.RayfoldClient
import dev.rayfold.client.RayfoldClientException
import dev.rayfold.client.Transport
import dev.rayfold.client.args
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** The real client over the real server, with [LocalTransport] where the network would be. */
class LocalTransportTest {
    private val shop = Shop()
    private val customer = buildJsonObject { put("id", "u1"); put("role", "customer") }
    private val staff = buildJsonObject { put("id", "s1"); put("role", "staff") }

    private fun bounded(block: suspend CoroutineScope.() -> Unit) = runBlocking { withTimeout(5_000) { block() } }

    @Test
    fun `a client's query is answered by the server's resolver`() = bounded {
        val client = RayfoldClient(LocalTransport(shop.server))
        assertEquals(json($$"""{"$type":"Book","title":"Book b1","stock":3}"""), client.query("book", args("id" to "b1"), "{ title stock }"))
    }

    @Test
    fun `a client's command runs on the server`() = bounded {
        val client = RayfoldClient(LocalTransport(shop.server) { customer })
        assertEquals(json($$"""{"$type":"Book","id":"b1","stock":1}"""), client.command("buy", args("bookId" to "b1", "qty" to 2), "{ id stock }"))
        assertEquals(1, shop.stock["b1"])
        assertEquals(1, shop.purchases.get())
    }

    @Test
    fun `the policies see the transport's viewer - a customer is refused what staff are given`() = bounded {
        val refused = assertFailsWith<RayfoldClientException> { RayfoldClient(LocalTransport(shop.server) { customer }).command("restock", args("bookId" to "b2", "qty" to 5)) }
        assertEquals("permission_denied", refused.code)
        assertEquals("Not allowed to access restock()", refused.message)
        assertEquals(0, shop.stock["b2"])
        // guard: the same command through a transport signed in as staff
        RayfoldClient(LocalTransport(shop.server) { staff }).command("restock", args("bookId" to "b2", "qty" to 5))
        assertEquals(5, shop.stock["b2"])
    }

    @Test
    fun `without a viewer the caller is anonymous`() = bounded {
        val refused = assertFailsWith<RayfoldClientException> { RayfoldClient(LocalTransport(shop.server)).command("buy", args("bookId" to "b1")) }
        assertEquals("unauthenticated", refused.code)
        assertEquals(0, shop.purchases.get())
    }

    @Test
    fun `the viewer is asked for with every batch, so a test can sign in between two calls`() = bounded {
        var viewer: JsonElement = JsonNull
        val asked = AtomicInteger()
        val client = RayfoldClient(LocalTransport(shop.server) { asked.incrementAndGet(); viewer })
        assertEquals("unauthenticated", assertFailsWith<RayfoldClientException> { client.command("buy", args("bookId" to "b1")) }.code)
        viewer = customer
        client.command("buy", args("bookId" to "b1"))
        assertEquals(1, shop.purchases.get())
        assertEquals(2, asked.get())
    }

    @Test
    fun `a watch sees a command's patch without asking the server again`() = bounded {
        val batches = AtomicInteger()
        val local = LocalTransport(shop.server) { customer }
        val client = RayfoldClient(Transport { envelope, safe -> batches.incrementAndGet(); local.send(envelope, safe) })
        val seen = Channel<JsonElement>(Channel.UNLIMITED)
        val watch = launch { client.watch("book", args("id" to "b1"), "{ id stock }").collect { seen.send(it) } }
        assertEquals(json($$"""{"$type":"Book","id":"b1","stock":3}"""), seen.receive())
        client.command("buy", args("bookId" to "b1", "qty" to 2), "{ id stock }")
        assertEquals(json($$"""{"$type":"Book","id":"b1","stock":1}"""), seen.receive())
        assertEquals(2, batches.get(), "the watch's read and the purchase")
        watch.cancelAndJoin()
    }

    @Test
    fun `the frames are the server's own, one for one`() = bounded {
        val envelope = json("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }"},{"id":2,"op":"restock","args":{"bookId":"b1","qty":1},"key":"restock-0001-first"}]}""") as JsonObject
        assertEquals(shop.server.collect(envelope, customer), LocalTransport(shop.server) { customer }.send(envelope, false).toList())
        assertEquals(3, shop.stock["b1"])
    }

    @Test
    fun `cancelling a live query's collection gives the server its subscription back`() = bounded {
        val client = RayfoldClient(LocalTransport(shop.server))
        val seen = Channel<JsonElement>(Channel.UNLIMITED)
        val live = launch { client.live("book", args("id" to "b1"), "{ id stock }").collect { seen.send(it) } }
        assertEquals(json($$"""{"$type":"Book","id":"b1","stock":3}"""), seen.receive())
        assertEquals(1, shop.server.changes.size)
        assertEquals(1, shop.server.inflight)
        live.cancelAndJoin()
        assertEquals(0, shop.server.changes.size)
        assertEquals(0, shop.server.inflight)
    }

    @Test
    fun `a collection that stops at the first frame ends the batch on the server`() = bounded {
        val envelope = json("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"live":true}]}""") as JsonObject
        val first = LocalTransport(shop.server).send(envelope, false).first()
        assertEquals(json($$"""{"$type":"Book","id":"b1","title":"Book b1","stock":3}"""), first["data"])
        assertEquals(0, shop.server.changes.size)
    }
}
