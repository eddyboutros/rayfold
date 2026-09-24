package dev.rayfold.core

import com.sun.net.httpserver.Headers
import com.sun.net.httpserver.HttpContext
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

/** One `@http` binding: an op on a REST-shaped route (spec 04 section 8). */
class Binding(
    val op: OpDef,
    val method: String,
    val path: String,
    /** Name of the argument that receives the JSON body, or "*" to spread the body into the arguments. */
    val body: String?,
    /** Location template for 201 responses, filled from the result, such as "/orders/{id}". */
    val location: String?,
    val params: List<String>,
    val regex: Regex,
)

object Bindings {
    private val PARAM = Regex("\\{([A-Za-z_][A-Za-z0-9_]*)\\}")

    /** Every `@http` op in schema order, with its method upper-cased and its path compiled to a matcher. */
    fun of(ir: RayfoldSchemaIR): List<Binding> = ir.ops.values.mapNotNull { op ->
        val a = op.annotations.find("http") ?: return@mapNotNull null
        val method = identOrString(a.args["method"])?.uppercase() ?: return@mapNotNull null
        val path = (a.args["path"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
        val params = mutableListOf<String>()
        val pattern = StringBuilder()
        var last = 0
        for (m in PARAM.findAll(path)) {
            pattern.append(Regex.escape(path.substring(last, m.range.first))).append("([^/]+)")
            params.add(m.groupValues[1])
            last = m.range.last + 1
        }
        pattern.append(Regex.escape(path.substring(last)))
        val location = (a.args["location"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        Binding(op, method, path, identOrString(a.args["body"]), location, params, Regex(pattern.toString()))
    }

    private fun identOrString(v: JsonElement?): String? = (v as? JsonPrimitive)?.takeIf { it.isString }?.content ?: v.identOrNull()
}

/**
 * Cache-Control, Vary and ETag for safe requests (spec 07 section 2; mirrors applyCacheHeaders in http.ts): the minimum
 * `@cache` over the ops and the entity types present in the response, private when a policy reads the viewer or a
 * viewer is signed in. Returns the ETag it set.
 */
object CacheHeaders {
    const val VARY = "Rayfold-Client, Accept, Authorization"

    fun apply(ir: RayfoldSchemaIR, ops: List<RequestOp>, frames: List<JsonObject>, viewer: JsonElement, headers: Headers): String =
        apply(ir, ops, frames, viewer) { name, value -> headers.set(name, value) }

    fun apply(ir: RayfoldSchemaIR, ops: List<RequestOp>, frames: List<JsonObject>, viewer: JsonElement, set: (String, String) -> Unit): String {
        var maxAge = Double.POSITIVE_INFINITY
        var swr = Double.POSITIVE_INFINITY
        var private = false
        fun consider(annotations: List<Annotation>) {
            annotations.find("cache")?.let { c ->
                c.args["maxAge"].durationMs()?.let { maxAge = minOf(maxAge, it / 1000.0) }
                c.args["swr"].durationMs()?.let { swr = minOf(swr, it / 1000.0) }
                if (c.args["scope"].identOrNull() == "private") private = true
            }
            for (a in annotations) {
                if ((a.name == "allow" || a.name == "deny") && a.args.values.any { v -> v.exprOrNull()?.let { Expr.referencesViewer(it) } == true }) private = true
            }
        }
        for (o in ops) ir.ops[o.op]?.let { consider(it.annotations) }
        // Only types and fields present in the response count (spec 07 section 1: "touches such a field"). A compact frame
        // leaves out `$type` wherever the schema fixes it, so the walk follows each op's return type, and reads `$type`
        // only where it is still there, as on a union member.
        val seen = mutableSetOf<String>()
        fun walk(v: JsonElement?, t: TypeRef?) {
            when (v) {
                is JsonArray -> v.forEach { walk(it, t?.takeIf { it.isList }?.element) }
                is JsonObject -> {
                    val tn = (v["\$type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                    val ref = if (tn != null) TypeRef("named", tn) else t?.takeIf { it.kind == "named" }
                    val def = ref?.name?.let { ir.types[it] }
                    if (def != null && seen.add(def.name)) consider(def.annotations)
                    val fields = ref?.let { ir.fieldsOf(it) }.orEmpty()
                    for ((k, x) in v) {
                        if (k == "\$type") continue
                        val fd = fields.firstOrNull { it.name == k }
                        if (fd != null && (fd.annotations.find("allow") != null || fd.annotations.find("deny") != null)) consider(fd.annotations)
                        walk(x, fd?.type)
                    }
                }
                else -> {}
            }
        }
        // the static type at a deferred frame's path, such as "items.0.author"
        fun typeAt(root: TypeRef?, path: String): TypeRef? {
            var t = root
            for (seg in if (path.isEmpty()) emptyList() else path.split('.')) {
                val cur = t ?: return null
                t = if (seg.all { it.isDigit() }) (if (cur.isList) cur.element else cur) else ir.fieldsOf(cur)?.firstOrNull { it.name == seg }?.type
            }
            return t
        }
        val opNames = ops.associate { it.id to it.op }
        for (f in frames) {
            if ("data" !in f) continue
            val returns = (f["id"] as? JsonPrimitive)?.content?.toIntOrNull()?.let { opNames[it] }?.let { ir.ops[it]?.returns }
            val at = (f["at"] as? JsonPrimitive)?.content
            walk(f["data"], if (at != null) typeAt(returns, at) else returns)
        }
        if (viewer !is JsonNull) private = true
        if (maxAge.isInfinite()) maxAge = 0.0
        if (swr.isInfinite()) swr = 0.0
        val directives = mutableListOf(if (private) "private" else "public", "max-age=${maxAge.toLong()}")
        if (swr > 0) directives.add("stale-while-revalidate=${swr.toLong()}")
        if (maxAge == 0.0 && swr == 0.0) directives.add("no-cache")
        set("Cache-Control", directives.joinToString(", "))
        set("Vary", VARY)
        // `meta.ms` is how long the server took, so it differs on every identical answer and would make every ETag
        // a miss. Dropped from the digest only, exactly as applyCacheHeaders does - the emptied `meta` stays, since
        // removing it altogether would canonicalise differently and part the two runtimes' ETags.
        val digested = frames.map { f ->
            val meta = f["meta"] as? JsonObject
            if (meta == null) f else JsonObject(f + ("meta" to JsonObject(meta - "ms")))
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(Canonical.json(JsonArray(digested)).toByteArray())
        val etag = "\"sha256-${digest.joinToString("") { "%02x".format(it) }}\""
        set("ETag", etag)
        return etag
    }
}

data class BindingOptions(
    /** Mount prefix, default "" (routes are served exactly as declared). */
    val prefix: String = "",
    val maxBodyBytes: Int = 1024 * 1024,
    /** Origins allowed to send requests that can change data (POST, PUT, PATCH, DELETE), besides the server's own. */
    val allowedOrigins: Set<String> = emptySet(),
    /** Host names answered; null answers any host, except that a loopback server answers loopback names only. */
    val allowedHosts: Set<String>? = null,
)

/**
 * REST-style HTTP bindings (spec 04 section 8; mirrors packages/server/src/bindings.ts): `@http` ops on their natural
 * methods, backed by the same contract (validation, policies, typed errors, idempotency, patches).
 *
 * [handle] answers bound routes and returns false for anything else, so a host can chain handlers; [mount] adds a
 * context to a JDK server (such as the one [RayfoldHttp.start] returns) that answers unbound paths with 404.
 */
class RayfoldBindings(
    private val server: RayfoldServer,
    private val options: BindingOptions = BindingOptions(),
    private val viewer: (HttpExchange) -> JsonElement = { JsonNull },
) {
    constructor(server: RayfoldServer, viewer: (HttpExchange) -> JsonElement) : this(server, BindingOptions(), viewer)

    val bindings: List<Binding> = Bindings.of(server.ir)

    fun mount(http: HttpServer): HttpContext = http.createContext(options.prefix.ifEmpty { "/" }) { ex ->
        if (!handle(ex)) Guard.refuse(ex, 404, Code.NOT_FOUND, "No route for ${ex.requestMethod} ${ex.requestURI.rawPath}")
    }

    /** Serves a bound route and returns true, or returns false having written nothing. */
    fun handle(ex: HttpExchange): Boolean {
        val raw = ex.requestURI.rawPath ?: "/"
        if (!raw.startsWith(options.prefix)) return false
        val path = raw.substring(options.prefix.length).ifEmpty { "/" }
        val matches = bindings.mapNotNull { b -> b.regex.matchEntire(path)?.let { b to it } }
        if (matches.isEmpty()) return false
        ex.responseHeaders.set("X-Content-Type-Options", "nosniff")
        val method = ex.requestMethod
        val safe = method == "GET" || method == "HEAD" || method == "QUERY" // queries only: they cannot change data
        val refused = Guard.hostProblem(ex, options.allowedHosts) ?: if (safe) null else Guard.originProblem(ex, options.allowedOrigins)
        if (refused != null) {
            Guard.refuse(ex, 403, Code.PERMISSION_DENIED, refused)
            return true
        }
        val hit = matches.firstOrNull { it.first.method == method }
        if (hit == null) {
            ex.responseHeaders.set("Allow", matches.joinToString(", ") { it.first.method })
            problem(ex, 405, RayfoldException(Code.UNIMPLEMENTED, "$method is not bound on $path").toWire())
            return true
        }
        try {
            serve(ex, hit.first, hit.second)
        } catch (e: Guard.BodyTooLarge) {
            Guard.refuseBody(ex, e)
        } catch (e: Throwable) {
            val w = when (e) {
                // a request can only overflow the stack by nesting, which is the client's error
                is StackOverflowError -> RayfoldException(Code.INVALID_ARGUMENT, "Request is nested too deeply")
                else -> RayfoldException.of(e)
            }
            problem(ex, Guard.status(w.code), w.toWire())
        }
        return true
    }

    private fun serve(ex: HttpExchange, b: Binding, m: MatchResult) {
        val args = linkedMapOf<String, JsonElement>()
        b.params.forEachIndexed { i, name -> args[name] = fromText(b.op, name, decodePathSegment(m.groupValues[i + 1], name)) }
        val query = parseQuery(ex.requestURI.rawQuery)
        val shape = query.firstOrNull { it.first == "shape" }?.second
        if (b.method == "GET") for ((k, v) in query) if (k != "shape" && k !in args) args[k] = fromText(b.op, k, v)
        b.body?.let { bodyArg ->
            val raw = Guard.readBody(ex, options.maxBodyBytes)
            if (raw.isNotEmpty()) {
                val ct = Guard.mediaType(ex.requestHeaders.getFirst("Content-Type"))
                val accepted = if (b.method == "PATCH") listOf("application/merge-patch+json", "application/json") else listOf("application/json")
                if (ct !in accepted) {
                    Guard.refuse(ex, 415, Code.INVALID_ARGUMENT, "Content-Type ${ct.ifEmpty { "(none)" }} is not accepted; send ${accepted[0]}", "unsupported_media_type")
                    return
                }
                val parsed = StrictJson.parse(raw.toString(Charsets.UTF_8), "body", "Body is not valid JSON")
                if (bodyArg == "*") args.putAll(parsed as? JsonObject ?: throw RayfoldException(Code.INVALID_ARGUMENT, "Body must be a JSON object"))
                else args[bodyArg] = parsed
            }
        }
        val key = ex.requestHeaders.getFirst("Idempotency-Key")?.takeIf { it.isNotEmpty() }
        val ifMatch = ex.requestHeaders.getFirst("If-Match")?.takeIf { it.isNotEmpty() }
        val op = buildJsonObject {
            put("id", 1); put("op", b.op.name); put("args", JsonObject(args))
            if (!shape.isNullOrEmpty()) put("shape", shape)
            if (key != null) put("key", key)
            if (ifMatch != null) {
                val v = ifMatch.removePrefix("W/").removePrefix("\"").removeSuffix("\"")
                put("ifVersion", if (v.isNotEmpty() && v.all { it in '0'..'9' }) JsonPrimitive(v.toBigInteger()) else JsonPrimitive(v))
            }
        }
        if (b.op.kind == "command" && b.method == "POST" && key == null && b.op.annotations.find("idempotent")?.args?.get("value") != JsonPrimitive(false)) {
            throw RayfoldException(Code.INVALID_ARGUMENT, "POST ${b.path} requires an Idempotency-Key header (16-128 characters)")
        }
        val envelope = buildJsonObject { put("ops", JsonArray(listOf(op))) }
        val v = viewer(ex)
        val frames = runBlocking { server.collect(envelope, ExecuteOptions(v, keyOptional = b.method in IDEMPOTENT_METHODS)) }
        val folded = fold(frames)
        folded.error?.let { e ->
            val code = Code.entries.firstOrNull { it.wire == (e["code"] as? JsonPrimitive)?.content } ?: Code.INTERNAL
            problem(ex, if ((e["type"] as? JsonPrimitive)?.content == "VersionConflict") 412 else Guard.status(code), e)
            return
        }
        val result = folded.result
        if (b.op.kind == "query") {
            val etag = CacheHeaders.apply(server.ir, RequestEnvelope.from(envelope).ops, frames, v, ex.responseHeaders)
            if (ex.requestHeaders.getFirst("If-None-Match") == etag) {
                ex.responseHeaders.remove("X-Content-Type-Options") // no body to sniff; the cached response keeps its headers
                ex.sendResponseHeaders(304, -1)
                ex.close()
                return
            }
            return json(ex, 200, result)
        }
        ex.responseHeaders.set("Cache-Control", "no-store")
        versionOf(b.op, result)?.let { ex.responseHeaders.set("ETag", "\"$it\"") }
        if (folded.replay) ex.responseHeaders.set("Idempotent-Replayed", "true")
        if (b.method == "POST" && !b.location.isNullOrEmpty() && result is JsonObject) {
            ex.responseHeaders.set("Location", options.prefix + fillTemplate(b.location, result))
            return json(ex, 201, result)
        }
        json(ex, 200, result)
    }

    private class Folded(val result: JsonElement, val replay: Boolean, val error: JsonObject?)

    /** One result from the frames: `ok` or `data`, with deferred `at` frames folded in, or the first error. */
    private fun fold(frames: List<JsonObject>): Folded {
        var result: JsonElement = JsonNull
        var replay = false
        for (f in frames) {
            (f["error"] as? JsonObject)?.let { return Folded(JsonNull, false, it) }
            val at = (f["at"] as? JsonPrimitive)?.content
            val ok = f["ok"]
            val data = f["data"]
            when {
                ok != null -> {
                    result = ok
                    replay = ((f["meta"] as? JsonObject)?.get("replay") as? JsonPrimitive)?.content == "true"
                }
                data != null && at == null -> result = data
                data != null && at != null && (result is JsonObject || result is JsonArray) -> result = Live.mergeAt(result, at, data)
            }
        }
        return Folded(result, replay, null)
    }

    /** The `@version` field of the result entity, if the op returns one. */
    private fun versionOf(op: OpDef, result: JsonElement): String? {
        if (result !is JsonObject || op.returns.kind != "named") return null
        val def = server.ir.types[op.returns.name]?.takeIf { it.kind == "entity" } ?: return null
        val vf = def.fields.firstOrNull { it.annotations.find("version") != null } ?: return null
        return (result[vf.name] as? JsonPrimitive)?.content
    }

    /** RFC 9457 problem; typed Rayfold errors keep their `type`, `data` and `path` so REST clients can branch on them. */
    private fun problem(ex: HttpExchange, status: Int, e: JsonObject) {
        val code = (e["code"] as? JsonPrimitive)?.content ?: Code.INTERNAL.wire
        val type = (e["type"] as? JsonPrimitive)?.content
        val body = buildJsonObject {
            put("type", Guard.PROBLEM_TYPE_BASE + (type ?: code))
            put("title", type ?: code.replace('_', ' '))
            put("status", status)
            put("detail", (e["message"] as? JsonPrimitive)?.content ?: "")
            put("code", code)
            e["path"]?.let { put("path", it) }
            e["data"]?.let { put("data", it) }
        }.toString().toByteArray()
        ex.responseHeaders.set("Content-Type", "application/problem+json")
        ex.responseHeaders.set("Cache-Control", "no-store")
        ex.sendResponseHeaders(status, body.size.toLong())
        ex.responseBody.use { it.write(body) }
    }

    private fun json(ex: HttpExchange, status: Int, body: JsonElement) {
        val bytes = body.toString().toByteArray()
        ex.responseHeaders.set("Content-Type", "application/json; charset=utf-8")
        ex.sendResponseHeaders(status, bytes.size.toLong())
        ex.responseBody.use { it.write(bytes) }
    }

    internal companion object {
        /** Methods whose HTTP semantics are idempotent: a command bound to them may run without an Idempotency-Key. */
        val IDEMPOTENT_METHODS = setOf("PUT", "PATCH", "DELETE")
        val DECIMAL_TEXT = Regex("^-?\\d+(\\.\\d+)?$")
        val TEMPLATE = Regex("\\{([A-Za-z_][A-Za-z0-9_]*)\\}")

        /** Path and query-string values are text; they are coerced by the argument's declared type. */
        fun fromText(op: OpDef, name: String, text: String): JsonElement {
            val def = op.args.firstOrNull { it.name == name }
            if (def == null || def.type.kind != "named") return JsonPrimitive(text)
            return when (def.type.name) {
                "Int", "Float" -> if (DECIMAL_TEXT.matches(text)) JsonUnquotedLiteral(text) else JsonPrimitive(text)
                "Boolean" -> when (text) { "true" -> JsonPrimitive(true); "false" -> JsonPrimitive(false); else -> JsonPrimitive(text) }
                "ID", "String", "Decimal", "Date", "Instant" -> JsonPrimitive(text)
                else -> try {
                    StrictJson.parse(text, "query parameter $name", "not JSON")
                } catch (e: RayfoldException) {
                    JsonPrimitive(text)
                }
            }
        }

        /** decodeURIComponent: UTF-8 percent-escapes, strictly; `+` stays a plus. */
        fun decodePathSegment(raw: String, name: String): String {
            val bad = RayfoldException(Code.INVALID_ARGUMENT, "Path parameter $name is not valid percent-encoding")
            val bytes = ByteArrayOutputStream()
            var i = 0
            while (i < raw.length) {
                val c = raw[i]
                if (c == '%') {
                    if (i + 2 >= raw.length) throw bad
                    val hex = raw.substring(i + 1, i + 3).toIntOrNull(16) ?: throw bad
                    bytes.write(hex)
                    i += 3
                } else {
                    bytes.write(c.toString().toByteArray(Charsets.UTF_8))
                    i++
                }
            }
            return try {
                Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
            } catch (e: CharacterCodingException) {
                throw bad
            }
        }

        /** Query-string pairs in order, decoded as URLSearchParams does (`+` is a space). */
        fun parseQuery(raw: String?): List<Pair<String, String>> = (raw ?: "").split("&").filter { it.isNotEmpty() }.map { kv ->
            fun dec(s: String) = try {
                URLDecoder.decode(s, Charsets.UTF_8)
            } catch (e: IllegalArgumentException) {
                throw RayfoldException(Code.INVALID_ARGUMENT, "Query string is not valid percent-encoding")
            }
            dec(kv.substringBefore("=")) to dec(kv.substringAfter("=", ""))
        }

        fun fillTemplate(template: String, result: JsonObject): String = TEMPLATE.replace(template) { m ->
            val v = result[m.groupValues[1]]
            encodeUriComponent(when (v) { null, is JsonNull -> ""; is JsonPrimitive -> v.content; else -> v.toString() })
        }

        private const val UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"

        fun encodeUriComponent(s: String): String = buildString {
            for (byte in s.toByteArray(Charsets.UTF_8)) {
                val c = (byte.toInt() and 0xff)
                if (c < 0x80 && c.toChar() in UNRESERVED) append(c.toChar()) else append('%').append("%02X".format(c))
            }
        }
    }
}
