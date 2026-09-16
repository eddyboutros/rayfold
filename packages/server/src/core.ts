/**
 * The runtime without a transport: schema, batches, policies, cost, live queries. Nothing here needs Node, so it runs
 * in a browser, a worker or any JavaScript runtime; the HTTP, WebSocket and MCP transports are in the main entry.
 */
export * from "./protocol.ts";
export { EventBus, MemoryIdempotencyStore, type IdempotencyClaim, type IdempotencyStore, type IdempotencyRecord, type RayfoldContext, type PolicyHint } from "./context.ts";
export { Executor, ok, derivePatches, stripTypes, type Resolvers, type FieldResolver, type SingleFieldResolver, type RootResolver, type StreamResolver, type CommandResult } from "./executor.ts";
export { executeBatch, FrameSink, type BatchOptions, type BatchRuntime, type ExecuteOptions } from "./batch.ts";
export { RayfoldServer, createRayfoldServer, type RayfoldServerOptions } from "./server.ts";
export { MemoryShapeRegistry, defaultShape, resolveRequestShape, type ShapeRegistry } from "./views.ts";
export { coerceArgs, coerceValue, coerceScalar, resolveRefs, collectRefs, getPath } from "./args.ts";
export { estimateCost, type CostEstimate } from "./cost.ts";
export { decide, decisionError, pushableFilter, hasPolicy, type Decision } from "./policy.ts";
export { checkWiring } from "./wiring.ts";
export { ChangeBus, changeFromPatch, diffResults, normalizeResult, readSetOf, type Change } from "./live.ts";
export type { Instrumentation, BatchInfo, OpInfo, LoaderInfo, Outcome } from "./instrumentation.ts";
export { MemoryUsage, type UsageSink, type UsageEvent, type UsageEntry } from "./usage.ts";
export { capabilityAllows } from "./capability-scope.ts";
