package dev.rayfold.opentelemetry

import dev.rayfold.core.Code
import dev.rayfold.core.HttpOptions
import dev.rayfold.core.Instrumentation
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldHttp
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.context.Context
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.data.SpanData
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Spans from real batches, in memory: the batch/op/loader tree, error spans, W3C trace context from the envelope and
 * from an HTTP header, and a resolver's own span nesting under its loader through the coroutine context. Every batch
 * runs under a 5 s bound.
 */
class OpenTelemetryTest {
    private val exporter = InMemorySpanExporter.create()
    private val provider = SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(exporter)).build()
    private val tracer = provider.get("test")
    private val servers = mutableListOf<com.sun.net.httpserver.HttpServer>()

    @AfterEach
    fun stop() {
        servers.forEach { it.stop(0) }
        provider.close()
    }

    private val schema = """
        entity Author { id: ID name: String }
        entity Book { id: ID title: String author: Author }
        query book(id: ID): Book?
        query books: [Book]
        query broken: Book?
    """
    private val books = mapOf(
        "b1" to buildJsonObject { put("id", "b1"); put("title", "The Dispossessed"); put("authorId", "a1") },
        "b2" to buildJsonObject { put("id", "b2"); put("title", "Kindred"); put("authorId", "a2") },
    )

    private fun server(instrumentation: Instrumentation = RayfoldOpenTelemetry(tracer)) = RayfoldServer(
        SchemaText.load(schema).ir,
        Resolvers(
            queries = mapOf(
                "book" to { args, _ -> books[args["id"]?.jsonPrimitive?.content] },
                "books" to { _, _ -> JsonArray(books.values.toList()) },
                "broken" to { _, _ -> buildJsonObject { put("id", "b0"); put("title", "?"); put("authorId", "gone") } },
            ),
            fields = mapOf("Book" to mapOf("author" to { parents, _, _ ->
                // a resolver's own span: its parent is whatever span is current in this coroutine
                tracer.spanBuilder("db select").setParent(Context.current()).startSpan().end()
                if (parents.any { it["authorId"]?.jsonPrimitive?.content == "gone" }) throw RayfoldException(Code.UNAVAILABLE, "the database is down")
                parents.map { p -> buildJsonObject { put("id", p["authorId"]?.jsonPrimitive?.content ?: ""); put("name", "Author of ${p["title"]?.jsonPrimitive?.content}") } }
            })),
        ),
        instrumentation = instrumentation,
    )

    private fun collect(s: RayfoldServer, batch: String): List<JsonObject> = runBlocking { withTimeout(5_000) { s.collect(Json.parseToJsonElement(batch).jsonObject) } }
    private fun spans(): List<SpanData> = exporter.finishedSpanItems
    private fun named(name: String): SpanData = spans().firstOrNull { it.name == name } ?: error("no span $name in ${spans().map { it.name }}")
    private fun attr(s: SpanData, key: String): Any? = s.attributes.asMap().entries.firstOrNull { it.key.key == key }?.value

    @Test
    fun `a batch is a span with a child per op and a grandchild per loader call, all in one trace`() {
        val frames = collect(server(), """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title author { name } }"},{"id":2,"op":"books","shape":"{ id author { name } }"}],"meta":{"client":"android"}}""")
        assertTrue(frames.none { "error" in it }, "$frames")
        val batch = named("rayfold batch")
        val book = named("rayfold query book")
        val list = named("rayfold query books")
        val loads = spans().filter { it.name == "rayfold load Book.author" }
        assertEquals(false, batch.parentSpanContext.isValid, "the batch is the root")
        assertEquals(listOf(batch.spanId, batch.spanId), listOf(book.parentSpanId, list.parentSpanId))
        // Both ops need b1's author and a batch loads a row once, so which op pays for it depends on which asked
        // first. What is fixed: every load hangs under the op that asked for it.
        assertTrue(loads.isNotEmpty(), "the author was loaded at least once")
        assertTrue(loads.all { it.parentSpanId == book.spanId || it.parentSpanId == list.spanId }, "a load belongs to the op that asked")
        assertEquals(1, spans().map { it.traceId }.toSet().size)
        assertEquals(2L, attr(batch, "rayfold.ops"))
        assertEquals("android", attr(batch, "rayfold.client"))
        // b1 and b2, each loaded once: the row both ops wanted is not fetched twice
        assertEquals(2L, loads.sumOf { (attr(it, "rayfold.parents") as? Long) ?: 0L }, "b1 and b2, each loaded once")
        // the resolver's own spans nest under the loader call that ran them
        assertEquals(loads.map { it.spanId }.toSet(), spans().filter { it.name == "db select" }.map { it.parentSpanId }.toSet())
        assertTrue(spans().none { it.status.statusCode == StatusCode.ERROR })
    }

    @Test
    fun `a failed op is an error span with its code, a loader that throws is an error span, and the sibling op is fine`() {
        collect(server(), """{"ops":[{"id":1,"op":"book","args":{}},{"id":2,"op":"broken","shape":"{ author { name } }"},{"id":3,"op":"book","args":{"id":"b2"},"shape":"{ id }"}]}""")
        val missingArg = spans().first { attr(it, "rayfold.op.id") == 1L }
        assertEquals(StatusCode.ERROR, missingArg.status.statusCode)
        assertEquals("invalid_argument", attr(missingArg, "rayfold.error.code"))
        val load = named("rayfold load Book.author")
        assertEquals(StatusCode.ERROR, load.status.statusCode)
        assertTrue(load.events.any { it.name == "exception" })
        assertEquals("unavailable", attr(named("rayfold query broken"), "rayfold.error.code"))
        assertEquals(StatusCode.UNSET, spans().first { attr(it, "rayfold.op.id") == 3L }.status.statusCode, "guard: the op that worked")
    }

    @Test
    fun `W3C trace context in the envelope meta continues the caller's trace`() {
        collect(server(), """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}],"meta":{"traceparent":"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"}}""")
        val batch = named("rayfold batch")
        assertEquals("0af7651916cd43dd8448eb211c80319c", batch.traceId)
        assertEquals("b7ad6b7169203331", batch.parentSpanId)
        assertEquals("0af7651916cd43dd8448eb211c80319c", named("rayfold query book").traceId)
    }

    @Test
    fun `a traceparent header over RayfoldHttp continues the caller's trace`() {
        val http = RayfoldHttp(server(), HttpOptions()).start(0).also { servers.add(it) }
        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
        val res = client.send(HttpRequest.newBuilder(URI("http://127.0.0.1:${http.address.port}/rayfold")).timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json").header("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
            .header("Rayfold-Client", "web")
            .POST(HttpRequest.BodyPublishers.ofString("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}""")).build(), HttpResponse.BodyHandlers.ofString())
        assertEquals(200, res.statusCode(), res.body())
        val batch = named("rayfold batch")
        assertEquals("4bf92f3577b34da6a3ce929d0e0e4736", batch.traceId)
        assertEquals("00f067aa0ba902b7", batch.parentSpanId)
        assertEquals("web", attr(batch, "rayfold.client"), "the Rayfold-Client header reaches the envelope meta too")
        client.shutdownNow()
    }

    @Test
    fun `guard - without instrumentation there are no rayfold spans and the frames are the same`() {
        val batch = """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title author { name } }"}]}"""
        val traced = collect(server(), batch)
        exporter.reset()
        val plain = collect(server(Instrumentation.NONE), batch)
        assertEquals(traced, plain)
        assertEquals(listOf("db select"), spans().map { it.name }, "only the resolver's own span")
        assertNull(spans().firstOrNull { it.name.startsWith("rayfold") })
    }
}
