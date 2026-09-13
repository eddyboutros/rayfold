package dev.rayfold.spring

import dev.rayfold.core.HttpCall
import dev.rayfold.core.RayfoldHttp
import kotlinx.serialization.json.JsonNull
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.autoconfigure.AutoConfigurations
import org.springframework.boot.test.context.runner.WebApplicationContextRunner
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress

/**
 * `rayfold.explorer.enabled` decides whether the explorer is served next to the endpoint. The property has to reach
 * the [dev.rayfold.core.HttpOptions] the starter builds, so this drives the real [RayfoldHttp] bean the way the
 * handler mapping does instead of reading the property back.
 */
class ExplorerPropertyTest {
    private val runner = WebApplicationContextRunner().withConfiguration(AutoConfigurations.of(RayfoldAutoConfiguration::class.java))

    /** One request as a servlet container hands it over, keeping the response for the assertions. */
    private class Recorded(override val path: String, override val method: String = "GET") : HttpCall {
        var status = 0
        val headers = mutableMapOf<String, String>()
        val written = ByteArrayOutputStream()
        override val rawQuery: String? = null
        override val body: InputStream = ByteArrayInputStream(ByteArray(0))
        override val secure: Boolean = false
        override val localAddress: InetAddress? = null
        // a container always delivers a Host; without one the endpoint refuses the request before it routes it
        override fun header(name: String): String? = if (name.equals("Host", ignoreCase = true)) "localhost" else null
        override fun setHeader(name: String, value: String) {
            headers[name.lowercase()] = value
        }

        override fun respond(status: Int, length: Long): OutputStream {
            this.status = status
            return written
        }

        override fun abort() {}

        val text: String get() = written.toByteArray().toString(Charsets.UTF_8)
    }

    private fun explorerRequest(vararg properties: String): Recorded {
        val call = Recorded("/rayfold/explorer")
        runner.withPropertyValues(*properties).run { ctx ->
            ctx.getBean(RayfoldHttp::class.java).serve(call, "/rayfold") { JsonNull }
        }
        return call
    }

    @Test
    fun `the property serves the explorer next to the endpoint`() {
        val call = explorerRequest("rayfold.explorer.enabled=true", "rayfold.explorer.title=Acme API")
        assertThat(call.status).isEqualTo(200)
        assertThat(call.headers["content-type"]).isEqualTo("text/html; charset=utf-8")
        assertThat(call.headers["cache-control"]).isEqualTo("no-store")
        assertThat(call.text).contains("Rayfold explorer").contains("Acme API")
    }

    @Test
    fun `guard - without the property nothing is served there`() {
        val call = explorerRequest()
        assertThat(call.status).isEqualTo(404)
        assertThat(call.text).doesNotContain("Rayfold explorer")
    }
}
