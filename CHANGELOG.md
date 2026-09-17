# Changelog

Every change a user will notice, newest first. Versions follow [docs/versioning.md](docs/versioning.md); the npm
packages and the Maven artifacts share one version number.

## Unreleased

- **Fifteen conformance defects fixed, most of them in both runtimes.** None changes what a correct client already
  did; each closes a place where a runtime did not do what the specification says.
  On the wire: an unsafe `POST` answered with a single JSON frame now carries `Cache-Control: no-store` (spec 07 §3) —
  the one response a shared cache is most likely to keep was the one that never said not to. One operation can no
  longer produce two terminal frames: a command that emitted `ok` and then failed while recording its idempotency
  record or publishing its change used to send a second, and the guard now sits in the frame sink rather than at each
  call site that could reach it (spec 04 §2). An `item` frame carries `errors` of its own as spec 04 §2 says, instead
  of TypeScript tucking them into `meta` and the JVM dropping them. `@live(false)` is enforced, so a query the schema
  opted out of is refused rather than opened live anyway. A declared domain error names itself once in a problem
  document, under `type` and `title` as spec 05 §4 says, rather than in a second member called `errorType`. And the
  WebSocket handler no longer offers stream items it cannot handle.
  In the schema validator, both runtimes: `@page` on an operation that does not return `Page<T>` is refused; a **field**
  returning `Page<T>` must accept page arguments, which spec 01 §9 always required of a field or a query and which was
  only ever checked for queries; a type reached only through a view is no longer reported unreachable (rule 9); and
  `@deprecated(sunset: 2027-06-30)` without quotes is refused instead of lexing into three numbers and leaving a
  deprecation nothing could ever retire.
  On the JVM: `isCancelled` is wired to the operation's job, so a resolver — and `Values.isCancelled()` from Java —
  can see a deadline or a caller that hung up, where it used to answer false for every resolver ever written; the
  context carries the request envelope's `meta`, so the W3C `traceparent` the transport already copied in reaches
  resolvers; a 501 says `Allow`; and the ETag stops digesting `meta.ms`, which is how long the server took and so
  differed on every identical answer.
  In `@rayfold/postgres`: `maxRecords` counts keys held by commands running now and never evicts one, so the bound
  means on Postgres what it already meant on the memory and JDBC stores (spec 12 §3). A fleet could previously hold
  the full bound in records *plus* a claim for every command in flight.

- **`cap` is not negotiated through the manifest**, and spec 06 §6 now says so. Spec 04 §4a requires a client not to
  use an extension a server does not list, and no server ever listed `cap`, which read as though capability tokens
  could not be used at all. There was never anything to negotiate: a token is a bearer credential presented where any
  other credential would be, and a holder that has one does not need to ask what the server supports.

- **A published conformance vector suite, and what it found.** `conformance/vectors/` is a second kind of
  conformance artifact beside the fixtures: where a fixture is a request and the frames a server must answer it with, a
  vector is a pure function and the answer the specification says it has — a number's canonical form, a shape's id, a
  hash, the status an error code derives, the outcome of a denial. Ten areas, and one rule that decides how they are
  built: **every expectation is written from the specification, never captured from a runtime.** A vector taken from an
  implementation proves only that the implementations agree, which was true the whole time spec 09 said 38 RB
  dictionary keys and both codecs held 40. Both runtimes read the same files.
  It produced eight gaps in the specification and seven defects in the code, six of the gaps before any code ran. Three
  of the defects change JVM behaviour: `Canonical.number` now writes the fewest digits that read back as the same
  double, as ECMAScript asks, rather than Java's `Double.toString`, so a denormal is `5e-324` and not `4.9e-324` —
  which moves the idempotency binding and viewer-scope hashes for values at the extremes of the double range, and
  leaves every other number alone. The JVM shape parser is strict: `@defer(foo: "x")` and `@defer(label: 5)` are
  refused rather than read and discarded, so a shape the JVM used to accept is now an error, and the second of those
  no longer produces a different canonical form — and so a different shape id — from the TypeScript one. And a policy
  denial on a list element now fails the operation rather than answering null, which is what spec 06 §3's table says
  and what the JVM already did.

- **The IR is written out.** Spec 01 §9 gave the IR's top-level shape and then said the canonical definition was
  `packages/schema/src/ir.ts`, so the structure the protocol's identity is computed over was defined by pointing at one
  implementation and nobody outside could reproduce a schema hash. §9 now carries the whole structure, member by
  member, including §9.1a's built-in definitions — the twelve scalars, `Page` and `PageArgs`, which every IR contains
  before a line of schema is read and which the old text never mentioned, so an implementer would have hashed only
  their own declarations and matched nobody. `conformance/vectors/hashing/schema.json` is the proof rather than the
  claim: the hashes in it were built by hand from the document alone and match both runtimes exactly.
  One rule was decided rather than discovered along the way: **the document's `extensions` member is excluded from the
  hashed form.** Vendor data is ignored by implementations that do not know it, so an identity that moved with it would
  make two servers offering the same conversation look different and a gateway that strips vendor metadata look like a
  schema change. TypeScript hashed the whole document and now does not; the JVM already projected it out, but its IR
  could not hold the member at all and dropped it when loading a document, which it no longer does. No published hash
  moves — nothing populates `extensions` today.

- **Patches have a chapter, and a deletion no longer takes two rows with it.** Spec 13 says what a client must do with
  a `patch`: the six operations, the order they apply in, which of them are safe to receive twice, and a deterministic
  answer for the cases that used to be left to a reader — a deletion, a membership change, a pagination boundary, an
  authorization change, a reconnect, a duplicate. Written as a clarification of Core rather than a change to it.
  Writing the property test for §8's invariant found a data-loss bug in **both** clients on its first generated
  sequence: a command's `del` and its live query's positional `list` operation describe one removal and both reach the
  client that ran the command, so a client that shortened its list on the `del` then applied `del: [0]` to whatever had
  moved into the slot — one removal, two rows gone from the screen. A deleted row now keeps its position until the
  positional operation has been applied. `conformance/vectors/patch/apply.json` has the regression case.

- **A live query no longer misses a change committed while its first read runs.** The TypeScript server read, then
  subscribed to the change bus. A command committing in that window changed rows the read had already looked at and
  the client was told nothing — and since nothing later is obliged to touch the same rows again, the screen stayed
  quietly wrong until something unrelated disturbed it. The server now attaches to the bus before the first execution
  and judges what arrived during it against the read set once there is one. Spec 08 §3 requires this of any server;
  the JVM already did it.

- **Three security fixes, two of which change behaviour.** A capability token's extra facts (`caps`, which policies
  read as `viewer.caps.*`) could be *replaced* when a token was attenuated, so a holder could derive a token claiming
  anything it liked — and because those facts were merged over the token's own signed fields, one called `ops` stood
  in for the operation list the batch gates on, which turned a narrow token into the run of the schema. Attenuation
  now accepts only facts the parent already carried, with the same value, since removal is the one narrowing a server
  can verify without knowing what a fact means; and the token's own `ops`, `exp`, `jti` and `iss` are applied last, so
  a fact can never stand in for them. The MCP bridge served the **whole** IR at `rayfold://schema`, policy expressions
  included, which is a map of what to probe; it now serves the IR without them by default, with `schema: "full"` and
  `schema: "off"` if you want otherwise (spec 12 §5.6, and what the JVM bridge already did). And `resources/read`
  would run a **command** if a URI named one, turning MCP's one safe verb into a write: the operation's kind now
  decides, not the name in the path.

- **Uploads, as the extension `upload`.** `POST /rayfold/uploads` takes bytes on a route of their own and answers with
  a handle; the command that uses them names the handle in its arguments. It is a route rather than a multipart batch
  because a browser may send multipart to any origin without a preflight, which is exactly what the batch endpoint's
  JSON-only rule prevents (spec 12 §2.1) — `application/octet-stream` is not safelisted either, so the protection is
  unchanged — and because bytes that travel as bytes cost what they weigh instead of a third more as base64. The size
  bound is enforced as the bytes arrive, not from a `Content-Length` a client may understate; an upload needs an
  identified sender unless you say otherwise; ids are unguessable, since holding one is what lets a command read those
  bytes. `MemoryUploadStore` is for tests and one small server, and `UploadStore` is three methods for S3, a Postgres
  large object or a disk. Spec 04 §9; a server serving the route says `upload` in its manifest.
  On the client, `client.upload(file)` sends it through the transport that sends everything else — so the headers that
  authorise a request authorise an upload — and answers with the handle; a `File` carries its own name and type, and a
  refusal arrives as a `RayfoldClientError` with the server's code.
  `PgUploadStore` (`@rayfold/postgres`) and `JdbcUploadStore` (`dev.rayfold:rayfold-jdbc`) keep uploads in the database
  so a fleet shares them: a file sent to one server is there for the command that runs on another, which an in-memory
  store cannot do. Both create the same columns, so either runtime may make the table; both expire what nobody used and
  stay inside a byte bound, oldest first. The bytes live in a row, so at hundreds of megabytes a storage URL is still
  the better answer.

- **Rayfold runs wherever a `Request` becomes a `Response`.** `createFetchHandler(server, options)` is the endpoint as
  a fetch handler, for Cloudflare Workers, Hono, Bun, Deno and a Next.js route handler: batches, live queries, uploads,
  the manifest, caching and the health and readiness routes, all of it, with nothing from Node in its import graph. The
  Node transport is now that handler with an adapter in front rather than a second implementation of the same rules, so
  a fix reaches every runtime at once. `@http` REST bindings are the one thing that does not come with it:
  `createBindingHandler` is still written against Node's `req`/`res`, so a schema's REST routes are served on Node
  only. A fetch runtime has no socket to read, so say `loopback: true` for a development server on localhost;
  `allowedHosts` works everywhere. [Guide](docs/guide/runtimes.md).

- **A live query outlives the server it was opened on.** When a server going away or a dropped connection ends a
  `client.live()` subscription with a retryable error, the client opens the query again after half a second, doubling
  to thirty, through whatever is in front of the servers, so a rolling deploy is invisible to a screen. `onError` now
  also receives `{ retrying }`; an error that would recur still ends the subscription. (TypeScript client.)
- **A deployment guide, and a check in CI that runs servers as separate processes against a real Postgres:** a keyed
  command sent to two at once runs once, a live query and a stream on one hear a command run on the other through
  `NOTIFY`, and stopping one ends its live queries with a retryable error while the other keeps serving. The fleet
  holds a TypeScript server and a JVM server together, which is what holds the two runtimes to one format for the
  records and notifications they share.
- **Fixed: a fleet of TypeScript and JVM servers could not share its idempotency records.** Three things they had
  never been made to agree on, each found by that check and none of them visible to a fleet of one runtime:
  the two created `rayfold_idempotency` with different column types and nullability, so whichever server started
  first left the other unable to write (`jsonb` against a bound string) or to finish a record (`NULL` into a
  `NOT NULL` token) - both now create the same columns, and a store may be created by either;
  the JVM could not take over a key another runtime had finished, since it matched the row on a token that is null
  there; and the two hashed a record's binding differently (`sha256(op + "\n" + args)` on the JVM against the
  canonical JSON of `{op, args}` in TypeScript), so each answered the other's retries with `already_exists` instead
  of replaying. Spec 12 §4.2 now states the hash, since a shared store needs every implementation to agree on it,
  including the form a number takes in it: `2.50` and `2.5` are one number and hash alike, which the JVM now honours
  for this hash and the viewer scope while leaving the wire, the ETags and the schema hash exactly as they were.
  A record written by an earlier build is not replayed after this change; it expires on its own.
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
