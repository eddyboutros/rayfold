import type { Instrumentation } from "./instrumentation.ts";
import { loadSchema, schemaHash, type LoadedSchema, type RayfoldSchemaIR, type Shape } from "@rayfold/schema";
import { executeBatch, type BatchOptions, type BatchRuntime, type ExecuteOptions } from "./batch.ts";
import { EventBus, MemoryIdempotencyStore, type IdempotencyStore } from "./context.ts";
import { Executor, type Resolvers } from "./executor.ts";
import type { Frame, RequestEnvelope } from "./protocol.ts";
import { MemoryShapeRegistry, type ShapeRegistry } from "./views.ts";
import { ChangeBus } from "./live.ts";
import { parseShapeText } from "@rayfold/schema";

export interface RayfoldServerOptions {
  /** `.rayfold` text, a loaded schema, or a raw IR. */
  schema: string | LoadedSchema | RayfoldSchemaIR;
  resolvers: Resolvers;
  /** Production mode: only registered shape ids are accepted (spec 02 §3). Default false. */
  trustedShapes?: boolean;
  /** Cost budget per batch (spec 06 §5). Default 1000. */
  budget?: number;
  maxOps?: number;
  maxDepth?: number;
  maxFields?: number;
  /** Add `meta.ms` to frames. Default false (keeps frames deterministic). */
  timing?: boolean;
  idempotency?: IdempotencyStore;
  shapes?: ShapeRegistry;
  events?: EventBus;
  now?: () => number;
  /** Hooks around batches, ops and loaders, for tracing and metrics (`@rayfold/otel` makes them OpenTelemetry spans). */
  instrumentation?: Instrumentation;
}

export class RayfoldServer {
  readonly ir: RayfoldSchemaIR;
  readonly hash: string;
  readonly events: EventBus;
  /** Entity/op change notifications driving live queries (extension `live`). */
  readonly changes = new ChangeBus();
  readonly shapes: ShapeRegistry;
  readonly options: BatchOptions;
  private readonly rt: BatchRuntime;

  constructor(opts: RayfoldServerOptions) {
    this.ir = typeof opts.schema === "string" ? loadSchema(opts.schema).ir : "ir" in opts.schema ? opts.schema.ir : opts.schema;
    this.hash = schemaHash(this.ir);
    this.events = opts.events ?? new EventBus();
    this.shapes = opts.shapes ?? new MemoryShapeRegistry(this.ir);
    this.options = {
      trustedShapes: opts.trustedShapes ?? false,
      budget: opts.budget ?? 1000,
      maxOps: opts.maxOps ?? 50,
      maxDepth: opts.maxDepth ?? 8,
      maxFields: opts.maxFields ?? 500,
      timing: opts.timing ?? false,
      now: opts.now ?? Date.now,
    };
    this.rt = {
      ir: this.ir,
      executor: new Executor(this.ir, opts.resolvers, { maxDepth: this.options.maxDepth, maxFields: this.options.maxFields, ...(opts.instrumentation ? { instrumentation: opts.instrumentation } : {}) }),
      registry: this.shapes,
      idempotency: opts.idempotency ?? new MemoryIdempotencyStore(undefined, this.options.now),
      events: this.events,
      changes: this.changes,
      options: this.options,
      inflight: new Map(),
      ...(opts.instrumentation ? { instrumentation: opts.instrumentation } : {}),
    };
  }

  /** Execute a batch; frames arrive as they are produced. */
  execute(envelope: RequestEnvelope, opts: ExecuteOptions = {}): AsyncIterable<Frame> {
    return executeBatch(this.rt, envelope, opts);
  }

  /** Convenience: run a batch and collect every frame. */
  async collect(envelope: RequestEnvelope, opts: ExecuteOptions = {}): Promise<Frame[]> {
    const out: Frame[] = [];
    for await (const f of this.execute(envelope, opts)) out.push(f);
    return out;
  }

  /** Register a shape (text or AST) so it can be referenced by id in trusted mode. */
  registerShape(shape: string | Shape): string {
    return this.shapes.register(typeof shape === "string" ? parseShapeText(shape) : shape, true);
  }

  /** Discovery document (spec 10 outline). */
  manifest(): { rayfold: string; schemaHash: string; extensions: string[]; limits: Omit<BatchOptions, "now"> } {
    const { now: _now, ...limits } = this.options;
    const extensions = ["live", "rb"];
    if (Object.values(this.ir.ops).some((o) => o.annotations.some((a) => a.name === "http"))) extensions.push("http");
    return { rayfold: "0.1", schemaHash: this.hash, extensions, limits };
  }
}

export function createRayfoldServer(opts: RayfoldServerOptions): RayfoldServer {
  return new RayfoldServer(opts);
}
