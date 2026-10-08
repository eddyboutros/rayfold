package com.example.bookshop

import dev.rayfold.client.RayfoldClient
import dev.rayfold.client.Transport
import dev.rayfold.client.args
import dev.rayfold.core.Code
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.SchemaText
import dev.rayfold.test.LocalTransport
import dev.rayfold.test.RayfoldTest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** The bookshop without a network: the real server, called in the test's own process. Every test gets its own store and server. */
class BookshopUnitTest {
    // #region test-setup
    private val store = Store()
    private val schema = SchemaText.load(checkNotNull(javaClass.getResource("/bookshop.rayfold")).readText()).ir
    private val server = RayfoldServer(schema, resolvers(store))

    // one caller per viewer: the value the schema's policies see as `viewer`
    private val anyone = RayfoldTest.of(server)
    private val customer = anyone.signedInAs(mapOf("id" to "u1", "role" to "customer"))
    private val staff = anyone.signedInAs(mapOf("id" to "s1", "role" to "staff"))
    // #endregion test-setup

    private fun json(text: String) = Json.parseToJsonElement(text)

    // #region test-resolver
    @Test
    fun `book returns the shape it was asked for, with the author's name`() {
        val book = anyone.query("book", args("id" to "b1"), shape = "{ title stock author { name } }")
        assertEquals(
            json($$"""{"$type":"Book","title":"A Wizard of Earthsea","stock":3,"author":{"$type":"Author","name":"Ursula K. Le Guin"}}"""),
            book,
        )
        assertEquals(1, store.authorLookups.get())
    }
    // #endregion test-resolver

    // #region test-policy
    @Test
    fun `a customer may not restock, and staff may`() {
        val refused = assertFailsWith<RayfoldException> {
            customer.command("restock", args("bookId" to "b2", "qty" to 5))
        }
        assertEquals(Code.PERMISSION_DENIED, refused.code)
        assertEquals(0, store.book("b2")?.stock)

        val restocked = staff.command("restock", args("bookId" to "b2", "qty" to 5), shape = "{ id stock }")
        assertEquals(json($$"""{"$type":"Book","id":"b2","stock":5}"""), restocked)
        assertEquals(5, store.book("b2")?.stock)
    }
    // #endregion test-policy

    @Test
    fun `buying without signing in is refused, and costPrice is for staff alone`() {
        val anonymous = assertFailsWith<RayfoldException> { anyone.command("buy", args("bookId" to "b1")) }
        assertEquals(Code.UNAUTHENTICATED, anonymous.code)
        // the schema's policy refused it, before the rule that a keyed command needs a caller could
        assertEquals("Sign in to access buy()", anonymous.message)
        assertEquals(3, store.book("b1")?.stock)

        val asked = assertFailsWith<RayfoldException> { customer.query("book", args("id" to "b1"), shape = "{ title costPrice }") }
        assertEquals(Code.PERMISSION_DENIED, asked.code)
        assertEquals("costPrice", asked.path)
        // guard: the same question from staff is answered
        assertEquals(
            json($$"""{"$type":"Book","title":"A Wizard of Earthsea","costPrice":"4.20"}"""),
            staff.query("book", args("id" to "b1"), shape = "{ title costPrice }"),
        )
    }

    @Test
    fun `a purchase of a book the shop does not have is not found, and a sale says what it changed`() {
        val missing = assertFailsWith<RayfoldException> { customer.command("buy", args("bookId" to "b9")) }
        assertEquals(Code.NOT_FOUND, missing.code)
        assertEquals("No book b9", missing.message)

        // guard: a book the shop has is sold, and the StockChanged the schema declares is emitted with its new stock
        val emitted = mutableListOf<String>()
        server.events.on("StockChanged") { emitted.add("${it["bookId"]}:${it["stock"]}") }
        customer.command("buy", args("bookId" to "b3", "qty" to 2))
        assertEquals(listOf("\"b3\":5"), emitted)
    }

    // #region test-error
    @Test
    fun `buying more than the shelf holds fails with OutOfStock and changes nothing`() {
        val error = assertFailsWith<RayfoldException> {
            customer.command("buy", args("bookId" to "b1", "qty" to 5))
        }
        assertEquals(Code.DOMAIN, error.code)
        assertEquals("OutOfStock", error.type)
        assertEquals(json("""{"bookId":"b1","available":3}"""), error.data)
        assertEquals("Only 3 left of A Wizard of Earthsea", error.message)
        assertEquals(3, store.book("b1")?.stock)

        // guard: what the shelf holds can be bought
        customer.command("buy", args("bookId" to "b1", "qty" to 3))
        assertEquals(0, store.book("b1")?.stock)
    }
    // #endregion test-error

    // #region test-replay
    @Test
    fun `a purchase retried with the same key sells once`() {
        val purchase = args("bookId" to "b3", "qty" to 2)
        val key = "purchase-0001-first"
        val first = customer.command("buy", purchase, shape = "{ id stock }", key = key)
        assertEquals(json($$"""{"$type":"Book","id":"b3","stock":5}"""), first)

        // frames() returns what the server sent as it sent it, where command() returns the result alone
        val retry = customer.frames("buy", purchase, shape = "{ id stock }", key = key).single()
        assertEquals(first, retry["ok"])
        assertEquals(json("""{"cost":1,"replay":true}"""), retry["meta"])
        assertEquals(5, store.book("b3")?.stock)

        // guard: without a key of its own each call gets a fresh one, so this is a new purchase
        customer.command("buy", purchase)
        assertEquals(3, store.book("b3")?.stock)
    }
    // #endregion test-replay

    // #region test-live
    @Test
    fun `a live query gets the new stock when someone buys`() {
        anyone.live("book", args("id" to "b3"), shape = "{ id stock }").use { book ->
            assertEquals(json($$"""{"$type":"Book","id":"b3","stock":7}"""), book.next())

            customer.command("buy", args("bookId" to "b3", "qty" to 2))
            // next() waits 5 s at most, and fails the test when nothing came
            assertEquals(json($$"""{"$type":"Book","id":"b3","stock":5}"""), book.next())
        }
        // closed, the query holds nothing on the server
        assertEquals(0, server.changes.size)
    }
    // #endregion test-live

    // #region test-clock
    @Test
    fun `a retry is answered from the first purchase for a day, and is a new purchase after it`() {
        val day = 24 * 60 * 60 * 1000L
        val now = AtomicLong(0)
        // the server tells the time by the clock it is given, and the test moves it
        val timed = RayfoldServer(schema, resolvers(store), now = now::get)
        val customer = RayfoldTest.of(timed).signedInAs(mapOf("id" to "u1", "role" to "customer"))
        val purchase = args("bookId" to "b3", "qty" to 2)

        customer.command("buy", purchase, key = "purchase-0001-first")
        now.set(day - 1)
        customer.command("buy", purchase, key = "purchase-0001-first")
        assertEquals(5, store.book("b3")?.stock)

        now.set(day)
        customer.command("buy", purchase, key = "purchase-0001-first")
        assertEquals(3, store.book("b3")?.stock)
    }
    // #endregion test-clock

    // #region test-client
    @Test
    fun `the client app sees its purchase through the watch`(): Unit = runBlocking {
        // the app's own client, with the server where the network would be, counting the batches it sends
        val local = LocalTransport(server) { buildJsonObject { put("id", "u1"); put("role", "customer") } }
        val batches = AtomicInteger()
        val client = RayfoldClient(Transport { envelope, safe -> batches.incrementAndGet(); local.send(envelope, safe) })
        val lines = mutableListOf<String>()
        withTimeout(5_000) { buyOneCopy(client, lines::add) }
        assertEquals(
            listOf("A Wizard of Earthsea by Ursula K. Le Guin: 3 in stock", "watching: 3 in stock", "after buying one: 2 in stock"),
            lines,
        )
        assertEquals(2, store.book("b1")?.stock)
        // the book, the watch's first read, the purchase: the stock after it came back with the purchase
        assertEquals(3, batches.get())
    }
    // #endregion test-client
}
