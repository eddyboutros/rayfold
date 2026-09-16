import type { Instrumentation } from "./instrumentation.ts";
import { loadSchema, schemaHash, type LoadedSchema, type RayfoldSchemaIR, type Shape } from "@rayfold/schema";
import { executeBatch, type BatchOptions, type BatchRuntime, type ExecuteOptions } from "./batch.ts";
import { EventBus, MemoryIdempotencyStore, type IdempotencyStore } from "./context.ts";
import { Executor, type Resolvers } from "./executor.ts";
import type { Frame, RequestEnvelope } from "./protocol.ts";
import { MemoryShapeRegistry, type ShapeRegistry } from "./views.ts";
import { ChangeBus } from "./live.ts";
import type { UsageSink } from "./usage.ts";
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
  /**
   * How long a command holds its idempotency key before another server may take it over, in milliseconds.
   * Default 30000. It is renewed while the command runs, so it only matters when a server stops mid-command.
   */
  idempotencyLeaseMs?: number;
  shapes?: ShapeRegistry;
  events?: EventBus;
  now?: () => number;
  /** Hooks around batches, ops and loaders, for tracing and metrics (`@rayfold/otel` makes them OpenTelemetry spans). */
  instrumentation?: Instrumentation;
  /** Where to record which members each client asks for (spec 11). Without one, nothing is recorded. */
  usage?: UsageSink;
}

export class RayfoldServer {
  readonly ir: RayfoldSchemaIR;
  readonly hash: string;
  readonly events: EventBus;
  /** Entity/op change notifications driving live queries (extension `live`). */
  readonly changes = new ChangeBus();
  /** Field-usage telemetry, when the server was given a sink (spec 11). */
  readonly usage: UsageSink | undefined;
  readonly shapes: ShapeRegistry;
  readonly options: BatchOptions;
  /** Extensions served by endpoints mounted beside this server, such as `mcp` by createMcpHandler; the manifest lists them. */
  readonly mounted = new Set<string>();
  private readonly rt: BatchRuntime;

  constructor(opts: RayfoldServerOptions) {
    this.ir = typeof opts.schema === "string" ? loadSchema(opts.schema).ir : "ir" in opts.schema ? opts.schema.ir : opts.schema;
    this.hash = schemaHash(this.ir);
    this.events = opts.events ?? new EventBus();
    this.usage = opts.usage;
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
      executor: new Executor(this.ir, opts.resolvers, {
        maxDepth: this.options.maxDepth,
        maxFields: this.options.maxFields,
        ...(opts.instrumentation ? { instrumentation: opts.instrumentation } : {}),
        ...(opts.usage ? { usage: opts.usage } : {}),
      }),
      registry: this.shapes,
      idempotency: opts.idempotency ?? new MemoryIdempotencyStore(undefined, this.options.now),
      leaseMs: opts.idempotencyLeaseMs ?? 30_000,
      events: this.events,
      changes: this.changes,
      options: this.options,
      ...(opts.usage ? { usage: opts.usage } : {}),
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
    if (this.mounted.has("mcp")) extensions.push("mcp");
    return { rayfold: "0.1", schemaHash: this.hash, extensions, limits };
  }
}

export function createRayfoldServer(opts: RayfoldServerOptions): RayfoldServer {
  return new RayfoldServer(opts);
}
