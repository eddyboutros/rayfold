package dev.rayfold.core

import com.sun.net.httpserver.HttpExchange
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.InputStream
import java.net.InetAddress
import java.net.URI

/**
 * Checks every HTTP entry point applies before doing any work (spec 12 section 2; mirrors packages/server/src/guard.ts).
 * - Host: a server reached on a loopback address answers only loopback host names. This defeats DNS rebinding, where
 *   a web page renames its own domain to 127.0.0.1 and reads or drives a local server as if same-origin.
 * - Origin: a state-changing request sent by a browser from another origin is refused unless that origin is allowed.
 *   Together with JSON-only content types this stops cross-site request forgery.
 */
object Guard {
    private val LOOPBACK_NAMES = setOf("localhost", "127.0.0.1", "[::1]")

    /** Status per error code (spec 05 section 3). */
    fun status(code: Code): Int = when (code) {
        Code.INVALID_ARGUMENT, Code.FAILED_PRECONDITION, Code.OUT_OF_RANGE -> 400
        Code.UNAUTHENTICATED -> 401
        Code.PERMISSION_DENIED -> 403
        Code.NOT_FOUND -> 404
        Code.ALREADY_EXISTS, Code.ABORTED -> 409
        Code.RESOURCE_EXHAUSTED -> 429
        Code.CANCELED -> 499
        Code.UNIMPLEMENTED -> 501
        Code.UNAVAILABLE -> 503
        Code.DEADLINE_EXCEEDED -> 504
        Code.DOMAIN -> 422
        Code.UNKNOWN, Code.INTERNAL, Code.DATA_LOSS -> 500
    }

    /** The host name of a Host header, lower-cased, without the port; an IPv6 literal keeps its brackets. */
    fun hostName(host: String): String {
        val h = host.trim().lowercase()
        if (h.startsWith("[")) return h.substring(0, h.indexOf(']') + 1)
        val i = h.lastIndexOf(':')
        return if (i >= 0) h.substring(0, i) else h
    }

    /**
     * Null when the Host header is acceptable, otherwise the reason. [local] is the address the request arrived on;
     * [allowedHosts], when given, replaces the loopback rule with an explicit list.
     */
    fun hostProblem(host: String?, local: InetAddress?, allowedHosts: Set<String>?): String? {
        if (host == null) return "Missing Host header"
        val name = hostName(host)
        if (allowedHosts != null) return if (name in allowedHosts || host.lowercase() in allowedHosts) null else "Host $host is not allowed"
        if (local != null && local.isLoopbackAddress && name !in LOOPBACK_NAMES) return "Host $host is not allowed on a loopback server"
        return null
    }

    fun hostProblem(ex: HttpExchange, allowedHosts: Set<String>?): String? =
        hostProblem(ex.requestHeaders.getFirst("Host"), ex.localAddress?.address, allowedHosts)

    /**
     * Null when the request is not a cross-origin browser request, or its origin is allowed; otherwise the reason.
     * Same origin means the origin's host[:port] equals the Host header, as `new URL(origin).host` does in the TS guard.
     */
    fun originProblem(origin: String?, host: String?, allowedOrigins: Set<String>): String? {
        if (origin == null) return null // browsers send Origin on every state-changing request; other clients need not
        if ("*" in allowedOrigins || origin in allowedOrigins) return null
        if (host != null && originHost(origin) == host.lowercase()) return null // same origin (Host is checked on its own)
        return "Origin $origin is not allowed"
    }

    fun originProblem(ex: HttpExchange, allowedOrigins: Set<String>): String? =
        originProblem(ex.requestHeaders.getFirst("Origin"), ex.requestHeaders.getFirst("Host"), allowedOrigins)

    /** `host[:port]` of an origin with the scheme's default port left out; null for "null" and malformed origins. */
    private fun originHost(origin: String): String? {
        val u = try { URI(origin) } catch (e: Exception) { return null }
        val scheme = u.scheme?.lowercase() ?: return null
        val host = u.host?.lowercase() ?: return null
        val default = when (scheme) { "http", "ws" -> 80; "https", "wss" -> 443; else -> -1 }
        return if (u.port == -1 || u.port == default) host else "$host:${u.port}"
    }

    /** The media type of a Content-Type header, lower-cased, without parameters. */
    fun mediaType(contentType: String?): String = (contentType ?: "").substringBefore(';').trim().lowercase()

    /** A request body over the transport's limit. Answered 413 Content Too Large, never 429: retrying cannot help. */
    class BodyTooLarge(val max: Int) : RuntimeException("Body exceeds $max bytes")

    /** How much of an over-limit body is drained (so the refusal can be read) before the connection is dropped. */
    private const val DRAIN_LIMIT = 1024 * 1024

    /**
     * Reads at most [max] bytes. Over the limit it drains up to [DRAIN_LIMIT] more, so the 413 reaches a client that
     * is still sending, then throws [BodyTooLarge]; the JDK server closes a connection whose body was not read to the end.
     */
    fun readBody(ex: HttpExchange, max: Int): ByteArray {
        val input = ex.requestBody
        val declared = ex.requestHeaders.getFirst("Content-Length")?.toLongOrNull()
        if (declared != null && declared > max) {
            if (declared <= max.toLong() + DRAIN_LIMIT) drain(input, declared)
            throw BodyTooLarge(max)
        }
        val bytes = input.readNBytes(max + 1)
        if (bytes.size > max) {
            drain(input, DRAIN_LIMIT.toLong())
            throw BodyTooLarge(max)
        }
        return bytes
    }

    // Read, never skip: the JDK's fixed-length body stream counts only the bytes that pass through read(). skip() goes
    // straight to the socket, so the stream still expects bytes that are gone and the exchange is left out of step.
    private fun drain(input: InputStream, limit: Long) {
        val sink = ByteArray(16 * 1024)
        var drained = 0L
        while (drained < limit) {
            val n = input.read(sink, 0, minOf(sink.size.toLong(), limit - drained).toInt())
            if (n < 0) break
            drained += n
        }
    }

    /** Where an RFC 9457 `type` points: the documentation site has a page for each problem type. */
    const val PROBLEM_TYPE_BASE = "https://eddyboutros.github.io/rayfold/errors/"

    /** An RFC 9457 refusal written before any operation ran. */
    fun refuse(ex: HttpExchange, status: Int, code: Code, detail: String, problemType: String = code.wire, headers: Map<String, String> = emptyMap()) {
        val body = buildJsonObject {
            put("type", PROBLEM_TYPE_BASE + problemType); put("title", problemType.replace('_', ' '))
            put("status", status); put("detail", detail); put("code", code.wire)
        }.toString().toByteArray()
        ex.responseHeaders.set("Content-Type", "application/problem+json")
        ex.responseHeaders.set("Cache-Control", "no-store")
        ex.responseHeaders.set("X-Content-Type-Options", "nosniff")
        for ((k, v) in headers) ex.responseHeaders.set(k, v)
        ex.sendResponseHeaders(status, body.size.toLong())
        ex.responseBody.use { it.write(body) }
    }

    fun refuseBody(ex: HttpExchange, e: BodyTooLarge) = refuse(ex, 413, Code.RESOURCE_EXHAUSTED, e.message ?: "Body too large", "payload_too_large")
}
