package dev.rayfold.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Whether a server should receive traffic, and every reason it should not. */
data class Readiness(val ready: Boolean, val reasons: List<String>) {
    constructor(reasons: List<String>) : this(reasons.isEmpty(), reasons)
}

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
    /** Where to record which members each client asks for (spec 11). Without one, nothing is recorded. */
    val usage: UsageSink? = null,
    /** Carries changes and events to and from the other servers sharing it; without one this server hears only itself. */
    relay: Relay? = null,
    /** Called when the relay refuses a message. What it carried already happened on this server. */
    onRelayError: (Throwable) -> Unit = {},
) {
    init { ir.checkFormats() }

    /** The last message the relay refused to carry, if any: the other servers missed it. */
    @Volatile
    var relayFailure: Throwable? = null
        private set

    /** What ended the relay subscription before it began, if anything: the server never heard the others. */
    @Volatile
    private var relayStopped: Throwable? = null

    private val relayError: (Throwable) -> Unit = { e ->
        relayFailure = e
        onRelayError(e)
    }

    val events = EventBus(relay, relayError)

    /** Entity and op change notifications driving live queries (spec 08 section 3); committed commands publish their patches here. */
    val changes = ChangeBus(relay, relayError)

    /** The relay subscription, started at construction; what stops it is what [close] calls. */
    private val listening: Deferred<suspend () -> Unit>? = relay?.let { r ->
        CoroutineScope(SupervisorJob() + Dispatchers.Default).async {
            try {
                r.subscribe(::receive)
            } catch (e: Throwable) {
                relayStopped = e
                relayError(e) // ready() reports it too; this keeps the failure from going unobserved
                throw e
            }
        }
    }

    private val drainer = Job()

    /** Completes once the server is shutting down. Live queries and streams end on it with a retryable `unavailable`. */
    val draining: Job get() = drainer

    private val active = AtomicInteger()

    /** Completed when the last batch in flight ends, for [drain] to wait on. */
    @Volatile
    private var idle: CompletableDeferred<Unit>? = null

    /** Extensions served by endpoints mounted beside this server, such as `mcp` by [RayfoldMcp]; the manifest lists them. */
    val mounted: MutableSet<String> = ConcurrentHashMap.newKeySet()
    val views = Views(ir, options.maxInlineShapes)
    private val executor = Executor(ir, resolvers, views, instrumentation, usage)
    private val cost = Cost(ir, views)
    private val runner = BatchRunner(ir, executor, views, cost, idempotency, events, options, changes, instrumentation, usage, drainer)

    /** sha256 of the canonical IR: the hash `@rayfold/schema` computes for the same schema ([SchemaText.hash]). */
    val hash: String by lazy { SchemaText.hash(ir) }

    /** A batch is in flight from its first frame being asked for until it ends, so [drain] can wait for it. */
    fun execute(envelope: RequestEnvelope, opts: ExecuteOptions): Flow<JsonObject> = flow {
        active.incrementAndGet()
        try {
            emitAll(runner.execute(envelope, opts))
        } finally {
            if (active.decrementAndGet() == 0) idle?.complete(Unit)
        }
    }

    fun execute(envelope: RequestEnvelope, viewer: JsonElement = JsonNull): Flow<JsonObject> = execute(envelope, ExecuteOptions(viewer))

    fun execute(envelope: JsonObject, viewer: JsonElement = JsonNull): Flow<JsonObject> = execute(RequestEnvelope.from(envelope), viewer)

    fun execute(envelope: JsonObject, opts: ExecuteOptions): Flow<JsonObject> = execute(RequestEnvelope.from(envelope), opts)

    suspend fun collect(envelope: JsonObject, viewer: JsonElement = JsonNull): List<JsonObject> = execute(envelope, viewer).toList()

    suspend fun collect(envelope: JsonObject, opts: ExecuteOptions): List<JsonObject> = execute(envelope, opts).toList()

    fun registerShape(text: String): String = views.register(Shapes.parse(text))

    /** Batches running right now. */
    val inflight: Int get() = active.get()

    /**
     * Begins the shutdown a rolling deploy needs: readiness turns false so the load balancer stops sending traffic, the
     * transports refuse new batches, and live queries and streams end with a retryable `unavailable` that sends their
     * clients to another server. Batches already running finish; this returns once they have, or after [timeoutMs].
     * Call [close] afterwards to stop hearing the relay.
     */
    suspend fun drain(timeoutMs: Long = 10_000) {
        drainer.complete()
        if (active.get() == 0) return
        val done = CompletableDeferred<Unit>()
        idle = done
        if (active.get() == 0) return // the last batch ended between the count and the hand-over
        withTimeoutOrNull(timeoutMs) { done.await() }
        idle = null
    }

    /** Whether this server should receive traffic, and every reason it should not. */
    fun readiness(): Readiness {
        val reasons = mutableListOf<String>()
        if (drainer.isCompleted) reasons.add("shutting down")
        val relay = listening
        if (relay != null && !relay.isCompleted) reasons.add("relay: not listening yet")
        relayStopped?.let { reasons.add("relay: ${it.message ?: it}") }
        return Readiness(reasons)
    }

    /** A message from another server: its change or event is delivered here as if it had happened here. */
    private fun receive(message: RelayMessage) {
        when (message) {
            is RelayMessage.Change -> changes.deliver(Change(message.keys, message.ops))
            is RelayMessage.Event -> events.deliver(message.name, message.payload)
        }
    }

    /** Returns once the server can serve: with a relay, once it hears the other servers. Throws what stopped it. */
    suspend fun ready() {
        listening?.await()
    }

    /** Stops hearing the other servers. */
    suspend fun close() {
        val stop = listening?.let { runCatching { it.await() }.getOrNull() } ?: return
        stop()
    }
}
