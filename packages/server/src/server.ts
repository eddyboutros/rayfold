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
import type { Counters } from "./counters.ts";
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
  /** Who this server is, for an operator looking at several of them. See {@link ServerIdentity}. */
  identity?: ServerIdentity;
  /** Where to count what this server does (spec-free, operator-facing). Without one, nothing is counted. */
  counters?: Counters;
}

/**
 * What tells one running server from another.
 *
 * None of this reaches the manifest. Spec 04 §4a fixes that document's members exactly and Core 0.1 is frozen, so
 * identity is served by `GET {base}/stats` instead - a route that is off until the transport is given an `authorize`
 * function, so a server discloses none of it until its operator decides to.
 */
export interface ServerIdentity {
  /** The application this server is: the same across its instances and its restarts. */
  name?: string;
  /** This process. Stable for its lifetime, new on every restart; a random id when you do not supply one. */
  instance?: string;
  /** Whatever you deploy by - a version, a commit, a build number. */
  version?: string;
  /** Small and free-form: region, zone, tenant. */
  labels?: Record<string, string>;
}

/** {@link ServerIdentity} as the server answers it: `instance` and `startedAt` are always present. */
export type ResolvedIdentity = ServerIdentity & { instance: string; startedAt: number };

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
  /** Everyone waiting in `drain()` for the last batch to end. */
  private idle: Array<() => void> = [];
  /** Field-usage telemetry, when the server was given a sink (spec 11). */
  readonly usage: UsageSink | undefined;
  /** What this server did, when it was given a sink. Counts nothing without one. */
  readonly counters: Counters | undefined;
  readonly shapes: ShapeRegistry;
  readonly options: BatchOptions;
  /** Extensions served by endpoints mounted beside this server, such as `mcp` by createMcpHandler; the manifest lists them. */
  readonly mounted = new Set<string>();
  /** Who this server is. Before this, two servers in one fleet were indistinguishable. */
  readonly identity: Readonly<ResolvedIdentity>;
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
      const lost = (error: unknown) => {
        this.relayState = "failed";
        this.relayStopped = error;
        relayError(error);
      };
      this.listening = opts.relay.subscribe((message) => this.receive(message), lost);
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
    this.counters = opts.counters;
    // A restart has to read as a restart, so the default instance id is per process rather than per host. Web Crypto
    // rather than node:crypto, as MemoryUploadStore does: this file is in the fetch handler's import graph.
    this.identity = Object.freeze({
      ...opts.identity,
      instance: opts.identity?.instance ?? crypto.randomUUID(),
      startedAt: (opts.now ?? Date.now)(),
    });
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
      ...(opts.counters ? { counters: opts.counters } : {}),
      ...(opts.instrumentation ? { instrumentation: opts.instrumentation } : {}),
    };
  }

  /**
   * Execute a batch; frames arrive as they are produced. The batch starts running now, whether or not its frames are
   * read, so it counts as in flight from here until it has finished running and its reader, if it has one, is done
   * with its frames: `drain()` waits for both, so a frame that ends an op is not lost to a closing connection.
   */
  execute(envelope: RequestEnvelope, opts: ExecuteOptions = {}): AsyncIterable<Frame> {
    this.active++;
    let ran = false;
    let reading = false;
    let read = false;
    let ended = false;
    const end = () => {
      if (ended || !ran || (reading && !read)) return;
      ended = true;
      if (--this.active === 0) for (const wake of this.idle.splice(0)) wake();
    };
    const frames = executeBatch(this.rt, envelope, opts, () => {
      ran = true;
      end();
    });
    const done = () => {
      read = true;
      end();
    };
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<Frame> => {
        reading = true;
        const it = frames[Symbol.asyncIterator]();
        return {
          next: async () => {
            const r = await it.next();
            if (r.done) done();
            return r;
          },
          return: async () => {
            done();
            return it.return ? it.return() : { value: undefined, done: true };
          },
        };
      },
    };
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
      const finish = () => {
        clearTimeout(timer);
        const i = this.idle.indexOf(finish);
        if (i >= 0) this.idle.splice(i, 1);
        resolve();
      };
      const timer = setTimeout(finish, opts.timeoutMs ?? 10_000);
      // the timeout bounds the wait; it must not be what keeps the process up (see close())
      (timer as { unref?: () => void }).unref?.();
      this.idle.push(finish);
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
  async close(closeTimeoutMs = 2_000): Promise<void> {
    if (!this.listening) return;
    // close() is what a shutdown path calls last, so waiting here without a bound is a server that never exits. A
    // relay still connecting has nothing to stop yet — `readiness()` reports that state as "relay: not listening
    // yet" — and its own subscribe may be retrying behind a dropped connection.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), closeTimeoutMs);
      // the guard must not be the reason the process stays up. `unref` is Node's, and this file is built for
      // runtimes that have no Node types, so it is reached the way the rest of the package reaches host extras.
      (timer as { unref?: () => void }).unref?.();
    });
    const stop = await Promise.race([this.listening.catch(() => undefined), bound]).finally(() => clearTimeout(timer));
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
