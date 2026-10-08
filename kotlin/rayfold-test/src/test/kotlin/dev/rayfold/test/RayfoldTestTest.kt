package dev.rayfold.test

import dev.rayfold.client.args
import dev.rayfold.core.Code
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.jupiter.api.Timeout
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A shop built from schema text, as an application's is, and called with nothing between the test and the server. */
internal class Shop {
    val stock = ConcurrentHashMap(mapOf("b1" to 3, "b2" to 0))

    /** How many times the `buy` resolver ran. */
    val purchases = AtomicInteger()

    /** Counted down when the batch holding `stuck` is cancelled. */
    val abandoned = CountDownLatch(1)

    /** What `blocked` holds its thread on, without suspending; bounded, so a test that never counts it down still ends. */
    val release = CountDownLatch(1)

    private fun book(id: String): JsonObject? = stock[id]?.let { left ->
        buildJsonObject { put("id", id); put("title", "Book $id"); put("stock", left); put("cost", "4.20") }
    }

    val server = RayfoldServer(
        SchemaText.load(SCHEMA).ir,
        Resolvers(
            queries = mapOf(
                "book" to { args, _ -> book(args.text("id")) },
                "ledger" to { _, _ -> book("b1") },
                "stuck" to { _, _ -> try { awaitCancellation() } finally { abandoned.countDown() } },
                "blocked" to { _, _ -> release.await(5, TimeUnit.SECONDS); book("b1") },
            ),
            commands = mapOf(
                "buy" to { args, _ ->
                    purchases.incrementAndGet()
                    val id = args.text("bookId")
                    val qty = args.getValue("qty").jsonPrimitive.int
                    val left = stock.getValue(id)
                    if (qty > left) throw RayfoldException.domain("OutOfStock", buildJsonObject { put("bookId", id); put("available", left) }, "Only $left left")
                    stock[id] = left - qty
                    book(id)
                },
                "restock" to { args, _ ->
                    val id = args.text("bookId")
                    stock[id] = stock.getValue(id) + args.getValue("qty").jsonPrimitive.int
                    book(id)
                },
            ),
        ),
    )

    val anyone = RayfoldTest.of(server)
    val customer = anyone.signedInAs(buildJsonObject { put("id", "u1"); put("role", "customer") })
    val staff = anyone.signedInAs(buildJsonObject { put("id", "s1"); put("role", "staff") })

    private fun JsonObject.text(name: String): String = getValue(name).jsonPrimitive.content

    companion object {
        const val SCHEMA = """
            entity Book {
              id: ID
              title: String
              stock: Int
              cost: Decimal? @allow(read: viewer.role == "staff")
            }
            error OutOfStock { bookId: ID, available: Int }
            query book(id: ID): Book?
            query ledger: Book? @allow(read: viewer.role == "staff")
            query stuck: Book?
            query blocked: Book?
            command buy(bookId: ID, qty: Int = 1): Book throws OutOfStock @allow(write: viewer != null)
            command restock(bookId: ID, qty: Int): Book @allow(write: viewer.role == "staff")
        """
    }
}

internal fun json(text: String): JsonElement = Json.parseToJsonElement(text)

class RayfoldTestTest {
    private val shop = Shop()

    @Test
    fun `a query returns what the resolver produced, in the shape asked for`() {
        assertEquals(json($$"""{"$type":"Book","title":"Book b1","stock":3}"""), shop.anyone.query("book", args("id" to "b1"), "{ title stock }"))
        // guard: another book is another answer, and a book the shop does not have is null
        assertEquals(json($$"""{"$type":"Book","title":"Book b2","stock":0}"""), shop.anyone.query("book", args("id" to "b2"), "{ title stock }"))
        assertEquals(json("null"), shop.anyone.query("book", args("id" to "b9")))
    }

    @Test
    fun `a command changes the shop and returns its result`() {
        assertEquals(json($$"""{"$type":"Book","id":"b1","stock":2}"""), shop.customer.command("buy", args("bookId" to "b1"), "{ id stock }"))
        assertEquals(2, shop.stock["b1"])
    }

    @Test
    fun `a policy refuses one viewer with its code and message, and nothing runs`() {
        val refused = assertFailsWith<RayfoldException> { shop.customer.command("restock", args("bookId" to "b2", "qty" to 5)) }
        assertEquals(Code.PERMISSION_DENIED, refused.code)
        assertEquals("Not allowed to access restock()", refused.message)
        assertEquals(0, shop.stock["b2"])

        val anonymous = assertFailsWith<RayfoldException> { shop.anyone.command("buy", args("bookId" to "b1")) }
        assertEquals(Code.UNAUTHENTICATED, anonymous.code)
        assertEquals("Sign in to access buy()", anonymous.message)
        assertEquals(0, shop.purchases.get())
    }

    @Test
    fun `the same command is allowed for the viewer the policy names`() {
        assertEquals(json($$"""{"$type":"Book","id":"b2","stock":5}"""), shop.staff.command("restock", args("bookId" to "b2", "qty" to 5), "{ id stock }"))
        assertEquals(5, shop.stock["b2"])
    }

    @Test
    fun `a viewer given as a map is the viewer the policies see`() {
        val staff = shop.anyone.signedInAs(mapOf("id" to "s2", "role" to "staff"))
        assertEquals(json($$"""{"$type":"Book","title":"Book b1","cost":"4.20"}"""), staff.query("book", args("id" to "b1"), "{ title cost }"))
        // guard: the same map with another role is refused, so the map is read rather than taken for staff
        val customer = shop.anyone.signedInAs(mapOf("id" to "u2", "role" to "customer"))
        assertEquals(Code.PERMISSION_DENIED, assertFailsWith<RayfoldException> { customer.query("book", args("id" to "b1"), "{ title cost }") }.code)
    }

    @Test
    fun `a refused field keeps the path the server gave it`() {
        val refused = assertFailsWith<RayfoldException> { shop.customer.query("book", args("id" to "b1"), "{ title cost }") }
        assertEquals(Code.PERMISSION_DENIED, refused.code)
        assertEquals("Not allowed to access Book.cost", refused.message)
        assertEquals("cost", refused.path)
        assertNull(refused.type)
        assertNull(refused.data)
    }

    @Test
    fun `a declared error arrives by name with its payload`() {
        val error = assertFailsWith<RayfoldException> { shop.customer.command("buy", args("bookId" to "b1", "qty" to 5)) }
        assertEquals(Code.DOMAIN, error.code)
        assertEquals("OutOfStock", error.type)
        assertEquals(json("""{"bookId":"b1","available":3}"""), error.data)
        assertEquals("Only 3 left", error.message)
        assertNull(error.path)
        assertEquals(3, shop.stock["b1"])
    }

    @Test
    fun `an operation the schema does not have is refused by the server`() {
        val error = assertFailsWith<RayfoldException> { shop.anyone.query("shelf") }
        assertEquals(Code.INVALID_ARGUMENT, error.code)
        assertEquals("""ops[0].op: unknown operation "shelf"""", error.message)
    }

    @Test
    fun `asking for a command as a query is refused before it runs`() {
        val asQuery = assertFailsWith<IllegalArgumentException> { shop.customer.query("buy", args("bookId" to "b1")) }
        assertEquals("buy is a command in the schema, not a query", asQuery.message)
        val asCommand = assertFailsWith<IllegalArgumentException> { shop.customer.command("book", args("id" to "b1")) }
        assertEquals("book is a query in the schema, not a command", asCommand.message)
        assertEquals(0, shop.purchases.get())
        assertEquals(3, shop.stock["b1"])
    }

    @Test
    fun `a command retried under the same key runs once and is answered as a replay`() {
        val key = "purchase-0001-first"
        val first = shop.customer.command("buy", args("bookId" to "b1"), "{ id stock }", key)
        val retry = shop.customer.command("buy", args("bookId" to "b1"), "{ id stock }", key)
        assertEquals(json($$"""{"$type":"Book","id":"b1","stock":2}"""), first)
        assertEquals(first, retry)
        assertEquals(1, shop.purchases.get())
        assertEquals(2, shop.stock["b1"])

        val replayed = shop.customer.frames("buy", args("bookId" to "b1"), "{ id stock }", key).single()
        assertEquals(json("""{"cost":1,"replay":true}"""), replayed["meta"])
        assertEquals(1, shop.purchases.get())
    }

    @Test
    fun `another key runs the command again, and its answer is no replay`() {
        shop.customer.command("buy", args("bookId" to "b1"), key = "purchase-0001-first")
        val second = shop.customer.frames("buy", args("bookId" to "b1"), "{ id stock }", "purchase-0002-second").single()
        assertEquals(json($$"""{"$type":"Book","id":"b1","stock":1}"""), second["ok"])
        assertEquals(json("""{"cost":1}"""), second["meta"])
        assertEquals(2, shop.purchases.get())
    }

    @Test
    fun `a command without a key gets a fresh one each time, so each call runs`() {
        shop.customer.command("buy", args("bookId" to "b1"))
        shop.customer.command("buy", args("bookId" to "b1"))
        shop.customer.frames("buy", args("bookId" to "b1"))
        assertEquals(3, shop.purchases.get())
        assertEquals(0, shop.stock["b1"])
    }

    @Test
    fun `a key the server would refuse is sent as it is`() {
        // guard for the fresh key: it is only made when the test gives none, so a key too short is the test's to see refused
        val error = assertFailsWith<RayfoldException> { shop.customer.command("buy", args("bookId" to "b1"), key = "short") }
        assertEquals(Code.INVALID_ARGUMENT, error.code)
        assertEquals("buy(): commands require an idempotency key of 16-128 characters", error.message)
        assertEquals(0, shop.purchases.get())
    }

    @Test
    fun `frames carry an error as a frame, where query and command throw it`() {
        val frame = shop.customer.frames("restock", args("bookId" to "b2", "qty" to 5)).single()
        assertEquals(json("""{"id":1,"error":{"code":"permission_denied","message":"Not allowed to access restock()"},"fin":true}"""), frame)
    }

    @Test
    fun `a live query gives its first result, then the result after a command changed it`() {
        shop.anyone.live("book", args("id" to "b1"), "{ id stock }").use { book ->
            assertEquals(json($$"""{"$type":"Book","id":"b1","stock":3}"""), book.next())
            shop.customer.command("buy", args("bookId" to "b1", "qty" to 2))
            assertEquals(json($$"""{"$type":"Book","id":"b1","stock":1}"""), book.next())
            shop.staff.command("restock", args("bookId" to "b1", "qty" to 4))
            assertEquals(json($$"""{"$type":"Book","id":"b1","stock":5}"""), book.next())
        }
    }

    // The three tests of a bound run under one of their own, shorter than the default 5 s: a wait that ignored the
    // bound it was given would still fail with the right message, only later.
    @Test
    @Timeout(4)
    fun `next fails with what it waited for when nothing arrives`() {
        shop.anyone.live("book", args("id" to "b1"), "{ id stock }").use { book ->
            book.next()
            val nothing = assertFailsWith<AssertionError> { book.next(200) }
            assertEquals("live book() sent nothing within 200 ms", nothing.message)
            // guard: a change to another book is not this query's, and one to this book still arrives afterwards
            shop.staff.command("restock", args("bookId" to "b2", "qty" to 1))
            assertEquals("live book() sent nothing within 200 ms", assertFailsWith<AssertionError> { book.next(200) }.message)
            shop.customer.command("buy", args("bookId" to "b1"))
            assertEquals(json($$"""{"$type":"Book","id":"b1","stock":2}"""), book.next())
        }
    }

    @Test
    fun `the caller's bound is the one its live queries wait by`() {
        shop.anyone.within(150).live("book", args("id" to "b1")).use { book ->
            book.next()
            assertEquals("live book() sent nothing within 150 ms", assertFailsWith<AssertionError> { book.next() }.message)
        }
    }

    @Test
    fun `a live query holds one subscription on the server, and close gives it back`() {
        assertEquals(0, shop.server.changes.size)
        val book = shop.anyone.live("book", args("id" to "b1"))
        assertEquals(1, shop.server.changes.size)
        val other = shop.anyone.live("book", args("id" to "b2"))
        assertEquals(2, shop.server.changes.size)
        book.close()
        assertEquals(1, shop.server.changes.size)
        other.close()
        assertEquals(0, shop.server.changes.size)
        assertEquals("live book() is closed", assertFailsWith<IllegalStateException> { book.next() }.message)
    }

    @Test
    fun `a live query the policy refuses fails where it is opened and holds no subscription`() {
        val refused = assertFailsWith<RayfoldException> { shop.customer.live("ledger") }
        assertEquals(Code.PERMISSION_DENIED, refused.code)
        assertEquals("Not allowed to access ledger()", refused.message)
        assertEquals(0, shop.server.changes.size)
        // guard: staff open the same query
        shop.staff.live("ledger", shape = "{ id }").use { ledger ->
            assertEquals(json($$"""{"$type":"Book","id":"b1"}"""), ledger.next())
        }
    }

    @Test
    fun `a live query the server ends is told with the server's error, however often it is asked`() {
        val book = shop.anyone.live("book", args("id" to "b1"))
        book.next()
        runBlocking { withTimeout(5_000) { shop.server.drain() } }
        repeat(2) {
            val ended = assertFailsWith<RayfoldException> { book.next() }
            assertEquals(Code.UNAVAILABLE, ended.code)
            assertEquals("The server is shutting down", ended.message)
        }
        book.close()
        assertEquals(0, shop.server.changes.size)
    }

    @Test
    @Timeout(4)
    fun `a resolver that never answers fails the call within the bound, and its batch is cancelled`() {
        val late = assertFailsWith<AssertionError> { shop.anyone.within(200).query("stuck") }
        assertEquals("stuck() did not answer within 200 ms", late.message)
        assertTrue(shop.abandoned.await(5, TimeUnit.SECONDS), "the batch was left running")
        // guard: the bound is for an answer that does not come; one that does is returned
        assertEquals(JsonPrimitive(3), shop.anyone.within(200).within(5_000).query("book", args("id" to "b1")).jsonObject["stock"])
    }

    @Test
    @Timeout(4)
    fun `a live query whose first result never comes fails where it is opened, and leaves nothing behind`() {
        val late = assertFailsWith<AssertionError> { shop.anyone.within(200).live("stuck") }
        assertEquals("live stuck() gave no first result within 200 ms", late.message)
        assertTrue(shop.abandoned.await(5, TimeUnit.SECONDS), "the batch was left running")
        assertEquals(0, shop.server.changes.size)
        // guard: a query that answers opens under the same bound
        shop.anyone.within(200).within(5_000).live("book", args("id" to "b1"), "{ id }").use { book ->
            assertEquals(json($$"""{"$type":"Book","id":"b1"}"""), book.next())
        }
    }

    @Test
    fun `a caller signed in from a bounded one keeps its bound`() {
        val late = assertFailsWith<AssertionError> { shop.anyone.within(200).signedInAs(mapOf("id" to "u1")).query("stuck") }
        assertEquals("stuck() did not answer within 200 ms", late.message)
        // guard: the viewer changed with it, so the bound is all it kept
        val staff = shop.anyone.within(5_000).signedInAs(mapOf("id" to "s1", "role" to "staff"))
        assertEquals(json($$"""{"$type":"Book","cost":"4.20"}"""), staff.query("book", args("id" to "b1"), "{ cost }"))
    }

    @Test
    fun `a resolver that holds its thread fails the call within the bound, not when it lets go`() {
        try {
            val late = assertFailsWith<AssertionError> { shop.anyone.within(200).query("blocked") }
            assertEquals("blocked() did not answer within 200 ms", late.message)
        } finally {
            shop.release.countDown()
        }
        // guard: once it lets go, it answers
        assertEquals(json($$"""{"$type":"Book","id":"b1"}"""), shop.anyone.query("blocked", shape = "{ id }"))
    }

    @Test
    fun `a query folds what the server deferred into one result, where frames keeps the frames apart`() {
        val server = RayfoldServer(
            SchemaText.load("entity Book { id: ID bio: String @lazy } query book(id: ID): Book").ir,
            Resolvers(
                queries = mapOf("book" to { args, _ -> buildJsonObject { put("id", args.getValue("id")) } }),
                fields = mapOf("Book" to mapOf("bio" to { books, _, _ -> books.map { JsonPrimitive("bio of ${it.getValue("id").jsonPrimitive.content}") } })),
            ),
        )
        val shelf = RayfoldTest.of(server)
        assertEquals(json($$"""{"$type":"Book","id":"b1","bio":"bio of b1"}"""), shelf.query("book", args("id" to "b1"), "{ id bio }"))
        assertEquals(
            listOf(
                json($$"""{"id":1,"data":{"$type":"Book","id":"b1"},"meta":{"cost":1}}"""),
                json("""{"id":1,"at":"","data":{"bio":"bio of b1"}}"""),
                json("""{"id":1,"fin":true}"""),
            ),
            shelf.frames("book", args("id" to "b1"), "{ id bio }"),
        )
    }

    @Test
    fun `a live query reports a deferred part as the result with that part merged in`() {
        val bios = AtomicInteger()
        val server = RayfoldServer(
            SchemaText.load("entity Book { id: ID bio: String @lazy } query book(id: ID): Book command touch(id: ID): Book").ir,
            Resolvers(
                queries = mapOf("book" to { args, _ -> buildJsonObject { put("id", args.getValue("id")) } }),
                commands = mapOf("touch" to { args, _ -> buildJsonObject { put("id", args.getValue("id")) } }),
                fields = mapOf("Book" to mapOf("bio" to { books, _, _ -> books.map { JsonPrimitive("bio ${bios.incrementAndGet()}") } })),
            ),
        )
        val shelf = RayfoldTest.of(server)
        shelf.live("book", args("id" to "b1"), "{ id bio }").use { book ->
            assertEquals(json($$"""{"$type":"Book","id":"b1"}"""), book.next())
            assertEquals(json($$"""{"$type":"Book","id":"b1","bio":"bio 1"}"""), book.next())
            // guard: a change is one value again, the deferred part loaded anew with it
            shelf.signedInAs(mapOf("id" to "u1")).command("touch", args("id" to "b1"), "{ id }")
            assertEquals(json($$"""{"$type":"Book","id":"b1","bio":"bio 2"}"""), book.next())
            assertEquals("live book() sent nothing within 200 ms", assertFailsWith<AssertionError> { book.next(200) }.message)
        }
        assertEquals(0, server.changes.size)
    }

    @Test
    fun `a bound that is no time at all is refused`() {
        assertEquals("timeoutMs must be positive, not 0", assertFailsWith<IllegalArgumentException> { shop.anyone.within(0) }.message)
    }
}
