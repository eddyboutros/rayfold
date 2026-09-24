---
title: MCP for AI agents
description: Serve the same API to AI agents over the Model Context Protocol — commands become tools, queries become tools and resources, and every rule still applies.
---

# MCP for AI agents

An agent that wants to use your API has the same problem a developer has: what can it call, what arguments does it
take, and what comes back. A Rayfold schema already answers all three, so the MCP endpoint is a translation rather
than a second API — mount it and an agent sees the operations you already wrote.

Nothing about authorization changes. An agent's request runs as a viewer like any other, through the same
`@allow`/`@deny` rules, the same cost limits and the same idempotency. There is no separate path into your data for
agents, which is the point.

## Mount it

::: code-group

```ts [TypeScript]
import { createServer } from "node:http";
import { createRayfoldServer, createHttpHandler } from "@rayfold/server";
import { createMcpHandler } from "@rayfold/server";

const server = createRayfoldServer({ schema, resolvers });
const rayfold = createHttpHandler(server, { viewer });
const mcp = createMcpHandler(server, { viewer });

createServer(async (req, res) => {
  if (await mcp(req, res)) return; // answers only its own path
  await rayfold(req, res);
}).listen(4000);
```

```kotlin [Kotlin]
val server = RayfoldServer(ir, resolvers)
val http = RayfoldHttp(server) { ex -> viewerOf(ex) }.start(4000) // serves /rayfold; returns the running HttpServer
RayfoldMcp(server) { ex -> viewerOf(ex) }.mount(http)              // adds /mcp beside it
```

:::

The handler answers `false` for a path that is not its own, so it chains in front of anything else. The default path
is `/mcp`; pass `path` to change it. A server serving MCP says `mcp` in its manifest, so a client can tell.

`POST` only, `application/json` only, and the `Origin` of the request is checked — without that, any web page open in
a browser could drive a local or intranet server. Configure `allowedOrigins` as you do for the main endpoint.

## What an agent sees

| Rayfold | MCP |
|---|---|
| `command` | a tool |
| `command` with `@simulate` | a second tool, `name.simulate`, that runs it as a dry run |
| `query` | a tool; also a listed resource at `rayfold://query/<name>` when it has no required arguments (the others can still be read as `rayfold://query/<name>?arg=value`) |
| `stream` | not exposed |
| the schema | a resource at `rayfold://schema` |

Argument schemas come from the operation's own arguments, so an agent gets the types, the defaults and the
descriptions you wrote once. A tool's `outputSchema` describes what a call returns, which is the default view: it
declares every field, but requires none, since the view may leave some out. Resource arguments in the URI are
converted by their declared types, so `?limit=5` passes the number 5 to an `Int` argument.

The `.simulate` variant appears **only** where the command declares `@simulate`. The runtime cannot make a resolver
honour a dry run that never checks `ctx.simulate`, so it does not offer a dry run it cannot keep — an agent that
wants to check before it acts can trust the tool being there.

## What the schema resource serves

`rayfold://schema` serves the IR **without policy expressions** by default. A policy expression is a description of
what your authorization depends on, which is a map of what to probe; the rules still run, the agent simply does not
get to read them.

```ts
createMcpHandler(server, { viewer, schema: "redacted" }); // the default
createMcpHandler(server, { viewer, schema: "full" });     // everything, for a trusted deployment
createMcpHandler(server, { viewer, schema: "off" });      // no schema resource at all
```

`resources/read` is a read verb, and it refuses to run a command however the URI is written — a read cannot be made
to write.

## Giving an agent less than a user

An agent usually needs a fraction of what the user it acts for can do. A [capability token](./capabilities.md) is the
narrow credential for that: mint one scoped to the operations the agent needs, hand it over, and let it expire.

## Next

- [Who can do what](../learn/auth.md) — the rules that still apply to every agent request.
- [Capability tokens](./capabilities.md) — scoped, short-lived credentials to hand an agent.
- [The MCP bridge chapter](../../spec/10-mcp-bridge.md) of the specification, which defines the mapping exactly.
