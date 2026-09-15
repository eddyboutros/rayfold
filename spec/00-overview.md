# Rayfold 0.1 overview

Rayfold is an application protocol for typed, client-shaped, streaming, cache-coherent APIs.
This document is the entry point; the numbered documents are normative.

| # | Document | Profile |
|---|---|---|
| 01 | [Schema](01-schema.md) | Core |
| 02 | [Shapes](02-shapes.md) | Core |
| 03 | [Batches and pipelining](03-batch-and-pipelining.md) | Core |
| 04 | [Frames and transport](04-frames-and-transport.md) | Core |
| 05 | [Errors](05-errors.md) | Core |
| 06 | [Authorization](06-auth.md) | Core |
| 07 | [Caching](07-cache.md) | Core |
| 08 | [Live queries and sync](08-live-and-sync.md) | Extension `live` |
| 09 | [Binary format (RB)](09-binary-format.md) | Extension `rb` |
| 10 | [MCP bridge](10-mcp-bridge.md) | Extension `mcp` |
| 04 §8 | [HTTP bindings and OpenAPI](04-frames-and-transport.md#8-http-bindings-extension-http) | Extension `http` |
| 11 | [Evolution](11-evolution.md) | Core (tooling) |
| 12 | [Security](12-security.md) | Core |

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

**Status.** Core 0.1 is frozen with the first release: it changes only by errata and clarifications. The extensions
are drafts. [process.md](process.md) says what may change in each part and how changes are proposed.

## Model in one paragraph

A **schema** declares types and four kinds of operation: `query` (safe, cacheable, shapeable, may be
live), `command` (state-changing, idempotency key required, typed errors, returns a result **and cache
patches**), `stream` (a sequence of typed items with backpressure) and `event` (a published fact that can
be subscribed to and replayed). A client sends a **batch** of operations; later operations may reference
results of earlier ones. The server answers with a stream of **frames**, one or more per operation, on any
transport that can carry ordered chunks. Every **entity** has a global identity `Type:id`, which is what
patches, caches and ETags are keyed on. JSON and the binary RB format encode the same model; a server MUST
support JSON.

## Why not just GraphQL / REST / gRPC

See [`docs/comparison.md`](../docs/comparison.md) for the feature matrix and benchmark results and
[`docs/landscape.md`](../docs/landscape.md) for the 2026 state of each incumbent.
The short version: each of them wins one dimension. Rayfold is designed so that the mechanisms compose:
persisted shapes make client-shaped queries CDN-cacheable; batch-by-default loaders make client-shaped
queries safe from N+1; typed error unions and patches make commands composable; schema-level policy makes
all of the above enforceable before deployment.

## Conformance

An implementation is *Core-conformant* when it passes every fixture in `conformance/fixtures/core/`.
Extension conformance is per extension directory. See [`conformance/README.md`](../conformance/README.md).
