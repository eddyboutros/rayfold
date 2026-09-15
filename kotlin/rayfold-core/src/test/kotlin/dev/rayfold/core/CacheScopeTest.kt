package dev.rayfold.core

import com.sun.net.httpserver.HttpServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlin.test.assertEquals

/**
 * Whether a safe response may sit in a shared cache (spec 07 section 2). A policy that reads the viewer makes it private
 * even for an anonymous caller, since another viewer could be answered differently; a policy that reads only the row
 * leaves it public. Driven through both callers of [CacheHeaders], RayfoldHttp's safe requests and RayfoldBindings' GET
 * routes, with type, field and op policies. Every request here is anonymous, so the policies alone decide.
 */
class CacheScopeTest {
    private val schema = """
        entity Notice @cache(maxAge: 60s, scope: public) @allow(read: viewer.role != "banned") { id: ID title: String }
        entity Bulletin @cache(maxAge: 60s, scope: public) @allow(read: published) {
          id: ID
          title: String
          published: Boolean
          memo: String @allow(read: viewer.role != "banned")
        }
        query notice(id: ID): Notice? @http(method: GET, path: "/notices/{id}")
        query bulletin(id: ID): Bulletin? @http(method: GET, path: "/bulletins/{id}")
        query pinned: Bulletin? @allow(read: viewer.role != "banned") @http(method: GET, path: "/pinned")
    """.trimIndent()

    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val started = mutableListOf<HttpServer>()
    private val calls = ConcurrentHashMap<String, Int>()

    @AfterEach
    fun stop() {
        started.forEach { it.stop(0) }
        client.shutdownNow()
    }

    private val noticeRow = obj("""{"id":"n1","title":"Closed on Monday"}""")
    private val bulletinRow = obj("""{"id":"b1","title":"Spring fair","published":true,"memo":"Bring chairs"}""")

    private fun server() = RayfoldServer(
        SchemaText.load(schema).ir,
        Resolvers(
            queries = mapOf(
                "notice" to { _, _ -> calls.merge("notice", 1, Int::plus); noticeRow },
                "bulletin" to { _, _ -> calls.merge("bulletin", 1, Int::plus); bulletinRow },
                "pinned" to { _, _ -> calls.merge("pinned", 1, Int::plus); bulletinRow },
            ),
        ),
    )

    private fun get(url: String): HttpResponse<String> =
        client.send(HttpRequest.newBuilder(URI(url)).timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofString())

    private fun enc(s: String) = URLEncoder.encode(s, Charsets.UTF_8)

    /** `GET /rayfold/{op}?a=&s=` on a RayfoldHttp at [port]: a single safe read, as a browser caches it. */
    private fun read(port: Int, op: String, args: String, shape: String): HttpResponse<String> =
        get("http://127.0.0.1:$port/rayfold/$op?a=${Base64.getUrlEncoder().withoutPadding().encodeToString(args.toByteArray())}&s=${enc(shape)}")

    private fun HttpResponse<String>.cacheControl(): String? = headers().firstValue("Cache-Control").orElse(null)

    private fun httpPort(): Int = RayfoldHttp(server()).start(0).also { started.add(it) }.address.port

    @Test
    fun `over RayfoldHttp, a type policy that reads the viewer makes an anonymous read private, and one that reads only the row leaves it public`() {
        val port = httpPort()
        val personal = read(port, "notice", """{"id":"n1"}""", "{ id title }")
        assertEquals(200, personal.statusCode(), personal.body())
        assertEquals("private, max-age=60", personal.cacheControl())
        assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Notice","id":"n1","title":"Closed on Monday"},"meta":{"cost":1},"fin":true}"""), obj(personal.body().trim()))

        val shared = read(port, "bulletin", """{"id":"b1"}""", "{ id title }")
        assertEquals(200, shared.statusCode(), shared.body())
        assertEquals("public, max-age=60", shared.cacheControl())
        assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Bulletin","id":"b1","title":"Spring fair"},"meta":{"cost":1},"fin":true}"""), obj(shared.body().trim()))
        assertEquals(mapOf("notice" to 1, "bulletin" to 1), calls.toMap())
    }

    @Test
    fun `over RayfoldHttp, a field policy that reads the viewer counts only when its field is in the response, and an op policy always counts`() {
        val port = httpPort()
        val memo = read(port, "bulletin", """{"id":"b1"}""", "{ id memo }")
        assertEquals("private, max-age=60", memo.cacheControl())
        assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Bulletin","id":"b1","memo":"Bring chairs"},"meta":{"cost":1},"fin":true}"""), obj(memo.body().trim()))
        assertEquals("public, max-age=60", read(port, "bulletin", """{"id":"b1"}""", "{ id title }").cacheControl(), "guard: the same type without that field")
        assertEquals("private, max-age=60", read(port, "pinned", "{}", "{ id title }").cacheControl())
        assertEquals(mapOf("bulletin" to 2, "pinned" to 1), calls.toMap())
    }

    @Test
    fun `over RayfoldBindings, the same policies decide the scope of a GET route`() {
        val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        RayfoldBindings(server()).mount(http)
        http.start()
        started.add(http)
        val base = "http://127.0.0.1:${http.address.port}"

        val notice = get("$base/notices/n1")
        assertEquals(200, notice.statusCode(), notice.body())
        assertEquals("private, max-age=60", notice.cacheControl())
        assertEquals(obj("""{"${'$'}type":"Notice","id":"n1","title":"Closed on Monday"}"""), obj(notice.body()))

        val titled = get("$base/bulletins/b1?shape=${enc("{ id title }")}")
        assertEquals("public, max-age=60", titled.cacheControl(), "guard: a row policy alone")
        assertEquals(obj("""{"${'$'}type":"Bulletin","id":"b1","title":"Spring fair"}"""), obj(titled.body()))

        // the default view selects every scalar field, the viewer-guarded memo among them
        val whole = get("$base/bulletins/b1")
        assertEquals("private, max-age=60", whole.cacheControl())
        assertEquals(obj("""{"${'$'}type":"Bulletin","id":"b1","title":"Spring fair","published":true,"memo":"Bring chairs"}"""), obj(whole.body()))

        assertEquals("private, max-age=60", get("$base/pinned?shape=${enc("{ id title }")}").cacheControl())
        assertEquals(mapOf("notice" to 1, "bulletin" to 2, "pinned" to 1), calls.toMap())
    }
}
