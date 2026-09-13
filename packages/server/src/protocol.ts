/** Wire-level request/frame types. Spec: spec/03, spec/04, spec/05. */
import type { JsonValue } from "@rayfold/schema";

export interface RequestOp {
  id: number;
  op: string;
  args?: Record<string, unknown>;
  shape?: string;
  vars?: Record<string, JsonValue>;
  key?: string;
  live?: boolean;
  deadline?: number;
  simulate?: boolean;
  /** Omit `$type` where the schema makes it redundant and omit `meta` unless it carries `replay`. Requires a schema-aware client. */
  compact?: boolean;
  /** Conditional write: the version the client last saw of the entity this command targets (spec 03 section 4a). */
  ifVersion?: string | number;
}

export interface RequestMeta {
  client?: string;
  deadline?: number;
  /** W3C trace context (spec 04 section 4); the HTTP transport copies it from the headers of the same names. */
  traceparent?: string;
  tracestate?: string;
}

export interface RequestEnvelope {
  rayfold?: string;
  ops: RequestOp[];
  meta?: RequestMeta;
}

export const PROTOCOL_CODES = [
  "canceled",
  "unknown",
  "invalid_argument",
  "deadline_exceeded",
  "not_found",
  "already_exists",
  "permission_denied",
  "resource_exhausted",
  "failed_precondition",
  "aborted",
  "out_of_range",
  "unimplemented",
  "internal",
  "unavailable",
  "data_loss",
  "unauthenticated",
] as const;
export type ProtocolCode = (typeof PROTOCOL_CODES)[number];
export type ErrorCode = ProtocolCode | "domain";

export interface WireError {
  code: ErrorCode;
  type?: string;
  message: string;
  data?: unknown;
  path?: string;
  retryable?: boolean;
}

export type PatchOp =
  | { set: string; value: Record<string, unknown> }
  | { del: string }
  | { inv: string[] }
  | { invOp: string[] }
  /** Result-scoped (spec 04 section 2b): merge these fields into the plain object at this result path. */
  | { at: string; value: Record<string, unknown> }
  /** Result-scoped: remove these old positions, then insert these elements at these new positions. */
  | { list: string; del?: number[]; ins?: Array<{ at: number; value: unknown }> };

export interface FrameMeta {
  cost?: number;
  cache?: "hit" | "miss" | "stale";
  ms?: number;
  replay?: boolean;
  cursor?: string;
  [k: string]: unknown;
}

export type Frame =
  | { id: number; data: unknown; meta?: FrameMeta; errors?: WireError[]; fin?: boolean }
  | { id: number; ok: unknown; patch?: PatchOp[]; meta?: FrameMeta; errors?: WireError[]; fin: true }
  | { id: number; item: unknown; meta?: FrameMeta }
  | { id: number; patch: PatchOp[]; meta?: FrameMeta }
  | { id: number; at: string; data: unknown; errors?: WireError[] }
  | { id: number; error: WireError; fin: true }
  | { id: number; fin: true }
  | { error: WireError; fin: true };

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_argument: 400,
  failed_precondition: 400,
  out_of_range: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  already_exists: 409,
  aborted: 409,
  resource_exhausted: 429,
  canceled: 499,
  unimplemented: 501,
  unavailable: 503,
  deadline_exceeded: 504,
  domain: 422,
  unknown: 500,
  internal: 500,
  data_loss: 500,
};

const RETRYABLE = new Set<ErrorCode>(["unavailable", "deadline_exceeded", "aborted"]);

/** Thrown by resolvers / runtime; converted to a WireError at the frame boundary. */
export class RayfoldError extends Error {
  readonly code: ErrorCode;
  readonly type: string | undefined;
  readonly data: unknown;
  readonly path: string | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: { type?: string | undefined; data?: unknown; path?: string | undefined; retryable?: boolean | undefined } = {}) {
    super(message);
    this.name = "RayfoldError";
    this.code = code;
    this.type = opts.type;
    this.data = opts.data;
    this.path = opts.path;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
  }

  toWire(): WireError {
    const w: WireError = { code: this.code, message: this.message };
    if (this.type !== undefined) w.type = this.type;
    if (this.data !== undefined) w.data = this.data;
    if (this.path !== undefined) w.path = this.path;
    if (this.retryable !== RETRYABLE.has(this.code)) w.retryable = this.retryable;
    return w;
  }

  withPath(path: string): RayfoldError {
    return new RayfoldError(this.code, this.message, { type: this.type, data: this.data, path, retryable: this.retryable });
  }

  static domain(type: string, data: unknown, message?: string): RayfoldError {
    return new RayfoldError("domain", message ?? type, { type, data });
  }
}

/**
 * Raised through `ctx.checkVersion` when a conditional command's `ifVersion` does not match.
 * The executor projects `current` through the op's shape so the client can repair its cache without a GET.
 */
export class VersionConflict extends RayfoldError {
  constructor(
    readonly key: string,
    readonly expected: string | number,
    readonly actual: unknown,
    readonly current: unknown,
  ) {
    super("failed_precondition", `${key} is at version ${String(actual)}, not ${String(expected)}`, { type: "VersionConflict", data: { key, expected, actual } });
  }
}

export function toWireError(e: unknown): WireError {
  if (e instanceof RayfoldError) return e.toWire();
  if (e instanceof Error && e.name === "AbortError") return { code: "canceled", message: "Canceled" };
  return { code: "internal", message: "Internal error" };
}
