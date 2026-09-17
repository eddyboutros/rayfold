# Rayfold versus the incumbents

Two parts: what each mechanism does (verified in this repo's tests and conformance fixtures), and what the
same three flows cost over REST, GraphQL and Rayfold (`npm run bench`, `bench/results/latest.md`).

## 1. Mechanisms

| Capability | REST | GraphQL | gRPC / Connect | tRPC | Convex / Zero | MCP | Rayfold |
|---|---|---|---|---|---|---|---|
| Client-shaped responses | no (over/under-fetch) | selection sets | no | no | query language | no | shapes, plus a **default view** so a bare call works from curl and agents |
| Shared HTTP caching | yes | `GET` for queries, persisted queries to keep URLs short; `POST` by default | `GET` for idempotent unary RPCs (Connect); none over gRPC/HTTP-2 | no | no | no | `GET`/`QUERY` with ETag + `Cache-Control` derived from `@cache` and policies |
| Typed contract | OpenAPI (optional) | SDL | Protobuf | TS only | TS only | JSON Schema per tool | one `.rayfold` IR: types, ops, **auth, cost, cache, views, deprecation** |
| Nullability default | n/a | nullable | optional-ish | TS | TS | JSON Schema | **non-null**; `T?` opts in |
| N+1 | n/a | DataLoader by hand | n/a | n/a | n/a | n/a | loaders are **batch by default**, one call per level across lists and pages |
| Round trips for create-then-read | 2 to 3 | 1 when the read is reachable from the mutation payload, 2 when it is not | 2 | 2 (batching is per-tick) | 1 (server function) | 2 | **1**: `{ "$ref": "1.id" }` pipelining, for any read |
| Errors | status codes | `errors[]` + partial data, HTTP 200 | 16 codes | thrown | thrown | `isError` | 16 codes **and** typed domain errors declared with `throws`; atomic by default, `@partial` opt-in |
| Authorization | middleware | per-resolver | interceptors | middleware | rules in code | OAuth only | **policy expressions in the schema**, evaluated per op / type / field; default views never leak |
| Cost / DoS control | rate limits | depth and complexity limits from libraries | none | none | none | none | static cost from `@cost` and page sizes, per-batch budget, trusted-shape allowlist |
| Cache coherence after writes | none | manual cache updates | none | invalidate | automatic | none | commands return **patches**; every client view updates without refetch |
| Realtime | SSE/WebSocket by hand | subscriptions (separate type) | streams | subscriptions | live queries | none | `"live": true` on any query; the server diffs the result it already served and sends **only what changed** (changed entity fields, rows added to or removed from a list, fields of a plain object), falling back to a fresh `data` frame when the change cannot be described |
| Streaming / incremental | chunked by hand | `@defer` shipped by several servers, still a spec draft | streams | `httpBatchStreamLink` and async-generator outputs (v11) | no | SSE | every response is frames; `@lazy`/`@defer` deliver later; streams with `fin` |
| Idempotency | Idempotency-Key convention | none | none | none | mutations are transactions | none | **mandatory key** on commands, replay with `meta.replay` |
| Evolution | versions | deprecation only | field numbers | none | none | none | additive-only enforced by `rayfold check`, sunset dates, lockfile ordinals, no versions |
| Agent access | OpenAPI-to-tools adapters | adapters | none | none | none | native | **any Rayfold server is an MCP server** (tools, resources, simulate, typed errors) |
| Binary wire | no | no | Protobuf | no | no | no | RB: schema key dictionary + string table; same frames as JSON |
| Discovery | OpenAPI | introspection | reflection | none | none | `tools/list` | `GET /rayfold/manifest`: IR, hash, extensions, limits |

**What this table compares, and what it does not.** Each column says what the protocol gives you by default, not the
ceiling of what a team can build on it. Most of the GraphQL rows can be met with work that many teams already do:
persisted queries put reads behind `GET` so a CDN can cache them, DataLoader solves N+1, complexity plugins bound cost,
an `Idempotency-Key` convention makes retries safe, and cache normalisation in Apollo or Relay keeps views current. The
claim here is not that GraphQL cannot do these things. It is that each is a separate decision, library and convention
per team, where Rayfold makes them the default and writes them in the schema, so a second team on the same API gets
them without repeating the work. Where a row says "no", it means the protocol has no answer of its own, not that the
ecosystem has none.

## 2. Measured on the bookstore (loopback, Node 24, 300 iterations, interleaved)

Same data, same three flows, careful implementations of each style (REST with parallel dependent
requests, GraphQL with a DataLoader-style batcher). Rayfold sends what its client sends when it has the schema:
compact frames, without `$type` and `meta` (the GraphQL queries ask for no `__typename` either). Each iteration runs
every implementation once, rotating which one goes first, so drift on the machine affects all of them alike. REST's
bytes up exclude request bodies for `GET`s, which is why its column reads 0 on the two read flows.

| Flow | Implementation | round trips | bytes down | bytes up | p50 ms | p99 ms |
|---|---|---:|---:|---:|---:|---:|
| A. product page (book + author + 3 reviews) | REST | 2 | 405 | 0 | 0.51 | 2.05 |
| | GraphQL | 1 | 282 | 157 | 0.59 | 2.49 |
| | Rayfold (JSON) | 1 | 302 | 182 | 0.60 | 2.10 |
| | Rayfold (RB) | 1 | **177** | 143 | 0.62 | 2.44 |
| B. catalogue list (20 books with author names) | REST | 2 | 2810 | 0 | 0.92 | 2.33 |
| | GraphQL | 1 | 2074 | 89 | 0.54 | 4.51 |
| | Rayfold (JSON) | 1 | 2083 | 142 | 0.53 | 1.59 |
| | Rayfold (RB) | 1 | **1080** | 95 | 0.58 | 2.12 |
| C. place order, read it back with stock | REST | 3 | 327 | 35 | 0.52 | 4.47 |
| | GraphQL | 2 | 157 | 204 | 0.86 | 3.44 |
| | Rayfold (JSON) | **1** | 220 | 279 | 0.56 | 2.76 |
| | Rayfold (RB) | **1** | **101** | 172 | 0.58 | 2.32 |

What the numbers say, honestly:

* **Round trips** are where Rayfold wins structurally: one for every flow, including create-then-read. Over a
  real network each extra round trip costs tens of milliseconds; on loopback it is invisible. GraphQL's second
  trip in flow C is not a hard limit — a mutation whose payload type reaches the data you want can select it
  inline. What it cannot do is feed an *independent* root field from a mutation's result, or carry unrelated
  reads in the same document, which is what `$ref` pipelining is for.
* **RB is the smallest in every flow**: 62% of GraphQL's bytes on the product page, 52% on the list and 64% on
  the order flow, with frames identical to the JSON run.
* **Compact JSON is close to GraphQL's JSON**, 7% larger on the product page and 0.4% on the list. In the order flow
  it is larger (220 vs 157 bytes) because the command also returns patches, which keep every cached view correct
  without a refetch. A client without the schema asks for full frames, which add `$type` to every entity and
  `meta.cost` to every frame.
* **Latency** at this scale is noise, and should be read as noise. Every median here sits between 0.5 and 0.9 ms on
  loopback, the spread between stacks is smaller than the spread between two runs of the same stack, and which one
  comes out lowest changes from run to run. All these numbers establish is that Rayfold's executor is in the same
  class as graphql-js and a hand-written REST handler, not that it is faster. The round-trip column is the one that
  survives contact with a real network.

## 3. The large example: an issue tracker

The numbers above come from the bookstore, which is small on purpose. `examples/workspace-ts` is the opposite: a
multi-tenant issue tracker with 2 organisations, 4 teams, 7 projects, 18 sprints, 630 issues
(with sub-issues, labels, estimates and versions), 900 comments, 1156 activity entries of four different kinds,
and notifications. It uses an interface for the feed, a union for search, row and field policies, per-parent
pagination, conditional writes, bulk commands, live queries, `@lazy` and `@partial` fields, `@cost` budgets,
`@cache` scopes, `@http` bindings, a stream and the MCP bridge.

`e2e/workspace.test.ts` builds that domain three ways (REST, GraphQL with and without DataLoader, Rayfold) and runs
17 scenarios against all three over real HTTP, checking they give the same answers before measuring what they cost.
Results: `e2e/workspace.md` and the "Issue tracker" section of the HTML report. Rayfold was ahead on 10, level on
7, behind on none.

Some of what it measured:

* **One board** (six columns, their totals and the first ten issues of each, with the assignee and labels):
  57 486 bytes over REST, 21 783 over GraphQL, 9 446 over Rayfold's binary wire, from one request on each.
* **One issue page** (project, people, labels, sub-issues, comments): five round trips over REST, one on the
  other two.
* **Closing a sprint**: the command answers with 11 entity patches, so every cached screen holding those issues is
  corrected without a refetch. The other two report the new sprint state and leave the client to refetch.
* **One tenant rule**: `@allow` on the entity is enforced on the batch endpoint, the `@http` route, the MCP
  resource and the live query alike; REST and GraphQL enforce theirs in the one handler each was written in.
* **N+1**: the same GraphQL query and schema without DataLoader made many times more data-source calls than with
  it; Rayfold has no such mode, because a field loader is handed the whole level.

Not measured yet: hit rates on a commercial CDN under real traffic (CI does put nginx in front as a shared cache
and asserts miss-then-hit on public reads and never-hit on private ones), live-query update latency versus polling,
and the Kotlin runtime.
