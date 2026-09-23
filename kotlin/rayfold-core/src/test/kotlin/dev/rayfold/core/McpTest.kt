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
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * The MCP bridge, mirroring packages/server/src/mcp.test.ts: tool and resource listings against the TypeScript
 * oracle, tool calls through the real pipeline (Mcp.handle), and the Streamable HTTP endpoint over real sockets with
 * the spec 12 refusals and their guards. Each test gets a fresh bookstore and server.
 */
class McpTest {
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val started = mutableListOf<HttpServer>()

    @AfterEach
    fun stop() {
        started.forEach { it.stop(0) }
        client.shutdownNow()
    }

    private val u1 = obj("""{"id":"u1","role":"customer"}""")
    private val DIALECT = "https://json-schema.org/draft/2020-12/schema"

    private fun order(bookId: String, qty: Int) = obj("""{"input":{"lines":[{"bookId":"$bookId","qty":$qty}]}}""")
    private suspend fun call(server: RayfoldServer, name: String, args: JsonObject, viewer: JsonElement = JsonNull, id: Int = 1): JsonObject =
        Mcp.handle(server, buildJsonObject {
            put("jsonrpc", "2.0"); put("id", id); put("method", "tools/call")
            put("params", buildJsonObject { put("name", name); put("arguments", args) })
        }, viewer) ?: error("tools/call is not a notification")

    private fun JsonElement.at(vararg path: String): JsonElement? = path.fold<String, JsonElement?>(this) { v, k -> (v as? JsonObject)?.get(k) ?: (v as? JsonArray)?.getOrNull(k.toIntOrNull() ?: -1) }
    private fun tools(server: RayfoldServer) = Mcp.tools(server.ir).map { it as JsonObject }

    // ------------------------------------------------------------------ tools and resources

    @Test
    fun `tools are the TypeScript tools - commands and queries with JSON Schema 2020-12 in and out schemas, @range bounds included`() {
        val bs = Bookstore()
        val all = Mcp.tools(bs.server.ir)
        assertEquals(Oracle.json("bookstore.mcp-tools.json"), all, "structure")
        assertEquals(Oracle.json("bookstore.mcp-tools.json").toString(), all.toString(), "key order")
        val names = tools(bs.server).map { (it["name"] as JsonPrimitive).content }
        assertTrue(names.containsAll(listOf("placeOrder", "placeOrder.simulate", "books")))
        assertTrue("stockUpdates" !in names, "streams are not tools")
        assertTrue("restock.simulate" in names, "restock declares @simulate")
        val place = tools(bs.server).single { it["name"] == JsonPrimitive("placeOrder") }
        assertEquals(obj("""{"type":"object","properties":{"bookId":{"type":"string"},"qty":{"type":"integer","x-rayfold-range":{"min":1,"max":100},"minimum":1,"maximum":100}},"additionalProperties":false,"required":["bookId"]}"""),
            place.at("inputSchema", "\$defs", "OrderLine"), "qty has a default, so it is optional")
        assertEquals(JsonPrimitive(DIALECT), place.at("outputSchema", "\$schema"))
        assertTrue((place["description"] as JsonPrimitive).content.contains("OutOfStock"))
        assertEquals(obj("""{"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true}"""), place["annotations"])
        assertEquals(obj("""{"readOnlyHint":true,"idempotentHint":true}"""), tools(bs.server).single { it["name"] == JsonPrimitive("books") }["annotations"])
    }

    @Test
    fun `a simulate tool is offered only for commands that declare @simulate`() {
        val ir = Oracle.ir("bookstore.ir.json")
        val stripped = ir.copy(ops = ir.ops.mapValues { (_, op) -> if (op.name == "restock") op.copy(annotations = op.annotations.filter { it.name != "simulate" }) else op })
        val names = Mcp.tools(stripped).map { ((it as JsonObject)["name"] as JsonPrimitive).content }
        assertTrue("restock" in names && "restock.simulate" !in names)
        assertTrue("placeOrder.simulate" in names, "guard: a command that declares @simulate keeps its dry run")
    }

    @Test
    fun `top-level @range arguments become JSON Schema bounds, and the pipeline enforces the same bounds`() = runTest(timeout = 5.seconds) {
        val s = RayfoldServer(Oracle.ir("mcp-range.ir.json"), Resolvers(commands = mapOf("set" to { _, _ -> obj("""{"id":"a"}""") })))
        assertEquals(Oracle.json("mcp-range.tools.json"), Mcp.tools(s.ir))
        assertEquals(obj("""{"type":"string","pattern":"^-?\\d+(\\.\\d+)?${'$'}","x-rayfold-range":{"min":0}}"""), tools(s).single().at("inputSchema", "properties", "price"),
            "Decimal travels as text: only the x- keyword can carry the bound")
        suspend fun errorOf(args: String) = call(s, "set", obj(args)).at("result", "structuredContent")
        assertEquals(obj("""{"error":{"code":"invalid_argument","message":"set().qty: must be <= 5"}}"""), errorOf("""{"qty":6,"name":"ab","price":"1","free":0}"""))
        assertEquals(obj("""{"error":{"code":"invalid_argument","message":"set().name: must be <= 3"}}"""), errorOf("""{"qty":5,"name":"abcd","price":"1","free":0}"""))
        assertEquals(obj("""{"error":{"code":"invalid_argument","message":"set().price: must be >= 0"}}"""), errorOf("""{"qty":5,"name":"abc","price":"-1","free":0}"""))
        // guard: the boundary values themselves are accepted
        assertEquals(obj("""{"result":{"${'$'}type":"A","id":"a"},"effects":[{"set":"A:a","value":{"${'$'}type":"A","id":"a"}}]}"""), errorOf("""{"qty":5,"name":"ab","price":"0","free":-9}"""))
    }

    @Test
    fun `lists resources for argument-free queries and the schema, as TypeScript does`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        assertEquals(Oracle.json("bookstore.mcp-resources.json"), Mcp.resources(bs.server.ir))
        assertEquals(listOf("rayfold://schema", "rayfold://query/books", "rayfold://query/myOrders"), Mcp.resources(bs.server.ir).map { ((it as JsonObject)["uri"] as JsonPrimitive).content })
        val list = Mcp.handle(bs.server, obj("""{"jsonrpc":"2.0","id":1,"method":"resources/list"}"""), JsonNull)
        assertEquals(Mcp.resources(bs.server.ir), list?.at("result", "resources"))
    }

    @Test
    fun `tools list returns the same tools with a cache hint`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val list = Mcp.handle(bs.server, obj("""{"jsonrpc":"2.0","id":1,"method":"tools/list"}"""), JsonNull)
        assertEquals(buildJsonObject { put("tools", Mcp.tools(bs.server.ir)); put("ttlMs", 300000); put("cacheScope", "public") }, list?.get("result"))
    }

    @Test
    fun `rayfold schema serves the IR without policy expressions by default - FULL serves them, OFF lists no schema`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val read = obj("""{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"rayfold://schema"}}""")
        val redacted = (Mcp.handle(bs.server, read, JsonNull)?.at("result", "contents", "0", "text") as JsonPrimitive).content
        assertTrue("\$expr" !in redacted, "no policy expression leaves the server")
        assertEquals(bs.server.ir.withoutPolicies(), RayfoldSchemaIR.parse(redacted))
        val full = (Mcp.handle(bs.server, read, JsonNull, McpOptions(schema = ManifestMode.FULL))?.at("result", "contents", "0", "text") as JsonPrimitive).content
        assertEquals(bs.server.ir, RayfoldSchemaIR.parse(full), "guard: the full IR is an explicit choice")
        val off = Mcp.handle(bs.server, read, JsonNull, McpOptions(schema = ManifestMode.OFF))
        assertEquals(obj("""{"code":-32602,"message":"Unknown resource rayfold://schema"}"""), off?.get("error"))
        assertTrue(Mcp.resources(bs.server.ir, ManifestMode.OFF).none { (it as JsonObject)["uri"] == JsonPrimitive("rayfold://schema") })
    }

    // ------------------------------------------------------------------ tool calls run through the normal pipeline

    @Test
    fun `policies - an anonymous caller gets a tool error and nothing is written, a signed-in caller places the order (guard)`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val anon = call(bs.server, "placeOrder", order("b1", 1))
        assertEquals(JsonPrimitive(true), anon.at("result", "isError"))
        assertEquals(JsonPrimitive("unauthenticated"), anon.at("result", "structuredContent", "error", "code"))
        assertEquals(0, bs.store.orders.size)
        val placed = call(bs.server, "placeOrder", order("b1", 1), u1)
        assertEquals(JsonPrimitive("complete"), placed.at("result", "resultType"))
        assertEquals(JsonPrimitive("o1"), placed.at("result", "structuredContent", "result", "id"))
        assertEquals(JsonPrimitive("PLACED"), placed.at("result", "structuredContent", "result", "status"))
        assertEquals(1, bs.store.orders.size)
    }

    @Test
    fun `simulate returns the would-be result and effects without writing`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val sim = call(bs.server, "placeOrder.simulate", order("b1", 1), u1)
        assertEquals(JsonPrimitive("complete"), sim.at("result", "resultType"))
        assertEquals(JsonPrimitive("PLACED"), sim.at("result", "structuredContent", "result", "status"))
        assertEquals(JsonPrimitive("12.99"), sim.at("result", "structuredContent", "result", "total"))
        assertTrue(obj("""{"set":"Book:b1","value":{"stock":4}}""") in (sim.at("result", "structuredContent", "effects") as JsonArray))
        assertEquals(0, bs.store.orders.size)
        assertEquals(5, bs.store.stock("b1"))
    }

    @Test
    fun `typed domain errors keep their type and data`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val r = call(bs.server, "placeOrder", order("b4", 1), u1)
        assertEquals(JsonPrimitive(true), r.at("result", "isError"))
        assertTrue((r.at("result", "content", "0", "text") as JsonPrimitive).content.startsWith("domain OutOfStock: "))
        assertEquals(obj("""{"code":"domain","type":"OutOfStock","message":"Only 0 of A Wizard of Earthsea left","data":{"bookId":"b4","available":0}}"""), r.at("result", "structuredContent", "error"))
    }

    @Test
    fun `two commands called with the same arguments are two calls, keyed as the TypeScript bridge keys them, and a repeat replays`() = runTest(timeout = 5.seconds) {
        val runs = mutableListOf<String>()
        val claimed = mutableListOf<String>()
        val memory = MemoryIdempotencyStore()
        val store = object : IdempotencyStore by memory {
            override fun claim(scope: String, key: String, leaseMs: Long): IdempotencyClaim = memory.claim(scope, key, leaseMs).also { claimed.add(key) }
        }
        val schema = SchemaText.load("entity Order { id: ID state: String } command cancelOrder(id: ID): Order command refundOrder(id: ID): Order").ir
        fun order(state: String): RootResolver = { args, _ -> runs.add("$state ${args.s("id")}"); obj("""{"id":"${args.s("id")}","state":"$state"}""") }
        val server = RayfoldServer(schema, Resolvers(commands = mapOf("cancelOrder" to order("cancelled"), "refundOrder" to order("refunded"))), idempotency = store)
        fun state(r: JsonObject) = r.at("result", "structuredContent", "result", "state")
        val r1 = obj("""{"id":"r1"}""")
        assertEquals(JsonPrimitive("cancelled"), state(call(server, "cancelOrder", r1, u1)))
        assertEquals(JsonPrimitive("refunded"), state(call(server, "refundOrder", r1, u1)), "a key of the arguments alone refused this as a reuse")
        assertEquals(JsonPrimitive("cancelled"), state(call(server, "cancelOrder", r1, u1)), "guard: the same call replays")
        assertEquals(listOf("cancelled r1", "refunded r1"), runs)
        // mcp- and the SHA-256 of {"args":{"id":"r1"},"op":"cancelOrder"}: byte for byte the key mcp.test.ts pins
        assertEquals(
            listOf(
                "mcp-0e33ac87ef0b7d8778fdb3e71157a86b69fc870673ffb6e45216915a20fd86a0",
                "mcp-a2e471d5d53e28ddd7f6e5176f511dc3612878c5062a0f9cbf225886886b022a",
                "mcp-0e33ac87ef0b7d8778fdb3e71157a86b69fc870673ffb6e45216915a20fd86a0",
            ),
            claimed,
        )
    }

    @Test
    fun `repeating a call with the same arguments replays the first result, and different arguments place a new order (guard)`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val first = call(bs.server, "placeOrder", order("b3", 2), u1)
        val again = call(bs.server, "placeOrder", order("b3", 2), u1, id = 2)
        assertEquals(JsonPrimitive("o1"), first.at("result", "structuredContent", "result", "id"))
        assertTrue(obj("""{"set":"Book:b3","value":{"stock":98}}""") in (first.at("result", "structuredContent", "effects") as JsonArray))
        assertEquals(first["result"], again["result"])
        assertEquals(1, bs.store.orders.size)
        assertEquals(1, bs.store.calls["Command.placeOrder"])
        assertEquals(98, bs.store.stock("b3"))
        assertEquals(JsonPrimitive("o2"), call(bs.server, "placeOrder", order("b3", 1), u1, id = 3).at("result", "structuredContent", "result", "id"))
        assertEquals(2, bs.store.orders.size)
    }

    @Test
    fun `resources read runs the query and returns its JSON`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val res = Mcp.handle(bs.server, obj("""{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{"uri":"rayfold://query/books"}}"""), JsonNull)
        val page = Json.parseToJsonElement((res?.at("result", "contents", "0", "text") as JsonPrimitive).content) as JsonObject
        assertEquals(listOf("b1", "b2", "b3", "b4"), (page["items"] as JsonArray).map { (it as JsonObject).s("id") })
        assertEquals(JsonPrimitive(false), page["hasMore"])
        assertEquals(JsonPrimitive(4), page["total"])
        assertEquals(1, bs.store.calls["Query.books"])
    }

    @Test
    fun `a resource URI naming a command is unknown and runs nothing, while one naming a query with arguments runs it (guard)`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        val cmd = Mcp.handle(bs.server, obj("""{"jsonrpc":"2.0","id":1,"method":"resources/read","params":{"uri":"rayfold://query/payOrder?id=o1"}}"""), u1)
        assertEquals(obj("""{"code":-32602,"message":"Unknown resource rayfold://query/payOrder?id=o1"}"""), cmd?.get("error"))
        assertNull(bs.store.calls["Command.payOrder"])
        val book = Mcp.handle(bs.server, obj("""{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"rayfold://query/book?id=b2"}}"""), JsonNull)
        assertEquals(JsonPrimitive("b2"), (Json.parseToJsonElement((book?.at("result", "contents", "0", "text") as JsonPrimitive).content) as JsonObject)["id"])
    }

    @Test
    fun `unknown methods and tools are reported, not thrown`() = runTest(timeout = 5.seconds) {
        val bs = Bookstore()
        assertEquals(obj("""{"jsonrpc":"2.0","id":8,"error":{"code":-32601,"message":"Method not found: nope"}}"""), Mcp.handle(bs.server, obj("""{"jsonrpc":"2.0","id":8,"method":"nope"}"""), JsonNull))
        val unknown = call(bs.server, "stockUpdates", JsonObject(emptyMap()))
        assertEquals(JsonPrimitive(true), unknown.at("result", "isError"))
        assertEquals(JsonPrimitive("Unknown tool stockUpdates"), unknown.at("result", "content", "0", "text"))
    }

    @Test
    fun `a tool result folds deferred @lazy parts into the structured result`() = runTest(timeout = 5.seconds) {
        val s = RayfoldServer(Oracle.ir("items.ir.json"), Resolvers(queries = mapOf("note" to { args, _ -> obj("""{"id":"${args.s("id")}","title":"T","body":"B","parent":null}""") })))
        val frames = s.collect(obj("""{"ops":[{"id":1,"op":"note","args":{"id":"n1"}}]}"""))
        assertTrue(frames.any { "at" in it }, "the default view defers the @lazy body")
        assertEquals(obj("""{"${'$'}type":"Note","id":"n1","title":"T","body":"B"}"""), call(s, "note", obj("""{"id":"n1"}""")).at("result", "structuredContent", "result"))
    }

    // ------------------------------------------------------------------ Streamable HTTP

    private fun serveMcp(bs: Bookstore, options: McpOptions = McpOptions()): Int {
        val mcp = RayfoldMcp(bs.server, options) { if (it.requestHeaders.getFirst("Authorization") != null) u1 else JsonNull }
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        http.createContext("/") { ex -> if (!mcp.handle(ex)) { ex.sendResponseHeaders(404, -1); ex.close() } }
        http.start()
        started.add(http)
        return http.address.port
    }

    private fun rpc(port: Int, body: String, headers: Map<String, String> = emptyMap(), method: String = "POST"): HttpResponse<String> {
        val all = linkedMapOf("content-type" to "application/json")
        for ((k, v) in headers) all[k.lowercase()] = v
        val b = HttpRequest.newBuilder(URI("http://127.0.0.1:$port/mcp")).timeout(Duration.ofSeconds(5))
            .method(method, if (method == "GET") HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(body))
        for ((k, v) in all) b.header(k, v)
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString())
    }

    private fun HttpResponse<String>.h(name: String): String? = headers().firstValue(name).orElse(null)
    private fun HttpResponse<String>.json(): JsonElement = Json.parseToJsonElement(body())

    @Test
    fun `initialize answers with the protocol version, capabilities and the schema hash`() {
        val bs = Bookstore()
        val port = serveMcp(bs)
        val res = rpc(port, """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}""")
        assertEquals(200, res.statusCode())
        assertEquals("2026-07-28", res.h("mcp-protocol-version"))
        assertEquals(obj("""{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2026-07-28","capabilities":{"tools":{"listChanged":false},"resources":{"subscribe":false,"listChanged":false}},"serverInfo":{"name":"rayfold","version":"0.1","schemaHash":"${bs.server.hash}"}}}"""), res.json())
    }

    @Test
    fun `server discover answers statelessly, a mismatched Mcp-Method header is refused, and a matching one passes (guard)`() {
        val bs = Bookstore()
        val port = serveMcp(bs)
        val res = rpc(port, """{"jsonrpc":"2.0","id":1,"method":"server/discover"}""")
        assertEquals(JsonPrimitive("2026-07-28"), res.json().at("result", "protocolVersion"))
        assertEquals(JsonPrimitive(bs.server.hash), res.json().at("result", "serverInfo", "schemaHash"))
        val bad = rpc(port, """{"jsonrpc":"2.0","id":2,"method":"ping"}""", mapOf("Mcp-Method" to "tools/list"))
        assertEquals(400, bad.statusCode())
        assertEquals(obj("""{"jsonrpc":"2.0","id":2,"error":{"code":-32020,"message":"HeaderMismatch"}}"""), bad.json())
        val good = rpc(port, """{"jsonrpc":"2.0","id":3,"method":"ping"}""", mapOf("Mcp-Method" to "ping"))
        assertEquals(obj("""{"jsonrpc":"2.0","id":3,"result":{}}"""), good.json())
    }

    @Test
    fun `a notification gets 202 with no body, and a batch gets replies for the requests only`() {
        val bs = Bookstore()
        val port = serveMcp(bs)
        val note = rpc(port, """{"jsonrpc":"2.0","method":"notifications/initialized"}""")
        assertEquals(202, note.statusCode())
        assertEquals("", note.body())
        val batch = rpc(port, """[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":2,"method":"tools/list"}]""")
        assertEquals(200, batch.statusCode())
        assertEquals(listOf(JsonPrimitive(1), JsonPrimitive(2)), (batch.json() as JsonArray).map { (it as JsonObject)["id"] })
    }

    @Test
    fun `the viewer hook decides policies for tool calls`() {
        val bs = Bookstore()
        val port = serveMcp(bs)
        val call = """{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"placeOrder","arguments":${order("b3", 1)}}}"""
        assertEquals(JsonPrimitive("unauthenticated"), rpc(port, call).json().at("result", "structuredContent", "error", "code"))
        assertEquals(JsonPrimitive("o1"), rpc(port, call, mapOf("Authorization" to "Bearer u1")).json().at("result", "structuredContent", "result", "id"))
        assertEquals("u1", bs.store.orders.getValue("o1").s("customerId"))
    }

    @Test
    fun `only POST is accepted and malformed JSON is a parse error`() {
        val bs = Bookstore()
        val port = serveMcp(bs)
        val get = rpc(port, "", method = "GET")
        assertEquals(405, get.statusCode())
        assertEquals("POST", get.h("allow"))
        assertEquals("nosniff", get.h("x-content-type-options"))
        val broken = rpc(port, "{")
        assertEquals(400, broken.statusCode())
        assertEquals(obj("""{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}"""), broken.json())
    }

    @Test
    fun `a tool call from a foreign browser Origin is 403 and nothing runs`() {
        val bs = Bookstore()
        val port = serveMcp(bs)
        val call = """{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"placeOrder","arguments":${order("b1", 1)}}}"""
        val attack = rpc(port, call, mapOf("Authorization" to "Bearer u1", "Origin" to "https://evil.example"))
        assertEquals(403, attack.statusCode())
        assertEquals(obj("""{"type":"https://eddyboutros.github.io/rayfold/errors/permission_denied","title":"permission denied","status":403,"detail":"Origin https://evil.example is not allowed","code":"permission_denied"}"""), attack.json())
        assertEquals("nosniff", attack.h("x-content-type-options"))
        assertEquals(5, bs.store.stock("b1"))
        assertNull(bs.store.calls["Command.placeOrder"])
    }

    @Test
    fun `guard - an AI client without Origin, the same origin and an allowed origin are answered`() {
        val bs = Bookstore()
        val port = serveMcp(bs, McpOptions(allowedOrigins = setOf("https://app.example")))
        for (origin in listOf(null, "http://127.0.0.1:$port", "https://app.example")) {
            val res = rpc(port, """{"jsonrpc":"2.0","id":1,"method":"tools/list"}""", if (origin == null) emptyMap() else mapOf("Origin" to origin))
            assertEquals(200, res.statusCode(), "$origin")
        }
    }

    @Test
    fun `a loopback MCP server refuses a foreign Host with 403 (guard - loopback names and an allowed host are answered)`() {
        val bs = Bookstore()
        val port = serveMcp(bs)
        val body = """{"jsonrpc":"2.0","id":1,"method":"tools/list"}"""
        fun raw(p: Int, host: String) = rawHttp(p, "POST /mcp HTTP/1.1\r\nHost: $host\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body")
        fun refusal(detail: String) =
            obj("""{"type":"https://eddyboutros.github.io/rayfold/errors/permission_denied","title":"permission denied","status":403,"detail":"$detail","code":"permission_denied"}""")
        val rebound = raw(port, "evil.example:$port")
        assertEquals(403, rebound.status)
        assertEquals("application/problem+json", rebound.header("Content-Type"))
        assertEquals(refusal("Host evil.example:$port is not allowed on a loopback server"), obj(rebound.body))
        val bare = rawHttp(port, "POST /mcp HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body")
        assertEquals(403, bare.status, bare.head)
        assertEquals(refusal("Missing Host header"), obj(bare.body))
        assertEquals(200, raw(port, "localhost:$port").status)
        val listed = serveMcp(Bookstore(), McpOptions(allowedHosts = setOf("mcp.example")))
        assertEquals(200, raw(listed, "mcp.example").status)
        assertEquals(403, raw(listed, "127.0.0.1:$listed").status)
    }

    @Test
    fun `a body that is not application json is 415 before it is parsed (guard - JSON with a charset is answered)`() {
        val bs = Bookstore()
        val port = serveMcp(bs)
        val call = """{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"placeOrder","arguments":${order("b1", 1)}}}"""
        for (ct in listOf("text/plain", "application/x-www-form-urlencoded")) {
            val res = rpc(port, call, mapOf("Content-Type" to ct, "Authorization" to "Bearer u1"))
            assertEquals(415, res.statusCode())
            assertEquals(obj("""{"type":"https://eddyboutros.github.io/rayfold/errors/unsupported_media_type","title":"unsupported media type","status":415,"detail":"Content-Type $ct is not accepted; send application/json","code":"invalid_argument"}"""), res.json())
        }
        assertNull(bs.store.calls["Command.placeOrder"])
        val ok = rpc(port, call, mapOf("Content-Type" to "application/json; charset=utf-8", "Authorization" to "Bearer u1"))
        assertEquals(JsonPrimitive("o1"), ok.json().at("result", "structuredContent", "result", "id"))
    }

    @Test
    fun `a body over maxBodyBytes is 413 and never parsed (guard - a body at the limit is answered)`() {
        val bs = Bookstore()
        val body = """{"jsonrpc":"2.0","id":1,"method":"ping"}"""
        val over = serveMcp(bs, McpOptions(maxBodyBytes = body.length - 1))
        val refused = rpc(over, body)
        assertEquals(413, refused.statusCode())
        assertEquals(JsonPrimitive("payload_too_large"), (refused.json() as JsonObject)["title"]?.let { JsonPrimitive((it as JsonPrimitive).content.replace(' ', '_')) })
        val at = serveMcp(bs, McpOptions(maxBodyBytes = body.length))
        assertEquals(obj("""{"jsonrpc":"2.0","id":1,"result":{}}"""), rpc(at, body).json())
    }

    @Test
    fun `mount serves MCP beside RayfoldHttp on one server - a look-alike path is a 404`() {
        val bs = Bookstore()
        val http = RayfoldHttp(bs.server).start(0)
        started.add(http)
        RayfoldMcp(bs.server).mount(http)
        val port = http.address.port
        assertEquals(obj("""{"jsonrpc":"2.0","id":1,"result":{}}"""), rpc(port, """{"jsonrpc":"2.0","id":1,"method":"ping"}""").json())
        val lookAlike = client.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/mcpx")).timeout(Duration.ofSeconds(5)).POST(HttpRequest.BodyPublishers.ofString("{}")).header("content-type", "application/json").build(), HttpResponse.BodyHandlers.ofString())
        assertEquals(404, lookAlike.statusCode())
        assertEquals("nosniff", lookAlike.headers().firstValue("x-content-type-options").orElse(null))
    }

    @Test
    fun `the manifest lists mcp once an MCP endpoint is mounted beside the server, and not before`() {
        val bs = Bookstore()
        val http = RayfoldHttp(bs.server).start(0)
        started.add(http)
        val before = manifestExtensions(http.address.port)
        assertTrue("mcp" !in before, "no MCP endpoint yet: $before")
        RayfoldMcp(bs.server).mount(http)
        assertEquals(before + "mcp", manifestExtensions(http.address.port))
        // guard: another server over the same schema serves no MCP endpoint, so its manifest does not claim one
        val other = RayfoldHttp(Bookstore().server).start(0)
        started.add(other)
        assertEquals(before, manifestExtensions(other.address.port))
    }

    private fun manifestExtensions(port: Int): List<String> {
        val res = client.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/rayfold/manifest")).timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofString())
        assertEquals(200, res.statusCode(), res.body())
        return ((res.json() as JsonObject)["extensions"] as JsonArray).map { (it as JsonPrimitive).content }
    }
}
