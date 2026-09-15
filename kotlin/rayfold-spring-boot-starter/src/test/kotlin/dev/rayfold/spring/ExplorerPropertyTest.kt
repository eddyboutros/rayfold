package dev.rayfold.spring

import dev.rayfold.core.RayfoldExplorer
import dev.rayfold.spring.properties.PropertiesApplication
import dev.rayfold.spring.properties.RunningApplication
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment
import org.springframework.test.annotation.DirtiesContext

/**
 * `rayfold.explorer.enabled` decides whether the explorer is served next to the endpoint. The property has to reach the
 * HttpOptions the starter builds and the handler mapping in front of it, so this starts the application on a real port
 * and fetches the page over HTTP.
 */
@SpringBootTest(
    classes = [PropertiesApplication::class],
    webEnvironment = WebEnvironment.RANDOM_PORT,
    properties = ["rayfold.explorer.enabled=true", "rayfold.explorer.title=Acme API"],
)
@DirtiesContext
class ExplorerPropertyTest : RunningApplication() {
    @Test
    fun `the property serves the explorer next to the endpoint`() {
        val res = send("GET", "/rayfold/explorer")
        assertThat(res.statusCode()).describedAs(res.body()).isEqualTo(200)
        assertThat(res.headers().firstValue("Content-Type")).hasValue("text/html;charset=utf-8")
        assertThat(res.headers().firstValue("Cache-Control")).hasValue("no-store")
        assertThat(res.body()).describedAs("the explorer page, for this endpoint and under its title")
            .contains("<title>Rayfold explorer</title>")
            .contains("""<script type="application/json" id="config">{"endpoint":"/rayfold","title":"Acme API"}</script>""")
        assertThat(res.body()).isEqualTo(RayfoldExplorer("/rayfold", "Acme API").html)
        assertThat(library.calls).isEmpty()
    }
}

/** The same application without the property. */
@SpringBootTest(classes = [PropertiesApplication::class], webEnvironment = WebEnvironment.RANDOM_PORT)
class ExplorerOffPropertyTest : RunningApplication() {
    @Test
    fun `guard - without the property nothing is served there`() {
        val res = send("GET", "/rayfold/explorer")
        assertThat(res.statusCode()).isEqualTo(404)
        assertThat(json(res.body())).isEqualTo(problem(404, "not_found", "No route for GET /rayfold/explorer", "not_found"))
    }
}
