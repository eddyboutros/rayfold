package dev.rayfold.spring

import dev.rayfold.core.BatchOptions
import dev.rayfold.core.RayfoldSchemaIR
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.SchemaText
import dev.rayfold.spring.properties.PropertiesApplication
import dev.rayfold.spring.properties.RunningApplication
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment
import org.springframework.test.annotation.DirtiesContext
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import java.nio.file.Files
import java.nio.file.Path

// Each `rayfold.*` property reaches the running application: every class starts it on a real port with one property
// set, drives it over HTTP, and closes it afterwards. Each refusal has a guard in its class showing that the property
// narrows what is served rather than turning the endpoint off.

private const val BOOK_TITLE = """{"id":1,"data":{"${'$'}type":"Book","id":"b1","title":"The Dispossessed"},"meta":{"cost":1},"fin":true}"""
private const val BOOK_ID = """{"id":1,"data":{"${'$'}type":"Book","id":"b1"},"meta":{"cost":1},"fin":true}"""

/** What `GET {path}/manifest` serves for [ir]. */
private fun manifestOf(ir: RayfoldSchemaIR): JsonObject = buildJsonObject {
    put("rayfold", "0.1")
    put("schemaHash", SchemaText.hash(ir))
    put("extensions", JsonArray(listOf(JsonPrimitive("live"), JsonPrimitive("rb"))))
    put(
        "limits",
        buildJsonObject {
            val d = BatchOptions()
            put("budget", d.budget); put("maxOps", d.maxOps); put("maxDepth", d.maxDepth)
            put("maxFields", d.maxFields); put("trustedShapes", d.trustedShapes)
        },
    )
    put("schema", RayfoldSchemaIR.json.encodeToJsonElement(RayfoldSchemaIR.serializer(), ir))
}

/** [json] with the value at [path] replaced by [value]. */
private fun replaced(json: JsonElement, path: List<String>, value: JsonElement): JsonElement {
    if (path.isEmpty()) return value
    val obj = json as? JsonObject ?: error("no object at ${path.first()}")
    val child = obj[path.first()] ?: error("no ${path.first()} in $obj")
    return JsonObject(obj + (path.first() to replaced(child, path.drop(1), value)))
}

private fun JsonElement.at(vararg path: String): JsonElement? = path.fold<String, JsonElement?>(this) { v, k -> (v as? JsonObject)?.get(k) }

@SpringBootTest(classes = [PropertiesApplication::class], webEnvironment = WebEnvironment.RANDOM_PORT, properties = ["rayfold.path=/api/v2"])
@DirtiesContext
class PathPropertyTest : RunningApplication() {
    @Test
    fun `the endpoint and its routes answer under rayfold-path, and nothing is left at the default path`() {
        val single = send("GET", bookPath("/api/v2", "{ id title }"), headers = mapOf("Accept" to "application/json"))
        assertThat(single.statusCode()).describedAs(single.body()).isEqualTo(200)
        assertThat(json(single.body())).isEqualTo(json(BOOK_TITLE))
        assertThat(frames(batch("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id title }"}]}""", "/api/v2"))).containsExactly(json(BOOK_TITLE))
        assertThat(send("GET", "/api/v2/manifest").statusCode()).isEqualTo(200)
        assertThat(library.calls).isEqualTo(mapOf("book" to 2))

        val old = send("GET", bookPath("/rayfold", "{ id title }"), headers = mapOf("Accept" to "application/json"))
        assertThat(old.statusCode()).describedAs(old.body()).isEqualTo(404)
        assertThat(batch("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id title }"}]}""").statusCode()).isEqualTo(404)
        assertThat(library.calls).describedAs("nothing ran for the default path").isEqualTo(mapOf("book" to 2))
    }
}

@SpringBootTest(classes = [PropertiesApplication::class], webEnvironment = WebEnvironment.RANDOM_PORT, properties = ["rayfold.allowed-hosts=api.example"])
@DirtiesContext
class AllowedHostsPropertyTest : RunningApplication() {
    private fun read(host: String) = raw("GET ${bookPath("/rayfold", "{ id }")} HTTP/1.1\r\nHost: $host\r\nAccept: application/json\r\nConnection: close\r\n\r\n")

    @Test
    fun `a Host the list does not name is refused before anything runs, the loopback address included`() {
        val refused = read("127.0.0.1:$port")
        assertThat(refused.status).describedAs(refused.head).isEqualTo(403)
        assertThat(json(refused.body)).isEqualTo(problem(403, "permission_denied", "Host 127.0.0.1:$port is not allowed", "permission_denied"))
        assertThat(json(read("evil.example").body)).isEqualTo(problem(403, "permission_denied", "Host evil.example is not allowed", "permission_denied"))
        assertThat(library.calls).isEmpty()
    }

    @Test
    fun `guard - the listed host is served`() {
        val served = read("api.example")
        assertThat(served.status).describedAs(served.head).isEqualTo(200)
        assertThat(json(served.body)).isEqualTo(json(BOOK_ID))
        assertThat(library.calls).isEqualTo(mapOf("book" to 1))
    }
}

@SpringBootTest(classes = [PropertiesApplication::class], webEnvironment = WebEnvironment.RANDOM_PORT, properties = ["rayfold.max-body-bytes=100"])
@DirtiesContext
class MaxBodyBytesPropertyTest : RunningApplication() {
    private val op = """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}"""

    /** The same batch, padded with whitespace to exactly [size] bytes. */
    private fun padded(size: Int): String = (op + " ".repeat(size - op.length)).also { assertThat(it.toByteArray()).hasSize(size) }

    @Test
    fun `a body over the limit is refused with 413 and nothing runs`() {
        val res = batch(padded(101))
        assertThat(res.statusCode()).describedAs(res.body()).isEqualTo(413)
        assertThat(json(res.body())).isEqualTo(problem(413, "payload_too_large", "Body exceeds 100 bytes", "resource_exhausted"))
        assertThat(library.calls).isEmpty()
    }

    @Test
    fun `guard - a body of exactly the limit is served`() {
        assertThat(frames(batch(padded(100)))).containsExactly(json(BOOK_ID))
        assertThat(library.calls).isEqualTo(mapOf("book" to 1))
    }
}

@SpringBootTest(classes = [PropertiesApplication::class], webEnvironment = WebEnvironment.RANDOM_PORT, properties = ["rayfold.trusted-shapes=true"])
@DirtiesContext
class TrustedShapesPropertyTest : RunningApplication() {
    @field:Autowired
    lateinit var server: RayfoldServer

    @Test
    fun `an inline shape is refused and nothing runs`() {
        assertThat(frames(batch("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id title }"}]}""")))
            .containsExactly(json("""{"id":1,"error":{"code":"permission_denied","message":"Only registered shapes are accepted"},"fin":true}"""))
        assertThat(library.calls).isEmpty()
    }

    @Test
    fun `guard - the same shape, registered with the server, is served by its id`() {
        val id = server.registerShape("{ id title }")
        assertThat(frames(batch("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"$id"}]}"""))).containsExactly(json(BOOK_TITLE))
        assertThat(library.calls).isEqualTo(mapOf("book" to 1))
    }
}

@SpringBootTest(classes = [PropertiesApplication::class], webEnvironment = WebEnvironment.RANDOM_PORT, properties = ["rayfold.budget=1"])
@DirtiesContext
class BudgetPropertyTest : RunningApplication() {
    @Test
    fun `a batch over the budget is refused whole with resource_exhausted and nothing runs`() {
        assertThat(frames(batch("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id author { name } }"}]}""")))
            .containsExactly(json("""{"error":{"code":"resource_exhausted","message":"Batch cost 2 exceeds budget 1","data":{"cost":2,"budget":1}},"fin":true}"""))
        assertThat(library.calls).isEmpty()
    }

    @Test
    fun `guard - a batch within the budget is served`() {
        assertThat(frames(batch("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id title }"}]}"""))).containsExactly(json(BOOK_TITLE))
        assertThat(library.calls).isEqualTo(mapOf("book" to 1))
    }
}

@SpringBootTest(classes = [PropertiesApplication::class], webEnvironment = WebEnvironment.RANDOM_PORT, properties = ["rayfold.manifest=off"])
@DirtiesContext
class ManifestOffPropertyTest : RunningApplication() {
    @Test
    fun `off - no manifest is served, while the endpoint still is (guard)`() {
        val res = send("GET", "/rayfold/manifest")
        assertThat(res.statusCode()).isEqualTo(404)
        assertThat(json(res.body())).isEqualTo(problem(404, "not_found", "No route for GET /rayfold/manifest", "not_found"))
        assertThat(frames(batch("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id title }"}]}"""))).containsExactly(json(BOOK_TITLE))
    }
}

@SpringBootTest(classes = [PropertiesApplication::class], webEnvironment = WebEnvironment.RANDOM_PORT, properties = ["rayfold.manifest=full"])
@DirtiesContext
class ManifestFullPropertyTest : RunningApplication() {
    @field:Autowired
    lateinit var server: RayfoldServer

    @Test
    fun `full - the manifest is the whole schema, policy expressions included`() {
        val res = send("GET", "/rayfold/manifest")
        assertThat(res.statusCode()).describedAs(res.body()).isEqualTo(200)
        val manifest = json(res.body())
        assertThat(manifest).isEqualTo(manifestOf(server.ir))
        assertThat(manifest.at("schema", "types", "Secret", "annotations")).isEqualTo(
            json("""[{"name":"allow","args":{"read":{"${'$'}expr":{"k":"bin","op":"!=","l":{"k":"path","root":"viewer","path":[]},"r":{"k":"lit","v":null}}}}}]"""),
        )
    }
}

@SpringBootTest(classes = [PropertiesApplication::class], webEnvironment = WebEnvironment.RANDOM_PORT, properties = ["rayfold.manifest=redacted"])
@DirtiesContext
class ManifestRedactedPropertyTest : RunningApplication() {
    @field:Autowired
    lateinit var server: RayfoldServer

    @Test
    fun `redacted - the manifest is the whole schema but for the policy expression, which is the one difference`() {
        val res = send("GET", "/rayfold/manifest")
        assertThat(res.statusCode()).describedAs(res.body()).isEqualTo(200)
        val manifest = json(res.body())
        assertThat(manifest.at("schema", "types", "Secret", "annotations")).isEqualTo(json("""[{"name":"allow"}]"""))
        assertThat(manifest).isEqualTo(replaced(manifestOf(server.ir), listOf("schema", "types", "Secret", "annotations"), json("""[{"name":"allow"}]""")))
    }
}

@SpringBootTest(classes = [PropertiesApplication::class], webEnvironment = WebEnvironment.RANDOM_PORT)
@DirtiesContext
class IrSchemaPropertyTest : RunningApplication() {
    @field:Autowired
    lateinit var server: RayfoldServer

    companion object {
        private val ir: RayfoldSchemaIR = SchemaText.load(
            IrSchemaPropertyTest::class.java.getResource("/properties.rayfold")?.readText() ?: error("properties.rayfold is missing"),
        ).ir
        private val dir: Path = Files.createTempDirectory("rayfold-ir")
        private val file: Path = dir.resolve("properties.ir.json").also { Files.writeString(it, RayfoldSchemaIR.json.encodeToString(RayfoldSchemaIR.serializer(), ir)) }

        @JvmStatic
        @DynamicPropertySource
        fun schemaLocation(registry: DynamicPropertyRegistry) {
            registry.add("rayfold.schema") { file.toUri().toString() }
        }

        @JvmStatic
        @AfterAll
        fun deleteSchema() {
            Files.deleteIfExists(file)
            Files.deleteIfExists(dir)
        }
    }

    @Test
    fun `a schema location ending in json is read as the IR and served`() {
        assertThat(server.ir).isEqualTo(ir)
        val res = send("GET", bookPath("/rayfold", "{ id title }"), headers = mapOf("Accept" to "application/json"))
        assertThat(res.statusCode()).describedAs(res.body()).isEqualTo(200)
        assertThat(res.headers().firstValue("Rayfold-Schema")).hasValue(SchemaText.hash(ir))
        assertThat(json(res.body())).isEqualTo(json(BOOK_TITLE))
        assertThat(library.calls).isEqualTo(mapOf("book" to 1))
    }
}
