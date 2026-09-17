/**
 * Uploads (extension `upload`): bytes too large or too awkward for a JSON argument arrive on their own route, and the
 * command that uses them names the upload rather than carrying it.
 *
 *   POST {path}/uploads          Content-Type: application/octet-stream   -> 201 { "id": "...", "size": 1234 }
 *   POST /rayfold                { "ops": [{ "op": "setAvatar", "args": { "upload": "<id>" }, "key": "..." }] }
 *
 * Two reasons it is a route of its own rather than a multipart batch. A browser can send `multipart/form-data` to any
 * site without a preflight, so accepting it on the batch endpoint would give up half of what stops cross-site writes
 * (spec 12 §2.1); `application/octet-stream` is not safelisted either, so this route keeps that protection. And bytes
 * that travel as bytes cost what they weigh, where a base64 argument costs a third more and must be held whole.
 *
 * The store is yours: `MemoryUploadStore` is for tests and small single servers, and anything that can keep bytes -
 * S3, a Postgres large object, a disk - is a few methods. For files measured in hundreds of megabytes, hand the client
 * a URL from your storage instead and let it upload there; a protocol should not pretend to be a file server.
 */

export interface UploadMeta {
  /** What the client called it, if it said. Never trusted as a path: treat it as a label. */
  name?: string | undefined;
  /** What the client said it is. Never trusted: sniff or restrict it yourself where it matters. */
  type?: string | undefined;
  /** Bytes stored. */
  size: number;
  /** When it arrived, in milliseconds since the epoch. */
  at: number;
  /** The viewer that sent it, so a command can refuse an upload that was not theirs. */
  viewer?: unknown;
}

export interface Upload extends UploadMeta {
  id: string;
}

export interface UploadStore {
  /** Keeps the bytes and answers with the handle a command will name. Reads the stream once. */
  put(body: ReadableStream<Uint8Array>, meta: Omit<UploadMeta, "size" | "at">): Promise<Upload>;
  /** The upload a command named, or undefined when it is gone: consumed, expired, or never there. */
  open(id: string): Promise<{ upload: Upload; body: ReadableStream<Uint8Array> } | undefined>;
  /** Drops it. A command that has taken what it needs should say so, rather than wait for the lifetime to pass. */
  delete(id: string): Promise<void>;
}

export interface MemoryUploadOptions {
  /** How long an upload waits to be used. Default 1 hour. */
  ttlMs?: number;
  /** Most bytes held at once; past it the oldest go first. Default 256 MiB. */
  maxBytes?: number;
  /** Wall clock, injectable for tests. */
  now?: () => number;
  /** Ids, injectable for tests. Must be unguessable: an id is what lets a command read those bytes. */
  id?: () => string;
}

/**
 * Uploads in memory, for tests and for one small server. Bytes are held whole, so the cap is what keeps a server from
 * being filled by uploads nobody uses; anything larger than that belongs in a store that writes them down.
 */
export class MemoryUploadStore implements UploadStore {
  private readonly held = new Map<string, { upload: Upload; bytes: Uint8Array }>();
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly nextId: () => string;
  private total = 0;

  constructor(opts: MemoryUploadOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
    this.nextId = opts.id ?? (() => crypto.randomUUID());
  }

  async put(body: ReadableStream<Uint8Array>, meta: Omit<UploadMeta, "size" | "at">): Promise<Upload> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      size += value.length;
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    const upload: Upload = { id: this.nextId(), size, at: this.now(), ...meta };
    this.held.set(upload.id, { upload, bytes });
    this.total += size;
    this.sweep();
    return upload;
  }

  async open(id: string): Promise<{ upload: Upload; body: ReadableStream<Uint8Array> } | undefined> {
    const kept = this.held.get(id);
    if (!kept) return undefined;
    if (this.now() - kept.upload.at >= this.ttlMs) {
      await this.delete(id);
      return undefined;
    }
    const bytes = kept.bytes;
    return {
      upload: kept.upload,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }

  async delete(id: string): Promise<void> {
    const kept = this.held.get(id);
    if (!kept) return;
    this.held.delete(id);
    this.total -= kept.upload.size;
  }

  /** Expired uploads go first, then the oldest, until the store is inside its bound. */
  private sweep(): void {
    const t = this.now();
    for (const [id, kept] of this.held) {
      if (t - kept.upload.at < this.ttlMs) break; // insertion order is arrival order, so the rest are younger
      this.held.delete(id);
      this.total -= kept.upload.size;
    }
    for (const [id, kept] of this.held) {
      if (this.total <= this.maxBytes) break;
      this.held.delete(id);
      this.total -= kept.upload.size;
    }
  }

  /** Uploads held right now, for tests and for a health check. */
  get size(): number {
    return this.held.size;
  }

  /** Bytes held right now. */
  get bytes(): number {
    return this.total;
  }
}

/** What the upload route reads and answers. */
export interface UploadOptions {
  /** Where the bytes go. Without one, the route is not served at all. */
  store: UploadStore;
  /** Most bytes one upload may carry. Default 25 MiB. */
  maxBytes?: number;
  /**
   * Whether an upload needs an identified viewer. Default true: an open upload route is a way to fill a server's
   * storage with nothing to trace it to.
   */
  viewerRequired?: boolean;
}
