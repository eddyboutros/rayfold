package dev.rayfold.spring

import dev.rayfold.spring.properties.PropertiesApplication
import dev.rayfold.spring.properties.RunningApplication
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment
import org.springframework.test.annotation.DirtiesContext

/**
 * Spec 04 section 4b through the starter's own endpoint: the servlet container and Spring's handler mapping sit in
 * front of RayfoldHttp, and either could answer a preflight itself, without the headers an allowed origin needs.
 */
@SpringBootTest(
    classes = [PropertiesApplication::class],
    webEnvironment = WebEnvironment.RANDOM_PORT,
    properties = ["rayfold.schema=classpath:schema.rayfold", "rayfold.allowed-origins=https://app.example"],
)
@DirtiesContext
class CorsPreflightTest : RunningApplication() {
    private fun preflight(origin: String) =
        send("OPTIONS", "/rayfold", headers = mapOf("Origin" to origin, "Access-Control-Request-Method" to "POST", "Access-Control-Request-Headers" to "content-type"))

    @Test
    fun `a preflight from an allowed origin is answered 204 with the headers that let it through`() {
        val res = preflight("https://app.example")
        assertThat(res.statusCode()).isEqualTo(204)
        assertThat(res.headers().firstValue("Access-Control-Allow-Origin")).hasValue("https://app.example")
        assertThat(res.headers().firstValue("Access-Control-Allow-Methods")).hasValue("GET, POST, QUERY, OPTIONS")
        assertThat(res.headers().firstValue("Access-Control-Allow-Headers"))
            .hasValue("Content-Type, Authorization, Rayfold-Client, Rayfold-Deadline, Rayfold-Safe, Rayfold-Upload-Name, Rayfold-Upload-Type")
    }

    @Test
    fun `guard - a preflight from another origin gets no Access-Control-Allow-Origin, so the browser stops there`() {
        val res = preflight("https://evil.example")
        assertThat(res.headers().firstValue("Access-Control-Allow-Origin")).isEmpty()
    }
}
