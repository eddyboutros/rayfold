# @rayfold/otel

[OpenTelemetry](https://opentelemetry.io) tracing for a [Rayfold](https://github.com/eddyboutros/rayfold) server: a
span per batch, a child span per op, and a grandchild per loader call, so a trace shows how a nested shape was resolved
level by level and where the time went.

```sh
npm install @rayfold/otel @opentelemetry/api
```

```ts
import { createRayfoldServer } from "@rayfold/server";
import { rayfoldTracing } from "@rayfold/otel";

const server = createRayfoldServer({ schema, resolvers, instrumentation: rayfoldTracing() });
```

Register a tracer provider as usual, for example with `@opentelemetry/sdk-node`; `rayfoldTracing()` uses the global
one, or pass `{ tracer }`.

| Span | Attributes |
|---|---|
| `rayfold batch` (kind server) | `rayfold.ops`, `rayfold.client` |
| `rayfold query book`, `rayfold command placeOrder`, ... | `rayfold.op`, `rayfold.op.kind`, `rayfold.op.id`, `rayfold.cost` |
| `rayfold load Book.author` | `rayfold.type`, `rayfold.field`, `rayfold.parents` (how many parents the one call served) |

A failed op or batch gets status `ERROR` and `rayfold.error.code`; a loader that throws records the exception.

**Trace context.** A request with a W3C `traceparent` header (or `meta.traceparent` in the envelope, over WebSocket)
continues the caller's trace. **Nesting.** Resolvers run inside their loader's span, so the spans of an instrumented
database client nest under it when a context manager is registered (the Node SDK registers one).

## License

Apache-2.0
