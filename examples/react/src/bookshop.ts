/**
 * The bookshop server behind the React app: the same one as in examples/typescript, accepting commands from the page
 * Vite serves in development. server.ts starts it on port 4000; the tests start it on a free port.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createHttpHandler, createRayfoldServer, type RayfoldServer } from "@rayfold/server";
import { viewerFrom } from "./auth.ts";
import { resolvers, seed, type Store } from "./resolvers.ts";

const schema = readFileSync(new URL("./bookshop.rayfold", import.meta.url), "utf8");

export function createBookshop(store: Store = seed()): { server: RayfoldServer; store: Store } {
  return { server: createRayfoldServer({ schema, resolvers: resolvers(store) }), store };
}

export function bookshopHttp(server: RayfoldServer): Server {
  // #region origins
  const endpoint = createHttpHandler(server, {
    viewer: (req) => viewerFrom(req.headers.authorization),
    // the page comes from the Vite dev server, another origin, so the browser names that origin on every command
    allowedOrigins: ["http://localhost:5173"],
  });
  // #endregion origins
  return createServer((req, res) => {
    if (req.url?.startsWith("/rayfold")) return void endpoint(req, res);
    res.writeHead(404).end();
  });
}
