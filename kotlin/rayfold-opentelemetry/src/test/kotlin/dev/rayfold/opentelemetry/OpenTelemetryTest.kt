package dev.rayfold.opentelemetry

import dev.rayfold.core.Code
import dev.rayfold.core.ExecuteOptions
import dev.rayfold.core.HttpOptions
import dev.rayfold.core.Instrumentation
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldHttp
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import io.opentelemetry.api.GlobalOpenTelemetry
import io.opentelemetry.api.trace.SpanKind
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator
import io.opentelemetry.context.Context
import io.opentelemetry.context.propagation.ContextPropagators
import io.opentelemetry.sdk.OpenTelemetrySdk
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.data.SpanData
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
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

/**
 * Spans from real batches, in memory: the batch/op/loader tree with its kinds and attributes, error spans, a cancelled
 * op, W3C trace context from the envelope and from an HTTP header, a resolver's own span nesting under its loader
 * through the coroutine context, and the tracer and propagators of the OpenTelemetry instance it is given. Every batch
 * runs under a 5 s bound, and the global OpenTelemetry is reset after every test.
 */
class OpenTelemetryTest {
    private val exporter = InMemorySpanExporter.create()
    private val provider = SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(exporter)).build()
    private val tracer = provider.get("test")
    private val servers = mutableListOf<com.sun.net.httpserver.HttpServer>()

    @AfterEach
    fun stop() {
        try {
            servers.forEach { it.stop(0) }
            provider.close()
        } finally {
            GlobalOpenTelemetry.resetForTest()
        }
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

    /**
     * A server whose `books` resolver answers only once the first author load has run, so when two ops need the same
     * author, the op that pays for the load is known: the other finds it in the batch's memo.
     */
    private fun server(instrumentation: Instrumentation = RayfoldOpenTelemetry(tracer)): RayfoldServer {
        val firstLoad = CompletableDeferred<Unit>()
        return RayfoldServer(
            SchemaText.load(schema).ir,
            Resolvers(
                queries = mapOf(
                    "book" to { args, _ -> books[args["id"]?.jsonPrimitive?.content] },
                    "books" to { _, _ -> firstLoad.await(); JsonArray(books.values.toList()) },
                    "broken" to { _, _ -> buildJsonObject { put("id", "b0"); put("title", "?"); put("authorId", "gone") } },
                ),
                fields = mapOf("Book" to mapOf("author" to { parents, _, _ ->
                    try {
                        // a resolver's own span: its parent is whatever span is current in this coroutine
                        tracer.spanBuilder("db select").setParent(Context.current()).startSpan().end()
                        if (parents.any { it["authorId"]?.jsonPrimitive?.content == "gone" }) throw RayfoldException(Code.UNAVAILABLE, "the database is down")
                        parents.map { p -> buildJsonObject { put("id", p["authorId"]?.jsonPrimitive?.content ?: ""); put("name", "Author of ${p["title"]?.jsonPrimitive?.content}") } }
                    } finally {
                        firstLoad.complete(Unit)
                    }
                })),
            ),
            instrumentation = instrumentation,
        )
    }

    private fun collect(s: RayfoldServer, batch: String): List<JsonObject> = runBlocking { withTimeout(5_000) { s.collect(Json.parseToJsonElement(batch).jsonObject) } }
    private fun spans(): List<SpanData> = exporter.finishedSpanItems
    private fun named(name: String): SpanData = spans().singleOrNull { it.name == name } ?: error("not exactly one span $name in ${spans().map { it.name }}")
    private fun attributes(s: SpanData): Map<String, Any> = s.attributes.asMap().entries.associate { (k, v) -> k.key to v }
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    @Test
    fun `a batch is a server span with a child per op and a grandchild per loader call, all in one trace`() {
        val frames = collect(server(), """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title author { name } }"},{"id":2,"op":"books","shape":"{ id author { name } }"}],"meta":{"client":"android"}}""")
        assertEquals(
            listOf(
                obj("""{"id":1,"data":{"${'$'}type":"Book","title":"The Dispossessed","author":{"${'$'}type":"Author","name":"Author of The Dispossessed"}},"meta":{"cost":2},"fin":true}"""),
                obj("""{"id":2,"data":[{"${'$'}type":"Book","id":"b1","author":{"${'$'}type":"Author","name":"Author of The Dispossessed"}},{"${'$'}type":"Book","id":"b2","author":{"${'$'}type":"Author","name":"Author of Kindred"}}],"meta":{"cost":2},"fin":true}"""),
            ),
            frames,
        )
        val batch = named("rayfold batch")
        val book = named("rayfold query book")
        val list = named("rayfold query books")
        assertEquals(SpanKind.SERVER, batch.kind)
        assertEquals(false, batch.parentSpanContext.isValid, "the batch is the root")
        assertEquals(mapOf("rayfold.ops" to 2L, "rayfold.client" to "android"), attributes(batch))
        for (op in listOf(book, list)) {
            assertEquals(SpanKind.INTERNAL, op.kind)
            assertEquals(batch.spanId, op.parentSpanId)
        }
        assertEquals(mapOf("rayfold.op" to "book", "rayfold.op.kind" to "query", "rayfold.op.id" to 1L, "rayfold.cost" to 2L), attributes(book))
        assertEquals(mapOf("rayfold.op" to "books", "rayfold.op.kind" to "query", "rayfold.op.id" to 2L, "rayfold.cost" to 2L), attributes(list))

        // op 1 loads b1's author; op 2 finds it in the batch's memo and loads only b2's
        val loads = spans().filter { it.name == "rayfold load Book.author" }.associateBy { it.parentSpanId }
        assertEquals(setOf(book.spanId, list.spanId), loads.keys)
        for (load in loads.values) {
            assertEquals(SpanKind.INTERNAL, load.kind)
            assertEquals(mapOf("rayfold.type" to "Book", "rayfold.field" to "author", "rayfold.parents" to 1L), attributes(load))
        }
        // the resolver's own spans nest under the loader call that ran them
        assertEquals(loads.values.map { it.spanId }.toSet(), spans().filter { it.name == "db select" }.map { it.parentSpanId }.toSet())
        assertEquals(7, spans().size, "a batch, two ops, two loads and two resolver spans")
        assertEquals(1, spans().map { it.traceId }.toSet().size)
        assertEquals(listOf(StatusCode.UNSET), spans().map { it.status.statusCode }.distinct())
    }

    @Test
    fun `a failed op is an error span with its code, a loader that throws is an error span with the exception, and the sibling op is fine`() {
        collect(server(), """{"ops":[{"id":1,"op":"book","args":{}},{"id":2,"op":"broken","shape":"{ author { name } }"},{"id":3,"op":"book","args":{"id":"b2"},"shape":"{ id }"}]}""")
        val missingArg = spans().single { attributes(it)["rayfold.op.id"] == 1L }
        assertEquals(StatusCode.ERROR, missingArg.status.statusCode)
        assertEquals("book().id: required", missingArg.status.description)
        assertEquals(mapOf("rayfold.op" to "book", "rayfold.op.kind" to "query", "rayfold.op.id" to 1L, "rayfold.cost" to 0L, "rayfold.error.code" to "invalid_argument"), attributes(missingArg))

        val load = named("rayfold load Book.author")
        assertEquals(StatusCode.ERROR, load.status.statusCode)
        assertEquals("the database is down", load.status.description)
        val exception = load.events.single()
        assertEquals("exception", exception.name)
        assertEquals("dev.rayfold.core.RayfoldException", exception.attributes.asMap().entries.single { it.key.key == "exception.type" }.value)
        assertEquals("the database is down", exception.attributes.asMap().entries.single { it.key.key == "exception.message" }.value)

        val broken = named("rayfold query broken")
        assertEquals(StatusCode.ERROR, broken.status.statusCode)
        assertEquals("unavailable", attributes(broken)["rayfold.error.code"])
        val fine = spans().single { attributes(it)["rayfold.op.id"] == 3L }
        assertEquals(StatusCode.UNSET, fine.status.statusCode, "guard: the op that worked")
        assertEquals(mapOf("rayfold.op" to "book", "rayfold.op.kind" to "query", "rayfold.op.id" to 3L, "rayfold.cost" to 1L), attributes(fine))
    }

    @Test
    fun `a cancelled live op ends its span without an error, and its batch span ends too`() {
        val s = server()
        val cancel = Job()
        runBlocking {
            withTimeout(5_000) {
                val frames = Channel<JsonObject>(Channel.UNLIMITED)
                val running = launch {
                    s.execute(obj("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }","live":true}]}"""), ExecuteOptions(JsonNull, cancel = cancel)).collect { frames.send(it) }
                }
                assertEquals(obj("""{"id":1,"data":{"${'$'}type":"Book","id":"b1"},"meta":{"cost":1}}"""), frames.receive())
                assertEquals(emptyList(), spans(), "guard: nothing has ended while the live op is open")
                cancel.complete()
                assertEquals(obj("""{"id":1,"error":{"code":"canceled","message":"Canceled"},"fin":true}"""), frames.receive())
                running.join()
            }
        }
        val op = named("rayfold query book")
        assertEquals(StatusCode.UNSET, op.status.statusCode, "a cancelled live query is not a failure of the op")
        assertEquals(emptyList(), op.events)
        assertEquals(mapOf("rayfold.op" to "book", "rayfold.op.kind" to "query", "rayfold.op.id" to 1L, "rayfold.cost" to 1L), attributes(op))
        val batch = named("rayfold batch")
        assertEquals(batch.spanId, op.parentSpanId)
        assertEquals(StatusCode.UNSET, batch.status.statusCode)
        assertEquals(listOf("rayfold query book", "rayfold batch"), spans().map { it.name }, "the op ended first, then its batch")
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
        try {
            val res = client.send(HttpRequest.newBuilder(URI("http://127.0.0.1:${http.address.port}/rayfold")).timeout(Duration.ofSeconds(5))
                .header("Content-Type", "application/rayfold+json").header("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
                .header("Rayfold-Client", "web")
                .POST(HttpRequest.BodyPublishers.ofString("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}]}""")).build(), HttpResponse.BodyHandlers.ofString())
            assertEquals(200, res.statusCode(), res.body())
            val batch = named("rayfold batch")
            assertEquals("4bf92f3577b34da6a3ce929d0e0e4736", batch.traceId)
            assertEquals("00f067aa0ba902b7", batch.parentSpanId)
            assertEquals("web", attributes(batch)["rayfold.client"], "the Rayfold-Client header reaches the envelope meta too")
        } finally {
            client.shutdownNow()
        }
    }

    @Test
    fun `built from an OpenTelemetry instance, it traces with that instance's tracer and propagators and never the global ones`() {
        val globalExporter = InMemorySpanExporter.create()
        val globalProvider = SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(globalExporter)).build()
        try {
            OpenTelemetrySdk.builder().setTracerProvider(globalProvider).setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance())).buildAndRegisterGlobal()
            val traced = """{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}],"meta":{"traceparent":"00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"}}"""

            val w3c = OpenTelemetrySdk.builder().setTracerProvider(provider).setPropagators(ContextPropagators.create(W3CTraceContextPropagator.getInstance())).build()
            collect(server(RayfoldOpenTelemetry(w3c)), traced)
            val batch = named("rayfold batch")
            assertEquals(RayfoldOpenTelemetry.INSTRUMENTATION_NAME, batch.instrumentationScopeInfo.name)
            assertEquals("0af7651916cd43dd8448eb211c80319c", batch.traceId)
            assertEquals("b7ad6b7169203331", batch.parentSpanId)

            // guard: an instance without propagators ignores the caller's context, so it is that instance's, not the global's
            exporter.reset()
            collect(server(RayfoldOpenTelemetry(OpenTelemetrySdk.builder().setTracerProvider(provider).build())), traced)
            assertEquals(false, named("rayfold batch").parentSpanContext.isValid)
            assertEquals(emptyList(), globalExporter.finishedSpanItems)
        } finally {
            globalProvider.close()
        }
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
