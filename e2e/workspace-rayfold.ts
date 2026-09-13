/**
 * The workspace served by Rayfold: one endpoint for the protocol, the MCP bridge and the `@http` bindings on the
 * same server, and a WebSocket for live queries and streams. Everything it enforces - who may read a row, what a
 * field costs, what may be cached - comes from `workspace.rayfold`; there is no per-route code here to write.
 */
import type { AddressInfo } from "node:net";
import { attachWebSocket, createBindingHandler, createHttpHandler, createMcpHandler } from "@rayfold/server";
import { createWorkspace, type Store } from "../examples/workspace-ts/src/index.ts";
import { closeServer, listen, viewerOf, type Counters, type WorkspaceStack } from "./workspace-rest.ts";

export async function startWorkspaceRayfold(store: Store): Promise<WorkspaceStack & { workspace: ReturnType<typeof createWorkspace> }> {
  const counters: Counters = { originRequests: 0, loaderCalls: store.calls };
  const workspace = createWorkspace({ store });
  const viewer = (req: { headers: Record<string, string | string[] | undefined> }): ReturnType<typeof viewerOf> => viewerOf(store, req.headers["authorization"] as string | undefined);

  const handler = createHttpHandler(workspace.server, { viewer });
  const mcp = createMcpHandler(workspace.server, { viewer });
  const bindings = createBindingHandler(workspace.server, { viewer });
  const server = await listen(async (req, res) => {
    counters.originRequests++;
    if ((req.url ?? "/").startsWith("/rayfold")) return handler(req, res);
    if (await mcp(req, res)) return;
    if (await bindings(req, res)) return;
    res.writeHead(404).end();
  });
  attachWebSocket(server, workspace.server, {
    viewer: (req) => {
      const auth = new URL(req.url ?? "/", "http://x").searchParams.get("auth");
      return viewerOf(store, auth ? `Bearer ${auth}` : undefined);
    },
  });

  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { name: "Rayfold", base, server, counters, store, workspace, close: () => closeServer(server) };
}
