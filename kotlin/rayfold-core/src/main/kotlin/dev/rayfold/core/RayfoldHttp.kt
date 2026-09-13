package dev.rayfold.core

import com.sun.net.httpserver.HttpContext
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpHandler
import com.sun.net.httpserver.HttpServer
import com.sun.net.httpserver.HttpsExchange
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.Base64
import java.util.concurrent.Executor
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** What `GET {path}/manifest` serves: nothing (404), the IR without policy expressions, or the IR in full. */
enum class ManifestMode { OFF, REDACTED, FULL }

data class HttpOptions(
    /** Origins (such as `https://app.example`) allowed to send requests that can change data, besides the server's own. */
    val allowedOrigins: Set<String> = emptySet(),
    /**
     * Host names this server answers to. Null (the default) answers any host, except that a server reached on a
     * loopback address answers only `localhost`, `127.0.0.1` and `[::1]` (DNS rebinding, spec 12 section 2).
     */
    val allowedHosts: Set<String>? = null,
    val manifest: ManifestMode = ManifestMode.REDACTED,
    /** Worker threads. Reading requests and running batches never happens on the JDK server's accept thread. */
    val threads: Int = 16,
    val maxBodyBytes: Int = 1024 * 1024, // spec 12 section 3 default
    /**
     * Seconds a client gets to deliver its request line, headers and body before the connection is dropped, so a
     * slow-loris client cannot hold a worker. The JDK server reads `sun.net.httpserver.maxReqTime` once per JVM:
     * the first [RayfoldHttp.start] sets it unless it is already set, and a value given on the command line wins.
     *
     * Limitation: this is a JVM-wide bound, not a per-server one. The JDK server reads request headers before any
     * handler runs and offers no per-server or per-connection timeout, so a second [RayfoldHttp] with another value
     * gets the first one's. [RayfoldBindings] and [RayfoldMcp] mounted on the same server share it. [RayfoldWebSocket] owns
     * its sockets and bounds its handshake per listener ([WsOptions.handshakeTimeoutMs]).
     */
    val requestTimeoutSeconds: Long = 30,
    /**
     * When a whole interval of this many milliseconds passes without a frame, a streaming response gets a keep-alive:
     * an empty line, or a zero-length RB frame (spec 04 section 4). It keeps proxies from closing an idle live query, and the write is how the server
     * notices a client that went away: neither the JDK server nor a servlet container reports it otherwise.
     */
    val keepAliveMs: Long = 15_000,
    /**
     * Serve the explorer at `{path}/explorer` (see [RayfoldExplorer]). Off by default: the page reads whatever the
     * viewer's token allows, so it is served only where it is turned on, behind the application's own security.
     */
    val explorer: Boolean = false,
    /** Shown in the explorer's header, to tell one service from another. */
    val explorerTitle: String? = null,
)

/**
 * One HTTP exchange as any server sees it. [RayfoldHttp.serve] works on this, so the JDK server, a servlet
 * container or any other server only has to adapt its own request and response objects.
 */
interface HttpCall {
    val method: String

    /** The path, percent-decoded, without the query string. */
    val path: String
    val rawQuery: String?
    fun header(name: String): String?
    val body: InputStream

    /** True over HTTPS: the Origin check compares the scheme too. */
    val secure: Boolean

    /** The address the request arrived on, for the loopback Host rule; null when the server does not say. */
    val localAddress: InetAddress?
    fun setHeader(name: String, value: String)

    /** Sends the status and headers; [length] is the body size, or -1 when the body streams. Returns the body stream. */
    fun respond(status: Int, length: Long): OutputStream

    /** Ends the exchange early: the response has started, so it can no longer carry an error. */
    fun abort()
}

/**
 * HTTP transport (spec/04 section 4): POST/QUERY batches as NDJSON frames or RB (spec 09), GET /rayfold/{op}?a=&s=&v=
 * for single queries, cache headers and 304 on safe requests (spec 07), live queries on a streaming response kept alive
 * by keep-alives, /rayfold/manifest, RFC 9457 problem bodies. [start] runs it on the JDK's built-in server; [serve]
 * runs it inside any other server through an [HttpCall].
 */
class RayfoldHttp(
    private val server: RayfoldServer,
    private val options: HttpOptions = HttpOptions(),
    private val viewer: (HttpExchange) -> JsonElement = { JsonNull },
) {
    /** The viewer as the second argument, as before [HttpOptions] existed; `RayfoldHttp(server) { exchange -> ... }` still works. */
    constructor(server: RayfoldServer, viewer: (HttpExchange) -> JsonElement) : this(server, HttpOptions(), viewer)

    private val STATUS = mapOf(
        Code.INVALID_ARGUMENT to 400, Code.FAILED_PRECONDITION to 400, Code.OUT_OF_RANGE to 400, Code.UNAUTHENTICATED to 401,
        Code.PERMISSION_DENIED to 403, Code.NOT_FOUND to 404, Code.ALREADY_EXISTS to 409, Code.ABORTED to 409,
        Code.RESOURCE_EXHAUSTED to 429, Code.CANCELED to 499, Code.UNIMPLEMENTED to 501, Code.UNAVAILABLE to 503,
        Code.DEADLINE_EXCEEDED to 504, Code.DOMAIN to 422,
    )

    private val redacted by lazy { server.ir.withoutPolicies() }

    /** One page per mount path: the page carries the endpoint it talks to. */
    private val explorerPages = ConcurrentHashMap<String, String>()

    private val rb by lazy { RbCodec(server.ir) }

    /** `http` is listed when the schema binds REST-style routes. */
    private val extensions = listOf("live", "rb") + (if (server.ir.ops.values.any { o -> o.annotations.any { it.name == "http" } }) listOf("http") else emptyList())

    /** An HTTP-level refusal whose status or problem type has no protocol code of its own (415, 413). */
    private class HttpProblem(val status: Int, val code: Code, val detail: String, val type: String = code.wire) : RuntimeException(detail)

    /** Listens on loopback unless [host] says otherwise (pass "0.0.0.0" for every interface). */
    fun start(port: Int, path: String = "/rayfold", host: String = "127.0.0.1"): HttpServer {
        if (System.getProperty(MAX_REQ_TIME) == null) System.setProperty(MAX_REQ_TIME, options.requestTimeoutSeconds.toString())
        val n = AtomicInteger()
        val pool = ThreadPoolExecutor(options.threads, options.threads, 30, TimeUnit.SECONDS, LinkedBlockingQueue<Runnable>()) { r ->
            Thread(r, "rayfold-http-${n.incrementAndGet()}").apply { isDaemon = true }
        }
        pool.allowCoreThreadTimeOut(true)
        val http = HttpServer.create(InetSocketAddress(host, port), 0)
        http.executor = pool
        http.createContext(path) { ex -> handle(ex, path) }
        http.start()
        return Pooled(http, pool)
    }

    fun handle(ex: HttpExchange, base: String) = serve(JdkCall(ex), base) { viewer(ex) }

    /**
     * Serves one request under [base] (such as "/rayfold"). [viewer] is asked only after the request passed the Host,
     * Origin and content checks and parsed, just before the batch runs.
     */
    fun serve(call: HttpCall, base: String, viewer: () -> JsonElement) {
        call.setHeader("Rayfold-Schema", server.hash)
        call.setHeader("X-Content-Type-Options", "nosniff")
        var streaming = false
        try {
            Guard.hostProblem(call.header("Host"), call.localAddress, options.allowedHosts)?.let { throw HttpProblem(403, Code.PERMISSION_DENIED, it) }
            val path = call.path
            // servers match mounts by string prefix; `/rayfoldbook` is not `/rayfold/book`
            val sub = when {
                path == base -> ""
                path.startsWith("$base/") -> path.substring(base.length)
                else -> throw RayfoldException(Code.NOT_FOUND, "No route for ${call.method} $path")
            }
            checkOrigin(call)
            if (sub == "/manifest" && call.method == "GET") return manifest(call, path)
            if (sub == "/openapi.json" && call.method == "GET") return json(call, 200, OpenApi.document(server.ir))
            if (sub == "/explorer" && call.method == "GET") return explorer(call, base, path)
            val envelope: JsonObject
            var safe = false
            if (sub.isEmpty() || sub == "/") {
                if (call.method != "POST" && call.method != "QUERY") throw RayfoldException(Code.UNIMPLEMENTED, "Method ${call.method} not allowed on $base")
                val binary = checkContentType(call) == RbCodec.CONTENT_TYPE
                val body = readBody(call)
                envelope = if (binary) {
                    (try { rb.decode(body) } catch (e: RbException) { null }) as? JsonObject ?: throw RayfoldException(Code.INVALID_ARGUMENT, "Body is not valid RB")
                } else {
                    StrictJson.parse(body.toString(Charsets.UTF_8), "body", "Body is not valid JSON") as? JsonObject
                        ?: throw RayfoldException(Code.INVALID_ARGUMENT, "Body is not valid JSON")
                }
                safe = call.method == "QUERY" || call.header("Rayfold-Safe") == "true"
            } else if (call.method == "GET") {
                val q = (call.rawQuery ?: "").split("&").filter { it.isNotEmpty() }.associate { kv -> kv.substringBefore("=") to java.net.URLDecoder.decode(kv.substringAfter("=", ""), "UTF-8") }
                envelope = buildJsonObject {
                    put("ops", JsonArray(listOf(buildJsonObject {
                        put("id", 1); put("op", sub.removePrefix("/"))
                        q["a"]?.let { put("args", queryJson(it, "a")) }
                        q["s"]?.let { put("shape", it) }
                        q["v"]?.let { put("vars", queryJson(it, "v")) }
                    })))
                }
                safe = true
            } else throw RayfoldException(Code.NOT_FOUND, "No route for ${call.method} $path")

            val env = RequestEnvelope.from(withHeaderMeta(envelope, call))
            if (safe && env.ops.any { server.ir.ops[it.op]?.kind != "query" }) throw RayfoldException(Code.INVALID_ARGUMENT, "Safe requests (GET/QUERY) may only contain queries")
            val v = viewer()
            val opts = ExecuteOptions(v)
            val batch = withHeaderMeta(envelope, call)
            val accepted = (call.header("Accept") ?: "").split(",").map { it.substringBefore(';').trim().lowercase() }.toSet()
            val wantsRb = RbCodec.CONTENT_TYPE in accepted && accepted.none { it == FRAMES_TYPE || it == "application/json" || it == "application/rayfold+json" }
            val wantsSingle = !wantsRb && "application/json" in accepted && env.ops.size == 1
            if (wantsSingle || safe) {
                // buffered, so the status and the cache headers can come from the complete result
                val frames = runBlocking { server.collect(batch, opts) }
                val etag = if (safe) CacheHeaders.apply(server.ir, env.ops, frames, v, call::setHeader) else null
                if (etag != null && call.header("If-None-Match") == etag) return call.respond(304, 0).close()
                if (wantsSingle && frames.size == 1) {
                    val f = frames[0]
                    val status = (f["error"] as? JsonObject)?.let { e -> STATUS[Code.entries.first { it.wire == (e["code"] as JsonPrimitive).content }] ?: 500 } ?: 200
                    return json(call, status, f)
                }
                if (!safe) call.setHeader("Cache-Control", "no-store")
                return if (wantsRb) bytes(call, RbCodec.CONTENT_TYPE, rb.encodeFrames(frames)) else bytes(call, FRAMES_TYPE, ndjson(frames))
            }
            // frames leave one by one, so a long batch never sits in memory as one response and a live query stays open
            call.setHeader("Content-Type", if (wantsRb) RbCodec.CONTENT_TYPE else FRAMES_TYPE)
            call.setHeader("Cache-Control", "no-store")
            call.setHeader("X-Accel-Buffering", "no")
            val out = call.respond(200, -1)
            streaming = true
            out.use { stream(it, batch, opts, wantsRb) }
        } catch (e: Throwable) {
            if (streaming) { call.abort(); return } // the status line is gone; the client sees the stream end early
            problem(call, e)
        }
    }

    /**
     * A request that can change data and carries an Origin must come from this server's own origin or an allowed one
     * (CSRF). Safe requests are exempt: GET, QUERY, and POST with `Rayfold-Safe: true`, which may hold only queries. A
     * foreign page cannot send QUERY or Rayfold-Safe without a CORS preflight and cannot read the answer, and reads keep
     * working behind proxies that rewrite Host. A safe batch smuggling a command is refused by the safe-request rule.
     */
    private fun checkOrigin(call: HttpCall) {
        val m = call.method
        if (m == "GET" || m == "QUERY" || (m == "POST" && call.header("Rayfold-Safe") == "true")) return
        val origin = call.header("Origin") ?: return
        val scheme = if (call.secure) "https" else "http"
        val host = call.header("Host")
        if (host != null && origin.equals("$scheme://$host", ignoreCase = true)) return
        if (origin in options.allowedOrigins) return
        throw RayfoldException(Code.PERMISSION_DENIED, "Origin $origin is not allowed")
    }

    /** Only JSON or RB bodies: text/plain and form posts are what a cross-site page can send without a preflight. Returns the media type. */
    private fun checkContentType(call: HttpCall): String {
        val raw = call.header("Content-Type")
        val media = raw?.substringBefore(';')?.trim()?.lowercase()
        if (media == null || media !in BODY_TYPES) {
            throw HttpProblem(415, Code.INVALID_ARGUMENT, "Content-Type ${raw ?: "(none)"} is not accepted; send application/rayfold+json", "unsupported_media_type")
        }
        return media
    }

    private fun readBody(call: HttpCall): ByteArray {
        val max = options.maxBodyBytes
        fun tooLarge() = HttpProblem(413, Code.RESOURCE_EXHAUSTED, "Body exceeds $max bytes", "payload_too_large")
        val declared = call.header("Content-Length")?.toLongOrNull()
        if (declared != null && declared > max) throw tooLarge()
        val bytes = call.body.readNBytes(max + 1)
        if (bytes.size > max) throw tooLarge()
        return bytes
    }

    private fun manifest(call: HttpCall, path: String) {
        val ir = when (options.manifest) {
            ManifestMode.OFF -> throw RayfoldException(Code.NOT_FOUND, "No route for GET $path")
            ManifestMode.REDACTED -> redacted
            ManifestMode.FULL -> server.ir
        }
        json(call, 200, buildJsonObject {
            put("rayfold", "0.1"); put("extensions", JsonArray(extensions.map { JsonPrimitive(it) }))
            put("schema", RayfoldSchemaIR.json.encodeToJsonElement(RayfoldSchemaIR.serializer(), ir))
        })
    }

    /** The explorer page, configured for the path this server is mounted at. */
    private fun explorer(call: HttpCall, base: String, path: String) {
        if (!options.explorer) throw RayfoldException(Code.NOT_FOUND, "No route for GET $path")
        val bytes = explorerPages.computeIfAbsent(base) { RayfoldExplorer.page(it, options.explorerTitle ?: "Rayfold") }.toByteArray()
        call.setHeader("Content-Type", "text/html; charset=utf-8")
        call.setHeader("Cache-Control", "no-store") // it carries the endpoint it talks to
        call.respond(200, bytes.size.toLong()).use { it.write(bytes) }
    }

    private fun problem(call: HttpCall, e: Throwable) {
        val p = e as? HttpProblem ?: when (e) {
            // a request can only overflow the stack by nesting, which is the client's error, not the server's
            is StackOverflowError -> HttpProblem(400, Code.INVALID_ARGUMENT, "Request is nested too deeply")
            else -> RayfoldException.of(e).let { re -> HttpProblem(STATUS[re.code] ?: 500, re.code, re.message) }
        }
        val body = buildJsonObject {
            put("type", "https://rayfold.dev/errors/${p.type}"); put("title", p.type.replace('_', ' '))
            put("status", p.status); put("detail", p.detail); put("code", p.code.wire)
        }
        val bytes = body.toString().toByteArray()
        call.setHeader("Content-Type", "application/problem+json")
        call.setHeader("Cache-Control", "no-store")
        call.respond(p.status, bytes.size.toLong()).use { it.write(bytes) }
    }

    private fun queryJson(v: String, name: String): JsonElement {
        val invalid = "Query parameter $name is not base64url JSON"
        val text = try {
            String(Base64.getUrlDecoder().decode(v), Charsets.UTF_8)
        } catch (e: IllegalArgumentException) {
            throw RayfoldException(Code.INVALID_ARGUMENT, invalid)
        }
        return StrictJson.parse(text, "query parameter $name", invalid)
    }

    private fun json(call: HttpCall, status: Int, body: JsonElement) {
        val bytes = Canonical.json(body).toByteArray()
        call.setHeader("Content-Type", "application/json; charset=utf-8")
        call.respond(status, bytes.size.toLong()).use { it.write(bytes) }
    }

    /** `Rayfold-Client`, a numeric `Rayfold-Deadline`, and W3C `traceparent`/`tracestate` go into the envelope's meta (spec 04 section 4). */
    private fun withHeaderMeta(envelope: JsonObject, call: HttpCall): JsonObject {
        val client = call.header("Rayfold-Client")
        val deadline = call.header("Rayfold-Deadline")?.takeIf { d -> d.isNotEmpty() && d.all { it.isDigit() } }
        val traceparent = call.header("traceparent")
        if (client == null && deadline == null && traceparent == null) return envelope
        val meta = (envelope["meta"] as? JsonObject)?.toMutableMap() ?: mutableMapOf()
        client?.let { meta["client"] = JsonPrimitive(it) }
        deadline?.toLongOrNull()?.let { meta["deadline"] = JsonPrimitive(it) }
        if (traceparent != null) {
            meta["traceparent"] = JsonPrimitive(traceparent)
            call.header("tracestate")?.let { meta["tracestate"] = JsonPrimitive(it) }
        }
        return JsonObject(envelope + ("meta" to JsonObject(meta)))
    }

    private fun ndjson(frames: List<JsonObject>) = frames.joinToString("\n", postfix = "\n") { Canonical.json(it) }.toByteArray()

    private fun bytes(call: HttpCall, type: String, body: ByteArray) {
        call.setHeader("Content-Type", type)
        call.respond(200, body.size.toLong()).use { it.write(body) }
    }

    /**
     * Writes frames as they come, and a keep-alive after [HttpOptions.keepAliveMs] of silence. A write that fails means
     * the client left: it cancels the batch, which ends its live queries, and the caller aborts the exchange.
     */
    private fun stream(out: OutputStream, envelope: JsonObject, opts: ExecuteOptions, binary: Boolean) = runBlocking {
        val lock = Any()
        var quiet = true
        val keepAlive = launch {
            while (true) {
                delay(options.keepAliveMs)
                synchronized(lock) {
                    if (quiet) {
                        out.write(if (binary) KEEP_ALIVE_RB else KEEP_ALIVE_JSON)
                        out.flush()
                    }
                    quiet = true
                }
            }
        }
        try {
            server.execute(envelope, opts).collect { f ->
                synchronized(lock) {
                    out.write(if (binary) rb.encodeFrames(listOf(f)) else (Canonical.json(f) + "\n").toByteArray())
                    out.flush()
                    quiet = false
                }
            }
        } finally {
            keepAlive.cancel()
        }
    }

    /** The JDK server's exchange as an [HttpCall]. */
    private class JdkCall(private val ex: HttpExchange) : HttpCall {
        override val method: String get() = ex.requestMethod
        override val path: String get() = ex.requestURI.path
        override val rawQuery: String? get() = ex.requestURI.rawQuery
        override fun header(name: String): String? = ex.requestHeaders.getFirst(name)
        override val body: InputStream get() = ex.requestBody
        override val secure: Boolean get() = ex is HttpsExchange
        override val localAddress: InetAddress? get() = ex.localAddress?.address
        override fun setHeader(name: String, value: String) = ex.responseHeaders.set(name, value)

        // the JDK server takes 0 for a chunked body and -1 for none
        override fun respond(status: Int, length: Long): OutputStream {
            ex.sendResponseHeaders(status, if (length < 0) 0 else if (length == 0L) -1 else length)
            return ex.responseBody
        }

        override fun abort() = ex.close()
    }

    /** The JDK server plus its worker pool, which [stop] shuts down as well. */
    private class Pooled(private val http: HttpServer, private val pool: ThreadPoolExecutor) : HttpServer() {
        override fun bind(addr: InetSocketAddress?, backlog: Int) = http.bind(addr, backlog)
        override fun start() = http.start()
        override fun setExecutor(executor: Executor?) = http.setExecutor(executor)
        override fun getExecutor(): Executor? = http.executor
        override fun stop(delay: Int) {
            http.stop(delay)
            pool.shutdownNow()
        }
        override fun createContext(path: String?, handler: HttpHandler?): HttpContext = http.createContext(path, handler)
        override fun createContext(path: String?): HttpContext = http.createContext(path)
        override fun removeContext(path: String?) = http.removeContext(path)
        override fun removeContext(context: HttpContext?) = http.removeContext(context)
        override fun getAddress(): InetSocketAddress = http.address
    }

    private companion object {
        const val MAX_REQ_TIME = "sun.net.httpserver.maxReqTime"
        const val FRAMES_TYPE = "application/rayfold-frames+json"
        val BODY_TYPES = setOf("application/rayfold+json", "application/json", RbCodec.CONTENT_TYPE)
        val KEEP_ALIVE_JSON = byteArrayOf('\n'.code.toByte())
        val KEEP_ALIVE_RB = byteArrayOf(0)
    }
}
