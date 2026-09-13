/**
 * Capability tokens (extension `cap`, spec 06 section 6): short-lived, scoped, delegatable references to a viewer.
 * They let an agent or a downstream service perform exactly one class of operation without ever holding the user's
 * credentials, and they can be narrowed further before being handed on.
 *
 * A token carries everything it claims and is signed, so verifying one needs no storage and no round trip:
 *
 *   rfcap1.<payload as base64url JSON>.<HMAC-SHA256 of the payload, base64url>
 *
 * The payload names the viewer it speaks for, the operations it may call, when it expires and any extra facts the
 * schema's policies may read as `viewer.caps`. Nothing in it is secret from its holder: it is a reference, not a
 * password, and it is signed so it cannot be edited.
 *
 * Attenuation only ever narrows: a derived token may drop operations and shorten the life, never add or extend.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { RayfoldError } from "./protocol.ts";

const PREFIX = "rfcap1";

export interface Capability {
  /** the viewer this token speaks for, as the server's own viewer shape */
  viewer: unknown;
  /** the operations it may call; an empty list may call none */
  ops: string[];
  /** epoch milliseconds after which it is refused */
  exp: number;
  /** who issued it, for logs and revocation lists */
  iss?: string;
  /** extra facts the schema's policies read as `viewer.caps` */
  caps?: Record<string, unknown>;
  /** unique id of this token, so one can be named in a revocation list */
  jti: string;
}

export interface MintOptions {
  /** the operations the holder may call */
  ops: string[];
  /** how long it lives, in milliseconds */
  ttlMs: number;
  iss?: string;
  caps?: Record<string, unknown>;
}

export interface CapabilitiesOptions {
  /** the signing secret; anything derived from it must not leave the server */
  secret: string | Uint8Array;
  now?: () => number;
  /** the longest life any token may have, minted or attenuated. Default one hour. */
  maxTtlMs?: number;
}

const b64url = (b: Buffer): string => b.toString("base64url");
const unb64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** Mints, verifies and narrows capability tokens with one secret. */
export class Capabilities {
  private readonly secret: Uint8Array;
  private readonly now: () => number;
  private readonly maxTtlMs: number;

  constructor(opts: CapabilitiesOptions) {
    this.secret = typeof opts.secret === "string" ? new TextEncoder().encode(opts.secret) : opts.secret;
    if (this.secret.length < 16) throw new Error("capability secret must be at least 16 bytes");
    this.now = opts.now ?? Date.now;
    this.maxTtlMs = opts.maxTtlMs ?? 3_600_000;
  }

  mint(viewer: unknown, opts: MintOptions): string {
    if (opts.ttlMs <= 0 || opts.ttlMs > this.maxTtlMs) {
      throw new Error(`capability ttl must be between 1 and ${this.maxTtlMs} ms`);
    }
    const cap: Capability = {
      viewer,
      ops: [...new Set(opts.ops)].sort(),
      exp: this.now() + opts.ttlMs,
      jti: randomUUID().replace(/-/g, ""),
      ...(opts.iss ? { iss: opts.iss } : {}),
      ...(opts.caps ? { caps: opts.caps } : {}),
    };
    return this.sign(cap);
  }

  /** The capability a token carries, or a refusal: unsigned, edited, malformed and expired all fail here. */
  verify(token: string): Capability {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX) throw new RayfoldError("unauthenticated", "Not a capability token");
    const signature = unb64url(parts[2]!);
    const expected = this.hmac(parts[1]!);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new RayfoldError("unauthenticated", "Capability signature does not match");
    }
    let cap: Capability;
    try {
      cap = JSON.parse(unb64url(parts[1]!).toString("utf8")) as Capability;
    } catch {
      throw new RayfoldError("unauthenticated", "Capability payload is not readable");
    }
    if (!cap || typeof cap !== "object" || !Array.isArray(cap.ops) || typeof cap.exp !== "number") {
      throw new RayfoldError("unauthenticated", "Capability payload is not a capability");
    }
    if (cap.exp <= this.now()) throw new RayfoldError("unauthenticated", "Capability has expired");
    return cap;
  }

  /**
   * A narrower token derived from this one: operations must be a subset of what it already allows, and the life
   * may only be shortened. The derived token is a token in its own right, so it can be narrowed again.
   */
  attenuate(token: string, narrow: { ops?: string[]; ttlMs?: number; caps?: Record<string, unknown> }): string {
    const cap = this.verify(token);
    const ops = narrow.ops ? [...new Set(narrow.ops)].sort() : cap.ops;
    const widened = ops.filter((op) => !cap.ops.includes(op));
    if (widened.length) throw new RayfoldError("permission_denied", `Cannot widen a capability: ${widened.join(", ")}`);
    const exp = narrow.ttlMs === undefined ? cap.exp : Math.min(cap.exp, this.now() + narrow.ttlMs);
    if (exp <= this.now()) throw new RayfoldError("permission_denied", "Cannot derive a capability that has expired");
    return this.sign({
      ...cap,
      ops,
      exp,
      jti: randomUUID().replace(/-/g, ""),
      // extra facts may be replaced, never added to: a narrower token cannot claim more than the one it came from
      ...(narrow.caps ? { caps: narrow.caps } : {}),
    });
  }

  /**
   * The viewer a token stands for, with what it allows attached as `caps`. Hand this to `execute` as the viewer:
   * the schema's policies read `viewer.caps.*`, and the batch refuses operations the token does not name.
   */
  viewerOf(token: string): unknown {
    const cap = this.verify(token);
    const viewer = cap.viewer;
    const caps = { ops: cap.ops, exp: cap.exp, jti: cap.jti, ...(cap.iss ? { iss: cap.iss } : {}), ...(cap.caps ?? {}) };
    return viewer !== null && typeof viewer === "object" && !Array.isArray(viewer) ? { ...(viewer as Record<string, unknown>), caps } : { viewer, caps };
  }

  private sign(cap: Capability): string {
    const payload = b64url(Buffer.from(JSON.stringify(cap), "utf8"));
    return `${PREFIX}.${payload}.${b64url(this.hmac(payload))}`;
  }

  private hmac(payload: string): Buffer {
    return createHmac("sha256", this.secret).update(`${PREFIX}.${payload}`).digest();
  }
}

/**
 * Whether a viewer holding a capability may call this operation. A viewer without `caps.ops` is not a capability
 * holder and is left to the schema's own policies.
 */
export function capabilityAllows(viewer: unknown, op: string): boolean {
  if (!viewer || typeof viewer !== "object" || Array.isArray(viewer)) return true;
  const caps = (viewer as { caps?: unknown }).caps;
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return true;
  const ops = (caps as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return true;
  return ops.includes(op);
}
