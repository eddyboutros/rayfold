/**
 * Where the bytes live once a command has kept them.
 *
 * An upload is a staging area with a lifetime; a document is not. So a command moves the bytes out of the upload
 * store and into this one, which is a directory of files named by revision id and nothing else. Every document and
 * every revision carries the `url` these are served at, and that is the only way anything else refers to the bytes.
 *
 * In production this is an object store and `url` points at it (or at a CDN in front of it). The shape does not
 * change: write the bytes somewhere, keep the URL, serve it.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** A revision id is a file name, so nothing else may be one. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export class FileStore {
  constructor(
    private readonly dir: string,
    /** What `url` is prefixed with. A path here; an object store's origin in production. */
    private readonly base = "/files",
  ) {}

  url(id: string): string {
    return `${this.base}/${id}`;
  }

  /** Writes the bytes under [id] and answers how many there were. */
  async write(id: string, body: ReadableStream<Uint8Array>): Promise<number> {
    if (!ID.test(id)) throw new Error(`FileStore: ${JSON.stringify(id)} is not a usable name`);
    // every time: a cached mkdir outlives the directory it made, and a volume that goes away then fails every write
    await mkdir(this.dir, { recursive: true });
    const path = this.path(id);
    try {
      await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path));
    } catch (e) {
      await rm(path, { force: true });
      throw e;
    }
    return (await stat(path)).size;
  }

  /** The bytes, or undefined when there are none under that name. */
  read(id: string): ReadableStream<Uint8Array> | undefined {
    if (!ID.test(id)) return undefined;
    const stream = createReadStream(this.path(id));
    // a missing file fails on the first read rather than here, so the stream is the place to notice it
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  }

  async has(id: string): Promise<boolean> {
    if (!ID.test(id)) return false;
    return stat(this.path(id)).then(
      () => true,
      () => false,
    );
  }

  async remove(id: string): Promise<void> {
    if (!ID.test(id)) return;
    await rm(this.path(id), { force: true });
  }

  private path(id: string): string {
    return join(this.dir, id);
  }
}
