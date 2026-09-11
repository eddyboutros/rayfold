/**
 * OpenTelemetry tracing for a Rayfold server: a span per batch, a child span per op, and a grandchild per loader call,
 * so a trace shows how a nested shape was resolved level by level, and where the time went.
 *
 * ```ts
 * import { createRayfoldServer } from "@rayfold/server";
 * import { rayfoldTracing } from "@rayfold/otel";
 * const server = createRayfoldServer({ schema, resolvers, instrumentation: rayfoldTracing() });
 * ```
 *
 * A batch that arrives with W3C trace context (the `traceparent` header over HTTP, or `meta.traceparent` in the
 * envelope) continues the caller's trace. Resolvers run inside their loader's span, so spans they start, such as those
 * of an instrumented database client, nest under it when a context manager is registered (the OpenTelemetry Node SDK
 * does this).
 */
import { context, propagation, SpanKind, SpanStatusCode, trace, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import type { Instrumentation, Outcome } from "@rayfold/server";

export interface RayfoldTracingOptions {
  /** Default: the global tracer provider's tracer named `@rayfold/server`. */
  tracer?: Tracer;
}

export function rayfoldTracing(opts: RayfoldTracingOptions = {}): Instrumentation {
  const tracer = opts.tracer ?? trace.getTracer("@rayfold/server");
  return {
    batch(info, run) {
      const carrier: Record<string, string> = {};
      if (info.meta.traceparent) carrier["traceparent"] = info.meta.traceparent;
      if (info.meta.tracestate) carrier["tracestate"] = info.meta.tracestate;
      const parent = carrier["traceparent"] ? propagation.extract(context.active(), carrier) : context.active();
      const attributes: Attributes = { "rayfold.ops": info.ops };
      if (info.meta.client) attributes["rayfold.client"] = info.meta.client;
      return tracer.startActiveSpan("rayfold batch", { kind: SpanKind.SERVER, attributes }, parent, (span) => outcomeOf(span, run));
    },
    op(info, run) {
      const attributes: Attributes = { "rayfold.op": info.name, "rayfold.op.kind": info.kind, "rayfold.op.id": info.id, "rayfold.cost": info.cost };
      return tracer.startActiveSpan(`rayfold ${info.kind} ${info.name}`, { attributes }, (span) => outcomeOf(span, run));
    },
    loader(info, run) {
      const attributes: Attributes = { "rayfold.type": info.type, "rayfold.field": info.field, "rayfold.parents": info.parents };
      return tracer.startActiveSpan(`rayfold load ${info.type}.${info.field}`, { attributes }, async (span) => {
        try {
          return await run();
        } catch (e) {
          failed(span, e);
          throw e;
        } finally {
          span.end();
        }
      });
    },
  };
}

async function outcomeOf(span: Span, run: () => Promise<Outcome>): Promise<Outcome> {
  try {
    const out = await run();
    if (out.error) {
      span.setAttribute("rayfold.error.code", out.error.code);
      span.setStatus({ code: SpanStatusCode.ERROR, message: out.error.message });
    }
    return out;
  } catch (e) {
    failed(span, e);
    throw e;
  } finally {
    span.end();
  }
}

function failed(span: Span, e: unknown): void {
  if (e instanceof Error) span.recordException(e);
  span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
}
