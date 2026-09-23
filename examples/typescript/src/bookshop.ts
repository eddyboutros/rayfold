/**
 * The bookshop's HTTP server, with the explorer beside the endpoint. server.ts starts it on port 4000; the tests start
 * the same server on a free port.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createExplorerHandler } from "@rayfold/explorer";
import { createHttpHandler, createRayfoldServer, type RayfoldServer } from "@rayfold/server";
import { viewerFrom } from "./auth.ts";
import { resolvers, seed, type Store } from "./resolvers.ts";

export { devToken, viewerFrom } from "./auth.ts";
export { resolvers, seed, type Author, type Book, type Store, type Viewer } from "./resolvers.ts";

// #region server
const schema = readFileSync(new URL("./bookshop.rayfold", import.meta.url), "utf8");

export function createBookshop(store: Store = seed()): { server: RayfoldServer; store: Store } {
  return { server: createRayfoldServer({ schema, resolvers: resolvers(store) }), store };
}

export function bookshopHttp(server: RayfoldServer): Server {
  const endpoint = createHttpHandler(server, { viewer: (req) => viewerFrom(req.headers.authorization) });
  const explorer = createExplorerHandler({ endpoint: "/rayfold", title: "Bookshop" });

  return createServer((req, res) => {
    if (explorer(req, res)) return;
    if (req.url?.startsWith("/rayfold")) return void endpoint(req, res);
    res.writeHead(404).end();
  });
}
// #endregion server
