package dev.rayfold.core

import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.net.InetAddress
import java.util.Base64
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * DNS rebinding and origin matching (spec 12 section 2; mirrors packages/server/src/guard.ts). [Guard] units, then the
 * Rayfold endpoint over real sockets: a loopback RayfoldHttp answers only loopback host names unless allowedHosts is set.
 * Bindings, MCP and WebSocket drive the same check in their own test classes.
 */
class HostGuardTest {
    private val fixture = Fixtures.load("core/03-pipelining.json")
    private val started = mutableListOf<HttpServer>()

    @AfterEach
    fun stop() = started.forEach { it.stop(0) }

    private fun serve(options: HttpOptions = HttpOptions()): Pair<Int, FixtureStore> {
        val store = FixtureStore(Fixtures.data(fixture))
        val http = RayfoldHttp(RayfoldServer(Fixtures.ir(fixture), FixtureResolvers.build(fixture, store)), options).start(0)
        started.add(http)
        return http.address.port to store
    }

    private val query = """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}"""
    private fun post(port: Int, host: String) = rawHttp(port, "POST /rayfold HTTP/1.1\r\nHost: $host\r\nContent-Type: application/rayfold+json\r\nContent-Length: ${query.length}\r\nConnection: close\r\n\r\n$query")
    private fun get(port: Int, path: String, host: String) = rawHttp(port, "GET $path HTTP/1.1\r\nHost: $host\r\nConnection: close\r\n\r\n")
    private fun refusal(detail: String) = buildJsonObject {
        put("type", "https://eddyboutros.github.io/rayfold/errors/permission_denied"); put("title", "permission denied"); put("status", 403); put("detail", detail); put("code", "permission_denied")
    }

    @Test
    fun `hostName lower-cases, drops the port and keeps IPv6 brackets`() {
        assertEquals("localhost", Guard.hostName("LocalHost:8080"))
        assertEquals("[::1]", Guard.hostName("[::1]:8080"))
        assertEquals("[::1]", Guard.hostName("[::1]"))
        assertEquals("example.com", Guard.hostName(" example.com "))
    }

    @Test
    fun `hostProblem refuses a foreign or missing Host on a loopback address, and a public address answers any host (guard)`() {
        val loopback = InetAddress.getByName("127.0.0.1")
        assertEquals("Host evil.example is not allowed on a loopback server", Guard.hostProblem("evil.example", loopback, null))
        assertEquals("Missing Host header", Guard.hostProblem(null, loopback, null))
        for (h in listOf("localhost", "127.0.0.1:1", "[::1]:9")) assertNull(Guard.hostProblem(h, loopback, null), h)
        assertNull(Guard.hostProblem("evil.example", InetAddress.getByName("10.1.2.3"), null), "guard: DNS rebinding targets loopback servers only")
        assertNull(Guard.hostProblem("api.example:443", loopback, setOf("api.example")), "an explicit list replaces the loopback rule")
        assertEquals("Host localhost is not allowed", Guard.hostProblem("localhost", loopback, setOf("api.example")))
    }

    @Test
    fun `originProblem - the same host and port is the server's own origin, anything else must be allowed`() {
        assertNull(Guard.originProblem(null, "a.com", emptySet()), "non-browser clients send no Origin")
        assertNull(Guard.originProblem("http://a.com", "a.com", emptySet()))
        assertNull(Guard.originProblem("http://a.com:80", "a.com", emptySet()), "the default port is left out, as URL.host does")
        assertNull(Guard.originProblem("http://A.com:8080", "a.com:8080", emptySet()))
        assertEquals("Origin http://a.com:8080 is not allowed", Guard.originProblem("http://a.com:8080", "a.com", emptySet()))
        assertEquals("Origin null is not allowed", Guard.originProblem("null", "a.com", emptySet()))
        assertEquals("Origin http:// is not allowed", Guard.originProblem("http://", "a.com", emptySet()))
        assertNull(Guard.originProblem("https://app.example", "a.com", setOf("https://app.example")))
        assertNull(Guard.originProblem("https://evil.example", "a.com", setOf("*")))
    }

    @Test
    fun `a loopback RayfoldHttp refuses a foreign Host with 403 before routing, on every route, and nothing runs`() {
        val (port, store) = serve()
        val refused = listOf(
            post(port, "evil.example") to "Host evil.example is not allowed on a loopback server",
            get(port, "/rayfold/manifest", "evil.example:$port") to "Host evil.example:$port is not allowed on a loopback server",
            get(port, "/rayfold/openapi.json", "evil.example") to "Host evil.example is not allowed on a loopback server",
            get(port, "/rayfold/nope", "evil.example") to "Host evil.example is not allowed on a loopback server",
        )
        for ((res, detail) in refused) {
            assertEquals(403, res.status, res.head)
            assertEquals("application/problem+json", res.header("Content-Type"))
            assertEquals("nosniff", res.header("X-Content-Type-Options"))
            assertEquals("no-store", res.header("Cache-Control"))
            assertEquals(refusal(detail), Json.parseToJsonElement(res.body))
        }
        assertEquals(emptyMap(), store.calls.toMap())
    }

    @Test
    fun `an HTTP 1-1 request without a Host header is refused with 403 before anything runs (guard - the same request with one is answered)`() {
        val (port, store) = serve()
        // a single query answered as one JSON document, so the raw body is exactly the frame
        val target = "/rayfold/book?a=${Base64.getUrlEncoder().withoutPadding().encodeToString("""{"id":"b1"}""".toByteArray())}&s=%7B+id+%7D"
        val bare = rawHttp(port, "GET $target HTTP/1.1\r\nAccept: application/json\r\nConnection: close\r\n\r\n")
        assertEquals(403, bare.status, bare.head)
        assertEquals("application/problem+json", bare.header("Content-Type"))
        assertEquals(refusal("Missing Host header"), Json.parseToJsonElement(bare.body))
        assertEquals(emptyMap(), store.calls.toMap())
        val hosted = rawHttp(port, "GET $target HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nAccept: application/json\r\nConnection: close\r\n\r\n")
        assertEquals(200, hosted.status, hosted.head)
        assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1"},"meta":{"cost":1},"fin":true}"""), obj(hosted.body))
        assertEquals(mapOf("Query.book" to 1), store.calls.toMap())
    }

    @Test
    fun `guard - loopback host names are answered, and allowedHosts replaces the loopback rule`() {
        val (port, store) = serve()
        for (host in listOf("127.0.0.1:$port", "localhost", "[::1]:$port")) assertEquals(200, post(port, host).status, host)
        assertEquals(3, store.calls["Query.book"])
        val (listed, _) = serve(HttpOptions(allowedHosts = setOf("api.example")))
        assertEquals(200, post(listed, "api.example").status)
        assertEquals(refusal("Host localhost is not allowed"), Json.parseToJsonElement(post(listed, "localhost").body))
    }
}
