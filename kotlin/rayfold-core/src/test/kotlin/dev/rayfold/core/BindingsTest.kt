package dev.rayfold.core

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Collections
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * REST-style bindings end to end, mirroring packages/server/src/bindings.test.ts case by case, plus the spec 12
 * refusals (415, Origin, Host, nosniff), each with a sibling proving honest use still works. Every test gets a fresh
 * bookstore and its own JDK server; every HTTP call carries a 5 s timeout.
 */
class BindingsTest {
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val started = mutableListOf<HttpServer>()

    @AfterEach
    fun stop() {
        started.forEach { it.stop(0) }
        client.shutdownNow()
    }

    private val KEY = "key-0123456789abcdef"
    private val KEY2 = "key-fedcba9876543210"
    private val U1 = mapOf("Authorization" to "Bearer u1")
    private val U2 = mapOf("Authorization" to "Bearer u2")
    private val ADMIN = mapOf("Authorization" to "Bearer admin")
    private val FALLTHROUGH = "host 404"
    private val ETAG = Regex("^\"sha256-[0-9a-f]{64}\"$")

    private val AUTHOR_A1 = """{"${'$'}type":"Author","id":"a1","name":"Ursula K. Le Guin"}"""
    private val BOOK_B1 = obj("""{"${'$'}type":"Book","id":"b1","title":"The Dispossessed","format":"PAPERBACK","price":"12.99","stock":5,"author":$AUTHOR_A1}""")
    private val REVIEW_R1 = obj("""{"${'$'}type":"Review","id":"r1","rating":5,"body":"Ambiguous utopia, unambiguous masterpiece.","reviewerId":"u2","version":1}""")
    private val ORDER_O1 = obj("""{"${'$'}type":"Order","id":"o1","status":"PLACED","total":"16.00","items":[{"qty":2,"unitPrice":"8.00","book":{"${'$'}type":"Book","id":"b3","title":"Kindred"}}]}""")

    /** Mounted the way e2e/harness.ts mounts it: the handler answers bound routes, the host answers everything else. */
    private fun serve(server: RayfoldServer, options: BindingOptions = BindingOptions()): String {
        val bindings = RayfoldBindings(server, options) { viewerOf(it.requestHeaders.getFirst("Authorization")) }
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        http.createContext("/") { ex ->
            if (!bindings.handle(ex)) {
                val b = FALLTHROUGH.toByteArray()
                ex.responseHeaders.set("Content-Type", "text/plain")
                ex.sendResponseHeaders(404, b.size.toLong())
                ex.responseBody.use { it.write(b) }
            }
        }
        http.start()
        started.add(http)
        return "http://127.0.0.1:${http.address.port}"
    }

    private fun port(base: String) = base.substringAfterLast(':').toInt()

    /** As the TS helper: Content-Type application/json unless [headers] says otherwise. */
    private fun send(url: String, method: String, body: String? = null, headers: Map<String, String> = emptyMap()): HttpResponse<String> {
        val all = linkedMapOf("content-type" to "application/json")
        for ((k, v) in headers) all[k.lowercase()] = v
        val b = HttpRequest.newBuilder(URI(url)).timeout(Duration.ofSeconds(5))
            .method(method, if (body == null) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(body))
        for ((k, v) in all) b.header(k, v)
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString())
    }

    /** As `fetch(url)`: a GET with no Content-Type. */
    private fun get(url: String, headers: Map<String, String> = emptyMap()): HttpResponse<String> {
        val b = HttpRequest.newBuilder(URI(url)).timeout(Duration.ofSeconds(5)).GET()
        for ((k, v) in headers) b.header(k, v)
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString())
    }

    private fun HttpResponse<String>.h(name: String): String? = headers().firstValue(name).orElse(null)
    private fun HttpResponse<String>.json(): JsonElement = Json.parseToJsonElement(body())
    private fun enc(s: String) = URLEncoder.encode(s, Charsets.UTF_8).replace("+", "%20")

    private fun problemOf(code: String, status: Int, detail: String) = buildJsonObject {
        put("type", "https://eddyboutros.github.io/rayfold/errors/$code"); put("title", code.replace('_', ' ')); put("status", status); put("detail", detail); put("code", code)
    }

    private fun calls(bs: Bookstore) = bs.store.calls.toMap()

    /** The TS itemsServer: a small schema whose resolvers record exactly the arguments they received. */
    private class Items(val server: RayfoldServer, val seen: MutableList<Pair<String, JsonObject>>)

    private fun itemsServer(): Items {
        val seen = Collections.synchronizedList(mutableListOf<Pair<String, JsonObject>>())
        val resolvers = Resolvers(
            queries = mapOf(
                "items" to { args, _ -> seen.add("items" to args); Json.parseToJsonElement("""[{"id":"i1","n":1}]""") },
                "item" to { args, _ -> seen.add("item" to args); buildJsonObject { put("id", "i${args.s("n")}"); put("n", args["n"] ?: JsonNull) } },
                "file" to { args, _ -> seen.add("file" to args); buildJsonObject { put("id", args.s("name")); put("n", 0) } },
                "note" to { args, _ -> obj("""{"id":"${args.s("id")}","title":"T","body":"B","parent":{"id":"p","title":"PT","body":"PB","parent":null}}""") },
            ),
            commands = mapOf(
                "free" to { args, _ -> seen.add("free" to args); buildJsonObject { put("id", "f${seen.size}"); put("n", args["n"] ?: JsonNull) } },
                "keyed" to { args, _ -> seen.add("keyed" to args); buildJsonObject { put("id", "k"); put("n", args["n"] ?: JsonNull) } },
                "drop" to { _, _ -> JsonNull },
            ),
        )
        return Items(RayfoldServer(Oracle.ir("items.ir.json"), resolvers), seen)
    }

    // ------------------------------------------------------------------ GET bindings

    @Test
    fun `GET books id - default view, Cache-Control from @cache, an ETag, and 304 on a matching If-None-Match`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val res = get("$base/books/b1")
        assertEquals(200, res.statusCode())
        assertEquals("application/json; charset=utf-8", res.h("content-type"))
        assertEquals("public, max-age=60", res.h("cache-control"))
        assertEquals("Rayfold-Client, Accept, Authorization", res.h("vary"))
        assertNull(res.h("location"))
        val etag = res.h("etag") ?: error("no ETag")
        assertTrue(ETAG.matches(etag), etag)
        assertEquals(BOOK_B1, res.json())

        val again = get("$base/books/b1", mapOf("If-None-Match" to etag))
        assertEquals(304, again.statusCode())
        assertEquals("", again.body())
        assertEquals(2, bs.store.calls["Query.book"], "the ETag is derived from the result, so a revalidation still runs the resolver")
    }

    @Test
    fun `GET answers 304 to the weak ETag a compressing proxy hands out, to a list naming it, and to a star`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val etag = get("$base/books/b1").h("etag") ?: error("no ETag")
        for (header in listOf("W/$etag", "\"sha256-${"0".repeat(64)}\", $etag", "*")) {
            val res = get("$base/books/b1", mapOf("If-None-Match" to header))
            assertEquals(304, res.statusCode(), header)
            assertEquals("", res.body())
        }
        // guard: a weak list that names only other tags gets the full answer
        val other = get("$base/books/b1", mapOf("If-None-Match" to "W/\"sha256-${"0".repeat(64)}\", W/\"x\""))
        assertEquals(200, other.statusCode())
        assertEquals(BOOK_B1, other.json())
    }

    @Test
    fun `a Long path parameter past 2^53 reaches the resolver digit for digit`() {
        val seen = mutableListOf<JsonElement?>()
        val ir = SchemaText.load("""entity L { id: ID n: Long } query byN(n: Long): L? @http(method: GET, path: "/longs/{n}")""").ir
        val server = RayfoldServer(ir, Resolvers(queries = mapOf("byN" to { args, _ -> seen.add(args["n"]); buildJsonObject { put("id", "l"); put("n", args["n"] ?: JsonNull) } })))
        val base = serve(server)
        val res = get("$base/longs/9007199254740993")
        assertEquals(200, res.statusCode(), res.body())
        assertEquals("9007199254740993", ((res.json() as JsonObject)["n"] as JsonPrimitive).content)
        assertEquals(listOf("9007199254740993"), seen.map { (it as JsonPrimitive).content })
        // guard: past the Long range it is refused before the resolver runs
        assertEquals(400, get("$base/longs/9223372036854775808").statusCode())
        assertEquals(1, seen.size)
    }

    @Test
    fun `GET with a foreign or outdated If-None-Match gets a full 200 with the current ETag`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val etag = get("$base/books/b1").h("etag") ?: error("no ETag")
        val foreign = get("$base/books/b1", mapOf("If-None-Match" to "\"sha256-${"0".repeat(64)}\""))
        assertEquals(200, foreign.statusCode())
        assertEquals(etag, foreign.h("etag"))
        assertEquals(BOOK_B1, foreign.json())

        bs.store.books["b1"] = JsonObject(bs.store.books.getValue("b1") + ("stock" to JsonPrimitive(4)))
        val changed = get("$base/books/b1", mapOf("If-None-Match" to etag))
        assertEquals(200, changed.statusCode())
        assertTrue(ETAG.matches(changed.h("etag") ?: ""))
        assertNotEquals(etag, changed.h("etag"))
        assertEquals(JsonObject(BOOK_B1 + ("stock" to JsonPrimitive(4))), changed.json())
    }

    @Test
    fun `GET shape= projects the requested shape instead of the default view, with its own ETag`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val res = get("$base/books/b1?shape=${enc("{ id author { name } }")}")
        assertEquals(200, res.statusCode())
        assertEquals("public, max-age=60", res.h("cache-control"))
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1","author":{"${'$'}type":"Author","name":"Ursula K. Le Guin"}}"""), res.json())
        val byDefault = get("$base/books/b1")
        assertTrue(ETAG.matches(res.h("etag") ?: ""))
        assertNotEquals(byDefault.h("etag"), res.h("etag"))
    }

    @Test
    fun `GET reviews and orders answer 200 without Location - Cache-Control and visibility follow @cache and the viewer`() {
        val bs = Bookstore()
        bs.store.orders["o1"] = ORDER_O1_ROW
        val base = serve(bs.server)

        val review = get("$base/reviews/r1")
        assertEquals(200, review.statusCode())
        assertNull(review.h("location"))
        assertEquals("public, max-age=0, no-cache", review.h("cache-control"))
        assertEquals(REVIEW_R1, review.json())

        val owner = get("$base/orders/o1", U1)
        assertEquals(200, owner.statusCode())
        assertNull(owner.h("location"))
        assertEquals("private, max-age=0, no-cache", owner.h("cache-control"))
        assertEquals(ORDER_O1, owner.json())

        val stranger = get("$base/orders/o1", U2)
        assertEquals(200, stranger.statusCode())
        assertEquals(JsonNull, stranger.json(), "default views never fail on a type policy: another customer sees null")

        val anonymous = get("$base/orders/o1")
        assertEquals(401, anonymous.statusCode())
        assertEquals("application/problem+json", anonymous.h("content-type"))
        assertEquals(problemOf("unauthenticated", 401, "Sign in to access order()"), anonymous.json())

        val missing = get("$base/books/zzz")
        assertEquals(200, missing.statusCode())
        assertEquals(JsonNull, missing.json())
        assertEquals(mapOf("Query.review" to 1, "Query.order" to 2, "Query.book" to 1, "OrderItem.book" to 1), calls(bs))
    }

    @Test
    fun `GET query-string values are coerced by declared type - Int, Boolean, enum text and a JSON-encoded input`() {
        val items = itemsServer()
        val base = serve(items.server)
        val res = get("$base/items?limit=-3&flag=false&format=B&where=${enc("""{"min":2}""")}")
        assertEquals(200, res.statusCode(), res.body())
        assertEquals(Json.parseToJsonElement("""[{"${'$'}type":"Item","id":"i1","n":1}]"""), res.json())
        assertEquals(200, get("$base/items?limit=7&flag=true").statusCode())
        assertEquals(listOf(
            "items" to obj("""{"limit":-3,"flag":false,"format":"B","where":{"min":2}}"""),
            "items" to obj("""{"limit":7,"flag":true}"""),
        ), items.seen.toList())
    }

    @Test
    fun `a query-string value that does not fit its declared type is a 400 before the resolver runs`() {
        val items = itemsServer()
        val base = serve(items.server)
        for ((qs, detail) in listOf(
            "limit=ten&flag=true" to "items().limit: expected Int",
            "limit=1.5&flag=true" to "items().limit: expected Int",
            "limit=1&flag=yes" to "items().flag: expected Boolean",
            "limit=1&flag=true&format=C" to "items().format: expected one of A, B",
            "limit=1&flag=true&bogus=1" to "items().bogus: unknown argument",
        )) {
            val res = get("$base/items?$qs")
            assertEquals(400, res.statusCode(), qs)
            assertEquals("application/problem+json", res.h("content-type"))
            assertEquals(problemOf("invalid_argument", 400, detail), res.json())
        }
        assertEquals(emptyList(), items.seen.toList())
        assertEquals(200, get("$base/items?limit=1&flag=true").statusCode(), "guard: a valid query string is served")
        assertEquals(listOf("items" to obj("""{"limit":1,"flag":true}""")), items.seen.toList())
    }

    @Test
    fun `an Int path parameter is coerced to a number, is percent-decoded, and wins over a same-named query parameter`() {
        val items = itemsServer()
        val base = serve(items.server)
        val res = get("$base/items/42?n=9")
        assertEquals(200, res.statusCode())
        assertEquals(obj("""{"${'$'}type":"Item","id":"i42","n":42}"""), res.json())

        val bad = get("$base/items/abc")
        assertEquals(400, bad.statusCode())
        assertEquals(problemOf("invalid_argument", 400, "item().n: expected Int"), bad.json())

        val decoded = get("$base/files/a%20b.json")
        assertEquals(200, decoded.statusCode())
        assertEquals(obj("""{"${'$'}type":"Item","id":"a b","n":0}"""), decoded.json())
        assertEquals(listOf("item" to obj("""{"n":42}"""), "file" to obj("""{"name":"a b"}""")), items.seen.toList())
    }

    @Test
    fun `GET folds deferred @lazy at frames into the JSON body, at the root and at a nested path`() = runTest(timeout = 5.seconds) {
        val items = itemsServer()
        val base = serve(items.server)
        val shape = "{ id body parent { id body } }"
        val res = get("$base/notes/n1?shape=${enc(shape)}")
        assertEquals(200, res.statusCode(), res.body())
        assertEquals(obj("""{"${'$'}type":"Note","id":"n1","body":"B","parent":{"${'$'}type":"Note","id":"p","body":"PB"}}"""), res.json())

        // the same op over Rayfold really does split the lazy fields into `at` frames, so the body above was folded
        val frames = items.server.collect(obj("""{"ops":[{"id":1,"op":"note","args":{"id":"n1"},"shape":"$shape"}]}"""))
        assertEquals(listOf(obj("""{"id":1,"at":"","data":{"body":"B"}}"""), obj("""{"id":1,"at":"parent","data":{"body":"PB"}}""")), frames.filter { "at" in it })

        val eager = get("$base/notes/n1?shape=${enc("{ id title }")}")
        assertEquals(obj("""{"${'$'}type":"Note","id":"n1","title":"T"}"""), eager.json())
    }

    // ------------------------------------------------------------------ QUERY bindings

    @Test
    fun `QUERY books spreads a JSON object body into the arguments, matching a direct Rayfold call, and revalidates with 304`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val base = serve(bs.server)
        val args = """{"filter":{"format":"PAPERBACK"},"page":{"first":1}}"""
        val res = send("$base/books", "QUERY", args)
        assertEquals(200, res.statusCode(), res.body())
        assertEquals("public, max-age=60", res.h("cache-control"))
        val etag = res.h("etag") ?: error("no ETag")
        assertTrue(ETAG.matches(etag))
        val body = res.json() as JsonObject
        assertEquals(listOf("b1"), (body["items"] as JsonArray).map { (it as JsonObject).s("id") })
        assertEquals(obj("""{"cursor":"b1","hasMore":true,"total":2}"""), JsonObject(body.filterKeys { it != "items" }))
        assertEquals(1, bs.store.calls["Query.books"])

        val frame = bs.server.collect(obj("""{"ops":[{"id":1,"op":"books","args":$args}]}""")).single()
        assertEquals(JsonPrimitive(true), frame["fin"])
        assertEquals(frame["data"], body)

        assertEquals(304, send("$base/books", "QUERY", args, mapOf("If-None-Match" to etag)).statusCode())
    }

    @Test
    fun `QUERY with an empty body runs with the declared defaults`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val base = serve(bs.server)
        val res = client.send(HttpRequest.newBuilder(URI("$base/books")).timeout(Duration.ofSeconds(5)).method("QUERY", HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString())
        assertEquals(200, res.statusCode(), res.body())
        val body = res.json() as JsonObject
        assertEquals(obj("""{"cursor":"b4","hasMore":false,"total":4}"""), JsonObject(body.filterKeys { it != "items" }))
        assertEquals(listOf("b1", "b2", "b3", "b4"), (body["items"] as JsonArray).map { (it as JsonObject).s("id") })
        assertEquals(bs.server.collect(obj("""{"ops":[{"id":1,"op":"books"}]}""")).single()["data"], body)
    }

    @Test
    fun `QUERY rejects a JSON body that is not an object, and malformed JSON, with 400 before the resolver runs`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        for (raw in listOf("[1,2]", "\"text\"", "null", "42")) {
            val res = send("$base/books", "QUERY", raw)
            assertEquals(400, res.statusCode(), raw)
            assertEquals("application/problem+json", res.h("content-type"))
            assertEquals(problemOf("invalid_argument", 400, "Body must be a JSON object"), res.json())
        }
        val malformed = send("$base/books", "QUERY", "{nope")
        assertEquals(400, malformed.statusCode())
        assertEquals(problemOf("invalid_argument", 400, "Body is not valid JSON"), malformed.json())
        assertNull(bs.store.calls["Query.books"])

        assertEquals(200, send("$base/books", "QUERY", "{}").statusCode(), "guard: an empty object runs")
        assertEquals(1, bs.store.calls["Query.books"])
    }

    // ------------------------------------------------------------------ POST bindings

    private val ORDER_BODY = """{"lines":[{"bookId":"b3","qty":2}]}"""

    @Test
    fun `POST orders without a valid Idempotency-Key is a 400 and places no order`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val missing = send("$base/orders", "POST", ORDER_BODY, U1)
        assertEquals(400, missing.statusCode())
        assertEquals(problemOf("invalid_argument", 400, "POST /orders requires an Idempotency-Key header (16-128 characters)"), missing.json())
        val short = send("$base/orders", "POST", ORDER_BODY, U1 + ("Idempotency-Key" to "short"))
        assertEquals(400, short.statusCode())
        assertEquals(problemOf("invalid_argument", 400, "placeOrder(): commands require an idempotency key of 16-128 characters"), short.json())
        assertEquals(0, bs.store.orders.size)
        assertEquals(100, bs.store.stock("b3"))
        assertNull(bs.store.calls["Command.placeOrder"])

        val keyed = send("$base/orders", "POST", ORDER_BODY, U1 + ("Idempotency-Key" to KEY))
        assertEquals(201, keyed.statusCode(), "guard: a valid key places the order")
        assertEquals(1, bs.store.orders.size)
    }

    @Test
    fun `POST orders with a key answers 201 and Location, the same key replays it, a new key places another order`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val first = send("$base/orders", "POST", ORDER_BODY, U1 + ("Idempotency-Key" to KEY))
        assertEquals(201, first.statusCode(), first.body())
        assertEquals("/orders/o1", first.h("location"))
        assertEquals("no-store", first.h("cache-control"))
        assertNull(first.h("etag"))
        assertNull(first.h("idempotent-replayed"))
        assertEquals(ORDER_O1, first.json())
        assertEquals(ORDER_O1_ROW, bs.store.orders["o1"])
        assertEquals(98, bs.store.stock("b3"))

        val replay = send("$base/orders", "POST", ORDER_BODY, U1 + ("Idempotency-Key" to KEY))
        assertEquals(201, replay.statusCode())
        assertEquals("/orders/o1", replay.h("location"))
        assertEquals("true", replay.h("idempotent-replayed"))
        assertEquals(first.json(), replay.json())
        assertEquals(1, bs.store.orders.size)
        assertEquals(98, bs.store.stock("b3"))
        assertEquals(1, bs.store.calls["Command.placeOrder"])

        val second = send("$base/orders", "POST", ORDER_BODY, U1 + ("Idempotency-Key" to KEY2))
        assertEquals(201, second.statusCode())
        assertEquals("/orders/o2", second.h("location"))
        assertNull(second.h("idempotent-replayed"))
        assertEquals(2, bs.store.orders.size)
        assertEquals(2, bs.store.calls["Command.placeOrder"])
    }

    @Test
    fun `POST on an @idempotent(false) command runs without a key, while a sibling command without the opt-out is refused`() {
        val items = itemsServer()
        val base = serve(items.server)
        val free = send("$base/free", "POST", """{"n":3}""")
        assertEquals(200, free.statusCode(), free.body())
        assertNull(free.h("location"))
        assertEquals("no-store", free.h("cache-control"))
        assertEquals(obj("""{"${'$'}type":"Item","id":"f1","n":3}"""), free.json())
        assertEquals(obj("""{"${'$'}type":"Item","id":"f2","n":3}"""), send("$base/free", "POST", """{"n":3}""").json())

        val keyed = send("$base/keyed", "POST", """{"n":3}""")
        assertEquals(400, keyed.statusCode())
        assertEquals(problemOf("invalid_argument", 400, "POST /keyed requires an Idempotency-Key header (16-128 characters)"), keyed.json())
        assertEquals(listOf("free" to obj("""{"n":3}"""), "free" to obj("""{"n":3}""")), items.seen.toList())
    }

    @Test
    fun `POST orders id pay answers 200 without Location, and a declared domain error is a 422 problem carrying its type and data`() {
        val bs = Bookstore()
        bs.store.orders["o1"] = ORDER_O1_ROW
        val base = serve(bs.server)
        val paid = send("$base/orders/o1/pay", "POST", null, U1 + ("Idempotency-Key" to KEY))
        assertEquals(200, paid.statusCode(), paid.body())
        assertNull(paid.h("location"))
        assertEquals("no-store", paid.h("cache-control"))
        assertEquals(JsonObject(ORDER_O1 + ("status" to JsonPrimitive("PAID"))), paid.json())
        assertEquals("PAID", bs.store.orders.getValue("o1").s("status"))

        val twice = send("$base/orders/o1/pay", "POST", null, U1 + ("Idempotency-Key" to KEY2))
        assertEquals(422, Guard.status(Code.DOMAIN))
        assertEquals(422, twice.statusCode())
        assertEquals("application/problem+json", twice.h("content-type"))
        assertEquals(obj("""{"type":"https://eddyboutros.github.io/rayfold/errors/NotPayable","title":"NotPayable","status":422,"detail":"Order is PAID","code":"domain","data":{"status":"PAID"}}"""), twice.json())
        assertEquals(2, bs.store.calls["Command.payOrder"])
    }

    // ------------------------------------------------------------------ PUT bindings

    private val EDIT = """{"rating":4,"body":"Better on a reread."}"""
    private val EDITED = JsonObject(REVIEW_R1 + mapOf("rating" to JsonPrimitive(4), "body" to JsonPrimitive("Better on a reread."), "version" to JsonPrimitive(2)))

    @Test
    fun `PUT reviews id with an If-Match that matches the version answers 200 with the new version as ETag`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val res = send("$base/reviews/r1", "PUT", EDIT, U2 + ("If-Match" to "\"1\""))
        assertEquals(200, res.statusCode(), res.body())
        assertEquals("\"2\"", res.h("etag"))
        assertEquals("no-store", res.h("cache-control"))
        assertNull(res.h("location"))
        assertEquals(EDITED, res.json())
        assertEquals(obj("""{"id":"r1","rating":4,"body":"Better on a reread.","bookId":"b1","reviewerId":"u2","version":2}"""), bs.store.reviews["r1"])
    }

    @Test
    fun `PUT with a stale If-Match is a 412 VersionConflict whose data current is the review as stored, and changes nothing`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        assertEquals(200, send("$base/reviews/r1", "PUT", EDIT, U2 + ("If-Match" to "\"1\"")).statusCode(), "guard: the matching version is accepted")
        val stale = send("$base/reviews/r1", "PUT", """{"rating":1,"body":"Changed my mind."}""", U2 + ("If-Match" to "\"1\""))
        assertEquals(412, stale.statusCode())
        assertEquals("application/problem+json", stale.h("content-type"))
        assertEquals(buildJsonObject {
            put("type", "https://eddyboutros.github.io/rayfold/errors/VersionConflict"); put("title", "VersionConflict"); put("status", 412)
            put("detail", "Review:r1 is at version 2, not 1"); put("code", "failed_precondition")
            put("data", buildJsonObject { put("key", "Review:r1"); put("expected", 1); put("actual", 2); put("current", EDITED) })
        }, stale.json())
        assertEquals(2, bs.store.reviews.getValue("r1").i("version"))
        assertEquals("Better on a reread.", bs.store.reviews.getValue("r1").s("body"))
    }

    @Test
    fun `PUT accepts a weak ETag as If-Match, and compares a non-numeric If-Match as a string (412)`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val weak = send("$base/reviews/r1", "PUT", EDIT, U2 + ("If-Match" to "W/\"1\""))
        assertEquals(200, weak.statusCode(), weak.body())
        assertEquals("\"2\"", weak.h("etag"))

        val text = send("$base/reviews/r1", "PUT", EDIT, U2 + ("If-Match" to "\"abc\""))
        assertEquals(412, text.statusCode())
        val body = text.json() as JsonObject
        assertEquals(JsonPrimitive("VersionConflict"), body["title"])
        assertEquals(JsonPrimitive("Review:r1 is at version 2, not abc"), body["detail"])
        val data = body["data"] as JsonObject
        assertEquals(obj("""{"key":"Review:r1","expected":"abc","actual":2}"""), JsonObject(data.filterKeys { it != "current" }))
        assertEquals(2, bs.store.reviews.getValue("r1").i("version"))
    }

    @Test
    fun `PUT runs without an Idempotency-Key (every call runs), and with a key a retry replays the first response`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val url = "$base/reviews/r1"
        val a = send(url, "PUT", EDIT, U2)
        val b = send(url, "PUT", EDIT, U2)
        assertEquals(listOf(200, 200), listOf(a.statusCode(), b.statusCode()))
        assertEquals(listOf("\"2\"", "\"3\""), listOf(a.h("etag"), b.h("etag")))
        assertNull(b.h("idempotent-replayed"))
        assertEquals(2, bs.store.calls["Command.editReview"])

        val c = send(url, "PUT", EDIT, U2 + ("Idempotency-Key" to KEY))
        val d = send(url, "PUT", EDIT, U2 + ("Idempotency-Key" to KEY))
        assertEquals(listOf(200, 200), listOf(c.statusCode(), d.statusCode()))
        assertNull(c.h("idempotent-replayed"))
        assertEquals("true", d.h("idempotent-replayed"))
        assertEquals("\"4\"", d.h("etag"))
        assertEquals(c.json(), d.json())
        assertEquals(3, bs.store.calls["Command.editReview"])
        assertEquals(4, bs.store.reviews.getValue("r1").i("version"))
    }

    // ------------------------------------------------------------------ PATCH bindings

    private val MERGE = ADMIN + ("Content-Type" to "application/merge-patch+json")

    @Test
    fun `PATCH books id applies a merge patch - absent fields stay, an explicit null the resolver refuses is a 400 with its message`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val res = send("$base/books/b1", "PATCH", """{"price":"10.00"}""", MERGE)
        assertEquals(200, res.statusCode(), res.body())
        assertEquals("no-store", res.h("cache-control"))
        assertNull(res.h("etag"))
        assertEquals(JsonObject(BOOK_B1 + ("price" to JsonPrimitive("10.00"))), res.json())
        assertEquals(obj("""{"id":"b1","title":"The Dispossessed","format":"PAPERBACK","price":"10.00","stock":5,"authorId":"a1","costPrice":"6.10","ownerId":"u1"}"""), bs.store.books["b1"])

        val cleared = send("$base/books/b1", "PATCH", """{"title":null}""", MERGE)
        assertEquals(400, cleared.statusCode())
        assertEquals(problemOf("invalid_argument", 400, "updateBook().patch.title: cannot be cleared"), cleared.json())
        assertEquals("The Dispossessed", bs.store.books.getValue("b1").s("title"))
        assertEquals(2, bs.store.calls["Command.updateBook"])
    }

    @Test
    fun `a numeric-looking String is range-checked by length, not value - PATCH title 1984 is accepted, 201 characters are not`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val res = send("$base/books/b1", "PATCH", """{"title":"1984"}""", MERGE)
        assertEquals(200, res.statusCode(), res.body())
        assertEquals(JsonPrimitive("1984"), (res.json() as JsonObject)["title"])
        val long = send("$base/books/b1", "PATCH", """{"title":"${"x".repeat(201)}"}""", MERGE)
        assertEquals(400, long.statusCode())
        assertEquals(problemOf("invalid_argument", 400, "updateBook().patch.title: must be <= 200"), long.json())
        assertEquals("1984", bs.store.books.getValue("b1").s("title"))
    }

    @Test
    fun `a malformed percent-escape in a path parameter is a 400, not a 500, and a well-formed one still decodes (guard)`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        // a syntactically valid escape that is not UTF-8 reaches the binding, which refuses it
        val bad = send("$base/books/%FF", "GET")
        assertEquals(400, bad.statusCode())
        assertEquals(problemOf("invalid_argument", 400, "Path parameter id is not valid percent-encoding"), bad.json())
        // the TS test's truncated escape: the JDK server refuses to parse the request line, also with 400, before any handler
        val truncated = rawHttp(port(base), "GET /books/%E0%A4%A HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        assertEquals(400, truncated.status, truncated.head)
        assertEquals(emptyMap(), calls(bs))
        val good = send("$base/books/b%31", "GET")
        assertEquals(200, good.statusCode())
        assertEquals(JsonPrimitive("b1"), (good.json() as JsonObject)["id"])
    }

    @Test
    fun `PATCH policy (write - viewer role admin) - anonymous 401, customer 403, admin 200`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val patch = """{"stock":7}"""
        val anonymous = send("$base/books/b1", "PATCH", patch)
        assertEquals(401, anonymous.statusCode())
        assertEquals(problemOf("unauthenticated", 401, "Sign in to access updateBook()"), anonymous.json())
        val customer = send("$base/books/b1", "PATCH", patch, U1)
        assertEquals(403, customer.statusCode())
        assertEquals(problemOf("permission_denied", 403, "Not allowed to access updateBook()"), customer.json())
        assertEquals(5, bs.store.stock("b1"))
        assertNull(bs.store.calls["Command.updateBook"])

        val admin = send("$base/books/b1", "PATCH", patch, ADMIN)
        assertEquals(200, admin.statusCode())
        assertEquals(JsonObject(BOOK_B1 + ("stock" to JsonPrimitive(7))), admin.json())
        assertEquals(7, bs.store.stock("b1"))
        assertEquals(1, bs.store.calls["Command.updateBook"])
    }

    // ------------------------------------------------------------------ DELETE bindings

    @Test
    fun `DELETE reviews id - a non-author is refused, the author gets the deleted review, and a second DELETE is 404`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val denied = send("$base/reviews/r1", "DELETE", null, U1)
        assertEquals(403, denied.statusCode())
        assertEquals(problemOf("permission_denied", 403, "Only the author of a review can delete it"), denied.json())
        assertTrue(bs.store.reviews.containsKey("r1"))

        val res = send("$base/reviews/r1", "DELETE", null, U2)
        assertEquals(200, res.statusCode())
        assertEquals("\"1\"", res.h("etag"))
        assertEquals("no-store", res.h("cache-control"))
        assertEquals(REVIEW_R1, res.json())
        assertTrue(!bs.store.reviews.containsKey("r1"))
        assertEquals(3, bs.store.reviews.size)

        val again = send("$base/reviews/r1", "DELETE", null, U2)
        assertEquals(404, again.statusCode())
        assertEquals(problemOf("not_found", 404, "Review r1 not found"), again.json())
    }

    @Test
    fun `DELETE retried with the same Idempotency-Key replays its first success instead of 404`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val headers = U2 + ("Idempotency-Key" to KEY)
        val first = send("$base/reviews/r1", "DELETE", null, headers)
        val retry = send("$base/reviews/r1", "DELETE", null, headers)
        assertEquals(listOf(200, 200), listOf(first.statusCode(), retry.statusCode()))
        assertEquals("true", retry.h("idempotent-replayed"))
        assertEquals(REVIEW_R1, retry.json())
        assertEquals(1, bs.store.calls["Command.deleteReview"])
        assertTrue(!bs.store.reviews.containsKey("r1"))
    }

    // ------------------------------------------------------------------ routing

    @Test
    fun `a bound path with an unbound method is a 405 whose Allow lists the bound methods in declaration order`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val post = send("$base/books/b1", "POST", "{}")
        assertEquals(405, post.statusCode())
        assertEquals("GET, PATCH", post.h("allow"))
        assertEquals("application/problem+json", post.h("content-type"))
        assertEquals(problemOf("unimplemented", 405, "POST is not bound on /books/b1"), post.json())

        fun allowOf(method: String, path: String): String? {
            val res = send("$base$path", method)
            assertEquals(405, res.statusCode(), "$method $path")
            return res.h("allow")
        }
        assertEquals("GET, PUT, DELETE", allowOf("POST", "/reviews/r1"))
        assertEquals("QUERY", allowOf("GET", "/books"))
        assertEquals("POST", allowOf("GET", "/orders"))
        assertEquals("POST", allowOf("GET", "/orders/o1/pay"))
        assertEquals(emptyMap(), calls(bs))
    }

    @Test
    fun `an unbound path makes the handler return false, so the host's own 404 answers`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        for (path in listOf("/authors/a1", "/books/b1/reviews", "/", "/rayfold")) {
            val res = get("$base$path")
            assertEquals(404, res.statusCode(), path)
            assertEquals(FALLTHROUGH, res.body())
        }
        assertEquals(emptyMap(), calls(bs))
        assertEquals(200, get("$base/books/b1").statusCode(), "guard: a bound path is served")
    }

    @Test
    fun `prefix - api books b1 is served, bare and look-alike paths fall through, and Location carries the prefix`() {
        val bs = Bookstore()
        val base = serve(bs.server, BindingOptions(prefix = "/api"))
        val res = get("$base/api/books/b1")
        assertEquals(200, res.statusCode())
        assertEquals(BOOK_B1, res.json())
        for (path in listOf("/books/b1", "/apix/books/b1")) {
            val miss = get("$base$path")
            assertEquals(404, miss.statusCode(), path)
            assertEquals(FALLTHROUGH, miss.body())
        }
        val placed = send("$base/api/orders", "POST", """{"lines":[{"bookId":"b3","qty":1}]}""", U1 + ("Idempotency-Key" to KEY))
        assertEquals(201, placed.statusCode())
        assertEquals("/api/orders/o1", placed.h("location"))
    }

    @Test
    fun `maxBody - a body one byte over the limit is a 413 payload_too_large problem that never reaches the resolver, and a body at the limit is served`() {
        val body = """{"filter":{"titleContains":"earthsea"}}"""
        val size = body.toByteArray().size
        val tooLarge = obj("""{"type":"https://eddyboutros.github.io/rayfold/errors/payload_too_large","title":"payload too large","status":413,"detail":"Body exceeds ${size - 1} bytes","code":"resource_exhausted"}""")

        val over = Bookstore()
        val overBase = serve(over.server, BindingOptions(maxBodyBytes = size - 1))
        val refused = send("$overBase/books", "QUERY", body)
        assertEquals(413, refused.statusCode(), "Content Too Large, not 429: retrying the same body cannot help")
        assertEquals("application/problem+json", refused.h("content-type"))
        assertEquals(tooLarge, refused.json())
        assertNull(over.store.calls["Query.books"])

        // far over the limit the body arrives in many chunks; the refusal must still arrive and the server keep serving
        val flood = send("$overBase/books", "QUERY", """{"filter":{"titleContains":"${"x".repeat(256 * 1024)}"}}""")
        assertEquals(413, flood.statusCode())
        assertEquals(tooLarge, flood.json())
        assertNull(over.store.calls["Query.books"])
        assertEquals(200, get("$overBase/books/b1").statusCode())

        val at = Bookstore()
        val atBase = serve(at.server, BindingOptions(maxBodyBytes = size))
        val res = send("$atBase/books", "QUERY", body)
        assertEquals(200, res.statusCode())
        assertEquals(listOf("b4"), ((res.json() as JsonObject)["items"] as JsonArray).map { (it as JsonObject).s("id") })
        assertEquals(1, at.store.calls["Query.books"])
    }

    // ------------------------------------------------------------------ bindingsOf

    @Test
    fun `Bindings of reads method, path, params, body and location from every @http op of the bookstore, and nothing else`() {
        val bindings = Bindings.of(Oracle.ir("bookstore.ir.json"))
        assertEquals(listOf(
            listOf("books", "QUERY", "/books", listOf<String>(), "*", null),
            listOf("book", "GET", "/books/{id}", listOf("id"), null, null),
            listOf("review", "GET", "/reviews/{id}", listOf("id"), null, null),
            listOf("order", "GET", "/orders/{id}", listOf("id"), null, null),
            listOf("placeOrder", "POST", "/orders", listOf<String>(), "input", "/orders/{id}"),
            listOf("payOrder", "POST", "/orders/{id}/pay", listOf("id"), null, null),
            listOf("editReview", "PUT", "/reviews/{id}", listOf("id"), "input", null),
            listOf("updateBook", "PATCH", "/books/{id}", listOf("id"), "patch", null),
            listOf("deleteReview", "DELETE", "/reviews/{id}", listOf("id"), null, null),
        ), bindings.map { listOf(it.op.name, it.method, it.path, it.params, it.body, it.location) })
        val pay = bindings.single { it.op.name == "payOrder" }
        assertEquals(listOf("o1"), pay.regex.matchEntire("/orders/o1/pay")?.groupValues?.drop(1))
        assertNull(pay.regex.matchEntire("/orders/o1"))
        assertNull(pay.regex.matchEntire("/orders/a/b/pay"))
        val book = bindings.single { it.op.name == "book" }
        assertNull(book.regex.matchEntire("/books/"))
        assertNull(book.regex.matchEntire("/books/b1/x"))
    }

    @Test
    fun `Bindings of upper-cases a method given as a string and escapes literal regex characters in the path`() {
        val bindings = Bindings.of(Oracle.ir("items.ir.json"))
        val drop = bindings.single { it.op.name == "drop" }
        assertEquals(listOf("DELETE", "/items/{id}", listOf("id")), listOf(drop.method, drop.path, drop.params))
        val file = bindings.single { it.op.name == "file" }
        assertEquals(listOf("a"), file.regex.matchEntire("/files/a.json")?.groupValues?.drop(1))
        assertNull(file.regex.matchEntire("/files/aXjson"))
    }

    // ------------------------------------------------------------------ spec 12 refusals, each with its guard

    @Test
    fun `a body that is not JSON is 415 before it is parsed, and merge-patch is accepted on PATCH only`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        fun unsupported(ct: String, send: String) = problemOf("unsupported_media_type", 415, "Content-Type $ct is not accepted; send $send").let {
            JsonObject(it + ("code" to JsonPrimitive("invalid_argument")))
        }
        val text = send("$base/reviews/r1", "PUT", EDIT, U2 + ("Content-Type" to "text/plain"))
        assertEquals(415, text.statusCode())
        assertEquals(unsupported("text/plain", "application/json"), text.json())
        val form = send("$base/orders", "POST", ORDER_BODY, U1 + ("Idempotency-Key" to KEY) + ("Content-Type" to "application/x-www-form-urlencoded"))
        assertEquals(unsupported("application/x-www-form-urlencoded", "application/json"), form.json())
        val mergeOnPut = send("$base/reviews/r1", "PUT", EDIT, U2 + ("Content-Type" to "application/merge-patch+json"))
        assertEquals(unsupported("application/merge-patch+json", "application/json"), mergeOnPut.json())
        val textPatch = send("$base/books/b1", "PATCH", """{"stock":7}""", ADMIN + ("Content-Type" to "text/plain"))
        assertEquals(unsupported("text/plain", "application/merge-patch+json"), textPatch.json())
        assertEquals(emptyMap(), calls(bs), "nothing ran")

        assertEquals(200, send("$base/reviews/r1", "PUT", EDIT, U2 + ("Content-Type" to "application/json; charset=utf-8")).statusCode(), "guard: JSON with parameters runs")
        assertEquals(200, send("$base/books/b1", "PATCH", """{"stock":7}""", ADMIN + ("Content-Type" to "application/json")).statusCode(), "guard: PATCH takes plain JSON too")
        assertEquals(mapOf("Command.editReview" to 1, "Command.updateBook" to 1), calls(bs).filterKeys { it.startsWith("Command.") })
    }

    @Test
    fun `a cross-origin POST, PUT, PATCH or DELETE is 403 and nothing runs`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val evil = mapOf("Origin" to "https://evil.example")
        for ((method, path, body, who) in listOf(
            listOf("POST", "/orders", ORDER_BODY, U1 + ("Idempotency-Key" to KEY)),
            listOf("PUT", "/reviews/r1", EDIT, U2),
            listOf("PATCH", "/books/b1", """{"stock":7}""", ADMIN),
            listOf("DELETE", "/reviews/r1", null, U2),
        )) {
            @Suppress("UNCHECKED_CAST")
            val res = send("$base$path", method as String, body as String?, (who as Map<String, String>) + evil)
            assertEquals(403, res.statusCode(), "$method $path")
            assertEquals(problemOf("permission_denied", 403, "Origin https://evil.example is not allowed"), res.json())
        }
        assertEquals(emptyMap(), calls(bs))
        assertEquals(5, bs.store.stock("b1"))
        assertTrue(bs.store.reviews.containsKey("r1"))
    }

    @Test
    fun `guard - same-origin, allow-listed and Origin-less writes run`() {
        val bs = Bookstore()
        val base = serve(bs.server, BindingOptions(allowedOrigins = setOf("https://app.example")))
        for (origin in listOf(null, "http://127.0.0.1:${port(base)}", "https://app.example")) {
            val res = send("$base/reviews/r1", "PUT", EDIT, U2 + (if (origin != null) mapOf("Origin" to origin) else emptyMap()))
            assertEquals(200, res.statusCode(), "$origin: ${res.body()}")
        }
        assertEquals(3, bs.store.calls["Command.editReview"])
    }

    @Test
    fun `GET and QUERY bindings answer another origin, since they only run queries`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val other = mapOf("Origin" to "https://other.example")
        assertEquals(BOOK_B1, get("$base/books/b1", other).json())
        val query = send("$base/books", "QUERY", """{"page":{"first":1}}""", other)
        assertEquals(200, query.statusCode(), query.body())
        assertEquals(mapOf("Query.book" to 1, "Query.books" to 1), calls(bs).filterKeys { it.startsWith("Query.") })
        // guard: the same origin on a write is still refused
        assertEquals(403, send("$base/books/b1", "PATCH", """{"stock":7}""", ADMIN + other).statusCode())
        assertNull(bs.store.calls["Command.updateBook"])
    }

    @Test
    fun `a loopback server refuses a foreign Host (DNS rebinding) with 403 on reads and writes, and nothing runs`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val read = rawHttp(port(base), "GET /books/b1 HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n")
        assertEquals(403, read.status)
        assertEquals("nosniff", read.header("X-Content-Type-Options"))
        assertEquals(problemOf("permission_denied", 403, "Host evil.example is not allowed on a loopback server"), Json.parseToJsonElement(read.body))
        val write = rawHttp(port(base), "POST /orders HTTP/1.1\r\nHost: evil.example:${port(base)}\r\nAuthorization: Bearer u1\r\nIdempotency-Key: $KEY\r\n" +
            "Content-Type: application/json\r\nContent-Length: ${ORDER_BODY.length}\r\nConnection: close\r\n\r\n$ORDER_BODY")
        assertEquals(403, write.status)
        val bare = rawHttp(port(base), "GET /books/b1 HTTP/1.1\r\nConnection: close\r\n\r\n")
        assertEquals(403, bare.status, bare.head)
        assertEquals(problemOf("permission_denied", 403, "Missing Host header"), Json.parseToJsonElement(bare.body))
        assertEquals(emptyMap(), calls(bs))
        assertEquals(0, bs.store.orders.size)
    }

    @Test
    fun `guard - loopback host names are answered, and an explicit allowedHosts list replaces the loopback rule`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        for (host in listOf("localhost:${port(base)}", "127.0.0.1", "[::1]:${port(base)}", "LOCALHOST")) {
            assertEquals(200, rawHttp(port(base), "GET /books/b1 HTTP/1.1\r\nHost: $host\r\nConnection: close\r\n\r\n").status, host)
        }
        val listed = serve(Bookstore().server, BindingOptions(allowedHosts = setOf("api.example")))
        assertEquals(200, rawHttp(port(listed), "GET /books/b1 HTTP/1.1\r\nHost: api.example\r\nConnection: close\r\n\r\n").status)
        val unlisted = rawHttp(port(listed), "GET /books/b1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        assertEquals(403, unlisted.status)
        assertEquals(problemOf("permission_denied", 403, "Host 127.0.0.1 is not allowed"), Json.parseToJsonElement(unlisted.body))
    }

    @Test
    fun `every binding response says nosniff, except a 304 which has no body`() {
        val bs = Bookstore()
        val base = serve(bs.server)
        val ok = get("$base/books/b1")
        val created = send("$base/orders", "POST", ORDER_BODY, U1 + ("Idempotency-Key" to KEY))
        val notAllowed = send("$base/books/b1", "POST", "{}")
        val problem = get("$base/orders/o1")
        val unsupported = send("$base/reviews/r1", "PUT", EDIT, U2 + ("Content-Type" to "text/plain"))
        for (res in listOf(ok, created, notAllowed, problem, unsupported)) assertEquals("nosniff", res.h("x-content-type-options"), "${res.statusCode()}")
        assertEquals(listOf(200, 201, 405, 401, 415), listOf(ok, created, notAllowed, problem, unsupported).map { it.statusCode() })
        for (res in listOf(notAllowed, problem, unsupported)) assertEquals("no-store", res.h("cache-control"), "problems are never cached")
        val notModified = get("$base/books/b1", mapOf("If-None-Match" to (ok.h("etag") ?: "")))
        assertEquals(304, notModified.statusCode())
        assertNull(notModified.h("x-content-type-options"))
    }

    @Test
    fun `mount serves bindings beside RayfoldHttp on one server - rayfold stays Rayfold, bound routes are served, anything else is a 404 problem`() {
        val bs = Bookstore()
        val http = RayfoldHttp(bs.server) { viewerOf(it.requestHeaders.getFirst("Authorization")) }.start(0)
        started.add(http)
        RayfoldBindings(bs.server) { viewerOf(it.requestHeaders.getFirst("Authorization")) }.mount(http)
        val base = "http://127.0.0.1:${http.address.port}"
        assertEquals(BOOK_B1, get("$base/books/b1").json())
        val placed = send("$base/orders", "POST", ORDER_BODY, U1 + ("Idempotency-Key" to KEY))
        assertEquals(201, placed.statusCode(), placed.body())
        val unbound = get("$base/authors/a1")
        assertEquals(404, unbound.statusCode())
        assertEquals(problemOf("not_found", 404, "No route for GET /authors/a1"), unbound.json())
        assertEquals("nosniff", unbound.h("x-content-type-options"))
        val rayfold = send("$base/rayfold", "POST", """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}""", mapOf("Content-Type" to "application/rayfold+json"))
        assertEquals("application/rayfold-frames+json", rayfold.h("content-type"))
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1"}"""), obj(rayfold.body().trim())["data"])
    }
}
