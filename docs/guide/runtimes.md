# Hono, Workers, Bun, Deno and Next.js

`createFetchHandler` is the Rayfold endpoint as a `Request` → `Response` function. Anywhere that shape is what a
server takes, Rayfold runs — with the same batches, live queries, policies and caching as on Node, because the Node
transport is this handler with an adapter in front rather than a second implementation. The one thing that does not
come with it is `@http` REST bindings: `createBindingHandler` is written against Node's `req`/`res` and has no fetch
form yet, so a schema's REST routes are served on Node only.

```ts
import { createFetchHandler } from "@rayfold/server";

const handler = createFetchHandler(server, {
  viewer: (request) => viewerFrom(request.headers.get("authorization")),
});
```

Nothing in it touches Node, so it also imports from `@rayfold/server/core` in a runtime that has no Node built-ins at
all. A test bundles that entry for the browser and fails if any file in its import graph imports from `node:` or
reaches for `Buffer` or `process`.

## Where to put it

::: code-group

```ts [Cloudflare Workers]
import { createRayfoldServer, createFetchHandler } from "@rayfold/server/core";

const server = createRayfoldServer({ schema, resolvers });
const handler = createFetchHandler(server, { viewer: (r) => viewerFrom(r) });

export default { fetch: handler };
```

```ts [Hono]
import { Hono } from "hono";

const app = new Hono();
// every method and every sub-path: /rayfold/manifest, /openapi.json, /health, /ready, /uploads
app.all("/rayfold/*", (c) => handler(c.req.raw));
app.all("/rayfold", (c) => handler(c.req.raw));
```

```ts [Bun]
Bun.serve({ port: 4000, fetch: handler });
```

```ts [Deno]
Deno.serve({ port: 4000 }, handler);
```

```ts [Next.js route handler]
// app/rayfold/[[...path]]/route.ts
const GET = (request: Request) => handler(request);
export { GET, GET as POST, GET as OPTIONS };
```

:::

`path` moves the endpoint (`createFetchHandler(server, { path: "/api/rayfold" })`); mount your framework's route on the
same prefix.

## What differs from the Node transport

**Say whether you are loopback-bound.** A server reached on 127.0.0.1 answers loopback host names only, which defeats
DNS rebinding ([spec 12 §2](../../spec/12-security.md)). The Node transport reads that from the socket; a fetch runtime
has none, so pass `loopback: true` when you serve a development server on localhost. `allowedHosts` works everywhere
and is what to use in production.

**Live queries need the platform to let a response stay open.** Workers, Deno and Bun stream, so a live query or a
stream works there as it does on Node. What serverless takes away is not streaming but duration: when a platform cuts
a response at its time limit, the op ends with it. The client library reopens a `client.live()` subscription after a
retryable end, so a screen recovers by itself — but on a platform with a short limit, expect reconnections rather than
one long-lived response.

**The relay and graceful shutdown assume a process.** `PgRelay` holds a `LISTEN` connection and `server.drain()` waits
for in-flight batches, which suit a server that stays up ([Deployment](deployment.md)). On a per-request runtime, a
command's patches still reach the caller that ran it; other instances hear them only if you give every one of them a
relay, which a durable object or a container can hold but a short-lived isolate cannot.

## Uploads and other bodies

The handler reads at most `maxBody` bytes (1 MiB by default) and refuses more with `413`, before anything runs.

The upload route comes with it: `createFetchHandler(server, { uploads: { store } })` serves `POST {path}/uploads` on
any of these runtimes ([Uploads](uploads.md)). It has a bound of its own — `maxBytes`, 25 MiB by default — counted as
the bytes arrive, so `maxBody` does not apply to it.

## Checking it

`GET {path}/health` and `GET {path}/ready` answer on every runtime, so the same probes work behind any of them
([Deployment](deployment.md)). `GET {path}/manifest` serves the schema a client needs to speak to you.
