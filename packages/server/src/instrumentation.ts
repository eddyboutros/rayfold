/** Hooks around batches, ops and loaders, for tracing and metrics without a dependency. See `@rayfold/otel`. */
import type { OpDef } from "@rayfold/schema";
import type { RequestMeta, WireError } from "./protocol.ts";

export interface BatchInfo {
  /** Ops in the envelope (0 when the envelope is malformed). */
  ops: number;
  /** The envelope's meta, with `traceparent` and `tracestate` when the caller sent W3C trace context. */
  meta: RequestMeta;
}

export interface OpInfo {
  id: number;
  name: string;
  kind: OpDef["kind"];
  /** The op's static cost (spec 06 section 5). */
  cost: number;
}

export interface LoaderInfo {
  type: string;
  field: string;
  /** Parents the one loader call serves: the whole level of a nested shape. */
  parents: number;
}

/** How a batch or an op ended: `error` when it failed. A failed op is reported here, not thrown. */
export interface Outcome {
  error?: WireError;
  /**
   * What a failed op was failed with, as it was thrown: a resolver's own exception, with its stack, where `error` says
   * only `internal`. It never reaches the client; this is where an operator logs it.
   */
  cause?: unknown;
}

/**
 * Wraps the work the runtime does. Each hook must call `run` exactly once and return what it returns. The hooks nest,
 * loaders inside their op and ops inside their batch, so a tracer that keeps the active span in async context (as
 * OpenTelemetry does on Node) parents them, and any span a resolver starts, without further help.
 */
export interface Instrumentation {
  batch?(info: BatchInfo, run: () => Promise<Outcome>): Promise<Outcome>;
  op?(info: OpInfo, run: () => Promise<Outcome>): Promise<Outcome>;
  loader?<T>(info: LoaderInfo, run: () => Promise<T>): Promise<T>;
}
