package dev.rayfold.core

import com.sun.net.httpserver.HttpContext
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import dev.rayfold.core.JsonSchema.obj
import dev.rayfold.core.JsonSchema.str
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class McpOptions(
    val path: String = "/mcp",
    /** Browser origins allowed besides the server's own. The MCP transport requires the Origin check on every request. */
    val allowedOrigins: Set<String> = emptySet(),
    /** Host names answered; null answers any host, except that a loopback server answers loopback names only. */
    val allowedHosts: Set<String>? = null,
    val maxBodyBytes: Int = 1024 * 1024,
    /** What `rayfold://schema` serves: the IR without policy expressions (default), the full IR, or nothing (spec 12 section 5.6). */
    val schema: ManifestMode = ManifestMode.REDACTED,
)

/**
 * MCP bridge (spec 10; mirrors packages/server/src/mcp.ts), revision 2026-07-28, stateless Streamable HTTP: commands
 * become tools (plus a `.simulate` tool where the command declares `@simulate`), queries become tools and resources,
 * schema docs become descriptions. Tool calls run through the normal pipeline: policies, idempotency, typed errors.
 */
object Mcp {
    const val PROTOCOL_VERSION = "2026-07-28"

    @OptIn(ExperimentalSerializationApi::class)
    private val pretty = Json { prettyPrint = true; prettyPrintIndent = "  " }

    fun tools(ir: RayfoldSchemaIR): JsonArray {
        val tools = mutableListOf<JsonElement>()
        for (op in ir.ops.values) {
            if (op.kind == "stream") continue
            val base = linkedMapOf<String, JsonElement>("name" to str(op.name), "inputSchema" to argsSchema(ir, op.args), "outputSchema" to resultSchema(ir, op.returns))
            val desc = listOfNotNull(
                op.description?.takeIf { it.isNotEmpty() },
                if (op.throws.isNotEmpty()) "May fail with: ${op.throws.joinToString(", ")}." else null,
                if (op.kind == "query") "Read-only." else "Changes state; idempotent per call key.",
            ).joinToString(" ")
            if (desc.isNotEmpty()) base["description"] = str(desc)
            base["annotations"] = if (op.kind == "query") obj("readOnlyHint" to JsonPrimitive(true), "idempotentHint" to JsonPrimitive(true))
            else obj("readOnlyHint" to JsonPrimitive(false), "destructiveHint" to JsonPrimitive(true), "idempotentHint" to JsonPrimitive(true))
            tools.add(JsonObject(base))
            // a dry-run tool only where the command declares @simulate: the runtime cannot stop a resolver that ignores ctx.simulate
            if (op.kind == "command" && op.annotations.find("simulate") != null) {
                val sim = LinkedHashMap(base)
                sim["name"] = str("${op.name}.simulate")
                sim["description"] = str("Dry run of ${op.name}: returns the would-be result and effects without committing.")
                sim["annotations"] = obj("readOnlyHint" to JsonPrimitive(true), "idempotentHint" to JsonPrimitive(true))
                tools.add(JsonObject(sim))
            }
        }
        return JsonArray(tools)
    }

    fun resources(ir: RayfoldSchemaIR, schema: ManifestMode = ManifestMode.REDACTED): JsonArray {
        val out = mutableListOf<JsonElement>()
        if (schema != ManifestMode.OFF) out.add(obj("uri" to str("rayfold://schema"), "name" to str("Rayfold schema (IR)"), "description" to str("The full schema as JSON IR"), "mimeType" to str("application/json")))
        for (op in ir.ops.values) {
            if (op.kind != "query" || op.args.any { !it.type.nullable && it.default == null }) continue
            val r = linkedMapOf<String, JsonElement>("uri" to str("rayfold://query/${op.name}"), "name" to str(op.name), "mimeType" to str("application/json"))
            if (!op.description.isNullOrEmpty()) r["description"] = str(op.description)
            out.add(JsonObject(r))
        }
        return JsonArray(out)
    }

    private fun argsSchema(ir: RayfoldSchemaIR, args: List<ArgDef>): JsonObject {
        val defs = linkedMapOf<String, JsonElement>()
        val properties = linkedMapOf<String, JsonElement>()
        val required = mutableListOf<JsonElement>()
        for (a in args) {
            properties[a.name] = JsonSchema.described(JsonSchema.withRange(JsonSchema.forType(ir, a.type, defs, true), a.annotations, a.type.baseName()), a.description)
            if (!a.type.nullable && a.default == null) required.add(str(a.name))
        }
        val schema = linkedMapOf<String, JsonElement>("\$schema" to str(JsonSchema.DIALECT), "type" to str("object"), "properties" to JsonObject(properties), "additionalProperties" to JsonPrimitive(false))
        if (required.isNotEmpty()) schema["required"] = JsonArray(required)
        if (defs.isNotEmpty()) schema["\$defs"] = JsonObject(defs)
        return JsonObject(schema)
    }

    private fun resultSchema(ir: RayfoldSchemaIR, t: TypeRef): JsonObject {
        val defs = linkedMapOf<String, JsonElement>()
        val inner = JsonSchema.forType(ir, t, defs, false)
        val schema = linkedMapOf<String, JsonElement>("\$schema" to str(JsonSchema.DIALECT), "type" to str("object"), "properties" to obj("result" to inner), "required" to JsonArray(listOf(str("result"))))
        if (defs.isNotEmpty()) schema["\$defs"] = JsonObject(defs)
        return JsonObject(schema)
    }

    private val QUERY_URI = Regex("^rayfold://query/([A-Za-z_][A-Za-z0-9_]*)(\\?(.*))?$")

    /** One JSON-RPC request (stateless); null for a notification. */
    suspend fun handle(server: RayfoldServer, req: JsonElement, viewer: JsonElement, options: McpOptions = McpOptions()): JsonObject? {
        val o = req as? JsonObject
        val id = o?.get("id") ?: JsonNull
        fun reply(result: JsonElement) = buildJsonObject { put("jsonrpc", "2.0"); put("id", id); put("result", result) }
        fun fail(code: Int, message: String) = buildJsonObject {
            put("jsonrpc", "2.0"); put("id", id); put("error", buildJsonObject { put("code", code); put("message", message) })
        }
        if (o == null) return fail(-32600, "Invalid Request")
        val method = (o["method"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val p = o["params"] as? JsonObject ?: JsonObject(emptyMap())
        val serverInfo = obj("name" to str("rayfold"), "version" to str("0.1"), "schemaHash" to str(server.hash))
        val listed = { key: String, items: JsonArray -> reply(obj(key to items, "ttlMs" to JsonPrimitive(300_000), "cacheScope" to str("public"))) }
        return when (method) {
            "initialize" -> reply(obj(
                "protocolVersion" to str(PROTOCOL_VERSION),
                "capabilities" to obj("tools" to obj("listChanged" to JsonPrimitive(false)), "resources" to obj("subscribe" to JsonPrimitive(false), "listChanged" to JsonPrimitive(false))),
                "serverInfo" to serverInfo,
            ))
            "server/discover" -> reply(obj("protocolVersion" to str(PROTOCOL_VERSION), "capabilities" to obj("tools" to obj(), "resources" to obj()), "serverInfo" to serverInfo))
            "ping" -> reply(obj())
            "notifications/initialized" -> null
            "tools/list" -> listed("tools", tools(server.ir))
            "tools/call" -> {
                val name = (p["name"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return fail(-32602, "name is required")
                reply(callTool(server, name, p["arguments"]?.takeIf { it !is JsonNull } ?: JsonObject(emptyMap()), viewer))
            }
            "resources/list" -> listed("resources", resources(server.ir, options.schema))
            "resources/read" -> {
                val uri = (p["uri"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return fail(-32602, "uri is required")
                if (uri == "rayfold://schema" && options.schema != ManifestMode.OFF) {
                    val ir = if (options.schema == ManifestMode.FULL) server.ir else server.ir.withoutPolicies()
                    return reply(obj("contents" to JsonArray(listOf(obj("uri" to str(uri), "mimeType" to str("application/json"), "text" to str(RayfoldSchemaIR.json.encodeToString(RayfoldSchemaIR.serializer(), ir)))))))
                }
                val m = QUERY_URI.matchEntire(uri)
                // a resource read is a read: only queries are resources, whatever the URI names
                if (m == null || server.ir.ops[m.groupValues[1]]?.kind != "query") return fail(-32602, "Unknown resource $uri")
                // values stay text, as URLSearchParams gives them; the pipeline coerces them by declared type
                val args = JsonObject(RayfoldBindingsText.query(m.groupValues[3]).associate { (k, v) -> k to JsonPrimitive(v) })
                val r = callTool(server, m.groupValues[1], args, viewer)
                if (r["isError"] == JsonPrimitive(true)) {
                    val text = (((r["content"] as? JsonArray)?.firstOrNull() as? JsonObject)?.get("text") as? JsonPrimitive)?.content ?: "error"
                    return fail(-32000, text)
                }
                val result = (r["structuredContent"] as? JsonObject)?.get("result") ?: JsonNull
                reply(obj("contents" to JsonArray(listOf(obj("uri" to str(uri), "mimeType" to str("application/json"), "text" to str(result.toString()))))))
            }
            "prompts/list" -> reply(obj("prompts" to JsonArray(emptyList())))
            else -> fail(-32601, "Method not found: ${method ?: "undefined"}")
        }
    }

    private suspend fun callTool(server: RayfoldServer, name: String, args: JsonElement, viewer: JsonElement): JsonObject {
        val simulate = name.endsWith(".simulate")
        val opName = name.removeSuffix(".simulate")
        val op = server.ir.ops[opName]
        if (op == null || op.kind == "stream") {
            return obj("isError" to JsonPrimitive(true), "content" to JsonArray(listOf(obj("type" to str("text"), "text" to str("Unknown tool $name")))))
        }
        val req = buildJsonObject {
            put("id", 1); put("op", opName); put("args", args)
            if (op.kind == "command") {
                val optedOut = op.annotations.find("idempotent")?.args?.get("value") == JsonPrimitive(false)
                // derived from the arguments, so a retried call with identical arguments replays instead of running twice
                if (!optedOut) put("key", "mcp-${hashKey(args.toString())}")
                if (simulate) put("simulate", true)
            }
        }
        val frames = server.collect(buildJsonObject { put("ops", JsonArray(listOf(req))); put("meta", buildJsonObject { put("client", "mcp") }) }, ExecuteOptions(viewer))
        var result: JsonElement = JsonNull
        var patch: JsonElement? = null
        for (f in frames) {
            (f["error"] as? JsonObject)?.let { e ->
                val code = (e["code"] as? JsonPrimitive)?.content ?: "internal"
                val type = (e["type"] as? JsonPrimitive)?.content
                val message = (e["message"] as? JsonPrimitive)?.content ?: ""
                return obj(
                    "isError" to JsonPrimitive(true),
                    "content" to JsonArray(listOf(obj("type" to str("text"), "text" to str("$code${if (type != null) " $type" else ""}: $message")))),
                    "structuredContent" to obj("error" to e),
                )
            }
            val at = (f["at"] as? JsonPrimitive)?.content
            val data = f["data"]
            val ok = f["ok"]
            when {
                ok != null -> { result = ok; patch = f["patch"] }
                data != null && at == null -> result = data
                data != null && at != null && (result is JsonObject || result is JsonArray) -> result = Live.mergeAt(result, at, data)
            }
        }
        val structured = linkedMapOf("result" to result)
        patch?.let { structured["effects"] = it }
        return obj(
            "content" to JsonArray(listOf(obj("type" to str("text"), "text" to str(pretty.encodeToString(JsonElement.serializer(), result))))),
            "structuredContent" to JsonObject(structured),
            "resultType" to str("complete"),
        )
    }

    /** FNV-1a over the UTF-16 units of the argument text, plus its length, as the TS bridge derives its keys. */
    private fun hashKey(s: String): String {
        var h = 2166136261L.toInt()
        for (c in s) h = (h xor c.code) * 16777619
        return Integer.toUnsignedString(h, 16).padStart(8, '0') + s.length.toString(16).padStart(8, '0')
    }
}

/** Query-string decoding shared with [RayfoldBindings]. */
internal object RayfoldBindingsText {
    fun query(raw: String): List<Pair<String, String>> = (raw).split("&").filter { it.isNotEmpty() }.map { kv ->
        fun dec(s: String) = try {
            java.net.URLDecoder.decode(s, Charsets.UTF_8)
        } catch (e: IllegalArgumentException) {
            s
        }
        dec(kv.substringBefore("=")) to dec(kv.substringAfter("=", ""))
    }
}

/**
 * The MCP endpoint over Streamable HTTP: POST JSON-RPC (or a batch), JSON reply. [handle] answers [McpOptions.path]
 * and returns false for anything else; [mount] adds it to a JDK server such as the one [RayfoldHttp.start] returns.
 */
class RayfoldMcp(
    private val server: RayfoldServer,
    private val options: McpOptions = McpOptions(),
    private val viewer: (HttpExchange) -> JsonElement = { JsonNull },
) {
    constructor(server: RayfoldServer, viewer: (HttpExchange) -> JsonElement) : this(server, McpOptions(), viewer)

    fun mount(http: HttpServer): HttpContext = http.createContext(options.path) { ex ->
        if (!handle(ex)) Guard.refuse(ex, 404, Code.NOT_FOUND, "No route for ${ex.requestMethod} ${ex.requestURI.rawPath}")
    }

    fun handle(ex: HttpExchange): Boolean {
        if (ex.requestURI.path != options.path) return false
        if (ex.requestMethod != "POST") {
            ex.responseHeaders.set("Allow", "POST")
            ex.responseHeaders.set("X-Content-Type-Options", "nosniff")
            ex.sendResponseHeaders(405, -1)
            ex.close()
            return true
        }
        // the MCP transport requires Origin validation: without it any web page could drive a local or intranet server
        val refused = Guard.hostProblem(ex, options.allowedHosts) ?: Guard.originProblem(ex, options.allowedOrigins)
        if (refused != null) {
            Guard.refuse(ex, 403, Code.PERMISSION_DENIED, refused)
            return true
        }
        val ct = Guard.mediaType(ex.requestHeaders.getFirst("Content-Type"))
        if (ct != "application/json") {
            Guard.refuse(ex, 415, Code.INVALID_ARGUMENT, "Content-Type ${ct.ifEmpty { "(none)" }} is not accepted; send application/json", "unsupported_media_type")
            return true
        }
        ex.responseHeaders.set("X-Content-Type-Options", "nosniff")
        val body = try {
            Guard.readBody(ex, options.maxBodyBytes)
        } catch (e: Guard.BodyTooLarge) {
            Guard.refuseBody(ex, e)
            return true
        }
        val parsed = try {
            StrictJson.parse(body.toString(Charsets.UTF_8), "body", "Parse error")
        } catch (e: RayfoldException) {
            rpc(ex, 400, rpcError(JsonNull, -32700, "Parse error"))
            return true
        }
        val v = viewer(ex)
        val headerMethod = ex.requestHeaders.getFirst("Mcp-Method")
        val first = (if (parsed is JsonArray) parsed.firstOrNull() else parsed)?.takeIf { it !is JsonNull }
        if (headerMethod != null && first != null && headerMethod != ((first as? JsonObject)?.get("method") as? JsonPrimitive)?.content) {
            rpc(ex, 400, rpcError((first as? JsonObject)?.get("id") ?: JsonNull, -32020, "HeaderMismatch"))
            return true
        }
        val requests = if (parsed is JsonArray) parsed.toList() else listOf(parsed)
        val results = runBlocking { coroutineScope { requests.map { r -> async { Mcp.handle(server, r, v, options) } }.awaitAll() } }
        ex.responseHeaders.set("MCP-Protocol-Version", Mcp.PROTOCOL_VERSION)
        val out: JsonElement? = if (parsed is JsonArray) JsonArray(results.filterNotNull()) else results[0]
        if (out == null) {
            ex.sendResponseHeaders(202, -1)
            ex.close()
            return true
        }
        rpc(ex, 200, out)
        return true
    }

    private fun rpcError(id: JsonElement, code: Int, message: String) = buildJsonObject {
        put("jsonrpc", "2.0"); put("id", id); put("error", buildJsonObject { put("code", code); put("message", message) })
    }

    private fun rpc(ex: HttpExchange, status: Int, body: JsonElement) {
        val bytes = body.toString().toByteArray()
        ex.responseHeaders.set("Content-Type", "application/json")
        ex.sendResponseHeaders(status, bytes.size.toLong())
        ex.responseBody.use { it.write(bytes) }
    }
}
