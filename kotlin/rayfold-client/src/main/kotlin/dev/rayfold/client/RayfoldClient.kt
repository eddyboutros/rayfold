package dev.rayfold.client

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.transformWhile
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.cancellation.CancellationException
import java.util.concurrent.atomic.AtomicReference

/** An error the server reported for an op, or for the whole batch. `isType("OutOfStock")` narrows on a declared error. */
class RayfoldClientException(
    val code: String,
    message: String,
    val type: String? = null,
    val data: JsonElement? = null,
    val path: String? = null,
    val retryable: Boolean = code in setOf("unavailable", "deadline_exceeded", "aborted"),
) : RuntimeException(message) {
    fun isType(type: String): Boolean = code == "domain" && this.type == type

    internal companion object {
        fun of(error: JsonObject): RayfoldClientException {
            fun s(k: String) = (error[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
            return RayfoldClientException(
                code = s("code") ?: "unknown",
                message = s("message") ?: "",
                type = s("type"),
                data = error["data"],
                path = s("path"),
                retryable = (error["retryable"] as? JsonPrimitive)?.booleanOrNull ?: (s("code") in setOf("unavailable", "deadline_exceeded", "aborted")),
            )
        }
    }
}

data class ClientOptions(
    /** Sent as meta.client, such as "android/2.3.0", for the server's usage records. */
    val client: String? = null,
    /** Batch deadline in milliseconds. */
    val deadlineMs: Long? = null,
    /** Operation names that are queries: batches of only these go out as safe requests. */
    val queries: Set<String> = emptySet(),
    /** Idempotency key for commands that have none. */
    val keyGen: () -> String = { UUID.randomUUID().toString().replace("-", "") },
    val now: () -> Long = System::currentTimeMillis,
    val cache: RayfoldCache? = null,
    /**
     * Queue commands made while the server cannot be reached (sub-profile `sync`) and send them, in order and with their
     * idempotency keys, on [RayfoldClient.drain] (call it at startup and when the device is back online) and whenever a
     * new command is made while others wait. Their predictions stay shown.
     */
    val offline: OfflineOptions? = null,
    /**
     * `Type.field` to its `@merge` policy (spec 08 section 5), so a prediction settles the way the schema says.
     * A server built on rayfold-core can produce this map from its IR; the client stays free of the schema types.
     */
    val mergePolicies: Map<String, String> = emptyMap(),
)

data class OfflineOptions(val storage: QueueStorage = MemoryQueueStorage())

/** Where a query's answer may come from. */
enum class Policy {
    /** Always ask the server (the default). */
    NETWORK,

    /** Use a fresh cached result when there is one. */
    CACHE,
}

/** One op inside a [Batch]. [ref] points a later op's argument at part of this op's result. */
class OpHandle internal constructor(val id: Int, internal val request: JsonObject) {
    internal val result = CompletableDeferred<JsonElement>()

    /** A command's answer as the cache holds it, entities replaced by refs, for reading back once settled. */
    @Volatile
    internal var skeleton: JsonElement? = null

    /** `{ "$ref": "<id>.path" }`: the server fills it in with that part of this op's result before the later op runs. */
    fun ref(path: String): JsonObject = JsonObject(mapOf("\$ref" to JsonPrimitive("$id.$path")))

    /** This op's result, once the batch ran; throws [RayfoldClientException] when the op failed. */
    suspend fun await(): JsonElement = result.await()
}

/** Several ops in one request. Commands run in order; later ops can use earlier results through [OpHandle.ref]. */
class Batch internal constructor(private val client: RayfoldClient) {
    private val ops = mutableListOf<OpHandle>()
    private var nextId = 1

    @JvmOverloads
    fun query(op: String, args: JsonObject = EMPTY, shape: String? = null, vars: JsonObject? = null, live: Boolean = false): OpHandle =
        add(request(nextId++, op, args, shape, vars, null, null, false, live))

    @JvmOverloads
    fun command(op: String, args: JsonObject = EMPTY, shape: String? = null, key: String? = null, ifVersion: JsonElement? = null, simulate: Boolean = false): OpHandle =
        add(request(nextId++, op, args, shape, null, key ?: client.newKey(), ifVersion, simulate, false))

    private fun add(req: JsonObject): OpHandle = OpHandle((req["id"] as JsonPrimitive).content.toInt(), req).also { ops.add(it) }

    /** Sends the batch; every handle settles as its frames arrive. [onFrame] sees each frame after the cache took it in. */
    suspend fun run(onFrame: ((JsonObject) -> Unit)? = null) = client.runBatch(ops.toList(), onFrame)
}

internal val EMPTY = JsonObject(emptyMap())

private fun request(id: Int, op: String, args: JsonObject, shape: String?, vars: JsonObject?, key: String?, ifVersion: JsonElement?, simulate: Boolean, live: Boolean): JsonObject {
    val m = linkedMapOf<String, JsonElement>("id" to JsonPrimitive(id), "op" to JsonPrimitive(op), "args" to args)
    shape?.let { m["shape"] = JsonPrimitive(it) }
    vars?.let { m["vars"] = it }
    key?.let { m["key"] = JsonPrimitive(it) }
    ifVersion?.let { m["ifVersion"] = it }
    if (simulate) m["simulate"] = JsonPrimitive(true)
    if (live) m["live"] = JsonPrimitive(true)
    return JsonObject(m)
}

/**
 * The Rayfold client for Kotlin and Android (mirrors packages/client). Results go into a normalized cache that command
 * patches keep current, so [watch] flows follow changes without refetching.
 *
 * ```kotlin
 * val client = RayfoldClient(HttpTransport("https://api.example/rayfold", headers = { mapOf("Authorization" to "Bearer $token") }))
 * val book = client.queryAs<Book>("book", args("id" to "b1"), shape = "{ id title stock }")
 * client.watch("book", args("id" to "b1")).collect { render(it) }
 * ```
 */
class RayfoldClient @JvmOverloads constructor(private val transport: Transport, private val options: ClientOptions = ClientOptions()) {
    val cache: RayfoldCache = options.cache ?: RayfoldCache(options.now, options.mergePolicies)
    private val queries = ConcurrentHashMap.newKeySet<String>().apply { addAll(options.queries) }
    private val queue: OfflineQueue? = options.offline?.let { o ->
        OfflineQueue(o.storage, { c -> settled(c, sendCommand(c)) }, { c -> cache.removeLayer(c.key) }, { c -> c.optimistic?.let { cache.addLayer(c.key, it) } })
    }

    /** Orders commands by when they were made, across restarts too: it starts from the clock. */
    private val nextSeq = AtomicLong(options.now())

    fun newKey(): String = options.keyGen()

    fun batch(): Batch = Batch(this)

    /** Tells the client which ops are queries, so all-query batches go out as safe requests. */
    fun markQueries(vararg names: String) {
        queries.addAll(names)
    }

    /** One query; returns the result, which later reads of the same entities keep coherent through the cache. */
    @JvmOverloads
    suspend fun query(op: String, args: JsonObject = EMPTY, shape: String? = null, policy: Policy = Policy.NETWORK, vars: JsonObject? = null): JsonElement {
        if (policy == Policy.CACHE) {
            val cached = cache.getResult(RayfoldCache.resultKey(op, args, shape, vars))
            if (cached != null && !cached.stale && cached.keys.none { cache.isStale(it) }) return cache.denormalize(cached.data)
        }
        val b = batch()
        val h = b.query(op, args, shape, vars)
        b.run()
        return h.await()
    }

    /**
     * One command, with an idempotency key so a retry never runs it twice. [optimistic] is the change it is expected to
     * make, shown in the cache at once: the server's patch replaces it when the command succeeds, and it is rolled back
     * when the command fails. With `offline`, a command made while the server is unreachable waits in the queue (and
     * this suspends) until [drain] sends it.
     */
    @JvmOverloads
    suspend fun command(op: String, args: JsonObject = EMPTY, shape: String? = null, key: String? = null, ifVersion: JsonElement? = null, optimistic: List<OptimisticOp>? = null): JsonElement {
        val c = QueuedCommand(key ?: newKey(), op, args, shape, ifVersion, optimistic?.takeIf { it.isNotEmpty() }, options.now(), nextSeq.getAndIncrement())
        c.optimistic?.let { cache.addLayer(c.key, it) }
        // Behind the commands still waiting, so the server sees them in the order they were made; and the queue is tried
        // again now, as nothing else would: this client has no network events to go by, and it may have been restarted
        // with the commands of a previous run waiting.
        if (queue != null && queue.size > 0) return coroutineScope {
            val sent = async(start = CoroutineStart.UNDISPATCHED) { queue.add(c) }
            queue.drain()
            sent.await()
        }
        return try {
            settled(c, sendCommand(c))
        } catch (e: CancellationException) {
            cache.removeLayer(c.key)
            throw e
        } catch (e: Exception) {
            if (queue != null && isUnreachable(e)) return queue.add(c) // its prediction stays until it is sent
            cache.removeLayer(c.key)
            throw e
        }
    }

    /** The command's result, and its answer as the cache holds it. */
    private suspend fun sendCommand(c: QueuedCommand): Pair<JsonElement, JsonElement?> {
        val b = batch()
        val h = b.command(c.op, c.args, c.shape, c.key, c.ifVersion)
        b.run()
        return h.await() to h.skeleton
    }

    /** Drops the command's prediction and returns its result as the server left it, not as it was predicted. */
    private fun settled(c: QueuedCommand, sent: Pair<JsonElement, JsonElement?>): JsonElement {
        if (c.optimistic == null) return sent.first
        cache.removeLayer(c.key)
        return sent.second?.let { cache.denormalize(it) } ?: sent.first
    }

    /** Commands waiting for the server (option `offline`), oldest first. */
    val queued: List<QueuedCommand> get() = queue?.commands ?: emptyList()

    /** Sends the waiting commands in order; returns how many still wait because the server is still unreachable. */
    suspend fun drain(): Int = queue?.drain() ?: 0

    /** Follows the queue: a command queued, sent, or refused when it finally went out. Returns the function that stops it. */
    fun onQueue(listener: (QueueEvent) -> Unit): () -> Unit = queue?.subscribe(listener) ?: {}

    /** The items of a stream op; the flow ends when the server finishes, and cancelling it stops the stream. */
    @JvmOverloads
    fun stream(op: String, args: JsonObject = EMPTY, shape: String? = null): Flow<JsonElement> = flow {
        var fin = false
        emitAll(
            transport.send(envelope(listOf(request(1, op, args, shape, null, null, null, false, false))), false).transformWhile { f ->
                val error = f["error"] as? JsonObject
                fin = (f["fin"] as? JsonPrimitive)?.booleanOrNull == true
                if ("item" in f) emit(cache.denormalize(cache.normalize(f["item"] ?: JsonNull)))
                if (error != null) throw RayfoldClientException.of(error)
                !fin
            },
        )
        // frames that stop without the server's fin are a response cut short, not the end of the stream
        if (!fin) throw RayfoldClientException("unavailable", "The stream $op ended without fin")
    }

    /**
     * The query's result now, then again whenever its own entities change in the cache (by a command's patch, a live
     * query or another query), without refetching. A change to another result of the same op is not reported.
     */
    @JvmOverloads
    fun watch(op: String, args: JsonObject = EMPTY, shape: String? = null, policy: Policy = Policy.NETWORK): Flow<JsonElement> = callbackFlow {
        val rk = RayfoldCache.resultKey(op, args, shape, null)
        val ready = AtomicBoolean(false)
        val seen = AtomicReference<CachedResult?>(null)
        val off = cache.subscribe { change ->
            val r = cache.getResult(rk) ?: return@subscribe
            if (!ready.get()) return@subscribe
            val hit = r !== seen.get() || change.keys.any { it in r.keys } || (op in change.ops && r.stale)
            if (hit) {
                seen.set(r)
                trySend(cache.denormalize(r.data))
            }
        }
        launch {
            try {
                val d = query(op, args, shape, policy)
                ready.set(true)
                val r = cache.getResult(rk)
                seen.set(r)
                // the cache, not the response, so a change that landed in between is not lost
                send(r?.let { cache.denormalize(it.data) } ?: d)
            } catch (e: Exception) {
                close(e)
            }
        }
        awaitClose { off() }
    }

    /**
     * A live query (extension `live`): the server keeps it open and pushes every change, whoever made it. The flow
     * gives the current result now and after each change; cancelling it unsubscribes.
     *
     * It outlives the server it was opened on, as the TypeScript client's does: a retryable end (a server draining in
     * a rolling deploy, a dropped connection, a response that simply ended) opens it again after half a second,
     * doubling to thirty while it keeps failing and starting over once data arrives. [onError] hears each failure and
     * whether it is being retried; an error that would recur, such as `permission_denied`, ends the flow with it.
     */
    @JvmOverloads
    fun live(op: String, args: JsonObject = EMPTY, shape: String? = null, onError: ((Throwable, Boolean) -> Unit)? = null): Flow<JsonElement> = channelFlow {
        val rk = RayfoldCache.resultKey(op, args, shape, null)
        var failures = 0
        while (true) {
            val failure: Throwable = try {
                var ended: Throwable? = null
                val b = batch()
                val h = b.query(op, args, shape, live = true)
                b.run { f ->
                    val id = (f["id"] as? JsonPrimitive)?.intOrNull
                    val error = f["error"] as? JsonObject
                    when {
                        // an error for the whole batch is this query's too: a draining server's 503, a refused envelope
                        id == null && error != null -> if (ended == null) ended = RayfoldClientException.of(error)
                        id != h.id -> {}
                        error != null -> if (ended == null) ended = RayfoldClientException.of(error)
                        ("data" in f && "at" !in f) || "patch" in f || "fin" in f -> {
                            failures = 0 // the connection is good again
                            cache.getResult(rk)?.let { trySend(cache.denormalize(it.data)) }
                        }
                    }
                }
                ended ?: RayfoldClientException("unavailable", "The live query $op ended without an error")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                e
            }
            val retrying = failure !is RayfoldClientException || failure.retryable
            onError?.invoke(failure, retrying)
            if (!retrying) throw failure
            delay(minOf(30_000L, 500L * (1L shl minOf(failures++, 6))))
        }
    }

    internal fun envelope(ops: List<JsonObject>): JsonObject {
        val m = linkedMapOf<String, JsonElement>("rayfold" to JsonPrimitive("0.1"), "ops" to JsonArray(ops))
        val meta = linkedMapOf<String, JsonElement>()
        options.client?.let { meta["client"] = JsonPrimitive(it) }
        options.deadlineMs?.let { meta["deadline"] = JsonPrimitive(it) }
        if (meta.isNotEmpty()) m["meta"] = JsonObject(meta)
        return JsonObject(m)
    }

    internal suspend fun runBatch(handles: List<OpHandle>, onFrame: ((JsonObject) -> Unit)?) {
        val byId = handles.associateBy { it.id }
        // a live query never goes out as a safe read: servers up to 0.2.1 buffer a safe request whole, and one never ends
        val safe = handles.all { (it.request["op"] as JsonPrimitive).content in queries && it.request["live"] != JsonPrimitive(true) }
        val resultKeys = handles.associate { h ->
            val r = h.request
            h.id to RayfoldCache.resultKey((r["op"] as JsonPrimitive).content, r["args"] as? JsonObject ?: EMPTY, (r["shape"] as? JsonPrimitive)?.content, r["vars"] as? JsonObject)
        }
        fun opOf(h: OpHandle) = (h.request["op"] as JsonPrimitive).content
        // the shape each op asked with, which tells the cache what belongs to that selection (spec 07 section 3)
        val levels = handles.associate { it.id to SelectionLevel.of((it.request["shape"] as? JsonPrimitive)?.contentOrNull) }
        fun levelOf(h: OpHandle) = levels[h.id]
        fun unsettled() = handles.filter { !it.result.isCompleted }
        try {
            transport.send(envelope(handles.map { it.request }), safe).collect { f ->
                val id = (f["id"] as? JsonPrimitive)?.intOrNull
                val error = f["error"] as? JsonObject
                if (id == null) {
                    val e = RayfoldClientException.of(error ?: JsonObject(emptyMap()))
                    for (h in unsettled()) h.result.completeExceptionally(e)
                    onFrame?.invoke(f)
                    return@collect
                }
                val h = byId[id] ?: return@collect
                val key = resultKeys.getValue(id)
                val fin = (f["fin"] as? JsonPrimitive)?.booleanOrNull == true
                when {
                    error != null -> {
                        if ((error["type"] as? JsonPrimitive)?.contentOrNull == "VersionConflict") {
                            ((error["data"] as? JsonObject)?.get("current"))?.let { cache.mergeEntities(it) }
                        }
                        h.result.completeExceptionally(RayfoldClientException.of(error))
                    }
                    // a dry run says what would happen; written to the cache it showed every watcher a change that never was
                    "ok" in f && h.request["simulate"] == JsonPrimitive(true) -> h.result.complete(f["ok"] ?: JsonNull)
                    "ok" in f -> {
                        var r: CachedResult? = null
                        cache.transaction {
                            r = cache.putCommandResult(opOf(h), f["ok"] ?: JsonNull, levelOf(h))
                            (f["patch"] as? JsonArray)?.let { p -> cache.applyPatch(p.mapNotNull { it as? JsonObject }) }
                        }
                        h.skeleton = r?.data
                        h.result.complete(r?.let { cache.denormalize(it.data) } ?: JsonNull)
                    }
                    "data" in f && "at" !in f -> {
                        val r = cache.putResult(key, opOf(h), f["data"] ?: JsonNull, levelOf(h))
                        if (fin) h.result.complete(cache.denormalize(r.data))
                    }
                    "at" in f -> cache.mergeAt(key, (f["at"] as? JsonPrimitive)?.contentOrNull ?: "", f["data"] ?: JsonNull, levelOf(h))
                    // a live update: `at` and `list` describe this op's own stored result
                    "patch" in f -> (f["patch"] as? JsonArray)?.let { p -> cache.applyPatch(p.mapNotNull { it as? JsonObject }, key) }
                    fin && !h.result.isCompleted -> h.result.complete(cache.getResult(key)?.let { cache.denormalize(it.data) } ?: JsonNull)
                }
                onFrame?.invoke(f) // after the cache has taken the frame in
            }
        } catch (e: Throwable) {
            for (h in unsettled()) h.result.completeExceptionally(e)
            throw e
        }
        for (h in unsettled()) h.result.completeExceptionally(RayfoldClientException("unavailable", "Batch ended without a result for this op"))
    }
}

/** JSON the client decodes typed results with: unknown fields (such as `$type`) are ignored. */
val RayfoldJson: Json = Json { ignoreUnknownKeys = true }

/** A query decoded into [T], for example a class from `rayfold gen kotlin`. */
suspend inline fun <reified T> RayfoldClient.queryAs(op: String, args: JsonObject = JsonObject(emptyMap()), shape: String? = null, policy: Policy = Policy.NETWORK): T =
    RayfoldJson.decodeFromJsonElement(query(op, args, shape, policy))

suspend inline fun <reified T> RayfoldClient.commandAs(op: String, args: JsonObject = JsonObject(emptyMap()), shape: String? = null, key: String? = null): T =
    RayfoldJson.decodeFromJsonElement(command(op, args, shape, key))

inline fun <reified T> RayfoldClient.watchAs(op: String, args: JsonObject = JsonObject(emptyMap()), shape: String? = null): Flow<T> =
    watch(op, args, shape).map { RayfoldJson.decodeFromJsonElement<T>(it) }

inline fun <reified T> RayfoldClient.liveAs(op: String, args: JsonObject = JsonObject(emptyMap()), shape: String? = null): Flow<T> =
    live(op, args, shape).map { RayfoldJson.decodeFromJsonElement<T>(it) }

/** Arguments from plain values: `args("id" to "b1", "qty" to 2, "tags" to listOf("a"))`. */
fun args(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.associate { (k, v) -> k to toJson(v) })

private fun toJson(v: Any?): JsonElement = when (v) {
    null -> JsonNull
    is JsonElement -> v
    is String -> JsonPrimitive(v)
    is Boolean -> JsonPrimitive(v)
    is Number -> JsonPrimitive(v)
    is Enum<*> -> JsonPrimitive(v.name)
    is Map<*, *> -> JsonObject(v.entries.associate { (k, x) -> k.toString() to toJson(x) })
    is Iterable<*> -> JsonArray(v.map(::toJson))
    is Array<*> -> JsonArray(v.map(::toJson))
    else -> throw IllegalArgumentException("args: ${v::class.java.name} is not a JSON value; pass a JsonElement")
}
