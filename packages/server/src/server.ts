import type { Instrumentation } from "./instrumentation.ts";
import { loadSchema, schemaHash, type LoadedSchema, type RayfoldSchemaIR, type Shape } from "@rayfold/schema";
import { executeBatch, type BatchOptions, type BatchRuntime, type ExecuteOptions } from "./batch.ts";
import { EventBus, MemoryIdempotencyStore, type IdempotencyStore } from "./context.ts";
import { Executor, type Resolvers } from "./executor.ts";
import { RayfoldError, type Frame, type RequestEnvelope } from "./protocol.ts";
import { MemoryShapeRegistry, type ShapeRegistry } from "./views.ts";
import { ChangeBus } from "./live.ts";
import type { Relay, RelayMessage } from "./relay.ts";
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
  /** Items one stream op may yield before it fails with `resource_exhausted` (spec 04 §5). Default 10000. */
  maxStreamItems?: number;
  /** Add `meta.ms` to frames. Default false (keeps frames deterministic). */
  timing?: boolean;
  idempotency?: IdempotencyStore;
  /**
   * How long a command holds its idempotency key before another server may take it over, in milliseconds.
   * Default 30000. It is renewed while the command runs, so it only matters when a server stops mid-command.
   */
  idempotencyLeaseMs?: number;
  shapes?: ShapeRegistry;
  /** Your own event bus. Hand it the relay yourself (`new EventBus(relay)`) when there is one. */
  events?: EventBus;
  /**
   * What joins this server to the others it runs beside: changes and events cross it, so a live query or a stream on
   * any server hears a command run on any other. Without one, each server hears only itself.
   */
  relay?: Relay;
  /** Called when the relay refuses a message. What it carried already happened on this server. */
  onRelayError?: (error: unknown) => void;
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
  readonly changes: ChangeBus;
  /** The last message the relay refused to carry, if any: the other servers missed it. */
  relayFailure: unknown;
  private readonly listening: Promise<() => Promise<void>> | undefined;
  private relayState: "none" | "pending" | "listening" | "failed" = "none";
  private relayStopped: unknown;
  private readonly drainer = new AbortController();
  private active = 0;
  private onIdle: (() => void) | undefined;
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
    const relayError = (error: unknown) => {
      this.relayFailure = error;
      opts.onRelayError?.(error);
    };
    this.events = opts.events ?? new EventBus(opts.relay, relayError);
    this.changes = new ChangeBus(opts.relay, relayError);
    if (opts.relay) {
      this.relayState = "pending";
      this.listening = opts.relay.subscribe((message) => this.receive(message));
      this.listening.then(
        () => (this.relayState = "listening"),
        (error: unknown) => {
          // ready() reports it too; this keeps the failure from going unobserved
          this.relayState = "failed";
          this.relayStopped = error;
          relayError(error);
        },
      );
    }
    this.usage = opts.usage;
    this.shapes = opts.shapes ?? new MemoryShapeRegistry(this.ir);
    this.options = {
      trustedShapes: opts.trustedShapes ?? false,
      budget: opts.budget ?? 1000,
      maxOps: opts.maxOps ?? 50,
      maxDepth: opts.maxDepth ?? 8,
      maxFields: opts.maxFields ?? 500,
      maxStreamItems: opts.maxStreamItems ?? 10_000,
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
      draining: this.drainer.signal,
      events: this.events,
      changes: this.changes,
      options: this.options,
      ...(opts.usage ? { usage: opts.usage } : {}),
      ...(opts.instrumentation ? { instrumentation: opts.instrumentation } : {}),
    };
  }

  /** Execute a batch; frames arrive as they are produced. */
  execute(envelope: RequestEnvelope, opts: ExecuteOptions = {}): AsyncIterable<Frame> {
    return this.counted(executeBatch(this.rt, envelope, opts));
  }

  /** A batch is in flight from its first frame being asked for until it ends, so `drain()` can wait for it. */
  private async *counted(frames: AsyncIterable<Frame>): AsyncGenerator<Frame> {
    this.active++;
    try {
      yield* frames;
    } finally {
      if (--this.active === 0) this.onIdle?.();
    }
  }

  /** Aborts once the server is shutting down. Live queries and streams end on it with a retryable `unavailable`. */
  get draining(): AbortSignal {
    return this.drainer.signal;
  }

  /** Batches running right now. */
  get inflight(): number {
    return this.active;
  }

  /**
   * Begins the shutdown a rolling deploy needs: readiness turns false so the load balancer stops sending traffic, the
   * transports refuse new batches, and live queries and streams end with a retryable `unavailable` that sends their
   * clients to another server. Batches already running finish; this resolves once they have, or after `timeoutMs`
   * (default 10 seconds). Call `close()` afterwards to stop hearing the relay.
   */
  async drain(opts: { timeoutMs?: number } = {}): Promise<void> {
    if (!this.drainer.signal.aborted) this.drainer.abort(new RayfoldError("unavailable", "The server is shutting down"));
    if (this.active === 0) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        this.onIdle = undefined;
        resolve();
      };
      timer = setTimeout(finish, opts.timeoutMs ?? 10_000);
      this.onIdle = finish;
    });
  }

  /** Whether this server should receive traffic, and every reason it should not. */
  readiness(): { ready: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (this.drainer.signal.aborted) reasons.push("shutting down");
    if (this.relayState === "pending") reasons.push("relay: not listening yet");
    if (this.relayState === "failed") reasons.push(`relay: ${this.relayStopped instanceof Error ? this.relayStopped.message : String(this.relayStopped)}`);
    return { ready: reasons.length === 0, reasons };
  }

  /** Convenience: run a batch and collect every frame. */
  async collect(envelope: RequestEnvelope, opts: ExecuteOptions = {}): Promise<Frame[]> {
    const out: Frame[] = [];
    for await (const f of this.execute(envelope, opts)) out.push(f);
    return out;
  }

  /** A message from another server: its change or event is delivered here as if it had happened here. */
  private receive(message: RelayMessage): void {
    if (message.kind === "change") this.changes.deliver({ keys: new Set(message.keys), ops: new Set(message.ops) });
    else this.events.deliver(message.name, message.payload);
  }

  /** Resolves once the server can serve: with a relay, once it hears the other servers. Rejects with what stopped it. */
  async ready(): Promise<void> {
    if (this.listening) await this.listening;
  }

  /** Stops hearing the other servers. */
  async close(): Promise<void> {
    if (!this.listening) return;
    const stop = await this.listening.catch(() => undefined);
    await stop?.();
  }

  /** Register a shape (text or AST) so it can be referenced by id in trusted mode. */
  registerShape(shape: string | Shape): string {
    return this.shapes.register(typeof shape === "string" ? parseShapeText(shape) : shape, true);
  }

  /**
   * Discovery document (spec 04 §4a). Served without a viewer to anyone who can reach the endpoint, so what goes in
   * it is named here rather than taken from whatever the server happens to be configured with: an option added for
   * some unrelated reason must not find its way into a public document by default.
   */
  manifest(): { rayfold: string; schemaHash: string; extensions: string[]; limits: Record<string, number | boolean> } {
    const o = this.options;
    const limits: Record<string, number | boolean> = {
      budget: o.budget,
      maxOps: o.maxOps,
      maxDepth: o.maxDepth,
      maxFields: o.maxFields,
      // whether inline shape text is refused, which decides how a client sends a shape at all
      trustedShapes: !!o.trustedShapes,
    };
    const extensions = ["live", "rb"];
    if (Object.values(this.ir.ops).some((o) => o.annotations.some((a) => a.name === "http"))) extensions.push("http");
    if (this.mounted.has("mcp")) extensions.push("mcp");
    if (this.mounted.has("upload")) extensions.push("upload");
    return { rayfold: "0.1", schemaHash: this.hash, extensions, limits };
  }
}

export function createRayfoldServer(opts: RayfoldServerOptions): RayfoldServer {
  return new RayfoldServer(opts);
}
