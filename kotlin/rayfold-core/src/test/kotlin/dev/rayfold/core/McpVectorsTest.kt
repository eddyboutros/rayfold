package dev.rayfold.core

import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The published `mcp/` vectors (spec 10), run against [RayfoldMcp] on a real socket. `mcp-vectors.test.ts` runs the
 * same file against the TypeScript endpoint. Each case gets a fresh server; its steps are POSTs made in order.
 */
class McpVectorsTest {
    private val root = File(System.getProperty("rayfold.vectors") ?: "../conformance/vectors")
    private val caseKeys = setOf("name", "why", "steps", "runs")
    private val requestKeys = setOf("json", "headers", "oversize")
    private val expectKeys = setOf("status", "headers", "noBody", "error", "batchErrors", "resourceItems", "isError", "validatesOutputSchemaOf", "problem")

    @TestFactory
    fun mcp(): List<DynamicTest> {
        val doc = Json.parseToJsonElement(File(File(root, "mcp"), "bridge.json").readText()).jsonObject
        val ir = SchemaText.load(doc.str("schema")).ir
        val out = doc.req("cases").jsonArray.map { case ->
            val c = case.jsonObject
            DynamicTest.dynamicTest("mcp/${c.str("name")}") { run(ir, c) }
        }
        assertTrue(out.size > 5, "no mcp vectors were found under ${root.absolutePath}")
        return out
    }

    private fun run(ir: RayfoldSchemaIR, c: JsonObject) {
        for (k in c.keys) assertTrue(k in caseKeys, "${c.str("name")}: no runner for case field $k")
        val why = c["why"]?.jsonPrimitive?.content ?: c.str("name")
        val runs = ConcurrentHashMap(mapOf("restock" to AtomicInteger(), "reserve" to AtomicInteger()))
        fun book(id: String) = buildJsonObject {
            put("id", id); put("title", "T")
            put("author", buildJsonObject { put("id", "a1"); put("name", "A") })
        }
        fun command(name: String): suspend (JsonObject, RayfoldContext) -> Any? = { args, _ ->
            runs.getValue(name).incrementAndGet()
            book(args.str("id"))
        }
        val server = RayfoldServer(
            ir,
            Resolvers(
                queries = mapOf(
                    "book" to { args, _ -> book(args.str("id")) },
                    "books" to { args, _ -> JsonArray(listOf("b1", "b2", "b3").map { book(it) }.take(args.str("limit").toInt())) },
                ),
                commands = mapOf("restock" to command("restock"), "reserve" to command("reserve")),
            ),
        )
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        RayfoldMcp(server) { buildJsonObject { put("id", "u1") } }.mount(http)
        http.start()
        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
        try {
            val url = URI("http://127.0.0.1:${http.address.port}/mcp")
            fun post(request: JsonObject): HttpResponse<String> {
                val body = request["oversize"]?.let { """{"jsonrpc":"2.0","id":1,"method":"ping"}""".padEnd(it.jsonPrimitive.content.toInt(), ' ') }
                    ?: request.req("json").toString()
                val b = HttpRequest.newBuilder(url).timeout(Duration.ofSeconds(10)).header("Content-Type", "application/json")
                (request["headers"] as? JsonObject)?.forEach { (h, v) -> b.header(h, v.jsonPrimitive.content) }
                return client.send(b.POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString())
            }
            for (s in c.req("steps").jsonArray) {
                val step = s.jsonObject
                val request = step.req("request").jsonObject
                val e = step.req("expect").jsonObject
                for (k in request.keys) assertTrue(k in requestKeys, "${c.str("name")}: no runner for request field $k")
                for (k in e.keys) assertTrue(k in expectKeys, "${c.str("name")}: no assertion for expect.$k")
                val res = post(request)
                val text = res.body()
                e["status"]?.let { assertEquals(it.jsonPrimitive.content.toInt(), res.statusCode(), why) }
                (e["headers"] as? JsonObject)?.forEach { (h, v) -> assertEquals(v.jsonPrimitive.content, res.headers().firstValue(h).orElse(null), "$why: header $h") }
                if (e["noBody"]?.jsonPrimitive?.booleanOrNull == true) assertEquals("", text, why)
                val reply = if (text.isEmpty()) null else Json.parseToJsonElement(text)
                e["error"]?.let { assertEquals(it.jsonPrimitive.content, ((reply as? JsonObject)?.get("error") as? JsonObject)?.get("code")?.jsonPrimitive?.content, "$why: $text") }
                e["batchErrors"]?.let { expected ->
                    assertTrue(reply is JsonArray, "$why: a batch is answered with an array: $text")
                    val codes = reply.jsonArray.map { ((it as JsonObject)["error"] as? JsonObject)?.get("code") ?: JsonNull }
                    assertEquals(expected.jsonArray.map { it.toString() }, codes.map { it.toString() }, why)
                }
                (e["problem"] as? JsonObject)?.let { p ->
                    assertTrue("application/problem+json" in res.headers().firstValue("Content-Type").orElse(""), why)
                    val problem = reply as JsonObject
                    assertTrue(p.str("type") in problem.str("type"), "$why: type was ${problem.str("type")}")
                    assertEquals(p.str("code"), problem.str("code"), why)
                }
                val result = (reply as? JsonObject)?.get("result") as? JsonObject
                e["resourceItems"]?.let {
                    assertEquals(null, (reply as JsonObject)["error"], "$why: $text")
                    val contents = result?.get("contents")?.jsonArray ?: error("$why: no contents in $text")
                    assertEquals(it.jsonPrimitive.content.toInt(), Json.parseToJsonElement(contents[0].jsonObject.str("text")).jsonArray.size, why)
                }
                e["isError"]?.let { assertEquals(it.jsonPrimitive.content == "true", result?.get("isError")?.jsonPrimitive?.booleanOrNull ?: false, "$why: $text") }
                e["validatesOutputSchemaOf"]?.let { tool ->
                    val listed = Json.parseToJsonElement(post(buildJsonObject { put("json", buildJsonObject { put("jsonrpc", "2.0"); put("id", 99); put("method", "tools/list") }) }).body()).jsonObject
                    val schema = listed.req("result").jsonObject.req("tools").jsonArray.map { it.jsonObject }
                        .single { it.str("name") == tool.jsonPrimitive.content }.req("outputSchema").jsonObject
                    val defs = (schema["\$defs"] as? JsonObject) ?: JsonObject(emptyMap())
                    assertEquals(emptyList(), violations(schema, result?.get("structuredContent") ?: JsonNull, defs, "structuredContent"), why)
                }
            }
            (c["runs"] as? JsonObject)?.let { expected ->
                assertEquals(expected.mapValues { it.value.jsonPrimitive.content.toInt() }, runs.mapValues { it.value.get() }.toSortedMap().toMap(), why)
            }
        } finally {
            client.shutdownNow()
            http.stop(0)
        }
    }

    /** Just enough JSON Schema 2020-12 for a tool's outputSchema: $ref, anyOf, const, type, properties, required, items. */
    private fun violations(schema: JsonObject, value: JsonElement, defs: JsonObject, at: String): List<String> {
        schema["\$ref"]?.let { return violations(defs.req(it.jsonPrimitive.content.removePrefix("#/\$defs/")).jsonObject, value, defs, at) }
        schema["anyOf"]?.let { any ->
            val each = any.jsonArray.map { violations(it.jsonObject, value, defs, at) }
            return if (each.any { it.isEmpty() }) emptyList() else each.flatten()
        }
        schema["const"]?.let { return if (value == it) emptyList() else listOf("$at: not $it") }
        val p = value as? JsonPrimitive
        return when (schema["type"]?.jsonPrimitive?.content) {
            "null" -> if (value is JsonNull) emptyList() else listOf("$at: not null")
            "string" -> if (p != null && p.isString) emptyList() else listOf("$at: not a string")
            "integer" -> if (p != null && !p.isString && p.content.toLongOrNull() != null) emptyList() else listOf("$at: not an integer")
            "number" -> if (p != null && !p.isString && p.doubleOrNull != null) emptyList() else listOf("$at: not a number")
            "boolean" -> if (p != null && !p.isString && p.booleanOrNull != null) emptyList() else listOf("$at: not a boolean")
            "array" -> if (value !is JsonArray) listOf("$at: not an array")
                else value.flatMapIndexed { i, v -> violations(schema.req("items").jsonObject, v, defs, "$at[$i]") }
            "object" -> {
                if (value !is JsonObject) return listOf("$at: not an object")
                val props = (schema["properties"] as? JsonObject) ?: JsonObject(emptyMap())
                val out = ((schema["required"] as? JsonArray) ?: JsonArray(emptyList())).map { it.jsonPrimitive.content }
                    .filter { it !in value }.map { "$at.$it: required and missing" }.toMutableList()
                for ((k, v) in value) {
                    val ps = props[k]
                    if (ps != null) out += violations(ps.jsonObject, v, defs, "$at.$k")
                    else if (schema["additionalProperties"] == JsonPrimitive(false)) out += "$at.$k: not a declared property"
                }
                out
            }
            else -> error("$at: the vector runner has no check for schema $schema")
        }
    }

    private fun JsonObject.req(key: String): JsonElement = this[key] ?: error("vector is missing \"$key\"")
    private fun JsonObject.str(key: String): String = req(key).jsonPrimitive.content
}
