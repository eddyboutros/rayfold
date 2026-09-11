package dev.rayfold.core

import kotlinx.serialization.json.JsonObject

data class BatchInfo(
    /** Ops in the envelope. */
    val ops: Int,
    /** The envelope's meta, with `traceparent` and `tracestate` when the caller sent W3C trace context. */
    val meta: JsonObject,
)

data class OpInfo(val id: Int, val name: String, val kind: String, val cost: Long)

/** One loader call, which serves [parents] parents: the whole level of a nested shape. */
data class LoaderInfo(val type: String, val field: String, val parents: Int)

/** How a batch or an op ended: [code] and [message] when it failed. A failed op is reported here, not thrown. */
data class Outcome(val code: String? = null, val message: String? = null) {
    val failed: Boolean get() = code != null
}

/**
 * Wraps the work the runtime does, for tracing and metrics without a dependency (module rayfold-opentelemetry turns it
 * into OpenTelemetry spans). Each hook must call `run` exactly once and return its result. The hooks nest, loaders
 * inside their op and ops inside their batch, and each runs in the coroutine of the work it wraps, so a hook that puts
 * a tracing context into the coroutine context (withContext) parents everything under it.
 */
interface Instrumentation {
    suspend fun batch(info: BatchInfo, run: suspend () -> Outcome): Outcome = run()

    suspend fun op(info: OpInfo, run: suspend () -> Outcome): Outcome = run()

    suspend fun <T> loader(info: LoaderInfo, run: suspend () -> T): T = run()

    companion object {
        /** No hooks: the default. */
        val NONE: Instrumentation = object : Instrumentation {}
    }
}
