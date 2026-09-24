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
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

/**
 * What tells one running server from another.
 *
 * None of this reaches the manifest. Spec 04 section 4a fixes that document's members exactly and Core 0.1 is
 * frozen, so identity is served by `GET {base}/stats` instead - a route that is off until [HttpOptions.stats] is
 * given, so a server discloses none of it until its operator decides to.
 */
data class ServerIdentity(
    /** The application this server is: the same across its instances and its restarts. */
    val name: String? = null,
    /** This process. Stable for its lifetime, new on every restart; a random id when you do not supply one. */
    val instance: String = java.util.UUID.randomUUID().toString().replace("-", ""),
    /** Whatever you deploy by - a version, a commit, a build number. */
    val version: String? = null,
    /** Small and free-form: region, zone, tenant. */
    val labels: Map<String, String> = emptyMap(),
    /** When this process started, epoch milliseconds. */
    val startedAt: Long = System.currentTimeMillis(),
)

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
    /** Who this server is, for an operator looking at several of them. See [ServerIdentity]. */
    identity: ServerIdentity = ServerIdentity(),
    /** Where to count what this server does. Without one, nothing is counted. */
    val counters: Counters? = null,
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
                r.subscribe(::receive) { lost ->
                    relayStopped = lost
                    relayError(lost)
                }
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

    /** Everyone waiting in [drain] for the last batch in flight to end. */
    private val idle = ConcurrentLinkedQueue<CompletableDeferred<Unit>>()

    /** Who this server is. Before this, two servers in one fleet were indistinguishable. */
    val identity: ServerIdentity = identity

    /** Milliseconds since this process started. */
    val uptimeMs: Long get() = System.currentTimeMillis() - identity.startedAt

    /** Extensions served by endpoints mounted beside this server, such as `mcp` by [RayfoldMcp]; the manifest lists them. */
    val mounted: MutableSet<String> = ConcurrentHashMap.newKeySet()
    val views = Views(ir, options.maxInlineShapes)
    private val executor = Executor(ir, resolvers, views, instrumentation, usage)
    private val cost = Cost(ir, views)
    private val runner = BatchRunner(ir, executor, views, cost, idempotency, events, options, changes, instrumentation, usage, drainer, counters)

    /** sha256 of the canonical IR: the hash `@rayfold/schema` computes for the same schema ([SchemaText.hash]). */
    val hash: String by lazy { SchemaText.hash(ir) }

    /** The hash of the schema as a public manifest shows it: another hash, but the same names, so the same RB keys. */
    internal val publicHash: String by lazy { SchemaText.hash(ir.withoutPolicies()) }

    /**
     * A batch is in flight from its first frame being asked for until it ends, so [drain] can wait for it. The flow is
     * cold: nothing runs before it is collected, so that is also when the batch starts.
     */
    fun execute(envelope: RequestEnvelope, opts: ExecuteOptions): Flow<JsonObject> = flow {
        active.incrementAndGet()
        try {
            emitAll(runner.execute(envelope, opts))
        } finally {
            if (active.decrementAndGet() == 0) while (true) (idle.poll() ?: break).complete(Unit)
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
        // one per caller: two callers draining at once each wait only as long as the batches do
        val done = CompletableDeferred<Unit>()
        idle.add(done)
        try {
            if (active.get() == 0) return // the last batch ended between the count and the hand-over
            withTimeoutOrNull(timeoutMs) { done.await() }
        } finally {
            idle.remove(done)
        }
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

    /**
     * Stops hearing the other servers.
     *
     * [closeTimeoutMs] bounds the wait for a subscription that has not finished starting. close() is what a shutdown
     * hook calls last, so waiting without a bound is a server that never exits: a relay still connecting has nothing
     * to stop yet - [readiness] reports that state as "relay: not listening yet" - and its own subscribe may be
     * retrying behind a dropped connection.
     */
    suspend fun close(closeTimeoutMs: Long = 2_000) {
        val subscription = listening ?: return
        val stop = withTimeoutOrNull(closeTimeoutMs) { runCatching { subscription.await() }.getOrNull() }
        if (stop == null) {
            subscription.cancel() // still connecting: give up the attempt rather than hold shutdown open
            return
        }
        stop()
    }
}
