# Changelog

Every change a user will notice, newest first. Versions follow [docs/versioning.md](docs/versioning.md); the npm
packages and the Maven artifacts share one version number.

## Unreleased

- **A documentation website with a playground:** https://eddyboutros.github.io/rayfold/. Get started in TypeScript,
  React, Kotlin, Java or Spring Boot, then learn the protocol from the basics to schema evolution. Every code sample
  comes from the example projects in `examples/`, whose tests run in CI, and the playground runs the Rayfold runtime in
  the page. `npm run docs:dev` and `npm run docs:build` replace `docs:site`.
- **`@rayfold/server/core`:** the runtime without its transports, using no Node API, so it runs in a browser, a worker
  or any other JavaScript runtime. The main entry still exports everything.
- **Problem types link to their documentation:** the `type` of a problem document is now
  `https://eddyboutros.github.io/rayfold/errors/<type>` instead of `https://rayfold.dev/errors/<type>`, in both
  runtimes, and each type has a page. A client that compares the whole URI needs the new base
  (`PROBLEM_TYPE_BASE` in TypeScript, `Guard.PROBLEM_TYPE_BASE` on the JVM).
- **A negative page offset is refused** with `invalid_argument` in both runtimes, as a negative `first` already was.
- **A schema number too large to represent is a syntax error:** `1e999` used to get through the reader and fail
  later while the schema was hashed.
- **JVM artifacts work from Kotlin 2.2:** the modules are compiled with language and API version 2.2, so a project
  does not need the Kotlin compiler the runtime was built with.
- **The runtime works with Spring Boot's managed kotlinx-coroutines:** it is built against 1.10.2, the version Spring
  Boot 4.1 ships. Built against 1.11, every request under Boot answered 200 with an empty body.
- **Scalars from the Spring starter and `rayfold-java` follow the spec:** `Decimal` and a `Long` beyond 2^53 are text,
  bytes are base64url, and `OffsetDateTime`, `ZonedDateTime` and `java.util.Date` are UTC instants, whatever the
  application's Jackson settings. `rayfold-java` wrote the last three and large longs differently before.
- **`RayfoldHttp` logs a failure after the response has started**, instead of dropping the connection silently.
- **The Kotlin client cancels a live query over HTTP at once**, rather than when the next keep-alive arrives.
- **Java API:** `HttpBuilder.explorer(title)`, `HttpBuilder.start` declares `IOException`, and `RayfoldExplorer.mount`
  has overloads without the path.
- **Fixed:** a body over the limit answered `400` instead of `413` on Linux.
- **Fixed:** on the Kotlin WebSocket server, reusing an op id right after its final frame arrived could be refused as
  still in use.

- **Resolver wiring is checked at build time:** `checkWiring(ir, resolvers)` in `@rayfold/server`, and
  `rayfold check schema.rayfold --resolvers <module>`. An operation with no resolver and a field that takes arguments
  with no loader are exactly what the runtime refuses with `unimplemented` on the first call that needs them; both are
  now errors before anyone calls. The reverse is reported too, and nothing reported it before: a resolver wired for an
  operation, type or field the schema no longer has, which is what a rename leaves behind.
- **`rayfold check` points at the line, and says what it probably should be:** findings are placed in the text with a
  codeframe and a caret, and where the schema makes the fix obvious it is offered - an unknown type or annotation gets
  "did you mean", an entity with no identity is told to take an `id: ID`. Syntax errors keep the position they already
  carried.
- **`rayfold mock <schema.rayfold>`:** a server that answers every operation from the schema alone - enum values,
  `@range` bounds, `@example` values, scalar formats, pages that honour `first` - with the explorer served beside it,
  so a client can be built before a resolver exists. The same call always gives the same answer, so a demo or a
  screenshot does not drift.
- **`rayfold import openapi|graphql`, and the IR back to text:** `printSchemaText(ir)` writes a schema file from an
  IR - the parser's inverse, proven by round-tripping every conformance fixture and both example schemas back to the
  same hash - and the new `import` command uses it to draft a schema from an OpenAPI document or a GraphQL SDL. A
  `GET` becomes a query and a change becomes a command, keeping its URL with `@http`; GraphQL's nullability is
  inverted on the way in. What a source cannot say (caching, policies, what a command throws or emits) is reported on
  stderr rather than guessed at. Reading SDL needs `graphql`, which the CLI declares as an optional peer.
- **Shape-typed results, still without code generation:** `Select<Type, "{ id title }">` reads the shape text in the
  type system, and `typedClient<typeof schema>(client)` gives a client whose operation names and arguments come from
  the schema and whose results are narrowed to the shape asked for. Lists, pages and nulls are followed through;
  `@defer` and `...on Type` contribute optional fields; a named-view spread falls back to the whole type, which is
  wider than the truth and never narrower. See the [TypeScript guide](docs/guide/typescript.md).
- **New package `@rayfold/lsp`, and `rayfold lsp`:** a language server for `.rayfold` documents. Errors as you type
  (the same parser and validator the runtime uses, so an underline matches `rayfold check` word for word), completion
  for declaration keywords, annotations and type names, hover, go to definition, and an outline. It speaks the
  protocol's framing directly over stdio and depends on nothing but `@rayfold/schema`; `editors/vscode` carries the
  grammar, and the [editor guide](docs/guide/editors.md) sets up VS Code and Neovim.
- **New package `@rayfold/explorer`:** the page a server serves next to its endpoint, Rayfold's counterpart of
  Swagger UI and GraphiQL. It reads the manifest, lists every operation with its arguments, result, cost and policies,
  fills in a request with a starting shape, sends the batch and shows each frame with its cost, dry-runs a command
  that allows `@simulate`, and can watch a query live. One self-contained document: nothing is loaded from anywhere
  else, and nothing is served unless the application mounts it. `rayfold dev` serves it in place of the playground it
  grew from, and the JVM serves the same page character for character: `RayfoldExplorer(endpoint, title).mount(http)`,
  `HttpOptions(explorer = true)` next to the endpoint, or `rayfold.explorer.enabled=true` in Spring Boot.
- **New JVM module `dev.rayfold:rayfold-jdbc`:** a SQL database behind Kotlin resolvers, the counterpart of
  `@rayfold/postgres`. Batch loads by id, keyset pages with totals, one query for a whole level of one-to-many pages,
  and the pushed-down read policy compiled into the `WHERE` clause, so a list never fetches rows its viewer may not
  see and a page's total counts only what they may see. It needs nothing but JDBC; what it cannot translate exactly
  is left to the runtime's own check, so it never drops a row the policy allows.
- **JVM parity.** Resolvers on the Kotlin runtime now receive the pushable read policy of what they are about to
  load as `ctx.policy`, by the same rule the TypeScript runtime uses, so a data source can filter at the source.
  The Kotlin client honours `@merge` policies too: it takes them as a `Type.field` map (`ClientOptions.mergePolicies`),
  which `mergePolicies(ir)` in `rayfold-core` builds from a schema, so the client module stays free of the schema types.
- **Capability tokens (extension `cap`, spec 06 section 6).** `Capabilities` mints signed, self-contained tokens that
  speak for a viewer, name the operations their holder may call and expire; verifying one needs no storage. The batch
  refuses an operation the token does not name before it runs, and the schema's policies read the token's extra facts
  as `viewer.caps.*`. Attenuation only ever narrows: a derived token may drop operations and shorten the life, never
  add or extend, so a chain of delegations can only lose authority.
- **Per-field conflict policy (`@merge`, spec 08 section 5).** A field may declare how it settles when a prediction
  and the server disagree: `serverWins` and `lww` drop the predicted value the moment the server speaks for that
  field, while `keepLocal` (and no annotation) keep it until the command settles. A client that holds the schema
  applies this on its own. `crdtText` and `custom` are declared but not implemented: predicting such a field is
  refused with a message naming it, rather than merged wrongly. Both schema readers accept and check the annotation.
- **RB:** the key dictionary gained `list` and `ins` for the result-scoped patch operations. Frame keys come before
  the schema's own names, so every schema-derived key id moves by two: both runtimes changed together and the
  generated cross-runtime corpus was regenerated, but bytes recorded by an older build no longer decode.
- **Field-usage telemetry (spec 11).** A server given a `usage` sink records which operation and which members each
  client (`Rayfold-Client`) asked for, with when it was last seen and how often; nothing is recorded without a sink,
  and only paths are kept, never arguments, values or viewers. `MemoryUsage` is the built-in sink.
  `rayfold check <schema> --unused <snapshot.json> [--since 30d]` lists members no client has asked for inside the
  window, and names the clients still asking for members already `@deprecated`.
- **Resolvers can see the shape (`ctx.shape`, both runtimes),** so an adapter can plan a whole screen rather than a
  level at a time. `@rayfold/postgres` uses it for `screen()`.
- **A deadline no longer takes back what already arrived:** a query whose `@lazy` part was still loading when the batch
  deadline passed keeps the frame it already sent, and only the part still in flight fails. Ops that finished before the
  deadline were already left alone; both are now held to it by tests.
- **One statement for a whole screen (`@rayfold/postgres`).** `PgStore.screen()` compiles a shape into a single SQL
  statement: related rows are gathered by correlated JSON subqueries, each level's read policy is pushed into its own
  `WHERE`, nested pages are first pages with their own `total`, and the root page still takes a cursor. Relations are
  declared per table (`relations: { author: { type: "Author", kind: "one", key: "authorId" } }`). Measured on PGlite:
  the nested screen the per-level loaders serve in three statements is served in one, whatever its depth.
- **One load per row for a whole request (both runtimes).** Field loads are now shared by every op of a batch: what
  the executor remembers is the load in flight, so an entity another op is already loading, or that appears twice at
  the same level, is never loaded twice. A load that fails is not remembered. Only entities take part, and the memo
  lives for one request, so nothing is ever served from an earlier one.
- **Live queries send the difference, not the page (both runtimes).** A `patch` frame can now carry two
  result-scoped operations besides the entity `set`s: `at` merges fields into a plain object at a path of the
  result, and `list` removes positions and inserts rows (spec 04 section 2b). A change that cannot be described
  that way still sends a fresh `data` frame, and so does a patch that would cost more than the result. Measured on
  the workspace example: keeping an open six-column board correct after one issue moved costs 692 bytes, against
  21,529 for a GraphQL subscription plus refetch and 56,628 for REST.
- **New example, `examples/workspace-ts`:** a multi-tenant issue tracker (organisations, teams, projects, sprints,
  issues with sub-issues and versions, comments, a polymorphic activity feed, search, notifications) seeded with
  630 issues, 900 comments and 1 156 activity rows across two tenants. It exercises row and field policies, an
  interface and a union, per-parent pagination, conditional writes, bulk commands with patches, live queries,
  `@lazy` and `@partial` fields, cost budgets, cache scopes, HTTP bindings, streams and the MCP bridge at once.
  `e2e/workspace.test.ts` runs fifteen scenarios against the same domain built three ways (REST, GraphQL with and
  without DataLoader, Rayfold) over real HTTP and writes `e2e/workspace.json`.
- **Interfaces (both runtimes):** a field or result typed as an `@interface` object resolves its concrete type from the
  value's `$type`, so `...on Concrete` selects fields the interface does not declare and the tag survives compact mode.
  Such a position used to project the interface's own fields and drop type conditions silently. A type condition naming
  a type that does not implement the interface is now a schema error (`bad-type-condition`).
- **Protocol:** a streaming HTTP response that stays idle gets keep-alives (an empty NDJSON line, or a zero-length RB
  frame) after 15 s by default, so proxies keep live queries open and servers notice a client that left
  (spec 04 §4). Clients skip them.
- **Protocol:** WebSocket binary messages carry RB; a batch is answered in the form it came in (spec 09 §4). The
  TypeScript client's WebSocket transport takes `binary: ir`.
- **Protocol:** the cost model charges rows and loads, not columns: scalar and enum fields cost nothing by default,
  fields that return objects cost 1, and every page charges one per row (spec 06 §5).
- **RB:** integers between 2^52 and 2^53 in magnitude keep their sign. The zigzag value was computed in doubles, so
  `-(2^53 - 1)` decoded as `2^53 - 2`.
- **WebSocket (TypeScript):** a message that is JSON `null` or a number is answered with an error instead of throwing.
- **Kotlin runtime:** RB over HTTP and WebSocket; `ETag`, `Cache-Control` and `304` on safe requests from `@cache`;
  live queries over HTTP; the `Rayfold-Schema` header carries the schema hash; the manifest lists `rb`.
- **Spring Boot starter:** the WebSocket transport at `{rayfold.path}/ws` on the application's own port when the
  application has spring-boot-starter-websocket (`rayfold.websocket=false` turns it off), with the Spring Security
  user as the viewer.
- **Manifest (TypeScript):** lists the `rb` extension, which the HTTP transport always served.
- **New package `@rayfold/postgres`:** batch loads by id, keyset pages, a page per parent in one query, and read
  policies compiled into the SQL `WHERE`, never dropping a row the policy allows.
- **Read-policy pushdown (TypeScript):** resolvers and field loaders now receive the pushable read policy of what they
  load as `ctx.policy.filter` (spec 06 §4). It was declared but never filled in.
- **Tracing:** `instrumentation` hooks around batches, ops and loader calls in both runtimes; `@rayfold/otel` and
  `dev.rayfold:rayfold-opentelemetry` turn them into OpenTelemetry spans that continue a W3C `traceparent`. The Java
  builder and the Spring starter take an `Instrumentation`. The Kotlin HTTP transport now copies `Rayfold-Client`,
  `Rayfold-Deadline` and `traceparent` into the envelope's meta, as the TypeScript one does.
- **Clients (sub-profile `sync`):** optimistic commands (`optimistic`) with rebase and rollback, and an offline queue
  that sends commands in order with their keys when the server is back, in `@rayfold/client`, `@rayfold/react`'s
  `useCommand` and the Kotlin client (`OfflineOptions`, `FileQueueStorage`).
- **Android:** `dev.rayfold:rayfold-client-okhttp`, the WebSocket transport on OkHttp. The client modules are checked
  against Android API level 26 on every build.
- **Kotlin runtime:** an IR read from JSON keeps an explicit `default: null`, so its schema hash matches TypeScript's.
- **Fixed, found by fuzzing:** an HTTP body that is JSON but no envelope (`null`, a number, `ops` that are not a list)
  answered 500 instead of 400; `shapeToString` printed object arguments with quoted keys that the shape grammar cannot
  read back.
- **Tooling:** property-based fuzz tests for the schema, shape and expression readers, the RB decoder and the HTTP
  transport (every push, and deeper nightly); a differential test of the Kotlin schema reader and RB codec against a
  seeded corpus from TypeScript; the web demo in Chromium, Firefox and WebKit (`npm run test:browsers`); the demo behind
  a real nginx proxy and cache (`npm run check:proxy`); a load test (`npm run bench:load`); dependency and secret
  scanning in CI; CycloneDX SBOMs on GitHub releases.

## 0.1.0 (not yet released)

The first release: the specification (Core 0.1 and the `live`, `rb`, `mcp` and `http` extensions), and

- npm: `@rayfold/schema`, `rb`, `builder`, `server`, `client`, `react`, `cli` and `conformance`;
- Maven Central: `dev.rayfold:rayfold-core`, `rayfold-java`, `rayfold-spring-boot-starter` and `rayfold-client`.
