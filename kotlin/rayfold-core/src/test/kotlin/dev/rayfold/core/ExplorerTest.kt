package dev.rayfold.core

import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The explorer as a server serves it: off unless it is turned on, configured for the path it is mounted at, mountable
 * on a server of its own, and carrying nothing it would have to fetch from elsewhere. Every call is bounded at 5 s so
 * a hung exchange fails the test instead of the build.
 */
class ExplorerTest {
    private val fixture = Fixtures.load("core/03-pipelining.json")
    private val ir = Fixtures.ir(fixture)
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val started = mutableListOf<HttpServer>()

    @AfterEach
    fun stop() {
        started.forEach { it.stop(0) }
        client.shutdownNow()
    }

    private fun serve(options: HttpOptions, path: String = "/rayfold"): Int {
        val store = FixtureStore(Fixtures.data(fixture))
        val http = RayfoldHttp(RayfoldServer(ir, FixtureResolvers.build(fixture, store)), options).start(0, path)
        started.add(http)
        return http.address.port
    }

    private fun get(port: Int, path: String, method: String = "GET"): HttpResponse<String> =
        client.send(
            HttpRequest.newBuilder(URI.create("http://127.0.0.1:$port$path"))
                .method(method, HttpRequest.BodyPublishers.noBody())
                .timeout(Duration.ofSeconds(5))
                .build(),
            HttpResponse.BodyHandlers.ofString(),
        )

    @Test
    fun `the explorer is not served unless it is turned on`() {
        assertEquals(404, get(serve(HttpOptions()), "/rayfold/explorer").statusCode())
    }

    @Test
    fun `turned on, it is served next to the endpoint`() {
        val res = get(serve(HttpOptions(explorer = true)), "/rayfold/explorer")
        assertEquals(200, res.statusCode())
        assertEquals("text/html; charset=utf-8", res.headers().firstValue("content-type").orElse(""))
        assertEquals("no-store", res.headers().firstValue("cache-control").orElse(""))
        assertTrue(res.body().contains("Rayfold explorer"), "the page itself")
    }

    @Test
    fun `the page is configured for the path the endpoint is mounted at`() {
        val res = get(serve(HttpOptions(explorer = true, explorerTitle = "Acme API"), "/api"), "/api/explorer")
        assertEquals(200, res.statusCode())
        assertTrue(res.body().contains("\"endpoint\":\"/api\""), "it sends its batches where the endpoint is")
        assertTrue(res.body().contains("\"title\":\"Acme API\""), "the title it was given")
    }

    @Test
    fun `a title cannot break out of the configuration it is written into`() {
        val page = RayfoldExplorer.page("/rayfold", "</script><script>alert(1)</script>")
        assertFalse(page.contains("</script><script>alert(1)"), "never closes the element it sits in")
        assertTrue(page.contains("\\u003c/script>"), "escaped, so the browser reads it as text")
    }

    @Test
    fun `it mounts on a server of its own, without the endpoint in front of it`() {
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        RayfoldExplorer(endpoint = "/rayfold", title = "Own server").mount(http)
        http.start()
        started.add(http)

        val res = get(http.address.port, "/rayfold/explorer")
        assertEquals(200, res.statusCode())
        assertTrue(res.body().contains("\"title\":\"Own server\""))

        val posted = get(http.address.port, "/rayfold/explorer", method = "POST")
        assertEquals(405, posted.statusCode())
        assertEquals("GET", posted.headers().firstValue("allow").orElse(""))
    }

    @Test
    fun `it loads nothing from anywhere else, so it works behind a strict policy and offline`() {
        val page = RayfoldExplorer().html
        assertFalse(Regex("https?://").containsMatchIn(page), "no font, script or style from another origin")
        assertFalse(Regex("\\ssrc=\"(?!data:)").containsMatchIn(page), "nothing is fetched")
    }
}
