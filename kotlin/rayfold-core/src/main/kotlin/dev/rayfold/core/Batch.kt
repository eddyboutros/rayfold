package dev.rayfold.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

data class BatchOptions(
    val trustedShapes: Boolean = false,
    val budget: Int = 1000,
    val maxOps: Int = 50,
    val maxDepth: Int = 8,
    val maxFields: Int = 500,
    /** Items one stream op may yield before it fails with resource_exhausted. */
    val maxStreamItems: Int = 10_000,
    /** Frames the resolvers of one batch may produce (data, item, at, fin); error frames always get through. */
    val maxFrames: Int = 100_000,
    /** Inline shapes remembered by id, least recently used evicted first; [RayfoldServer.registerShape] entries stay. */
    val maxInlineShapes: Int = 10_000,
    /**
     * How long one run owns an idempotency key before another may take it over ([IdempotencyStore.claim]). The lease
     * is renewed every third of it while the command runs, so it bounds how long a key stays held by a server that
     * died, not how long a command may take.
     */
    val idempotencyLeaseMs: Long = 30_000,
)

/** How a transport runs a batch. None of this is settable from the wire envelope. */
data class ExecuteOptions(
    val viewer: JsonElement = JsonNull,
    /** Set by transports whose HTTP method is itself idempotent (PUT, PATCH, DELETE bindings): commands may run without an idempotency key. */
    val keyOptional: Boolean = false,
    /** Completing this job cancels the batch: every op still open ends with `canceled`, and live queries unsubscribe. */
    val cancel: Job? = null,
    /** False on transports that cannot notice a vanished client (the JDK HTTP server): live ops answer `unimplemented`. */
    val allowLive: Boolean = true,
    /** Set by the batch itself: the memo its ops share so a row is loaded once. Never read from the wire. */
    val batchState: MutableMap<String, CompletableDeferred<JsonElement>>? = null,
    /** Set by the batch itself from `meta.client`, for usage telemetry (spec 11). */
    val client: String = "",
    /** Set by the batch itself: the envelope's `meta`, which carries the W3C trace context (spec 04 section 4). */
    val meta: JsonObject = JsonObject(emptyMap()),
)

/** A command's first run, or its failure after the side effect. Both frame forms are kept so a retry is answered in the form it asks for. */
data class IdempotencyRecord(val argsHash: String, val frame: JsonObject, val compactFrame: JsonObject)

/** What [IdempotencyStore.claim] found. */
sealed class IdempotencyClaim {
    /** The caller runs the command and settles the key with [token]: [IdempotencyStore.put] or [IdempotencyStore.release]. */
    class Owned(val token: String) : IdempotencyClaim()
    class Done(val record: IdempotencyRecord) : IdempotencyClaim()
    /** Another run holds the key until [heldUntil] (epoch milliseconds); this one waits and claims again. */
    class InFlight(val heldUntil: Long) : IdempotencyClaim()
}

/**
 * Where a command's answer is kept so a retry replays it instead of running the command twice. [claim] is the one
 * operation that must be atomic: a store shared by several server processes makes the guarantee hold across all of
 * them, and [MemoryIdempotencyStore] holds it within one.
 *
 * A claim is a lease, not a lock. Its owner renews it while the command runs, and a claim nobody renewed is taken
 * over, so a server that dies does not hold a key until its record expires. The [IdempotencyClaim.Owned] token tells
 * the owner apart from whoever took the key afterwards: [put] and [release] from a lost claim do nothing, which is
 * what makes handing a lease over safe.
 */
interface IdempotencyStore {
    fun get(scope: String, key: String): IdempotencyRecord?

    /** Reserves [key] for [leaseMs] milliseconds, atomically against every other caller of this store. */
    fun claim(scope: String, key: String, leaseMs: Long): IdempotencyClaim

    /** Extends an owned claim by another [leaseMs]; false when the claim was lost and this run no longer owns the key. */
    fun renew(scope: String, key: String, token: String, leaseMs: Long): Boolean

    /** Stores what a retry replays and clears the claim. */
    fun put(scope: String, key: String, record: IdempotencyRecord, token: String)

    /** Gives up a claim after a failure that left nothing to replay, so the next retry runs the command. */
    fun release(scope: String, key: String, token: String)

    /**
     * Waits at most [timeoutMs] for the claim on [key] to settle. The caller claims again either way, so this is only
     * ever a hint: a store inside one process can wake its waiter the moment the claim settles, one shared between
     * processes can do no better than sleeping.
     */
    suspend fun awaitSettled(scope: String, key: String, timeoutMs: Long) {
        delay(timeoutMs)
    }
}

/**
 * In-memory store, for one process. Records expire [ttlMs] after they were stored (checked on get, swept on put) and
 * at most [maxSize] keys are kept: expired entries go first, then the oldest. A waiter here is woken as soon as the
 * claim it waits for settles, rather than waiting out the caller's backoff.
 */
class MemoryIdempotencyStore(
    private val ttlMs: Long = 24 * 60 * 60 * 1000L,
    private val maxSize: Int = 100_000,
    private val now: () -> Long = System::currentTimeMillis,
) : IdempotencyStore {
    /** The key is held by one run until [heldUntil], unless it renews; [waiters] complete when the run settles it. */
    private class Claim(val token: String, var heldUntil: Long) {
        val waiters = CompletableDeferred<IdempotencyRecord?>()
    }

    /** A stored [record], or a [claim] in flight. */
    private class Entry(val at: Long, val record: IdempotencyRecord?, val claim: Claim?)

    // insertion order is age order (put re-inserts), so expired and oldest entries sit at the head; guarded by itself
    private val map = LinkedHashMap<String, Entry>()

    /** Keys held: stored records and claims in flight together. */
    val size: Int get() = synchronized(map) { map.size }

    private fun expired(e: Entry, t: Long) = e.record != null && t - e.at >= ttlMs

    override fun get(scope: String, key: String): IdempotencyRecord? = synchronized(map) {
        val k = "$scope $key"
        val e = map[k] ?: return null
        if (expired(e, now())) { map.remove(k); return null }
        e.record
    }

    override fun claim(scope: String, key: String, leaseMs: Long): IdempotencyClaim = synchronized(map) {
        val k = "$scope $key"
        val t = now()
        val e = map[k]
        val record = e?.record
        val held = e?.claim
        when {
            e != null && record != null && !expired(e, t) -> IdempotencyClaim.Done(record)
            held != null && held.heldUntil > t -> IdempotencyClaim.InFlight(held.heldUntil)
            else -> {
                map.remove(k)
                val claim = Claim(UUID.randomUUID().toString(), t + leaseMs)
                insert(k, Entry(t, null, claim), t)
                held?.waiters?.complete(null) // whoever waited on the lease that ran out claims again, behind this one
                IdempotencyClaim.Owned(claim.token)
            }
        }
    }

    override fun renew(scope: String, key: String, token: String, leaseMs: Long): Boolean = synchronized(map) {
        // a lease that ran out is still this run's while nobody has taken it: renewing then costs no one anything
        val claim = map["$scope $key"]?.claim?.takeIf { it.token == token } ?: return false
        claim.heldUntil = now() + leaseMs
        true
    }

    override fun put(scope: String, key: String, record: IdempotencyRecord, token: String) {
        val k = "$scope $key"
        val claim = synchronized(map) {
            val held = map[k]?.claim?.takeIf { it.token == token } ?: return // the claim was lost: its new owner decides
            val t = now()
            map.remove(k)
            insert(k, Entry(t, record, null), t)
            held
        }
        claim.waiters.complete(record)
    }

    override fun release(scope: String, key: String, token: String) {
        val k = "$scope $key"
        val claim = synchronized(map) { map[k]?.claim?.takeIf { it.token == token }?.also { map.remove(k) } ?: return }
        claim.waiters.complete(null)
    }

    override suspend fun awaitSettled(scope: String, key: String, timeoutMs: Long) {
        val waiters = synchronized(map) { map["$scope $key"]?.claim?.waiters } ?: return
        withTimeoutOrNull(timeoutMs) { waiters.await() }
    }

    /** Sweeps expired entries off the head, evicts the oldest records while full, then adds [e]. Caller holds the lock. */
    private fun insert(k: String, e: Entry, t: Long) {
        val sweep = map.entries.iterator()
        while (sweep.hasNext()) {
            val head = sweep.next().value
            val claim = head.claim
            if (claim != null) { if (claim.heldUntil <= t) sweep.remove(); continue } // a claim in flight never expires
            if (expired(head, t)) sweep.remove() else break
        }
        if (map.size >= maxSize) {
            // claims in flight are skipped: dropping one would let a concurrent duplicate run
            val evict = map.entries.iterator()
            while (map.size >= maxSize && evict.hasNext()) {
                val claim = evict.next().value.claim
                if (claim == null || claim.heldUntil <= t) evict.remove()
            }
        }
        map[k] = e
    }
}

/** A command whose resolver already ran, so its side effect is committed, failed afterwards (e.g. projecting its shape). */
class CommittedCommandException(val error: RayfoldException) : RuntimeException(error.message)

/** Batch scheduling (spec/03): dependency waves, serial commands by id, deadlines, idempotency. */
class BatchRunner(
    private val ir: RayfoldSchemaIR,
    private val executor: Executor,
    private val views: Views,
    private val cost: Cost,
    private val idempotency: IdempotencyStore,
    private val events: EventBus,
    private val options: BatchOptions,
    private val changes: ChangeBus = ChangeBus(),
    private val instrumentation: Instrumentation = Instrumentation.NONE,
    /** Records which operations each client called (spec 11). */
    private val usage: UsageSink? = null,
    /** Completes once the server is shutting down: live queries and streams end on it with a retryable `unavailable`. */
    private val draining: Job = Job(),
    /** Counts what the server did, for an operator. */
    private val counters: Counters? = null,
) {
    private class Planned(val req: RequestOp, val op: OpDef, val explicit: Boolean, val deps: List<Int>) {
        var shape: Shape = Shape()
        var cost: Long = 0
        var failure: RayfoldException? = null
        /** Coerced during planning when the args hold no `$ref`. */
        var args: JsonObject? = null
        var resolved: Views.Resolved? = null
    }

    private class Claimed(val scope: String, val key: String, val hash: String, val token: String)

    /** Frames out of one batch: caps what resolvers produce and remembers which ops have ended. */
    private class Sink(private val ch: Channel<JsonObject>, private val maxFrames: Int) {
        private val produced = AtomicInteger()
        private val ended = ConcurrentHashMap.newKeySet<Int>()

        fun ended(id: Int) = id in ended

        /** Error and replay frames: never refused, so an op over the cap can still say so. */
        suspend fun send(f: JsonObject) { mark(f); ch.send(f) }

        /** Frames an executor produces while an op runs. */
        fun emit(f: JsonObject) {
            if (produced.incrementAndGet() > maxFrames) throw RayfoldException(Code.RESOURCE_EXHAUSTED, "Batch produced more than $maxFrames frames")
            mark(f)
            ch.trySend(f)
        }

        private fun mark(f: JsonObject) {
            if (f["fin"] == JsonPrimitive(true)) (f["id"] as? JsonPrimitive)?.content?.toIntOrNull()?.let { ended.add(it) }
        }
    }

    fun execute(envelope: RequestEnvelope, viewer: JsonElement = JsonNull): Flow<JsonObject> = execute(envelope, ExecuteOptions(viewer))

    fun execute(envelope: RequestEnvelope, opts: ExecuteOptions): Flow<JsonObject> = flow {
        val ch = Channel<JsonObject>(Channel.UNLIMITED)
        coroutineScope {
            launch {
                try { run(envelope, opts, Sink(ch, options.maxFrames)) } catch (e: Throwable) { ch.send(Frames.batchError(RayfoldException.of(e))) } finally { ch.close() }
            }
            for (f in ch) emit(f)
        }
    }

    private suspend fun run(envelope: RequestEnvelope, opts: ExecuteOptions, sink: Sink) {
        instrumentation.batch(BatchInfo(envelope.ops.size, envelope.meta)) { runBatch(envelope, opts, sink) }
    }

    private suspend fun runBatch(envelope: RequestEnvelope, opts: ExecuteOptions, sink: Sink): Outcome {
        val viewer = opts.viewer
        validate(envelope)?.let { sink.send(Frames.batchError(it)); return Outcome(it.code.wire, it.message) }

        val rawOps = envelope.raw["ops"] as? JsonArray
        val planned = envelope.ops.mapIndexed { i, req -> plan(i, req, rawOps?.getOrNull(i) as? JsonObject) }
        val total = planned.fold(0L) { acc, p -> Sat.add(acc, p.cost) }
        if (total > options.budget) {
            val over = RayfoldException(Code.RESOURCE_EXHAUSTED, "Batch cost $total exceeds budget ${options.budget}",
                data = buildJsonObject { put("cost", total); put("budget", options.budget) })
            sink.send(Frames.batchError(over))
            return Outcome(over.code.wire, over.message)
        }
        // only inline shapes whose op passed planning, in a batch within budget, are remembered by id
        for (p in planned) p.resolved?.let { r -> r.inlineId?.let { views.registerInline(it, r.shape) } }

        // One memo for the whole batch: a field loaded for an entity by one op is not loaded again by another.
        val scoped = opts.copy(
            batchState = ConcurrentHashMap(),
            client = (envelope.meta["client"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "",
            meta = envelope.meta,
        )
        val results = ConcurrentHashMap<Int, JsonElement>()
        val status = ConcurrentHashMap<Int, String>()
        val done = planned.associate { it.req.id to CompletableDeferred<Unit>() }
        // canonical JSON, as the TypeScript runtime's hashJson: the same viewer built with its keys in another order (a
        // Map's iteration order, another instance sharing the store) must land in the same scope
        val viewerScope = sha256(Canonical.hashed(viewer))
        val deadline = deadlineOf(envelope.meta["deadline"])

        val all: suspend () -> Unit = {
            coroutineScope {
                var prevCommand: Deferred<Unit>? = null
                val tasks = planned.sortedBy { it.req.id }.map { p ->
                    val gate = if (p.op.kind == "command") prevCommand else null
                    val task = async {
                        val body: suspend () -> Unit = {
                            p.deps.forEach { done[it]?.await() }
                            gate?.await()
                            runOne(p, scoped, viewerScope, results, status, sink)
                        }
                        val own = p.req.deadline
                        if (own == null) body()
                        else if (withTimeoutOrNull(own) { body() } == null) {
                            if (!sink.ended(p.req.id)) sink.send(Frames.error(p.req.id, RayfoldException(Code.DEADLINE_EXCEEDED, "Op deadline exceeded")))
                            status[p.req.id] = "failed"
                            gate?.await() // a later command still waits for the earlier one, even when this one gave up first
                        }
                        done[p.req.id]?.complete(Unit)
                        Unit
                    }
                    if (p.op.kind == "command") prevCommand = task
                    task
                }
                tasks.awaitAll()
            }
        }
        // one timer for the whole batch: every op still unfinished when it fires ends with deadline_exceeded
        val timed: suspend () -> Unit = {
            if (deadline == null) all()
            else if (withTimeoutOrNull(deadline) { all() } == null) {
                for (p in planned.sortedBy { it.req.id }) {
                    if (!sink.ended(p.req.id)) sink.send(Frames.error(p.req.id, RayfoldException(Code.DEADLINE_EXCEEDED, "Batch deadline exceeded")))
                }
            }
        }
        if (!untilCancelled(opts.cancel, timed)) {
            for (p in planned.sortedBy { it.req.id }) {
                if (!sink.ended(p.req.id)) sink.send(Frames.error(p.req.id, RayfoldException(Code.CANCELED, "Canceled")))
            }
        }
        return Outcome()
    }

    /**
     * A live query or a stream ends only when its caller goes away, so a server shutting down ends it here, with a
     * retryable error that sends the client to another server. Anything shorter is left to finish.
     */
    private suspend fun <T> untilDrained(block: suspend () -> T): T {
        if (draining.isCompleted) throw shuttingDown()
        return coroutineScope {
            val work = async { block() }
            val watch = launch { draining.join(); work.cancel() }
            try {
                work.await()
            } catch (e: CancellationException) {
                ensureActive() // our own cancellation still propagates
                if (work.isCancelled && draining.isCompleted) throw shuttingDown()
                throw e
            } finally {
                watch.cancel()
            }
        }
    }

    private fun shuttingDown() = RayfoldException(Code.UNAVAILABLE, "The server is shutting down")

    /** Runs [block]; false when [cancel] completed first and cancelled it. */
    private suspend fun untilCancelled(cancel: Job?, block: suspend () -> Unit): Boolean {
        if (cancel == null) { block(); return true }
        return coroutineScope {
            val work = async { block() }
            val watch = launch { cancel.join(); work.cancel() }
            try {
                work.await()
                true
            } catch (e: CancellationException) {
                ensureActive() // our own cancellation still propagates
                if (!work.isCancelled) throw e
                false
            } finally {
                watch.cancel()
            }
        }
    }

    /**
     * Shape, args, cost and limits for one op. An op whose args fail coercion never runs, so it costs nothing and
     * reports the error when its turn comes; args holding a `$ref` are costed raw, where unknown page sizes count high.
     */
    private fun plan(i: Int, req: RequestOp, raw: JsonObject?): Planned {
        val op = ir.ops[req.op] ?: error("validate() admits known operations only")
        val p = Planned(req, op, req.shape != null, Args.collectRefs(req.args).toList())
        try {
            raw?.get("deadline")?.let { d -> if (d !is JsonNull && deadlineOf(d) == null) throw RayfoldException(Code.INVALID_ARGUMENT, "ops[$i].deadline: $DEADLINE_RULE") }
            val resolved = views.resolveRequestShape(req.shape, op.returns, options.trustedShapes)
            p.shape = resolved.shape
            val args = if (p.deps.isEmpty()) Args.coerce(ir, op.args, req.args, "${op.name}()").also { p.args = it } else req.args
            val est = cost.estimate(op, args, p.shape, req.vars)
            if (est.depth > options.maxDepth) throw RayfoldException(Code.RESOURCE_EXHAUSTED, "Shape depth ${est.depth} exceeds ${options.maxDepth}")
            if (est.fields > options.maxFields) throw RayfoldException(Code.RESOURCE_EXHAUSTED, "Shape selects ${est.fields} fields, max ${options.maxFields}")
            p.cost = est.cost
            p.resolved = resolved
        } catch (e: RayfoldException) { p.failure = e }
        return p
    }

    private fun validate(env: RequestEnvelope): RayfoldException? {
        fun bad(m: String) = RayfoldException(Code.INVALID_ARGUMENT, m)
        val rawOps = env.raw["ops"] as? JsonArray ?: return bad("Body must be { ops: [...] }")
        if (env.ops.isEmpty()) return bad("ops must not be empty")
        if (env.ops.size > options.maxOps) return RayfoldException(Code.RESOURCE_EXHAUSTED, "At most ${options.maxOps} ops per batch")
        env.raw["meta"]?.let { meta ->
            try { StrictJson.check(meta, "meta") } catch (e: RayfoldException) { return e }
            (meta as? JsonObject)?.get("deadline")?.let { d -> if (d !is JsonNull && deadlineOf(d) == null) return bad("meta.deadline: $DEADLINE_RULE") }
        }
        val ids = mutableSetOf<Int>()
        env.ops.forEachIndexed { i, req ->
            val raw = rawOps[i] as? JsonObject ?: return bad("ops[$i]: expected an object")
            if (req.id <= 0) return bad("ops[$i].id: expected a positive integer")
            if (!ids.add(req.id)) return bad("ops[$i].id: duplicate id ${req.id}")
            val op = ir.ops[req.op]
            if (req.op.isEmpty() || op == null) return bad("ops[$i].op: unknown operation \"${req.op}\"")
            raw["args"]?.let { if (it !is JsonObject) return bad("ops[$i].args: expected an object") }
            // before anything below walks these values recursively
            try {
                for (k in listOf("args", "vars", "ifVersion")) raw[k]?.let { StrictJson.check(it, "ops[$i].$k") }
            } catch (e: RayfoldException) { return e }
            for (d in Args.collectRefs(req.args)) {
                if (d <= 0) return bad("ops[$i].args: bad \$ref")
                if (d >= req.id) return bad("ops[$i].args: \$ref to op $d must point to an earlier op")
                if (d !in ids) return bad("ops[$i].args: \$ref to unknown op $d")
            }
            if (req.live && op.kind != "query") return bad("ops[$i].live: only queries can be live")
            // `@live(false)` opts a query out; declared in the schema and enforced nowhere, so it opened live anyway
            if (req.live && (op.annotations.find("live")?.args?.get("value") as? JsonPrimitive)?.booleanOrNull == false) {
                return bad("ops[$i].live: ${op.name} is declared @live(false)")
            }
        }
        return null
    }

    private suspend fun runOne(p: Planned, opts: ExecuteOptions, viewerScope: String, results: MutableMap<Int, JsonElement>, status: MutableMap<Int, String>, sink: Sink) {
        instrumentation.op(OpInfo(p.req.id, p.op.name, p.op.kind, p.cost)) { runOp(p, opts, viewerScope, results, status, sink) }
    }

    /** Runs one op and sends its frames; the [Outcome] says whether it failed. */
    private suspend fun runOp(p: Planned, opts: ExecuteOptions, viewerScope: String, results: MutableMap<Int, JsonElement>, status: MutableMap<Int, String>, sink: Sink): Outcome {
        val viewer = opts.viewer
        val id = p.req.id
        suspend fun fail(e: Throwable): Outcome {
            val re = RayfoldException.of(e)
            sink.send(Frames.error(id, re))
            status[id] = "failed"
            countFailure(p, re.code.wire, re.type)
            return Outcome(re.code.wire, re.message)
        }
        p.failure?.let { return fail(it) }
        for (d in p.deps) if (status[d] != "ok") {
            return fail(RayfoldException(Code.FAILED_PRECONDITION, "Depends on op $d, which failed", "DependencyFailed", buildJsonObject { put("op", d) }))
        }
        return try {
            val args = p.args ?: run {
                val rawArgs = Args.resolveRefs(p.req.args, { opId, path -> Args.getPath(results[opId], path) }, "ops.$id.args") as JsonObject
                Args.coerce(ir, p.op.args, rawArgs, "${p.op.name}()")
            }
            usage?.record(UsageEvent(p.op.name, "", opts.client), System.currentTimeMillis())
            // the op's own job, so a resolver (and Values.isCancelled() for Java) can see a deadline or a caller
            // hanging up. Left at its default here, isCancelled answered false for every resolver ever written.
            val job = currentCoroutineContext()[Job]
            val ctx = RayfoldContext(viewer, p.req.simulate, id, p.op.name, p.req.vars, events, isCancelled = { job?.isActive == false }, compact = p.req.compact, ifVersion = p.req.ifVersion, batch = opts.batchState ?: ConcurrentHashMap(), shape = p.shape, client = opts.client, meta = opts.meta)
            when (p.op.kind) {
                "query" -> {
                    if (p.req.live) {
                        if (!opts.allowLive) throw RayfoldException(Code.UNIMPLEMENTED, "Live queries are served over the WebSocket transport")
                        untilDrained { runLive(p, args, ctx, sink, results) } // returns only by cancellation or failure
                    } else results[id] = executor.runQuery(p.op, args, p.shape, p.explicit, p.cost, ctx, sink::emit)
                }
                "stream" -> untilDrained { executor.runStream(p.op, args, p.shape, p.explicit, ctx, sink::emit, options.maxStreamItems) }
                // the command sent its error frame itself (a failure after committing, or the replay of one), so it is
                // reported and counted here rather than through fail(), which would send a second one
                "command" -> command(p, args, ctx, viewerScope, results, sink, opts.keyOptional)?.let { err ->
                    status[id] = "failed"
                    val code = (err["code"] as? JsonPrimitive)?.content ?: Code.INTERNAL.wire
                    countFailure(p, code, (err["type"] as? JsonPrimitive)?.content)
                    return Outcome(code, (err["message"] as? JsonPrimitive)?.content)
                }
            }
            status[id] = "ok"
            counters?.add("rayfold.ops", mapOf("kind" to p.op.kind, "outcome" to "ok"))
            Outcome()
        } catch (e: CancellationException) {
            throw e // a deadline or cancel must reach withTimeoutOrNull, not become an `internal` error frame
        } catch (e: CommittedCommandException) {
            fail(e.error)
        } catch (e: Throwable) {
            fail(e)
        }
    }

    /**
     * Counted whether or not an Instrumentation hook was configured: an operator asking what a server is doing should
     * not first have to wire up tracing.
     *
     * Every declared error is `domain` on the wire and carries its name in `type`, so counting the code alone would
     * put a schema's whole error vocabulary in one bucket. Both labels come from the schema, so the series stay
     * bounded by it.
     */
    private fun countFailure(p: Planned, code: String, type: String?) {
        counters?.add("rayfold.ops", mapOf("kind" to p.op.kind, "outcome" to code))
        counters?.add("rayfold.errors", mapOf("op" to p.op.name, "code" to code, "type" to (type ?: "")))
    }

    /** Runs or replays a command; the wire error when it ended with an error frame already sent (a committed failure or its replay). */
    private suspend fun command(p: Planned, args: JsonObject, ctx: RayfoldContext, viewerScope: String, results: MutableMap<Int, JsonElement>, sink: Sink, keyOptional: Boolean): JsonObject? {
        val op = p.op
        val idem = op.annotations.find("idempotent")
        val optedOut = idem != null && idem.args["value"] == JsonPrimitive(false)
        val key = p.req.key
        // keyOptional lets an idempotent HTTP method omit the key; a key that is sent must still be well-formed
        if (!optedOut && !(keyOptional && key == null) && (key == null || key.length < 16 || key.length > 128)) {
            throw RayfoldException(Code.INVALID_ARGUMENT, "${op.name}(): commands require an idempotency key of 16-128 characters")
        }
        // @simulate is the author's promise that the resolver honours ctx.simulate; without it a dry run would commit
        if (ctx.simulate && op.annotations.find("simulate") == null) throw RayfoldException(Code.FAILED_PRECONDITION, "${op.name}() does not support dry runs")
        // before any replay: a caller who lost permission gets the policy error, never the stored result
        executor.checkOpPolicy(op, "write", args, ctx)
        if (key == null || ctx.simulate) return execute(p, args, ctx, results, sink, null)
        // every anonymous caller shares one scope, so a key would let one stranger replay another's result
        if (ctx.viewer is JsonNull) throw RayfoldException(Code.UNAUTHENTICATED, "${op.name}(): idempotency keys need an identified caller")
        // The binding a record carries (spec 12 section 4.2). Every runtime hashes it the same way, so a server of
        // either can replay a record the other wrote when they share a store.
        val hash = sha256(Canonical.hashed(buildJsonObject { put("op", JsonPrimitive(op.name)); put("args", args) }))
        var wait = FIRST_WAIT_MS
        while (true) {
            when (val c = idempotency.claim(viewerScope, key, options.idempotencyLeaseMs)) {
                is IdempotencyClaim.Done -> {
                    counters?.add("rayfold.idempotency", mapOf("claim" to "done"))
                    return replay(c.record, hash, key, p, results, sink)
                }
                is IdempotencyClaim.Owned -> {
                    counters?.add("rayfold.idempotency", mapOf("claim" to "owned"))
                    return execute(p, args, ctx, results, sink, Claimed(viewerScope, key, hash, c.token))
                }
                // Another run owns the key: wait, then claim again. A store in this process wakes us the moment that run
                // settles, but one behind a database cannot, so it is claiming again, not the wake-up, that answers us.
                // The wait ends early when the op's deadline passes or the caller goes away, and the op ends with it.
                is IdempotencyClaim.InFlight -> {
                    counters?.add("rayfold.idempotency", mapOf("claim" to "inflight"))
                    idempotency.awaitSettled(viewerScope, key, wait)
                    wait = (wait * 2).coerceAtMost(MAX_WAIT_MS)
                }
            }
        }
    }

    /**
     * Runs [body] while the claim's lease is renewed every third of it, so a command that outlives one lease keeps its
     * key. Renewals stop as soon as the store says the claim is gone; the [IdempotencyStore.put] that follows is then
     * ignored, and the run that took the key over answers the retries.
     */
    private suspend fun <T> holding(claim: Claimed?, body: suspend () -> T): T {
        if (claim == null) return body()
        val lease = options.idempotencyLeaseMs
        return coroutineScope {
            val renewals = launch {
                while (true) {
                    delay((lease / 3).coerceAtLeast(1))
                    if (!idempotency.renew(claim.scope, claim.key, claim.token, lease)) break
                }
            }
            try { body() } finally { renewals.cancel() }
        }
    }

    private suspend fun execute(p: Planned, args: JsonObject, ctx: RayfoldContext, results: MutableMap<Int, JsonElement>, sink: Sink, claim: Claimed?): JsonObject? {
        var settled = false
        var committed = false
        try {
            val (result, frame, compactFrame) = holding(claim) {
                executor.runCommand(p.op, args, p.shape, p.explicit, p.cost, ctx, sink::emit, policyChecked = true) { committed = true }
            }
            claim?.let { idempotency.put(it.scope, it.key, IdempotencyRecord(it.hash, frame, compactFrame), it.token) }
            settled = true
            results[p.req.id] = result
            // a dry run never publishes live-query changes (spec 12 section 6); a replay changed nothing, so it is not here
            if (!ctx.simulate) changes.publish(Live.changeFromPatch((frame["patch"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()))
            return null
        } catch (e: CommittedCommandException) {
            // the side effect happened, so this failure is the answer a retry must get, not a second run
            val ef = Frames.error(p.req.id, e.error)
            claim?.let { idempotency.put(it.scope, it.key, IdempotencyRecord(it.hash, ef, ef), it.token) }
            settled = true
            sink.send(ef)
            return e.error.toWire()
        } catch (e: CancellationException) {
            // The deadline passed, or the caller went away, after the resolver had already committed. Releasing the key
            // here would let the retry run the command a second time, so the key keeps this answer instead. The batch
            // sends the op's canceled or deadline_exceeded frame itself; this one is only ever replayed.
            if (committed) claim?.let {
                val ef = Frames.error(p.req.id, RayfoldException(Code.CANCELED, "${p.op.name}() committed, then the op ended before its result was delivered"))
                idempotency.put(it.scope, it.key, IdempotencyRecord(it.hash, ef, ef), it.token)
                settled = true
            }
            throw e
        } finally {
            if (!settled) claim?.let { idempotency.release(it.scope, it.key, it.token) }
        }
    }

    private suspend fun replay(prior: IdempotencyRecord, hash: String, key: String, p: Planned, results: MutableMap<Int, JsonElement>, sink: Sink): JsonObject? {
        if (prior.argsHash != hash) throw RayfoldException(Code.ALREADY_EXISTS, "Idempotency key $key was used for another operation or other arguments")
        // the retry's own compact flag picks the form; meta stays even when compact because it carries the replay marker
        val frame = if (p.req.compact) prior.compactFrame else prior.frame
        val metaObj = JsonObject((frame["meta"] as? JsonObject ?: JsonObject(emptyMap())) + ("replay" to JsonPrimitive(true)))
        // the stored frame carries the first run's op id; the answer belongs to the retrying op
        sink.send(JsonObject(frame + ("id" to JsonPrimitive(p.req.id)) + ("meta" to metaObj)))
        // a recorded failure is the answer this retry gets, so the op ends the way the first run ended
        val ok = prior.frame["ok"] ?: return prior.frame["error"] as? JsonObject ?: JsonObject(emptyMap())
        results[p.req.id] = ok
        return null
    }

    /**
     * Live query loop (spec 08): the first result, then a re-run on every intersecting change, sending a `patch` frame
     * when only entity fields changed and a `data` frame when the structure did. It never returns normally: it ends by
     * cancellation (the transport's cancel job, a deadline, the collector going away), after which the batch reports the
     * op as `canceled` or `deadline_exceeded`, or by a failing re-run, which the caller reports as the op's error.
     */
    private suspend fun runLive(p: Planned, args: JsonObject, ctx: RayfoldContext, sink: Sink, results: MutableMap<Int, JsonElement>) {
        val id = p.req.id
        // read sets and diffs need `$type`, so the query always runs in full form; compaction happens on the way out
        val runCtx = if (!ctx.compact) ctx else RayfoldContext(ctx.viewer, ctx.simulate, ctx.opId, ctx.opName, ctx.vars, ctx.events, ctx.isCancelled, compact = false, ifVersion = ctx.ifVersion, batch = ctx.batch, shape = ctx.shape, client = ctx.client, meta = ctx.meta)
        class Run(val frames: List<JsonObject>, val data: JsonElement, val unions: Set<String>)
        // the first run shares the batch's loader memo like any op; a re-run gets a fresh one. The memo remembers a
        // field's load per entity, and a re-run exists to read what changed: with the memo kept, a loaded field would
        // come back as it was on the first run for as long as the query stayed open.
        var first = true
        suspend fun collect(): Run {
            val frames = mutableListOf<JsonObject>()
            val unions = mutableSetOf<String>()
            val runIn = if (first) runCtx else runCtx.copy(batch = ConcurrentHashMap())
            first = false
            executor.runQuery(p.op, args, p.shape, p.explicit, p.cost, runIn, emit = { frames.add(it) }, unionPaths = unions)
            return Run(frames, Live.foldFrames(frames), unions)
        }
        fun wire(f: JsonObject, unions: Set<String>): JsonObject {
            if (!ctx.compact || "data" !in f) return f
            val at = (f["at"] as? JsonPrimitive)?.content ?: ""
            return JsonObject(f - "meta" + ("data" to Executor.stripTypes(f["data"] ?: JsonNull, unions, at)))
        }
        val typeSet = reachableEntityTypes(p.op.returns)
        // null until the first result is known: a change that lands while it runs schedules a re-run instead of being lost
        val readSet = AtomicReference<Set<String>?>(null)
        // changes before a re-run starts share it; changes during a run schedule exactly one more. The channel only
        // wakes the loop (it can hold one wake-up beside the one handed over); `dirty` decides whether to run.
        val dirty = AtomicBoolean(false)
        val wake = Channel<Unit>(Channel.CONFLATED)
        val off = changes.subscribe { c ->
            val reads = readSet.get()
            if (reads == null || p.op.name in c.ops || c.keys.any { k -> k in reads || k.substringBefore(':') in typeSet }) {
                dirty.set(true)
                wake.trySend(Unit)
            }
        }
        try {
            val first = collect()
            var current = first.data
            readSet.set(Live.readSetOf(current))
            for (f0 in first.frames) {
                val f = wire(f0, first.unions)
                if (f["fin"] == JsonPrimitive(true) && "data" !in f && "error" !in f) continue // keep the op open
                sink.emit(if ("data" in f && "at" !in f) JsonObject(f - "fin") else f)
            }
            results[id] = current
            counters?.add("rayfold.live.opened", mapOf("op" to p.op.name))
            while (true) {
                wake.receive()
                if (!dirty.getAndSet(false)) continue
                counters?.add("rayfold.live.reran", mapOf("op" to p.op.name))
                val next = collect()
                val d = Live.diffResults(current, next.data)
                current = next.data
                readSet.set(Live.readSetOf(current))
                results[id] = current
                when (d) {
                    is Live.Diff.Patch -> sink.emit(Frames.patch(id, d.patch))
                    is Live.Diff.Data -> sink.emit(wire(buildJsonObject { put("id", id); put("data", d.data); put("meta", buildJsonObject { put("cost", p.cost) }) }, next.unions))
                    null -> {}
                }
            }
        } finally {
            off()
            counters?.add("rayfold.live.closed", mapOf("op" to p.op.name))
        }
    }

    /** Entity types reachable from a result type: a new entity of such a type may change a live result's membership. */
    private fun reachableEntityTypes(root: TypeRef, maxDepth: Int = 4): Set<String> {
        val out = mutableSetOf<String>()
        fun visit(t: TypeRef, depth: Int) {
            val name = t.baseName()
            val def = ir.types[name] ?: return
            if (depth > maxDepth) return
            if (def.kind == "entity" && !out.add(name)) return
            for (f in def.fields) visit(f.type, depth + 1)
            if (def.kind == "union") for (m in def.members) visit(TypeRef("named", m), depth + 1)
            if (t.kind == "named") t.args?.forEach { visit(it, depth) }
        }
        visit(root, 0)
        return out
    }

    private fun sha256(s: String): String = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }

    private companion object {
        const val DEADLINE_RULE = "expected an integer number of milliseconds from 0 to ${RequestOp.MAX_DEADLINE_MS}"

        /** Backoff between claims while another run holds the key: 50, 100, 200, 400, then 500 ms. */
        const val FIRST_WAIT_MS = 50L
        const val MAX_WAIT_MS = 500L

        fun deadlineOf(v: JsonElement?): Long? = StrictJson.integerOrNull(v)?.toLongOrNull()?.takeIf { it in 0..RequestOp.MAX_DEADLINE_MS }
    }
}

/** Canonical JSON: sorted keys, no whitespace (spec/01 section 9). */
object Canonical {
    fun json(v: JsonElement): String = when (v) {
        is JsonNull -> "null"
        is JsonPrimitive -> if (v.isString) Shapes.Json.quote(v.content) else v.content
        is JsonArray -> "[" + v.joinToString(",") { json(it) } + "]"
        is JsonObject -> "{" + v.keys.sorted().joinToString(",") { Shapes.Json.quote(it) + ":" + json(v.getValue(it)) } + "}"
    }

    /**
     * Canonical JSON for the two hashes servers of different implementations must agree on: the scope a record is kept
     * under and the binding it carries (spec 12 section 4). It differs from [json] in one way, and only here: a number
     * is written in the one form every implementation can produce from the value, rather than as the sender wrote it,
     * so that `2.50` and `2.5` - the same number, two literals - hash alike. [json] itself is left as it is because it
     * writes the wire, the ETags and the schema hash, where the bytes are already settled.
     */
    fun hashed(v: JsonElement): String = when (v) {
        is JsonNull -> "null"
        is JsonPrimitive -> if (v.isString) Shapes.Json.quote(v.content) else number(v.content)
        is JsonArray -> "[" + v.joinToString(",") { hashed(it) } + "]"
        is JsonObject -> "{" + v.keys.sorted().joinToString(",") { Shapes.Json.quote(it) + ":" + hashed(v.getValue(it)) } + "}"
    }

    /**
     * A JSON number as ECMAScript writes it, which is the form the specification names: the shortest decimal that reads
     * back as the same value, without a trailing `.0`, in exponent form only below 1e-6 or from 1e21 up. Anything that
     * is not a number in double range (`true`, or a value too large to be one) is left as it stands.
     */
    fun number(literal: String): String {
        val d = literal.toDoubleOrNull() ?: return literal
        if (d.isNaN() || d.isInfinite()) return literal
        if (d == 0.0) return "0" // ECMAScript writes negative zero as "0" too
        // Java's own shortest round-trip digits, read back as digits and a decimal exponent: the value is
        // `digits * 10^(point - digits.length)`, which is what the ECMAScript rules below are written against.
        //
        // Java is not quite ECMAScript here. `Double.toString` must emit at least one digit after the point, so where
        // a single digit would read back exactly it still writes two: Double.MIN_VALUE comes out as 4.9E-324 where
        // ECMAScript, which asks only for the fewest digits that round-trip, writes 5e-324. Shortening while the value
        // still reads back as the same double is that rule, and it leaves every other number alone.
        var decimal = java.math.BigDecimal(d.toString()).stripTrailingZeros()
        while (decimal.precision() > 1) {
            val shorter = decimal.round(java.math.MathContext(decimal.precision() - 1)).stripTrailingZeros()
            if (shorter.toDouble() != d) break
            decimal = shorter
        }
        val digits = decimal.unscaledValue().abs().toString()
        val point = digits.length - decimal.scale()
        val sign = if (d < 0) "-" else ""
        val body = when {
            point in digits.length..21 -> digits + "0".repeat(point - digits.length)
            point in 1..21 -> digits.substring(0, point) + "." + digits.substring(point)
            point in -5..0 -> "0." + "0".repeat(-point) + digits
            else -> {
                val exponent = point - 1
                val mantissa = if (digits.length == 1) digits else digits[0] + "." + digits.substring(1)
                mantissa + "e" + (if (exponent < 0) "-" else "+") + kotlin.math.abs(exponent)
            }
        }
        return sign + body
    }
}

fun CoroutineScope.unused() = Unit
