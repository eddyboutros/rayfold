package dev.rayfold.core

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * Entry point: schema IR + resolvers -> batch execution producing frames. Construction fails with
 * [IllegalArgumentException] when a `@format` pattern in [ir] does not compile.
 */
class RayfoldServer(
    val ir: RayfoldSchemaIR,
    resolvers: Resolvers,
    val options: BatchOptions = BatchOptions(),
    idempotency: IdempotencyStore = MemoryIdempotencyStore(),
    /** Hooks around batches, ops and loaders, for tracing (module rayfold-opentelemetry makes them spans). */
    instrumentation: Instrumentation = Instrumentation.NONE,
) {
    init { ir.checkFormats() }

    val events = EventBus()

    /** Entity and op change notifications driving live queries (spec 08 section 3); committed commands publish their patches here. */
    val changes = ChangeBus()
    val views = Views(ir, options.maxInlineShapes)
    private val executor = Executor(ir, resolvers, views, instrumentation)
    private val cost = Cost(ir, views)
    private val runner = BatchRunner(ir, executor, views, cost, idempotency, events, options, changes, instrumentation)

    /** sha256 of the canonical IR: the hash `@rayfold/schema` computes for the same schema ([SchemaText.hash]). */
    val hash: String by lazy { SchemaText.hash(ir) }

    fun execute(envelope: RequestEnvelope, opts: ExecuteOptions): Flow<JsonObject> = runner.execute(envelope, opts)

    fun execute(envelope: RequestEnvelope, viewer: JsonElement = JsonNull): Flow<JsonObject> = execute(envelope, ExecuteOptions(viewer))

    fun execute(envelope: JsonObject, viewer: JsonElement = JsonNull): Flow<JsonObject> = execute(RequestEnvelope.from(envelope), viewer)

    fun execute(envelope: JsonObject, opts: ExecuteOptions): Flow<JsonObject> = execute(RequestEnvelope.from(envelope), opts)

    suspend fun collect(envelope: JsonObject, viewer: JsonElement = JsonNull): List<JsonObject> = execute(envelope, viewer).toList()

    suspend fun collect(envelope: JsonObject, opts: ExecuteOptions): List<JsonObject> = execute(envelope, opts).toList()

    fun registerShape(text: String): String = views.register(Shapes.parse(text))
}
