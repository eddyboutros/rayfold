package dev.rayfold.test

import dev.rayfold.core.Code
import dev.rayfold.core.Live
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldServer
import dev.rayfold.java.Rayfold
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.future.future
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

private val NO_ARGS = JsonObject(emptyMap())

/** The error member of a frame as the exception the server made it from. */
internal fun errorOf(error: JsonObject): RayfoldException {
    fun text(name: String) = (error[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val wire = text("code")
    return RayfoldException(Code.entries.firstOrNull { it.wire == wire } ?: Code.UNKNOWN, text("message") ?: "", text("type"), error["data"], text("path"))
}

/**
 * Calls a [RayfoldServer] from a test: one op at a time, with no network, no client and no coroutines. Each call is a
 * batch the real server runs for this caller's viewer, so policies, argument checks and idempotency apply as they do
 * behind a transport.
 *
 * ```kotlin
 * val shop = RayfoldTest.of(server)
 * val staff = shop.signedInAs(buildJsonObject { put("id", "s1"); put("role", "staff") })
 * val book = staff.query("book", args("id" to "b1"), "{ title costPrice }")
 * ```
 *
 * An op the server refuses is thrown as the [RayfoldException] the server produced, so a test asserts on its `code`,
 * or on the `type` and `data` of a declared error. Arguments given as [JsonObject] are answered with [JsonElement];
 * given as a `Map`, as Java gives them, with plain values ([Rayfold.fromJson]).
 *
 * Every wait is bounded, by 5 seconds unless [within] says otherwise: a resolver that never answers fails the test
 * with an [AssertionError] instead of hanging it.
 */
class RayfoldTest private constructor(private val server: RayfoldServer, private val viewer: JsonElement, private val timeoutMs: Long) {
    // off the test's thread, so the bound holds even against a resolver that blocks
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** A caller for [viewer], what the schema's policies see as `viewer`: a [JsonElement], a map or a record; null is anonymous. */
    fun signedInAs(viewer: Any?): RayfoldTest = RayfoldTest(server, Rayfold.toJson(viewer), timeoutMs)

    /** A caller that waits at most [timeoutMs] for each answer, and for each value of a live query it opens. */
    fun within(timeoutMs: Long): RayfoldTest {
        require(timeoutMs > 0) { "timeoutMs must be positive, not $timeoutMs" }
        return RayfoldTest(server, viewer, timeoutMs)
    }

    /** The result of one query, deferred parts folded in. */
    fun query(op: String, args: JsonObject = NO_ARGS, shape: String? = null): JsonElement {
        declared(op, "query")
        return Live.foldFrames(answered(frames(op, args, shape)))
    }

    /** For Java: [query] with plain values. The result is a `Map`, a `List`, a `String`, a `Long`, a `Double`, a `Boolean` or null. */
    @JvmOverloads
    fun <T> query(op: String, args: Map<String, *>, shape: String? = null): T = plain(query(op, json(args), shape))

    /**
     * The result of one command. Without a [key] it gets a fresh one, as every client sends one; a test of a retry
     * passes its own to both calls, and [frames] shows whether the answer was a replay (`meta.replay`).
     */
    fun command(op: String, args: JsonObject = NO_ARGS, shape: String? = null, key: String? = null): JsonElement {
        declared(op, "command")
        return answered(frames(op, args, shape, key)).firstNotNullOfOrNull { it["ok"] } ?: JsonNull
    }

    /** For Java: [command] with plain values. */
    @JvmOverloads
    fun <T> command(op: String, args: Map<String, *>, shape: String? = null, key: String? = null): T = plain(command(op, json(args), shape, key))

    /**
     * Every frame the server answered one op with, as a transport would carry them: `meta`, a command's `patch`, and
     * an error as the frame it is rather than an exception. A command without a [key] gets a fresh one.
     */
    fun frames(op: String, args: JsonObject = NO_ARGS, shape: String? = null, key: String? = null): List<JsonObject> {
        val sent = key ?: if (server.ir.ops[op]?.kind == "command") UUID.randomUUID().toString() else null
        val request = buildJsonObject {
            put("id", 1)
            put("op", op)
            put("args", args)
            shape?.let { put("shape", it) }
            sent?.let { put("key", it) }
        }
        val envelope = buildJsonObject { put("ops", JsonArray(listOf(request))) }
        return bounded("$op()") { server.collect(envelope, viewer) }
    }

    /** For Java: [frames] with plain values. */
    @JvmOverloads
    fun frames(op: String, args: Map<String, *>, shape: String? = null, key: String? = null): List<Map<String, Any?>> =
        frames(op, json(args), shape, key).map { plain(it) }

    /**
     * Opens a live query and returns once its first result is there, so a command made afterwards is one it hears.
     * Close it when the test is done with it: that gives the server its subscription back.
     */
    fun live(op: String, args: JsonObject = NO_ARGS, shape: String? = null): LiveQuery<JsonElement> =
        LiveQuery(scope, server, viewer, op, args, shape, timeoutMs) { it }.opened()

    /** For Java: [live] with plain values. */
    @JvmOverloads
    fun live(op: String, args: Map<String, *>, shape: String? = null): LiveQuery<Any?> =
        LiveQuery(scope, server, viewer, op, json(args), shape, timeoutMs) { Rayfold.fromJson(it) }.opened()

    /** An op the schema does not have is left to the server, whose answer is the one a client would get. */
    private fun declared(op: String, kind: String) {
        val actual = server.ir.ops[op]?.kind ?: return
        require(actual == kind) { "$op is a $actual in the schema, not a $kind" }
    }

    private fun answered(frames: List<JsonObject>): List<JsonObject> {
        frames.firstNotNullOfOrNull { it["error"] as? JsonObject }?.let { throw errorOf(it) }
        return frames
    }

    private fun <T> bounded(what: String, block: suspend () -> T): T {
        val work = scope.future { block() }
        return try {
            work.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            work.cancel(true)
            throw AssertionError("$what did not answer within $timeoutMs ms")
        } catch (e: ExecutionException) {
            throw e.cause ?: e
        }
    }

    private fun json(args: Map<String, *>): JsonObject = Rayfold.toJson(args) as? JsonObject ?: NO_ARGS

    @Suppress("UNCHECKED_CAST")
    private fun <T> plain(json: JsonElement): T = Rayfold.fromJson(json) as T

    companion object {
        /** How long a wait may take unless [within] says otherwise. */
        const val DEFAULT_TIMEOUT_MS: Long = 5_000

        /** A caller nobody is signed in as; [signedInAs] makes one for a viewer. */
        @JvmStatic
        fun of(server: RayfoldServer): RayfoldTest = RayfoldTest(server, JsonNull, DEFAULT_TIMEOUT_MS)
    }
}
