/**
 * Uploads written to a directory rather than held in memory or kept in a database row.
 *
 * This is the store to reach for when the bytes are files. `MemoryUploadStore` holds everything whole, and
 * `PgUploadStore` puts the bytes in a column — which suits small things and stops suiting them somewhere in the low
 * megabytes, because both ends of a database round trip hold the whole value. Here the bytes are streamed to a file
 * and streamed back out, so what a server needs at once is one chunk, whatever the file weighs.
 *
 *   const uploads = new FileUploadStore({ dir: "/var/lib/app/uploads" });
 *   createHttpHandler(server, { uploads: { store: uploads } });
 *
 * What it is not: permanent storage. An upload is a staging area — bytes arrive, a command names them, and the
 * command takes what it needs and deletes them ([ttlMs] sweeps whatever nobody claimed). An application that keeps
 * files keeps them somewhere of its own and hands out a URL; see examples/document-store.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Upload, UploadMeta, UploadStore } from "./uploads.ts";

export interface FileUploadOptions {
  /** The directory the bytes are written under. Created if it is not there. */
  dir: string;
  /** How long an upload waits to be claimed. Default 1 hour. */
  ttlMs?: number;
  /** Wall clock, injectable for tests. */
  now?: () => number;
  /** Ids, injectable for tests. Must be unguessable: an id is what lets a command read those bytes. */
  id?: () => string;
}

/** An id is a file name here, so anything that is not one is refused before it can reach the filesystem. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export class FileUploadStore implements UploadStore {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly nextId: () => string;

  constructor(opts: FileUploadOptions) {
    this.dir = opts.dir;
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.now = opts.now ?? Date.now;
    this.nextId = opts.id ?? (() => crypto.randomUUID());
  }

  async put(body: ReadableStream<Uint8Array>, meta: Omit<UploadMeta, "size" | "at">): Promise<Upload> {
    // every time, not once: a directory that goes away — a remounted volume, an operator clearing it, a tmpfs that
    // reset — used to leave a cached promise saying it was there, and every upload after that failed until restart.
    // `mkdir -p` on a directory that exists is one cheap syscall.
    await mkdir(this.dir, { recursive: true });
    const id = this.nextId();
    if (!ID.test(id)) throw new Error(`FileUploadStore: an id must match ${ID}, got ${JSON.stringify(id)}`);
    const bytes = this.bytesPath(id);
    try {
      await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(bytes));
    } catch (e) {
      // a half-written file is worse than none: a later open would hand a command a truncated document
      await rm(bytes, { force: true });
      throw e;
    }
    const upload: Upload = { id, size: (await stat(bytes)).size, at: this.now(), ...meta };
    await writeFile(this.metaPath(id), JSON.stringify(upload), "utf8");
    await this.sweep();
    return upload;
  }

  async open(id: string): Promise<{ upload: Upload; body: ReadableStream<Uint8Array> } | undefined> {
    if (!ID.test(id)) return undefined;
    const upload = await this.meta(id);
    if (!upload) return undefined;
    if (this.now() - upload.at >= this.ttlMs) {
      await this.delete(id);
      return undefined;
    }
    const body = Readable.toWeb(createReadStream(this.bytesPath(id))) as ReadableStream<Uint8Array>;
    return { upload, body };
  }

  async delete(id: string): Promise<void> {
    if (!ID.test(id)) return;
    await Promise.all([rm(this.bytesPath(id), { force: true }), rm(this.metaPath(id), { force: true })]);
  }

  /** Drops whatever nobody claimed before its lifetime ran out. Called on every put; safe to call yourself. */
  async sweep(): Promise<void> {
    const t = this.now();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return; // the directory is gone; there is nothing to sweep
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const upload = await this.meta(id);
      if (upload && t - upload.at >= this.ttlMs) await this.delete(id);
    }
  }

  private async meta(id: string): Promise<Upload | undefined> {
    try {
      return JSON.parse(await readFile(this.metaPath(id), "utf8")) as Upload;
    } catch {
      return undefined; // never written, already claimed, or swept
    }
  }

  private bytesPath(id: string): string {
    return join(this.dir, `${id}.bin`);
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
