# Tracing with OpenTelemetry

Both runtimes can trace every batch: a span for the batch, a child span for each op, and a grandchild for each loader
call. Because loaders batch by nesting level, the trace of a nested shape reads like its plan: one `rayfold load
Book.author` span serves every book on the page, and its `rayfold.parents` attribute says how many.

| Span | Attributes |
|---|---|
| `rayfold batch` (kind server) | `rayfold.ops`, `rayfold.client` |
| `rayfold query book`, `rayfold command placeOrder`, ... | `rayfold.op`, `rayfold.op.kind`, `rayfold.op.id`, `rayfold.cost` |
| `rayfold load Book.author` | `rayfold.type`, `rayfold.field`, `rayfold.parents` |

A failed op gets status `ERROR` and `rayfold.error.code`; a loader that throws records the exception. A request with a
W3C `traceparent` header continues the caller's trace, and so does `meta.traceparent` in an envelope sent over
WebSocket. Resolvers run inside their loader's span, so spans that an instrumented database client starts nest under it.

## TypeScript

```ts
import { createRayfoldServer } from "@rayfold/server";
import { rayfoldTracing } from "@rayfold/otel";

const server = createRayfoldServer({ schema, resolvers, instrumentation: rayfoldTracing() });
```

Register a tracer provider as usual (the OpenTelemetry Node SDK does it, with a context manager and the W3C propagator).
`rayfoldTracing({ tracer })` takes a specific tracer.

## Kotlin, Java and Spring Boot

Add `dev.rayfold:rayfold-opentelemetry`, then:

```kotlin
val server = RayfoldServer(ir, resolvers, instrumentation = RayfoldOpenTelemetry(openTelemetry))
```

In Java, `Rayfold.server(schema).instrumentation(new RayfoldOpenTelemetry(openTelemetry))`. With the Spring Boot
starter, declare the bean and the starter uses it:

```java
@Bean
Instrumentation rayfoldTracing(OpenTelemetry openTelemetry) {
    return new RayfoldOpenTelemetry(openTelemetry);
}
```

## Other tools

`instrumentation` is a plain set of three hooks (`batch`, `op` and `loader`, each wrapping the work it reports), so
metrics or logging need no OpenTelemetry at all: implement `Instrumentation` directly.
