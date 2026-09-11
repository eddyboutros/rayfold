# Changelog

Every change a user will notice, newest first. Versions follow [docs/versioning.md](docs/versioning.md); the npm
packages and the Maven artifacts share one version number.

## Unreleased

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
