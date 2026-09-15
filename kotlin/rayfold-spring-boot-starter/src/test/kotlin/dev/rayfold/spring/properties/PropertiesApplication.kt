package dev.rayfold.spring.properties

import dev.rayfold.spring.Arg
import dev.rayfold.spring.RayfoldQuery
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.context.annotation.Bean
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.web.SecurityFilterChain
import org.springframework.stereotype.Component
import java.net.Socket
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

/**
 * The application the `rayfold.*` property tests start on a real port, each test class with its own properties. It
 * reads `classpath:properties.rayfold` unless a test says otherwise.
 */
@SpringBootApplication(proxyBeanMethods = false)
class PropertiesApplication {
    /** Rayfold guards its endpoint against CSRF itself, wherever `rayfold.path` puts it, and nothing else is served here. */
    @Bean
    fun security(http: HttpSecurity): SecurityFilterChain = http.authorizeHttpRequests { it.anyRequest().permitAll() }.csrf { it.disable() }.build()
}

/** The resolvers behind the property tests, counting their runs so a test can say that nothing ran. */
@Component
class Library {
    private val runs = ConcurrentHashMap<String, Int>()

    val calls: Map<String, Int> get() = runs.toMap()

    fun reset() = runs.clear()

    @RayfoldQuery("book")
    fun book(@Arg("id") id: String): Map<String, Any?>? {
        runs.merge("book", 1, Int::plus)
        return BOOKS[id]
    }

    @RayfoldQuery("secret")
    fun secret(@Arg("id") id: String): Map<String, Any?> {
        runs.merge("secret", 1, Int::plus)
        return mapOf("id" to id, "note" to "classified")
    }

    private companion object {
        val BOOKS = mapOf("b1" to mapOf("id" to "b1", "title" to "The Dispossessed", "author" to mapOf("id" to "a1", "name" to "Ursula K. Le Guin")))
    }
}

/** A test against the running [PropertiesApplication]: its port, its resolvers, and an HTTP client closed after each test. */
abstract class RunningApplication {
    @field:Value("\${local.server.port}")
    var port: Int = 0

    @field:Autowired
    lateinit var library: Library

    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

    @BeforeEach
    fun resetLibrary() = library.reset()

    @AfterEach
    fun closeClient() = client.shutdownNow()

    fun send(method: String, path: String, body: String? = null, headers: Map<String, String> = emptyMap()): HttpResponse<String> {
        val b = HttpRequest.newBuilder(URI("http://127.0.0.1:$port$path")).timeout(Duration.ofSeconds(5))
            .method(method, if (body == null) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(body))
        for ((k, v) in headers) b.header(k, v)
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString())
    }

    fun batch(body: String, path: String = "/rayfold"): HttpResponse<String> = send("POST", path, body, mapOf("Content-Type" to "application/rayfold+json"))

    /** The NDJSON frames of a 200 response. */
    fun frames(res: HttpResponse<String>): List<JsonElement> {
        assertThat(res.statusCode()).describedAs(res.body()).isEqualTo(200)
        return res.body().lines().filter { it.isNotBlank() }.map { Json.parseToJsonElement(it) }
    }

    fun json(text: String): JsonElement = Json.parseToJsonElement(text)

    fun problem(status: Int, type: String, detail: String, code: String): JsonElement =
        json("""{"type":"https://eddyboutros.github.io/rayfold/errors/$type","title":"${type.replace('_', ' ')}","status":$status,"detail":"$detail","code":"$code"}""")

    /** `{base}/book?a=&s=` for book b1: the single-query GET route. */
    fun bookPath(base: String, shape: String): String =
        "$base/book?a=${Base64.getUrlEncoder().withoutPadding().encodeToString("""{"id":"b1"}""".toByteArray())}&s=${URLEncoder.encode(shape, Charsets.UTF_8)}"

    class Raw(val status: Int, val head: String, val body: String)

    /** A raw HTTP/1.1 exchange that should say `Connection: close`, for a Host header the JDK client will not send. */
    fun raw(request: String): Raw = Socket("127.0.0.1", port).use { s ->
        s.soTimeout = 5_000
        s.getOutputStream().apply { write(request.toByteArray()); flush() }
        val text = s.getInputStream().readAllBytes().toString(Charsets.UTF_8)
        val end = text.indexOf("\r\n\r\n")
        val head = if (end < 0) text else text.substring(0, end)
        Raw(head.substringAfter(' ').substringBefore(' ').toIntOrNull() ?: 0, head, if (end < 0) "" else text.substring(end + 4))
    }
}
