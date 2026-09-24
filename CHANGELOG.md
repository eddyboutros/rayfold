# Changelog

Every change a user will notice, newest first. Versions follow [docs/versioning.md](docs/versioning.md); the npm
packages and the Maven artifacts share one version number.

Everything under a dated heading is published on npm and Maven Central.

## Unreleased

- **A command that commits and then fails to answer still tells live queries and subscribers what changed.** When a
  non-null field resolved to null or a loader threw after the resolver had returned, the change and the
  `ok(..., { emit })` events were dropped. Both runtimes now publish them once the command commits.

- **`@defer` works at a union position, and `...on Interface` selects fields on union members that implement it.** Both
  were silently dropped, so a deferred field never arrived.

- **A deferred frame carries only its own errors.** The frame for `items.1` also collected errors from `items.10`.

- **`@format(pattern:)` must match the whole value in the TypeScript runtime, as on the JVM.** `[a-z]+` accepted any
  value that merely contained letters. Patterns are compiled once, and inputs over 10,000 characters are refused.

- **Int accepts -2147483648 and Long text is range-checked in the TypeScript runtime.** It refused the Int minimum and
  accepted Long text of any size; both runtimes now take exactly the 32- and 64-bit ranges.

- **A command marked `@idempotent(false)` ignores an idempotency key instead of replaying it.** The client libraries
  send a key with every command, so a second call replayed the first instead of running. Specs 01 and 03 now agree.

- **The original exception behind an `internal` error reaches the `op` instrumentation hook.** `Outcome.cause` holds
  what the resolver threw, stack included, so operators can log it; clients still see only `Internal error`.

- **A long-lived live query on the JVM no longer ends after `maxFrames` changes.** Its re-run frames stop counting
  toward the per-batch frame cap, as in the TypeScript runtime.

- **An op's own `deadline` counts from the start of the batch in both runtimes.** In TypeScript it started only once the
  op's references and earlier commands had cleared, so it could run far past what the caller asked for.

- **An unauthorized dry run is refused for permission first in both runtimes.** The JVM runtime revealed whether the
  command supports dry runs before checking the caller. TypeScript now also remembers an inline shape only when its
  batch is within budget.

- **`drain()` waits for batches whose frames nobody is reading, and concurrent callers all wake.** In TypeScript a batch
  counted only once its frames were read, and in both runtimes a second `drain()` made the first wait out its timeout.

- **A NaN or an infinity from a resolver goes out as `null` on the JVM.** It was printed bare, which made the whole
  answer unreadable JSON; the TypeScript runtime already wrote `null`, as `JSON.stringify` does.

- **A client with a schema tells union members apart again.** Compact frames keep `$type` only on union and interface
  members, and the TypeScript client dropped it again when the member was an `object` rather than an entity, so
  `... on Photo` results arrived without a type. It now keeps every `$type` the server sent.

- **`@merge(serverWins)` and `@merge(lww)` apply to every server value.** A pending prediction gave way only to a `set`
  patch, so a query's data or a compact command's answer (which carries no `set`) left the prediction showing. Both
  clients now apply the policy wherever the server's value lands, and the TypeScript client no longer edits the
  prediction array you passed in.

- **A refused batch on a WebSocket fails only itself.** A refusal without an op id went to every batch on the socket:
  an unrelated live query failed and the refused `client.query` never settled. Both clients now deliver such a frame
  only to the batch that must own it and close that batch.

- **A WebSocket client speaking RB checks the server's schema.** RB keys are numbered from the schema, and a socket
  has no `Rayfold-Schema` header, so after a deploy a client read every answer under the wrong field names, without an
  error. The TypeScript transport now names its schema hash when it connects, and the TypeScript, JVM and Spring Boot
  servers close a socket naming another one with code 4409. The batches on it fail as `unavailable` and the transport
  speaks JSON from then on (spec 04 §5). Pass the whole manifest as `binary`, as over HTTP.

- **Leaving a stream early closes it.** Breaking out of `for await (… of client.stream(…))` over the fetch transport
  kept the HTTP response and the server's stream open; the transport now cancels the body. Aborting `stream()` through
  its signal ends it quietly over fetch as it did elsewhere, and a stream cut off before `fin` now fails as
  `unavailable` in both clients instead of looking finished.

- **The offline queue sends itself.** Restored commands waited for an `online` event that never comes after a reload,
  and new commands queued behind them unsent, also after a server outage that left the network up. The TypeScript
  client now drains at startup and whenever a command is made while others wait (`drainOnReconnect: false` leaves it
  all to `drain()`); the Kotlin client drains when a command is made while others wait.

- **`useCommand` sees the latest props.** An `optimistic: (cache) => …` function kept the props and state of the first
  render, because `run` was keyed on the options as JSON, which drops functions.

- **A watch's first report includes changes made while it loaded.** A command landing after the query's data but
  before its response ended was hidden by the older response; `watch()` now reports from the cache.

- **RB sends what JSON sends.** `NaN` and the infinities went as doubles and a `Date` as `{}`; both codecs now write
  `null` for non-finite numbers, and the TypeScript codec writes a `Date` (anything with `toJSON`) as JSON would.

- **Less client memory over a long session.** The client cache kept every command's answer for good, one per distinct
  set of arguments, and each WebSocket request left a listener on the caller's abort signal. Both are gone; query
  results are kept as before.

- **Dates and times come back right in any time zone.** `@rayfold/postgres` returned a `date` column a day early east
  of UTC and `screen()` wrote a `timestamptz` in the session's zone; `JdbcStore` wrote timestamps as JVM local time.
  Both stores now return a Date as `YYYY-MM-DD` and an Instant as RFC 3339 UTC. TypeScript resolvers now get a Date
  field as that string rather than a JavaScript `Date`.

- **`screen()` serves a level with more than fifty fields.** Postgres takes at most 100 arguments to one function, and
  such a level failed.

- **A nested page in `screen()` takes the size the schema or the shape gives it.** A page selected without arguments
  used the field's declared default only in the runtime; the store fetched 10. `$variables` are read too.

- **`pagesByField` keeps each parent's total past the cursor and fetches at most a page of each.** A parent whose rows
  all came before `after` got a total of 0, and every child row of every parent was fetched.

- **Relay messages arrive in the order they were sent.** A message too large for a notification was delivered after the
  smaller ones that followed it on the TypeScript relay.

- **Stopping one relay subscription no longer silences another on the same `pg` client.** `pgNotifications` now keeps a
  channel listened while anyone still wants it.

- **`JdbcStore.pagesByField` with only null parent keys returns empty pages** instead of sending `IN ()` to Postgres.

- **`PgIdempotencyStore` quotes its table name as `JdbcIdempotencyStore` does**, so a mixed-case name is one table for a
  mixed fleet. A TypeScript deployment that already configured a mixed-case name has a lower-case table today, and
  should rename it or pass the lower-case name.

- **A large relay message holding U+0000 goes through.** `jsonb` refused it; such a message is now kept as a JSON
  string, which both runtimes already read.

- **`rayfold import openapi` reads the parameters it used to miss.** Parameters written on a path and `$ref` parameters
  become arguments. Names like `first-name` become `firstName` (the `@http` path template follows), and enum values
  that read alike are told apart. A body property with a parameter's name is left out, with a note, so the imported
  schema parses and validates.

- **`rayfold import graphql` keeps entities, the built-ins and deprecation reasons.** An `id: String!` or `Int!` becomes
  `ID`, a type named `Page` (or like another built-in) is renamed with a note, and `@deprecated(reason:)` keeps its
  reason.

- **A printed schema reads back exactly.** Descriptions ending in a quote, holding `"""` or carriage returns, and
  defaults with keys that are not names now survive `printSchemaText`. Block strings accept the `\"""` escape and
  literal objects accept quoted keys, in both runtimes (spec 01 §1).

- **`rayfold gen kotlin` output compiles for more schemas.** A field named `type`, fields named for Kotlin keywords, and
  enum, Float, JSON and input defaults are written the way Kotlin reads them. A `$` in a default is text, not a
  template.

- **`rayfold gen java` output compiles for more schemas.** Record components named `notify`, `wait`, `hashCode`,
  `toString` and the other methods of Object get a trailing underscore, and a backslash-u in a description no longer
  breaks javac.

- **Schema validation catches more mistakes, the same way in both runtimes.** `T` outside a generic, `Page<…>` as an
  argument or input field, a bad `@input(Type)`, members named twice, argument and enum value names starting with
  `__`, and names no schema file could hold (in IR from importers, the builder or a lock file) are errors. An object
  used only in an error payload is no longer called unreachable.

- **`rayfold gen graphql` output is valid for types with no fields.** Each one gets a placeholder field `_`, and `lost`
  says so.

- **`rayfold mock` answers `@example(EBOOK)` and `@example(5m)` as the wire carries them**, not as tagged IR values.

- **Policies decide the same on both runtimes.** A TypeScript policy path now reads only an object's own members, so
  `tags.length` or `viewer.constructor` is null there, as on the JVM.

- **Shape ids sort `item` before `item2`.** Fields are ordered by name, then by arguments. This changes the id of any
  shape where one field name begins another; both runtimes and the conformance vectors agree (spec 02 §3).

- **`rayfold check --against rayfold.lock.json` compares ordinals by name.** Adding a field between two others is
  compatible. A written `@ordinal` that disagrees with the lock, or a new field taking a locked ordinal, still fails.
  Against an older `.rayfold` file a moved field is a warning.

- **Smaller tooling fixes.** The language server and `rayfold check` point at the argument a finding is about. An
  explorer title holding `$&` or `$'` no longer breaks the page. The builder's `.annotate("interface")` makes an
  interface, and `rayfold check` no longer calls a nullability-only change inside a list breaking when it is
  compatible.

- **The spec states the limits servers already applied.** Idempotency records are kept 24 hours with bounded eviction,
  and an over-limit body is answered 413 `payload_too_large` (spec 03); the 413 and 415 answers are the exceptions to
  the status a batch's frames imply (spec 04); names starting with `__` or `$` are reserved everywhere (spec 01 §7).

- **Releases run the full test suites before publishing.** A tagged release now runs the TypeScript and JVM checks in
  a `verify` job, and the npm and Maven jobs wait for it.

- **A client that stops reading no longer makes the Node server buffer for it without bound.** A streaming HTTP
  response or a WebSocket kept queueing a live query's or a stream's frames for a client that had gone quiet. The
  TypeScript server now stops the batch once `maxBuffered` bytes (8 MiB by default) wait unread, and ends the response
  or drops the socket. Cancelling a fetch response's body now ends its batch too, and with it the live query's
  subscription.

- **`{ "cancel": id }` on a WebSocket stops that op, not its whole batch.** Both servers cancelled every op sent in the
  same batch as the one named. Now the other ops keep running, as spec 04 §5 says.

- **A WebSocket batch refused as a whole is answered for each of its ops.** An unknown op, a bad envelope or a batch
  over budget got one error frame with no op id, which a client could not route, so that batch's ops never ended. Both
  servers now send `{ id, error, fin: true }` for every op id the batch named.

- **CORS preflight works from `allowedOrigins` alone.** The TypeScript server answered `OPTIONS` only when the separate
  `cors` option was set, the JVM server always answered 501, and Spring Boot answered the preflight itself without the
  headers. Now an allowed origin gets 204 with the `Access-Control-Allow-*` headers and `Vary: Origin`, as do the
  responses that follow; any other origin gets no such headers.

- **A WebSocket opened with a capability token closes when the token expires.** The TypeScript server kept serving the
  socket, live queries included, after the token's `exp`. Now its open ops end `unauthenticated`, later batches are
  refused, and the socket closes with code 1008.

- **The JVM readiness check keeps to `readinessTimeoutMs`.** A check that blocked its thread, such as a JDBC `isValid`,
  held `/ready` until it returned, however short the limit. Checks now run on their own threads, and the answer comes
  at the limit.

- **Closing JVM WebSocket sessions no longer leaks or stalls.** Every session stayed referenced by the server until it
  drained, and a drain paused 5 seconds on each connection it closed while the connection waited for itself.

- **MCP follows spec 10 more closely.** A JSON-RPC body of `null`, or `null` in a batch, now gets `-32600` instead of
  failing the TypeScript handler. Every notification now gets 202, not only `initialized`. The HeaderMismatch reply
  carries `MCP-Protocol-Version`. A resource's URI arguments are converted by type, so `?limit=5` is a number.

- **MCP tool output schemas accept what the tools return.** They required every non-null field, but a tool call
  answers with the default view, which leaves some out, so clients that validate `structuredContent` refused valid
  results. The output schemas now require no fields inside objects and entities, in both runtimes.

- **A malformed Host header is a 400, not a 500.** The Node transport built the request URL from the raw `Host` header,
  so `Host: a b` or a port past 65535 threw. The URL now uses a fixed origin, and such a Host is refused.

- **`stale-while-revalidate` takes the smallest `swr`, as spec 07 says.** Both servers took the largest one.

- **A field asked for with arguments, or under an alias, no longer overwrites another result's.** The client caches
  stored every field of an entity by its output name, so `reviews(page: { first: 1 })` in one result and
  `reviews(page: { first: 3 })` in another, or `x: title` beside `x: stock`, overwrote each other through the shared
  entity, and a screen showed another screen's answer. The servers made it worse: the `set` patches they derive named
  those fields too, writing one selection's value into every cache. Now both clients keep such a field with the result
  that asked for it (read from the request's shape), and both servers leave it out of `set` patches, resending a live
  result whose value for one changed. Spec 07 §3 states the rule, with a patch vector.

- **Live queries recover in both clients.** The TypeScript client dropped an error meant for the whole batch, such as
  a draining server's 503 answering a reopen, and treated a response that simply ended as normal: either way the query
  stopped with nothing said and nothing retried, and `useLive` and `injectLive` stayed loading. Both now count as a
  retryable end. The Kotlin client never reopened a live query at all; `live()` now reopens after half a second,
  doubling to thirty, and takes an `onError(error, retrying)`, as the TypeScript client does.

- **The TypeScript WebSocket transport connects again after a refused connection.** It kept the failed attempt, so
  every later request got the same rejection and the transport was dead for the life of the client.

- **A dry run no longer changes the client cache.** Both clients stored a `simulate: true` command's result and applied
  its patch, so every watcher showed a change that never happened.

- **A command's answer, and every op after it in the batch, see what the command changed.** The batch shares one
  memo of loaded fields, and it outlived the command: a loader-backed field on the command's own result, and on any op
  after it, was answered from before the command ran, and that stale value went into the command's patch and into
  every client cache. Both runtimes now forget what was loaded once a command commits; a dry run keeps it.

- **On the JVM, one op's deadline no longer ends the batch.** An op that shared another op's field load, and was
  still waiting on it when that op ran out of time, received the other op's cancellation and ended the whole batch. It
  now loads for itself.

- **A stream whose resolver ignores the signal ends at its deadline.** The Node runtime waited for the resolver to
  finish before reporting `deadline_exceeded`, which a resolver stuck on an await never does, so the op never ended.

- **A server whose relay connection drops stops being ready.** When the connection Postgres `LISTEN`s on died, the
  server silently stopped hearing the other servers while going on publishing and reporting ready. `Relay.subscribe`
  now takes an optional callback for a lost subscription; `PgRelay` in both runtimes calls it, and the server reports
  the loss through `onRelayError` and its readiness.

- **`JdbcStore` works with Postgres column types and more policies.** Values were bound untyped, so a policy or a
  `find` on a `uuid`, `boolean` or `integer` column failed with "operator does not exist"; they are now bound as
  Postgres types a literal, from the column. An untranslatable comparison under `!` left its value among the
  statement's parameters and every read of the type failed, a list holding `null` dropped rows whose column is null,
  and a field on the right of `in` was read as the other way round; all three are now left to the runtime.

- **Shape ids agree between the runtimes.** The JVM wrote numbers in shape arguments as Java prints them (`1.0E-4`),
  and did not read `60s` or comments in shapes, so the same shape had another id there. It now reads and writes them as
  the TypeScript runtime does, with conformance vectors for each.

- **MCP tool calls are keyed by operation and arguments.** Two commands called with the same arguments shared an
  idempotency key, so the second was refused as a reuse of the first's. The key is now `mcp-` and the SHA-256 of the
  canonical `{op, args}`, the same in both runtimes (spec 10).

- **`rayfold check` sees a page of another type as a breaking change.** `Page<Book>?` to `Page<Author>` was reported as
  a compatible change of nullability.

- **A WebSocket message or a viewer hook can no longer end a Node server.** An envelope whose ops were not objects
  (`{"ops":[null]}`) threw out of the socket's data handler, and a `viewer` hook that threw or rejected was an unhandled
  rejection; either ended the process. The first is now refused like any malformed batch, and a refusing viewer is
  answered before the socket opens, as HTTP answers it: 401 for `unauthenticated`, 500 for anything else.

- **A store that fails to renew a lease no longer ends a Node server.** The renewal of a keyed command's lease was not
  caught, so one failed call, a Postgres connection dropping mid-command, was an unhandled rejection. A failed renewal
  is now asked again at the next tick, and renewals stop once the store says the claim is gone.

- **A live query or a stream sent as a safe request answers.** A request marked safe (`QUERY`, `Rayfold-Safe: true`)
  or asking for one plain JSON document was answered whole, and a live query never ends, so it never answered; on the
  JVM it held a worker thread for good. Both runtimes now stream it, and both clients stop sending a live query as a
  safe request, which is what `client.live()` over HTTP did whenever the client knew the op was a query.

- **RB decoders bound what string references expand to.** A two-byte reference stands for a string of any length, so
  a 208 KB body could stand for 800 MB, and the JVM ran out of memory hashing it. A decoder now refuses a message
  whose references stand for more than 16 times its length or 1 MiB, whichever is more (spec 09 §2, with vectors).

- **`rayfold check --resolvers` no longer switches `--against` off.** The resolver check returned before the
  compatibility check ran, so the CI line the CLI guide recommends passed a breaking change whenever the resolvers
  covered the schema. Both checks now run, and either fails the command.

- **The cost model charges what a union and a renamed page argument select.** Fields asked of a union are handed to
  every member, but were costed against the union, where they found nothing: a shape could nest pages without limit
  under a union, past the budget and the depth and field limits. They are now charged as each member would answer
  them, the dearest counting. A `PageArgs` argument not called `page` was charged as a page of 20, and a page's own
  `first` argument was never capped; the argument is now found by its type, and `first` is capped at 200.

- **The Node MCP endpoint limits what it reads.** `createMcpHandler` read a request body whole however large it was,
  so one POST could make a server hold as much as a client cared to send. It now takes `maxBody`, 1 MiB by default
  like the Rayfold endpoint, and refuses a larger body with the same 413 problem, drained so the client can read it.
  The JVM runtime's `maxBodyBytes` already did this.

- **A negated read policy keeps the rows it allows on the JVM.** `JdbcStore` pushed `!(status == "closed")` into SQL
  as `NOT (status = ?)`, which is unknown for a row whose status is null, so the row was dropped although the policy
  allows it. The negation now reads a null comparison as false first, as the policy does.

- **A negated policy the Postgres store cannot translate no longer breaks the query.** `@rayfold/postgres` left the
  value of an untranslatable comparison under a `!` — `!(total == viewer.limit)` on a `Decimal` — among the query's
  parameters while dropping the comparison itself, and Postgres refused the statement. The value now goes with it.

- **The explorer says when a server has its manifest turned off.** With `manifest: "off"` the page showed
  "rayfold undefined" and listed nothing; it now says there is no manifest, as it does when nothing answers.

- **`rayfold import` keeps argument descriptions.** A GraphQL or OpenAPI argument's description was dropped from the
  schema it wrote.

- **`/rayfold/stats` reports uptime on the server's clock.** A server given its own `now` reported the gap between that
  clock and the wall clock as its uptime.

## 0.2.1 (2026-09-23)

- **A live query's re-run loads its fields again.** Every op of a batch shares one loader memo, so a field loaded
  for an entity by one op is not loaded again by another. A live query's re-runs ran inside the same batch and so
  shared that memo, which meant a loaded field — an issue's assignee, a book's author — was answered from the first
  run for as long as the query stayed open: the row changed, the re-run saw the change on the entity's own columns,
  and reported the field as it had been. Both runtimes now give each re-run a fresh memo; the first run shares the
  batch's as before. Found by a page that hands an issue to someone and watches the list not change.

- **Uploads can go to a directory.** `FileUploadStore` in `@rayfold/server` streams an upload to a file and back out,
  so what a server holds at once is one chunk whatever the file weighs — `MemoryUploadStore` holds everything whole
  and `PgUploadStore` puts the bytes in a column, which stops suiting them somewhere in the low megabytes. It survives
  its directory going away between uploads. The [uploads guide](https://rayfold.dev/guide/uploads) shows it, and the
  new `examples/document-store` keeps files with it and shares one with a capability token.

- **A browser on another origin can upload.** The upload route's own headers, `Rayfold-Upload-Name` and
  `Rayfold-Upload-Type`, were missing from the preflight's allow list, so a cross-origin upload failed in the browser
  before the server saw a byte. They are allowed now, with a test.

## 0.2.0 (2026-09-19)

- **A JVM server sharing a Postgres relay now stops when it is told to.** `PgNotifications` guards the listening
  connection with a lock, and the notification poll loop asks for that lock again on the next line of its own `while`.
  Java's monitors are unfair, so the loop barged in front of everything else: an unsubscribe during shutdown — and,
  with the default notifier, every relay publish — queued behind it. Measured against a real Postgres in a container:
  a member told to stop took 0.7s when it had just started, 5.7s a tenth of a second later, and **19.9s** after a
  second of listening, against a deploy's twenty-second patience. The lock is fair now, and the same measurements are
  0.7s throughout. This is what had been failing the fleet job in CI intermittently.

- **`field()` in a shape is the same selection as `field`.** An empty argument list was parsed into an empty argument
  map, which the canonical form and the printer both drop, so a parsed shape did not survive being printed and read
  back. Both runtimes now record no arguments for it. Shape ids were never affected — the canonical form already
  ignored an empty map — so nothing on the wire changes. Found by the nightly fuzz job.

- **A server can say who it is and what it is doing.** Two Rayfold servers were indistinguishable: there was no name,
  no instance id, no start time — the concept did not exist in either runtime. `identity` supplies the first three
  (an instance id is generated per process, so a restart reads as a restart), and `GET {base}/stats` serves them
  beside what was already in the process and unreachable from outside: operations in flight, live queries open,
  readiness detail, the last relay failure, the field-usage snapshot.
  The route is **off unless you configure it**, and an unconfigured server answers `404` rather than `403` — a server
  that has not enabled it should look from outside like one that never had it, not advertise that it is there and
  refused. Nothing about identity reaches the manifest: spec 04 §4a fixes that document's members exactly and Core
  0.1 is frozen.

- **Counters, so an operator does not have to wire up tracing first.** `Counters` is a sink beside `UsageSink`, and
  `MemoryCounters` keeps them for one process. What it counts cannot be had any other way: `rayfold.refused{reason}`
  is a request turned away for its host, origin, media type or method — all of which are answered and returned
  *before* a batch is built, so no instrumentation hook has ever seen one. Also `rayfold.ops{kind,outcome}`,
  `rayfold.errors{op,code,type}` — every declared error is `domain` on the wire and carries its name in `type`, so a
  code alone would put a schema's whole error vocabulary in one bucket — `rayfold.idempotency{claim}` (ran it,
  replayed it, or waited for whoever holds the key), and `rayfold.live.opened/reran/closed` — one live query is a
  single op for its whole life, so its re-runs were invisible, and opened-minus-closed is a subscription leak you can
  now see.
  A full sink says so. `MemoryUsage` stops recording at its bound, which leaves a graph that keeps drawing and stops
  being true; counters keep counting the series they know and report `dropped` beside the numbers. Both runtimes emit
  the same names, because a console reading them from one and not the other is worse than neither.

- **`@rayfold/angular`.** Angular had nothing — the only bindings were React's. `provideRayfold(client)`, then
  `injectQuery`, `injectLive` and `injectCommand` return signals, which is what the client already wants: it keeps a
  normalised cache and pushes to it, and a signal invalidates on push and computes on read. A query is in flight the
  moment it is injected rather than on the first change detection, and arguments may be a function
  (`() => ({ id: this.id() })`) so a call re-runs when the signals it read change, as may `enabled`
  (`enabled: () => this.id() !== ""`) — the shape every detail screen has, where the id is not known when the
  component is created. Standalone, `OnPush`, no zone.

- **A replayed failure is reported as a failure.** A command that failed after its effect had happened records that
  failure, and every retry is answered with it (spec 12 §4.4). TypeScript then marked the replaying op *succeeded*:
  a later op reading its result through `$ref` ran with nothing to read, and a command that never succeeds counted as
  one that always does. It now ends the op the way the first run ended, as the JVM already did. The JVM in turn
  counted a command that sent its own error frame as neither success nor failure, and reported it to instrumentation
  as `failed` rather than as its code; both now match TypeScript.

- **A server whose relay is still connecting can now shut down.** `close()` waited for the relay subscription with no
  bound, in both runtimes. A relay that is re-establishing its connection has nothing to stop yet — `readiness()`
  reports exactly that state as "relay: not listening yet" — so the wait could never end, the shutdown hook never
  returned, and the process sat there until the platform killed it. A rolling deploy would stall on the server it was
  replacing. The wait is bounded now (`closeTimeoutMs`, default 2000); past it the subscription attempt is abandoned
  rather than held open.

- **A stream is bounded in TypeScript too.** Spec 04 §5 says a server emits stream items as its resolver yields them,
  "bounded by its own per-stream item limit". The JVM has always had one; TypeScript had none, so a resolver that
  never stopped produced frames until the process gave out. `maxStreamItems` is now a server option in both, default
  10000, and a stream that passes it ends with `resource_exhausted`. A resolver that stops on its own is unaffected.

- **The website documents the features it advertises.** The home page promised REST routes, an OpenAPI document and
  an MCP endpoint, and none of the three had a page to send a reader to; `Capabilities` was named only in a README
  the site excludes; the sidebar's "Command line" entry left the site altogether; and `stream`, one of the three
  operation kinds, was a single row in a table. There are now pages for
  [the command line](https://rayfold.dev/guide/cli), [streams and events](https://rayfold.dev/learn/streams),
  [MCP](https://rayfold.dev/guide/mcp), [REST routes and OpenAPI](https://rayfold.dev/guide/rest-bindings) and
  [capability tokens](https://rayfold.dev/guide/capabilities), and the annotations that existed only in the
  specification — `@version`, `@page`, `@load`, `@lazy`, `@live`, `@interface`, `@format`, `@unit`, `@example`,
  `@ordinal` — are taught where they belong, along with interfaces and unions, `...on` conditions, offset
  pagination, deadlines, conditional writes, and how to serve the WebSocket endpoint from Node.

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
