# Changelog

Every change a user will notice, newest first. Versions follow [docs/versioning.md](docs/versioning.md); the npm
packages and the Maven artifacts share one version number.

## Unreleased

- **A live query outlives the server it was opened on.** When a server going away or a dropped connection ends a
  `client.live()` subscription with a retryable error, the client opens the query again after half a second, doubling
  to thirty, through whatever is in front of the servers, so a rolling deploy is invisible to a screen. `onError` now
  also receives `{ retrying }`; an error that would recur still ends the subscription. (TypeScript client.)
- **A deployment guide, and a check in CI that runs two servers as two processes against a real Postgres:** a keyed
  command sent to both at once runs once, a live query and a stream on one hear a command run on the other through
  `NOTIFY`, and stopping one ends its live queries with a retryable error while the other keeps serving.
- **A server tells its load balancer when to send traffic, and stops without dropping anyone.** `GET /rayfold/health`
  says the process runs. `GET /rayfold/ready` says whether this server should receive traffic and every reason it
  should not: still connecting to the relay, shutting down, or a check you configured (`db: () => pool.query("select
  1")`) failing or not answering in time. `server.drain()` turns readiness off, refuses new batches, ends live queries
  and streams with a retryable `unavailable` that sends their clients to another server, and waits for the batches still
  running; `shutdown(server, http)` does that, closes the connections and stops hearing the relay, for `SIGTERM`. A
  WebSocket closes as a server going away (1001) once the frames ending its ops are out.
- **Live queries and streams follow commands run on other servers.** A `relay` joins the servers behind one load
  balancer: a command's changes and the events it emits cross it, so a live query or a stream open on any server hears
  a command run on any other, and no server hears its own change twice. `PgRelay` (`@rayfold/postgres`) carries them
  over Postgres `LISTEN`/`NOTIFY`, through a table when a message is too large for one notification; `MemoryRelay`
  joins servers in one process. `server.ready()` resolves once the server hears the others and `server.close()` stops
  it; a refused message is reported through `onRelayError` and `server.relayFailure` while the command that made the
  change still succeeds on its own server.
- **The site states the advantage plainly, compares more fairly, and agrees with itself about what is released.**
  The landing page now shows one feature written the usual way and then in Rayfold, so the saving is visible rather
  than described. The comparison table says what each protocol gives by default and now says so explicitly: GraphQL
  serves reads over `GET` with persisted queries, which a CDN can cache, and the table no longer implies it cannot.
  "Should you use Rayfold?" said the packages were unpublished and the specification a first draft, on the same page
  that announced 0.1.0 on npm and Maven Central; it now says what is actually true — published and frozen at Core 0.1,
  with the extensions still drafts, and no production users yet. Spec 12 no longer calls itself a draft while being
  part of frozen Core.
- **Several servers run a keyed command once between them.** `PgIdempotencyStore` (`@rayfold/postgres`) and
  `JdbcIdempotencyStore` (`dev.rayfold:rayfold-jdbc`) keep idempotency records in the database, so a retry that lands on
  another instance replays the first answer instead of running the command a second time. Two requests that arrive
  together take the key with one statement: one runs the command, the other waits for it and replays. The server that
  owns a key renews a lease while the command runs, so a server that stops mid-command does not hold the key forever —
  the lease runs out and the next retry takes it over. `idempotencyLeaseMs` sets the lease (default 30 seconds); on the
  JVM, `builder.idempotencyStore(...)` or an `IdempotencyStore` bean wires the store in.
- **Fixed: a command that had committed and was then canceled could run a second time.** When the caller went away or
  the deadline passed after the resolver had returned, the key was released, so the retry ran the command again. Both
  runtimes now record a `canceled` answer saying the command committed, and answer retries with it.
- **Spec: leases, and what a failed command leaves behind** (03 §4, 12 §3.6 and §4.4). A claimed key is held under a
  bounded lease that may be taken over once it lapses, a key held by a running command is never evicted, and a command
  that failed or was canceled after its effect records that answer rather than releasing the key.
- **Fixed: the in-memory idempotency store could grow past its cap, and a stranded server could overwrite the answer
  of the server that took its key over.** A claim whose holder had died and whose key nobody retried stopped the sweep
  behind it, so nothing younger was ever removed; and a record written from a lost lease landed once the new owner had
  answered, because only claims in flight were checked. Both hold now; the Postgres store is held to the same two
  cases.

- **`rayfold gen graphql`** prints a GraphQL schema for a Rayfold schema: types, fields, arguments, defaults,
  descriptions and deprecations, with queries, commands and streams as `Query`, `Mutation` and `Subscription` fields.
  What GraphQL cannot express (typed errors, idempotency keys, patches, live queries, the rules written as annotations)
  is listed on stderr. `generateGraphql` in `@rayfold/schema` returns both.

- **The documentation site is at https://rayfold.dev/.** Links to `eddyboutros.github.io/rayfold/` redirect there,
  problem-type URIs included, which keep their 0.1.0 form.
- **Security: a `__proto__` key in a request's arguments is plain data again (TypeScript server).** Next to a `$ref`, or
  in the body of an `@http` route that takes the whole body, it replaced the prototype of the server's copy of the
  arguments, so a client could pass values that argument validation never saw. `Object.prototype` itself was not
  touched.
- **Fixed: a command retried with the same idempotency key could run twice under the Spring Boot starter.** Spring
  Security hands over a user's authorities in a different order from one request to the next, so the retry was looked
  up under another viewer. The starter now sorts them before deriving `roles` and `role`.
- **Fixed: the JVM runtime scopes idempotency records by the viewer's canonical JSON,** as the TypeScript runtime does,
  not by `toString()`. A viewer map with its keys in another order, which is what a second instance sharing the store
  can see, now finds the first answer. A record written before this change is not found by a retry after it.
- **Fixed: `store.screen()` through the runtime.** A shape reaching a relation with arguments, such as
  `author { books(page: { first: 2 }) { items { id } } }`, failed with `unimplemented`, and aliases came back empty. Both
  runtimes now serve a field with arguments from its parent when the op's resolver already returned it (a loader is
  still needed otherwise), and `screen` keys its rows by field name. A field selected twice in different ways is
  refused.
- **Fixed: JVM query and stream resolvers are handed `ctx.policy`,** the pushable read policy of what they return, as
  field loaders and the TypeScript runtime already were, so a data source can filter a list at the source.
- **Fixed: a refused WebSocket handshake in `rayfold-client-okhttp`** fails the waiting batches with
  `unavailable` every time, instead of sometimes with an untyped `ClosedSendChannelException`.
- **Fixed: `rayfold mock --port 0` and `rayfold dev --port 0` printed port 0** instead of the port they got.
- **The manifest lists `mcp` when the MCP endpoint is mounted** beside the server, in both runtimes, so a client can
  tell it is there (spec/process.md).
- **`rayfold check --strict` says what failed:** when only warnings fail the check, it prints
  `FAILED: warnings against <file> (--strict)` instead of claiming breaking changes.
- **Spec clarification: what is protocol and what is library.** A client is not required to keep a normalized cache;
  only a client that keeps one must key it by `Type:id` (07 §3). Repeating a failed request is the client's choice,
  guided by `retryable` (03 §4). The overview now separates the protocol, the schema language and the reference
  libraries (00). Nothing changes on the wire.
- **Spec erratum (11, Evolution):** the list of compatible changes said that making a required argument optional was
  not allowed. It is allowed, as `rayfold check` has always treated it; so is making a nullable result field non-null.
- **`ROADMAP.md`** says what comes next, what 0.1 does not do yet, and what is not planned; `docs/releasing.md`
  replaces the pre-release checklist.

## 0.1.0 (2026-09-15)

The first release: the specification (Core 0.1 and the `live`, `rb`, `mcp` and `http` extensions), and

- npm: `@rayfold/schema`, `rb`, `builder`, `server`, `client`, `react`, `explorer`, `lsp`, `postgres`, `otel`, `cli`
  and `conformance`;
- Maven Central: `dev.rayfold:rayfold-core`, `rayfold-java`, `rayfold-spring-boot-starter`, `rayfold-client`,
  `rayfold-client-okhttp`, `rayfold-jdbc` and `rayfold-opentelemetry`.

What it holds, newest first:

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
- **The TypeScript HTTP transport checks the schema before it uses RB:** `binary` now takes the manifest (or the
  server's full schema), and RB is used only once a response's `Rayfold-Schema` header matches that schema's hash, as
  spec 09 requires. Before, a client holding a different schema read fields under the wrong names without an error. An
  RB answer that arrives with another hash fails as `unavailable`, and the next request goes as JSON. Passing
  `manifest.schema` alone now keeps the transport on JSON, because that schema has its policies removed and hashes
  differently: pass the whole manifest.
- **Fixed:** a compact read (`compact: true`, which a client given the schema sends) got `max-age=0, no-cache`,
  because both servers looked for `@cache` through `$type`, which compact frames leave out. The entity types now come
  from the schema.

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
