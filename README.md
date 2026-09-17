<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo/rayfold-symbol-color-dark.svg">
  <img src="logo/rayfold-symbol-color.svg" width="72" height="72" alt="">
</picture>

# Rayfold

Rayfold is an API protocol where the rules live in the schema: not just the shape of a request, but who may make it,
what may be cached, how clients stay consistent, and what may change later. Describe your API once and you get:

- **One request per screen.** Several operations travel in one batch, and a later one can use an earlier one's result.
- **Screens that stay current.** Commands return patches for what they changed; the client's cache applies them, so
  every component showing that entity updates without fetching it again. Live queries push other people's changes.
- **Rules in the schema.** Access (`@allow`), cost limits (`@cost`), caching (`@cache`) and deprecation with a sunset
  date live in the schema; the runtime enforces them and the tooling reports breaking changes before they ship.
- **No N+1 by accident.** Field resolvers are batch loaders by default: one call per nesting level.
- **Plain HTTP when you want it.** JSON over `POST`, cacheable `GET`, REST routes from `@http`, OpenAPI 3.2, and an
  MCP endpoint so AI agents can use the same API.

The [website](https://rayfold.dev/) has a [get started guide](https://rayfold.dev/get-started/)
for TypeScript, React, Kotlin, Java and Spring Boot, and a [playground](https://rayfold.dev/playground)
that runs Rayfold in your browser.

## Install

| You build | Install | Guide |
|---|---|---|
| A Node.js server | `npm install @rayfold/server` | [Quickstart](docs/guide/quickstart.md) |
| A server on Workers, Deno, Bun or Hono | `npm install @rayfold/server` | [Runtimes](docs/guide/runtimes.md) |
| A web or Node.js client | `npm install @rayfold/client` | [Quickstart](docs/guide/quickstart.md#4-call-it) |
| A React app | `npm install @rayfold/react @rayfold/client` | [React](docs/guide/react.md) |
| Resolvers over Postgres | `npm install @rayfold/postgres` | [Postgres](docs/guide/postgres.md) |
| OpenTelemetry tracing | `npm install @rayfold/otel` | [Tracing](docs/guide/tracing.md) |
| An explorer next to the endpoint | `npm install @rayfold/explorer` | [Explorer](docs/guide/explorer.md) |
| Editor support for `.rayfold` | `npm install --save-dev @rayfold/lsp` | [Editors](docs/guide/editors.md) |
| Schemas written in TypeScript | `npm install @rayfold/builder` | [TypeScript](docs/guide/typescript.md) |
| Schema tooling: check, lock, explain, gen, import, mock | `npm install --save-dev @rayfold/cli` | [CLI](packages/cli/README.md) |
| A Kotlin server | `dev.rayfold:rayfold-core` | [Kotlin](docs/guide/kotlin.md) |
| A Kotlin or Android client | `dev.rayfold:rayfold-client` (and `rayfold-client-okhttp` on Android) | [Kotlin client](docs/guide/kotlin.md#a-client) |
| A Java server | `dev.rayfold:rayfold-java` | [Java](docs/guide/java-spring.md) |
| A Spring Boot app | `dev.rayfold:rayfold-spring-boot-starter` | [Spring Boot](docs/guide/java-spring.md#spring-boot) |

Version 0.1.0 is on npm and Maven Central; the [changelog](CHANGELOG.md) lists what it holds.

## Sixty-second tour

```
entity Book @cache(maxAge: 60s, scope: public) {
  id: ID
  title: String
  stock: Int
  author: Author                                     // batch loader by default
  costPrice: Decimal? @allow(read: viewer.role == "admin" || viewer.id == ownerId)
  ownerId: ID
}
view Book.default = { id title stock author { id name } }
query books(filter: BookFilter?, page: PageArgs = { first: 20 }): Page<Book> @cost(base: 5, perItem: 1)
command placeOrder(input: OrderInput): Order throws OutOfStock | PaymentDeclined emits OrderPlaced @allow(write: viewer != null)
```

```json
POST /rayfold
{ "ops": [
  { "id": 1, "op": "placeOrder", "args": { "input": { "lines": [{ "bookId": "b1", "qty": 2 }] } }, "key": "5c9c..." },
  { "id": 2, "op": "order", "args": { "id": { "$ref": "1.id" } }, "shape": "{ id status items { qty book { id stock } } }", "live": true }
]}
```

```
{"id":1,"ok":{"$type":"Order","id":"o1",...},"patch":[{"set":"Order:o1",...},{"set":"Book:b1","value":{"stock":3}}],"meta":{"cost":10},"fin":true}
{"id":2,"data":{"$type":"Order","id":"o1","status":"PLACED",...},"meta":{"cost":9}}
{"id":2,"patch":[{"set":"Order:o1","value":{"status":"CANCELLED"}}]}      <- later, because live:true
```

## What you stop writing

That tour is one ordinary feature: place an order, show it, and leave every other open screen correct. Written the
usual way it is three steps, and the third grows with every screen you add.

```ts
await client.mutate({ mutation: PLACE_ORDER, variables: { input } });        // 1. the write
const { data } = await client.query({ query: ORDER, variables: { id },      // 2. the read it implies
  fetchPolicy: "network-only" });
await client.refetchQueries({ include: [CART, STOCK_BANNER, ORDERS] });     // 3. everything else is stale now
```

In Rayfold step 2 travels in the same request and takes its argument from step 1's result, and step 3 does not exist:
the command answers with patches, so every cached view holding those entities has already corrected itself.

```ts
const batch = client.batch();
const placed = batch.command<Order>("placeOrder", { input }, { shape: "{ id }" });
const shown = batch.query<Order>("order", { id: placed.ref("id") }, { shape: "{ status items { qty book { stock } } }" });
await batch.run();
```

Read the [documentation](docs/index.md): guides, the [specification](spec/00-overview.md) and
[how Rayfold compares](docs/comparison.md) with REST and GraphQL.

## Working on Rayfold

```
npm install
npm test                                   # the TypeScript suite: packages, conformance, e2e comparison, real-data and security runs
npm run typecheck
npm run build                              # the npm packages into packages/*/dist
npm run smoke:packages                     # install the packed packages in a fresh project and use them there
npm run docs:dev                           # the documentation site and playground at http://localhost:5173/
npm run rayfold -- dev examples/bookstore-ts   # explorer http://localhost:4400, /rayfold, /rayfold/ws, /mcp
npm run bench                              # REST vs GraphQL vs Rayfold (JSON, RB) -> bench/results/latest.md
npm run e2e && npm run e2e:html            # the comparison suite -> e2e/report.html
npm run demo                               # web demo on the Project Gutenberg catalogue: http://localhost:4610
cd kotlin && ./gradlew test                # every JVM module, incl. the conformance suite
npm run smoke:maven                        # publish the JVM modules locally and build a separate project against them
```

| Path | What |
|---|---|
| [`spec/`](spec/00-overview.md) | The protocol: schema, shapes, batches, frames, errors, auth, cache, patches (Core); live, RB, MCP, REST bindings, uploads, capability tokens (extensions); evolution; security; ADRs |
| [`docs/`](docs/index.md) | User guides and background; [`docs/releasing.md`](docs/releasing.md) is the release checklist |
| [`packages/schema`](packages/schema) | `.rayfold` parser, validator, shapes, policy expressions, breaking-change diff, TypeScript/Kotlin/Java/GraphQL generators |
| [`packages/builder`](packages/builder) | code-first TypeScript schemas with inferred types |
| [`packages/server`](packages/server) | the server runtime: executor, batches, idempotency, policies, cost, cache headers, live queries, uploads, `@http` bindings, OpenAPI, WebSocket, MCP; a fetch handler with a Node adapter over it, a relay to join a fleet, and drain and readiness for a rolling deploy |
| [`packages/client`](packages/client) | normalized cache with patches, batches with `$ref`, watch/live, uploads, an offline queue, fetch and WebSocket transports, RB |
| [`packages/react`](packages/react) | `useQuery`, `useLive`, `useCommand` |
| [`packages/rb`](packages/rb) | Rayfold Binary codec |
| [`packages/cli`](packages/cli) | `rayfold check \| lock \| hash \| explain \| gen ts\|kotlin\|java\|graphql \| shapes \| import openapi\|graphql \| mock \| lsp \| dev` |
| [`conformance/`](conformance) | the fixtures (schema, IR, data, expected frames) every implementation must pass, and the vectors: a pure function and the answer the specification says it has |
| [`kotlin/`](kotlin) | JVM modules: `rayfold-core`, `rayfold-java`, `rayfold-spring-boot-starter`, `rayfold-client`, `rayfold-client-okhttp`, `rayfold-opentelemetry`, `rayfold-jdbc` |
| [`examples/`](examples) | the bookstore used by tests, explorer and bench; the same bookshop per stack (`typescript`, `react`, `kotlin`, `java`, `spring-boot`) that the get-started guides are written from; the web demo; `workspace-ts`, a multi-tenant issue tracker that exercises every part of the protocol at once |
| [`e2e/`](e2e/report.md) | the same flows over REST, GraphQL and Rayfold, every report cell asserted |
| [`scripts/`](scripts) | build, publish, set-version, smoke tests, docs site, oracles for the Kotlin tests |
| [`data/`](data) | the Project Gutenberg catalogue used by the real-data tests and the demo (see its README for attribution) |

Status: **Core 0.1 is frozen**: it changes only by errata. Core is deliberately small; live queries, the binary format,
the MCP bridge, REST routes, uploads and capability tokens are extensions, and those are still drafts.
[ROADMAP.md](ROADMAP.md) says what comes next.

The protocol and the schema language are the standard; the packages in this repository are reference libraries built
on them. Batch loaders, the normalized client cache, React hooks and the offline queue are their design, not
requirements for other implementations ([spec/00](spec/00-overview.md#protocol-schema-language-libraries)).

## License

Apache-2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE). The Project Gutenberg data in `data/` is not covered by
this license; see [data/README.md](data/README.md).
