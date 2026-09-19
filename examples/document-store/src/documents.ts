/**
 * The document store as a server: three routes, and only one of them carries bytes.
 *
 *   POST /rayfold/uploads   the bytes arrive, and are written to a file, not held and not put in a row
 *   POST /rayfold           a command names the upload; the answer carries `url`, never the bytes
 *   GET  /files/{id}        where that url points, for the browser, an <img>, or a download
 *
 * server.ts starts it on port 4000; the tests start it on a free port with directories of their own.
 */
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHttpHandler, createRayfoldServer, FileUploadStore, type RayfoldServer, type UploadStore } from "@rayfold/server";
import { FileStore } from "./files.ts";
import { resolvers, seed, viewerFrom, type Parts, type Store } from "./resolvers.ts";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("./documents.rayfold", import.meta.url), "utf8");

export interface Bookkeeping {
  /** Where uploads wait to be claimed. */
  uploads: string;
  /** Where kept bytes live. */
  files: string;
}

export interface DocumentStore {
  server: RayfoldServer;
  store: Store;
  files: FileStore;
  /** The same instance the route writes to: what a command opens has to be what arrived. */
  uploads: UploadStore;
}

export function createDocumentStore(dirs: Bookkeeping, parts: Partial<Parts> = {}): DocumentStore {
  const store = parts.store ?? seed();
  const files = parts.files ?? new FileStore(dirs.files);
  const uploads = parts.uploads ?? new FileUploadStore({ dir: dirs.uploads });
  const server = createRayfoldServer({
    schema,
    resolvers: resolvers({ store, files, uploads, ...(parts.id ? { id: parts.id } : {}), ...(parts.now ? { now: parts.now } : {}) }),
  });
  return { server, store, files, uploads };
}

/** Two directories under the system's temporary one, for a demo or a test that does not care where they are. */
export async function scratchDirs(): Promise<Bookkeeping> {
  const root = await mkdtemp(join(tmpdir(), "document-store-"));
  return { uploads: join(root, "uploads"), files: join(root, "files") };
}

export function documentStoreHttp({ server, files, uploads }: DocumentStore): Server {
  const endpoint = createHttpHandler(server, {
    viewer: (req) => viewerFrom(req.headers.authorization),
    // an upload is a write: it wants an identified sender, and the store writes it straight to disk
    uploads: { store: uploads },
  });

  return createServer((req, res) => {
    // #region serve
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (req.method === "GET" && path.startsWith("/files/")) return void serve(decodeURIComponent(path.slice("/files/".length)));
    // #endregion serve
    if (path.startsWith("/rayfold")) return void endpoint(req, res);
    res.writeHead(404).end();

    async function serve(id: string): Promise<void> {
      // asked before the status line goes out: a stream that fails afterwards can only close the connection, which
      // a client cannot tell from a network fault
      if (!(await files.has(id))) return void res.writeHead(404).end();
      const bytes = files.read(id);
      if (!bytes) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/octet-stream", "x-content-type-options": "nosniff" });
      // streamed, so serving a large document costs one chunk of memory rather than the whole file
      Readable.fromWeb(bytes as Parameters<typeof Readable.fromWeb>[0])
        .on("error", () => res.destroy())
        .pipe(res);
    }
  });
}
