package dev.rayfold.core

import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * OpenAPI 3.2 against the TypeScript oracle: the documents `openApiFor` makes from the same IRs are checked in under
 * `resources/oracle`, and the Kotlin output must equal them structurally and in key order. A few semantic checks from
 * openapi.test.ts are repeated so a regression names what broke, and the served route is driven over real HTTP.
 */
class OpenApiTest {
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val started = mutableListOf<HttpServer>()

    @AfterEach
    fun stop() {
        started.forEach { it.stop(0) }
        client.shutdownNow()
    }

    private fun assertSameAsTs(expected: JsonElement, actual: JsonElement, what: String) {
        assertEquals(expected, actual, "$what: structure")
        assertEquals(expected.toString(), actual.toString(), "$what: key order")
    }

    private fun bookstoreDoc() = OpenApi.document(Oracle.ir("bookstore.ir.json"))
    private fun JsonElement.o(vararg path: String): JsonObject = path.fold(this) { v, k -> (v as JsonObject)[k] ?: error("no $k in $v") } as JsonObject

    /** Every operation as "method path", in document order. */
    private fun operations(doc: JsonObject): List<Pair<String, JsonObject>> =
        doc.o("paths").flatMap { (path, ops) -> (ops as JsonObject).map { (method, op) -> "$method $path" to (op as JsonObject) } }

    private fun header(op: JsonObject, name: String) = (op["parameters"] as JsonArray).map { it as JsonObject }
        .firstOrNull { it["in"] == JsonPrimitive("header") && it["name"] == JsonPrimitive(name) }

    @Test
    fun `the bookstore document is the TypeScript document, structure and key order`() {
        assertSameAsTs(Oracle.json("bookstore.openapi.json"), bookstoreDoc(), "bookstore")
    }

    @Test
    fun `title, version and prefix land in info and in every path key, as in TypeScript`() {
        val doc = OpenApi.document(Oracle.ir("bookstore.ir.json"), title = "Bookstore", version = "2.1", prefix = "/api")
        assertSameAsTs(Oracle.json("bookstore.openapi.prefixed.json"), doc, "prefixed bookstore")
        assertEquals(listOf("/api/books", "/api/books/{id}", "/api/reviews/{id}", "/api/orders/{id}", "/api/orders", "/api/orders/{id}/pay"), doc.o("paths").keys.toList())
    }

    @Test
    fun `the custom schema of openapi test ts - query params, @range keywords, policies, versions - is the TypeScript document`() {
        assertSameAsTs(Oracle.json("openapi-custom.openapi.json"), OpenApi.document(Oracle.ir("openapi-custom.ir.json")), "custom")
    }

    @Test
    fun `wire names from @http(name) - parameters, path templates and body properties - are the TypeScript document`() {
        val doc = OpenApi.document(Oracle.ir("openapi-wire.ir.json"))
        assertSameAsTs(Oracle.json("openapi-wire.openapi.json"), doc, "wire")
        assertEquals(listOf("/find", "/hits/{hit-id}", "/search"), doc.o("paths").keys.toList())
        val find = (doc.o("paths", "/find", "get")["parameters"] as JsonArray).map { ((it as JsonObject)["name"] as JsonPrimitive).content }
        assertEquals(listOf("first-name", "max-count", "shape"), find)
        assertEquals(listOf("first-name", "where"), doc.o("paths", "/search", "query", "requestBody", "content", "application/json", "schema", "properties").keys.toList())
        assertEquals(listOf("zip-code", "near-by"), doc.o("components", "schemas", "Where", "properties").keys.toList())
        assertEquals(listOf("max-km"), doc.o("components", "schemas", "Near", "properties").keys.toList())
        // results keep their schema names
        assertEquals(listOf("\$type", "id", "first"), doc.o("components", "schemas", "Hit", "properties").keys.toList())
    }

    @Test
    fun `OpenAPI 3 2 with exactly the bound paths and methods - QUERY is the query key on books`() {
        val doc = bookstoreDoc()
        assertEquals(JsonPrimitive("3.2.0"), doc["openapi"])
        assertEquals(mapOf(
            "/books" to listOf("query"), "/books/{id}" to listOf("get", "patch"), "/reviews/{id}" to listOf("get", "put", "delete"),
            "/orders/{id}" to listOf("get"), "/orders" to listOf("post"), "/orders/{id}/pay" to listOf("post"),
        ), doc.o("paths").mapValues { (it.value as JsonObject).keys.toList() })
        assertEquals(JsonPrimitive("List books, newest first."), doc.o("paths", "/books", "query")["summary"])
    }

    @Test
    fun `Idempotency-Key is required on POST unless @idempotent(false), If-Match and 412 appear exactly on versioned commands`() {
        val doc = bookstoreDoc()
        assertEquals(JsonPrimitive(true), header(doc.o("paths", "/orders", "post"), "Idempotency-Key")?.get("required"))
        assertEquals(null, header(doc.o("paths", "/reviews/{id}", "put"), "Idempotency-Key"))
        val custom = OpenApi.document(Oracle.ir("openapi-custom.ir.json"))
        assertEquals(JsonPrimitive(false), header(custom.o("paths", "/free", "post"), "Idempotency-Key")?.get("required"))
        val withIfMatch = operations(doc).filter { header(it.second, "If-Match") != null }.map { it.first }
        val with412 = operations(doc).filter { "412" in it.second.o("responses") }.map { it.first }
        assertEquals(listOf("put /reviews/{id}", "delete /reviews/{id}"), withIfMatch)
        assertEquals(withIfMatch, with412)
    }

    @Test
    fun `no defs reference survives and every components reference resolves to a non-empty component`() {
        for (doc in listOf(bookstoreDoc(), OpenApi.document(Oracle.ir("openapi-custom.ir.json")))) {
            val text = doc.toString()
            assertTrue("#/\$defs/" !in text)
            val refs = Regex("\"\\\$ref\":\"([^\"]*)\"").findAll(text).map { it.groupValues[1] }.toList()
            assertTrue(refs.isNotEmpty())
            val schemas = doc.o("components", "schemas")
            for (ref in refs) {
                assertTrue(ref.startsWith("#/components/schemas/"), ref)
                assertTrue((schemas[ref.removePrefix("#/components/schemas/")] as? JsonObject)?.isNotEmpty() == true, ref)
            }
        }
    }

    @Test
    fun `GET rayfold openapi json over the real HTTP transport serves the document, and a foreign Host is refused (guard - loopback Host served)`() {
        val bs = Bookstore()
        val http = RayfoldHttp(bs.server).start(0)
        started.add(http)
        val res = client.send(HttpRequest.newBuilder(URI("http://127.0.0.1:${http.address.port}/rayfold/openapi.json")).timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofString())
        assertEquals(200, res.statusCode())
        assertEquals("application/json; charset=utf-8", res.headers().firstValue("content-type").orElse(null))
        assertEquals("nosniff", res.headers().firstValue("x-content-type-options").orElse(null))
        assertEquals(Oracle.json("bookstore.openapi.json"), Json.parseToJsonElement(res.body()))
        val rebound = rawHttp(http.address.port, "GET /rayfold/openapi.json HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n")
        assertEquals(403, rebound.status)
        assertTrue("Host evil.example is not allowed on a loopback server" in rebound.body, rebound.body)
    }
}
