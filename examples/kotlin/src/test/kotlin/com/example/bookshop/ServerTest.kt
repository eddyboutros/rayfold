package com.example.bookshop

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
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
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNull

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

    /** A request signed in as [token] ("customer" or "staff", with a token as the identity provider issues one), or as nobody. */
    private fun request(ops: JsonObject, token: String?, bearer: String? = token?.let { devToken(if (it == "staff") "s1" else "u1", it) }): HttpRequest {
        val body = buildJsonObject { put("ops", JsonArray(listOf(ops))) }
        val request = HttpRequest.newBuilder(endpoint)
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString(body.toString()))
        bearer?.let { request.header("Authorization", "Bearer $it") }
        return request.build()
    }

    /** Sends a batch of one op, signed in as [token] or as nobody, and returns the op's one frame. */
    private fun send(op: JsonObject, token: String?): JsonObject {
        val response = client.send(request(op, token), HttpResponse.BodyHandlers.ofString())
        assertEquals(200, response.statusCode(), response.body())
        return response.body().lines().filter { it.isNotBlank() }.map(::json).single()
    }

    private fun get(path: String): HttpResponse<String> =
        client.send(HttpRequest.newBuilder(endpoint.resolve(path)).timeout(Duration.ofSeconds(5)).build(), HttpResponse.BodyHandlers.ofString())

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
    private fun command(name: String, args: String, shape: String? = null, token: String? = null, key: String = UUID.randomUUID().toString()) =
        send(op(name, args, shape, key = key), token)

    @Test
    fun `book returns the shape it was asked for, with the author's name`() {
        val frame = query("book", """{"id":"b1"}""", shape = "{ title stock author { name } }")
        assertEquals(
            json($$"""{"$type":"Book","title":"A Wizard of Earthsea","stock":3,"author":{"$type":"Author","name":"Ursula K. Le Guin"}}"""),
            frame["data"],
        )
    }

    @Test
    fun `books come a page at a time, and the cursor picks up where the last page ended`() {
        val first = query("books", """{"page":{"first":2}}""", shape = "{ items { id } cursor hasMore total }")
        assertEquals(
            json($$"""{"items":[{"$type":"Book","id":"b1"},{"$type":"Book","id":"b2"}],"cursor":"b2","hasMore":true,"total":3}"""),
            first["data"],
        )
        val cursor = first.text("data", "cursor")
        val second = query("books", """{"page":{"first":2,"after":"$cursor"}}""", shape = "{ items { id } cursor hasMore total }")
        assertEquals(json($$"""{"items":[{"$type":"Book","id":"b3"}],"cursor":"b3","hasMore":false,"total":3}"""), second["data"])
    }

    @Test
    fun `buy takes copies off the shelf`() {
        val frame = command("buy", """{"bookId":"b3","qty":2}""", shape = "{ id stock }", token = "customer")
        assertEquals(json($$"""{"$type":"Book","id":"b3","stock":5}"""), frame["ok"])
        assertEquals(5, store.book("b3")?.stock)
    }

    @Test
    fun `a purchase retried with the same key gets the first answer again, marked as a replay, and sells once`() {
        val key = UUID.randomUUID().toString()
        val first = command("buy", """{"bookId":"b3","qty":2}""", shape = "{ id stock }", token = "customer", key = key)
        assertEquals(json($$"""{"$type":"Book","id":"b3","stock":5}"""), first["ok"])
        assertNull(first.getValue("meta").jsonObject["replay"])

        val retry = command("buy", """{"bookId":"b3","qty":2}""", shape = "{ id stock }", token = "customer", key = key)
        val replayed = JsonObject(first.getValue("meta").jsonObject + ("replay" to JsonPrimitive(true)))
        assertEquals(JsonObject(first + ("meta" to replayed)), retry)
        assertEquals(5, store.book("b3")?.stock)

        // guard: a new key is a new purchase
        val next = command("buy", """{"bookId":"b3","qty":2}""", shape = "{ id stock }", token = "customer")
        assertEquals(json($$"""{"$type":"Book","id":"b3","stock":3}"""), next["ok"])
        assertEquals(3, store.book("b3")?.stock)
    }

    @Test
    fun `a qty outside 1 to 10 is refused before the resolver sees it, and nothing is sold`() {
        val none = command("buy", """{"bookId":"b3","qty":0}""", token = "customer")
        assertEquals(json("""{"code":"invalid_argument","message":"buy().qty: must be >= 1"}"""), none["error"])
        val tooMany = command("buy", """{"bookId":"b3","qty":11}""", token = "customer")
        assertEquals(json("""{"code":"invalid_argument","message":"buy().qty: must be <= 10"}"""), tooMany["error"])
        assertEquals(7, store.book("b3")?.stock)
    }

    @Test
    fun `a qty at either end of the range sells`() {
        // Dune has 7 copies, so staff bring it up to the 10 one purchase may take
        command("restock", """{"bookId":"b3","qty":3}""", token = "staff")
        val most = command("buy", """{"bookId":"b3","qty":10}""", shape = "{ id stock }", token = "customer")
        assertEquals(json($$"""{"$type":"Book","id":"b3","stock":0}"""), most["ok"])
        val least = command("buy", """{"bookId":"b1","qty":1}""", shape = "{ id stock }", token = "customer")
        assertEquals(json($$"""{"$type":"Book","id":"b1","stock":2}"""), least["ok"])
    }

    @Test
    fun `buying more than the shelf holds fails with OutOfStock and changes nothing`() {
        val frame = command("buy", """{"bookId":"b1","qty":5}""", token = "customer")
        assertEquals(
            json("""{"code":"domain","type":"OutOfStock","message":"Only 3 left of A Wizard of Earthsea","data":{"bookId":"b1","available":3}}"""),
            frame["error"],
        )
        assertEquals(3, store.book("b1")?.stock)
    }

    @Test
    fun `buying without signing in is refused and sells nothing`() {
        val frame = command("buy", """{"bookId":"b1"}""")
        assertEquals(json("""{"code":"unauthenticated","message":"Sign in to access buy()"}"""), frame["error"])
        assertEquals(3, store.book("b1")?.stock)
        // guard: the same purchase from a signed-in customer goes through, one copy by default
        val signedIn = command("buy", """{"bookId":"b1"}""", shape = "{ id stock }", token = "customer")
        assertEquals(json($$"""{"$type":"Book","id":"b1","stock":2}"""), signedIn["ok"])
        assertEquals(2, store.book("b1")?.stock)
    }

    @Test
    fun `a customer may not restock`() {
        val frame = command("restock", """{"bookId":"b2","qty":5}""", token = "customer")
        assertEquals(json("""{"code":"permission_denied","message":"Not allowed to access restock()"}"""), frame["error"])
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
        assertEquals(json("""{"code":"permission_denied","message":"Not allowed to access Book.costPrice","path":"costPrice"}"""), asked["error"])
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
        assertEquals(
            json(
                $$"""
                {"items":[
                  {"$type":"Book","title":"A Wizard of Earthsea","author":{"$type":"Author","name":"Ursula K. Le Guin"}},
                  {"$type":"Book","title":"The Left Hand of Darkness","author":{"$type":"Author","name":"Ursula K. Le Guin"}},
                  {"$type":"Book","title":"Dune","author":{"$type":"Author","name":"Frank Herbert"}}
                ],"total":3}
                """,
            ),
            frame["data"],
        )
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

    @Test
    fun `the explorer is served beside the endpoint, and nothing else is`() {
        val page = get("/rayfold/explorer")
        assertEquals(200, page.statusCode())
        assertEquals("text/html; charset=utf-8", page.headers().firstValue("Content-Type").orElse(null))
        // the page carries the endpoint it talks to and the title startServer gave it
        assertContains(page.body(), """<script type="application/json" id="config">{"endpoint":"/rayfold","title":"Bookshop"}</script>""")
        assertEquals(404, get("/elsewhere").statusCode())
    }

    @Test
    fun `a role is believed only from a token that verifies, and a forged or foreign one is refused before anything runs`() {
        fun signed(key: String, issuer: String = "http://localhost:4000/dev", audience: String = "bookshop", expires: Long = System.currentTimeMillis() + 3_600_000): String {
            val claims = com.nimbusds.jwt.JWTClaimsSet.Builder().subject("s1").issuer(issuer).audience(audience).claim("role", "staff")
                .expirationTime(java.util.Date(expires)).build()
            return com.nimbusds.jwt.SignedJWT(com.nimbusds.jose.JWSHeader(com.nimbusds.jose.JWSAlgorithm.HS256), claims)
                .apply { sign(com.nimbusds.jose.crypto.MACSigner(key.toByteArray())) }.serialize()
        }
        val restock = op("restock", """{"bookId":"b2","qty":4}""", "{ id stock }", key = UUID.randomUUID().toString())
        val devKey = "bookshop development key, not a secret"
        val refused = listOf(
            "staff", // the role's name is not a credential
            signed("a key this server does not hold, at least 32 bytes"),
            signed(devKey, expires = 1_000),
            signed(devKey, issuer = "https://someone-else.example"),
            signed(devKey, audience = "another-app"),
        ).map { bearer -> client.send(request(restock, token = null, bearer = bearer), HttpResponse.BodyHandlers.ofString()).let { it.statusCode() to json(it.body()).text("detail") } }
        assertEquals(List(5) { 401 to "Invalid or expired token" }, refused)
        assertEquals(0, store.book("b2")?.stock)
        // guard: the same claims, signed with the key and for this issuer and audience, are believed
        val ok = client.send(request(restock, token = null, bearer = signed(devKey)), HttpResponse.BodyHandlers.ofString())
        assertEquals(200, ok.statusCode(), ok.body())
        assertEquals(4, store.book("b2")?.stock)
    }
}
