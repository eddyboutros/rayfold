package dev.rayfold.opentelemetry

import dev.rayfold.core.BatchInfo
import dev.rayfold.core.Instrumentation
import dev.rayfold.core.LoaderInfo
import dev.rayfold.core.OpInfo
import dev.rayfold.core.Outcome
import io.opentelemetry.api.OpenTelemetry
import io.opentelemetry.api.trace.Span
import io.opentelemetry.api.trace.SpanKind
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.api.trace.Tracer
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator
import io.opentelemetry.context.Context
import io.opentelemetry.context.propagation.TextMapGetter
import io.opentelemetry.context.propagation.TextMapPropagator
import io.opentelemetry.extension.kotlin.asContextElement
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive
import kotlin.coroutines.cancellation.CancellationException

/**
 * OpenTelemetry tracing for a Rayfold server: a span per batch, a child span per op and a grandchild per loader call.
 * A batch whose meta carries W3C `traceparent` (RayfoldHttp copies the header) continues the caller's trace. Each span
 * is current in the coroutine of the work it wraps, so spans that resolvers start (with `Context.current()` as parent,
 * as instrumented clients do) nest under their loader.
 *
 * ```kotlin
 * val server = RayfoldServer(ir, resolvers, instrumentation = RayfoldOpenTelemetry(openTelemetry))
 * ```
 */
class RayfoldOpenTelemetry @JvmOverloads constructor(
    private val tracer: Tracer,
    private val propagator: TextMapPropagator = W3CTraceContextPropagator.getInstance(),
) : Instrumentation {
    /** Uses the SDK's tracer provider and its propagators. */
    constructor(openTelemetry: OpenTelemetry) : this(openTelemetry.getTracer(INSTRUMENTATION_NAME), openTelemetry.propagators.textMapPropagator)

    override suspend fun batch(info: BatchInfo, run: suspend () -> Outcome): Outcome {
        val carrier = listOf("traceparent", "tracestate").mapNotNull { k -> (info.meta[k] as? JsonPrimitive)?.takeIf { it.isString }?.let { k to it.content } }.toMap()
        val parent = if ("traceparent" in carrier) propagator.extract(Context.current(), carrier, MapGetter) else Context.current()
        val span = tracer.spanBuilder("rayfold batch").setParent(parent).setSpanKind(SpanKind.SERVER).setAttribute("rayfold.ops", info.ops.toLong())
            .apply { (info.meta["client"] as? JsonPrimitive)?.takeIf { it.isString }?.let { setAttribute("rayfold.client", it.content) } }
            .startSpan()
        return traced(span, parent, run)
    }

    override suspend fun op(info: OpInfo, run: suspend () -> Outcome): Outcome {
        val parent = Context.current()
        val span = tracer.spanBuilder("rayfold ${info.kind} ${info.name}").setParent(parent)
            .setAttribute("rayfold.op", info.name).setAttribute("rayfold.op.kind", info.kind)
            .setAttribute("rayfold.op.id", info.id.toLong()).setAttribute("rayfold.cost", info.cost)
            .startSpan()
        return traced(span, parent, run)
    }

    override suspend fun <T> loader(info: LoaderInfo, run: suspend () -> T): T {
        val parent = Context.current()
        val span = tracer.spanBuilder("rayfold load ${info.type}.${info.field}").setParent(parent)
            .setAttribute("rayfold.type", info.type).setAttribute("rayfold.field", info.field).setAttribute("rayfold.parents", info.parents.toLong())
            .startSpan()
        return traced(span, parent, run)
    }

    private suspend fun <T> traced(span: Span, parent: Context, block: suspend () -> T): T = withContext(parent.with(span).asContextElement()) {
        try {
            block().also { out ->
                if (out is Outcome && out.failed) {
                    out.code?.let { span.setAttribute("rayfold.error.code", it) }
                    span.setStatus(StatusCode.ERROR, out.message ?: "")
                }
            }
        } catch (e: CancellationException) {
            throw e // a cancelled live query or a passed deadline is not a failure of the op
        } catch (e: Throwable) {
            span.recordException(e)
            span.setStatus(StatusCode.ERROR, e.message ?: e.javaClass.name)
            throw e
        } finally {
            span.end()
        }
    }

    private object MapGetter : TextMapGetter<Map<String, String>> {
        override fun keys(carrier: Map<String, String>): Iterable<String> = carrier.keys
        override fun get(carrier: Map<String, String>?, key: String): String? = carrier?.get(key)
    }

    companion object {
        const val INSTRUMENTATION_NAME = "dev.rayfold"
    }
}
