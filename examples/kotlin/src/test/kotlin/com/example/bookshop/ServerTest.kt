package com.example.bookshop

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** The server over real HTTP on a free port. Every test gets its own store and server, stopped afterwards. */
class ServerTest {
    private val store = Store()
    private val http = startServer(port = 0, store)
    private val endpoint = URI("http://127.0.0.1:${http.address.port}/rayfold")
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

    @AfterTest
    fun stop() {
        http.stop(0)
        // unlike close, shutdownNow does not wait for a live response to end
        client.shutdownNow()
    }

    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private fun JsonObject.text(vararg path: String): String =
        path.dropLast(1).fold(this) { o, key -> o.getValue(key).jsonObject }.getValue(path.last()).jsonPrimitive.content

    private fun request(ops: JsonObject, token: String?): HttpRequest {
        val body = buildJsonObject { put("ops", JsonArray(listOf(ops))) }
        val request = HttpRequest.newBuilder(endpoint)
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
        token?.let { request.header("Authorization", "Bearer $it") }
        return request.build()
    }

    /** Sends a batch of one op, as the viewer [token] names or as nobody, and returns the op's one frame. */
    private fun send(op: JsonObject, token: String?): JsonObject {
        val response = client.send(request(op, token), HttpResponse.BodyHandlers.ofString())
        assertEquals(200, response.statusCode(), response.body())
        return response.body().lines().filter { it.isNotBlank() }.map(::json).single()
    }

    private fun op(name: String, args: String, shape: String?, key: String? = null, live: Boolean = false) = buildJsonObject {
        put("id", 1)
        put("op", name)
        put("args", json(args))
        shape?.let { put("shape", it) }
        key?.let { put("key", it) }
        if (live) put("live", true)
    }

    private fun query(name: String, args: String, shape: String? = null, token: String? = null) =
        send(op(name, args, shape), token)

    // every client sends an idempotency key with a command
    private fun command(name: String, args: String, shape: String? = null, token: String? = null) =
        send(op(name, args, shape, key = UUID.randomUUID().toString()), token)

    @Test
    fun `book returns the shape it was asked for, with the author's name`() {
        val frame = query("book", """{"id":"b1"}""", shape = "{ title stock author { name } }")
        assertEquals(
            json($$"""{"$type":"Book","title":"A Wizard of Earthsea","stock":3,"author":{"$type":"Author","name":"Ursula K. Le Guin"}}"""),
            frame["data"],
        )
    }

    @Test
    fun `buy takes copies off the shelf`() {
        val frame = command("buy", """{"bookId":"b3","qty":2}""", shape = "{ id stock }", token = "customer")
        assertEquals(json($$"""{"$type":"Book","id":"b3","stock":5}"""), frame["ok"])
        assertEquals(5, store.book("b3")?.stock)
    }

    @Test
    fun `buying more than the shelf holds fails with OutOfStock and changes nothing`() {
        val frame = command("buy", """{"bookId":"b1","qty":5}""", token = "customer")
        assertEquals("domain", frame.text("error", "code"))
        assertEquals("OutOfStock", frame.text("error", "type"))
        assertEquals(json("""{"bookId":"b1","available":3}"""), frame.getValue("error").jsonObject["data"])
        assertEquals(3, store.book("b1")?.stock)
    }

    @Test
    fun `a customer may not restock`() {
        val frame = command("restock", """{"bookId":"b2","qty":5}""", token = "customer")
        assertEquals("permission_denied", frame.text("error", "code"))
        assertEquals(0, store.book("b2")?.stock)
    }

    @Test
    fun `staff may restock`() {
        val frame = command("restock", """{"bookId":"b2","qty":5}""", shape = "{ id stock }", token = "staff")
        assertEquals(json($$"""{"$type":"Book","id":"b2","stock":5}"""), frame["ok"])
        assertEquals(5, store.book("b2")?.stock)
    }

    @Test
    fun `costPrice is left out for a customer, and refused when a customer names it`() {
        val book = query("book", """{"id":"b1"}""", token = "customer")
        assertEquals(json($$"""{"$type":"Book","id":"b1","title":"A Wizard of Earthsea","stock":3}"""), book["data"])
        val asked = query("book", """{"id":"b1"}""", shape = "{ title costPrice }", token = "customer")
        assertEquals("permission_denied", asked.text("error", "code"))
    }

    @Test
    fun `staff see costPrice`() {
        val book = query("book", """{"id":"b1"}""", token = "staff")
        assertEquals(json($$"""{"$type":"Book","id":"b1","title":"A Wizard of Earthsea","stock":3,"costPrice":"4.20"}"""), book["data"])
        val asked = query("book", """{"id":"b1"}""", shape = "{ title costPrice }", token = "staff")
        assertEquals(json($$"""{"$type":"Book","title":"A Wizard of Earthsea","costPrice":"4.20"}"""), asked["data"])
    }

    @Test
    fun `a page of books loads its authors in one lookup`() {
        val frame = query("books", "{}", shape = "{ items { title author { name } } total }")
        val items = frame.getValue("data").jsonObject.getValue("items").jsonArray.map { it.jsonObject }
        assertEquals(listOf("Ursula K. Le Guin", "Ursula K. Le Guin", "Frank Herbert"), items.map { it.text("author", "name") })
        assertEquals(1, store.authorLookups.get())
        // guard: the count follows the lookups, so one more request is one more
        query("book", """{"id":"b3"}""", shape = "{ author { name } }")
        assertEquals(2, store.authorLookups.get())
    }

    @Test
    fun `a live query stays open and gets the new stock when someone buys`() {
        val live = op("book", """{"id":"b3"}""", shape = "{ id stock }", live = true)
        val response = client.send(request(live, token = null), HttpResponse.BodyHandlers.ofInputStream())
        assertEquals(200, response.statusCode())
        response.body().bufferedReader().use { frames ->
            // each read is bounded, so a frame that never comes fails the test instead of hanging it
            fun next(): JsonObject = generateSequence { CompletableFuture.supplyAsync { frames.readLine() }.get(5, TimeUnit.SECONDS) }
                .first { it.isNotBlank() }
                .let(::json)
            assertEquals(json($$"""{"$type":"Book","id":"b3","stock":7}"""), next()["data"])
            command("buy", """{"bookId":"b3","qty":2}""", token = "customer")
            assertEquals(json("""{"id":1,"patch":[{"set":"Book:b3","value":{"stock":5}}]}"""), next())
        }
    }
}
