# Roadmap

Rayfold 0.1.0 is out. This page says what comes next, and just as plainly what does not. It changes as people use
Rayfold: if something here would unblock you, or something you need is missing, open an
[issue](https://github.com/eddyboutros/rayfold/issues) and say what you are building.

## Now

- Keep what is published correct: the docs, the spec (errata only for Core 0.1), and the rough edges filed as issues.
- Hear from people trying it: what they build, and where they get stuck.
- Read what people say about it, and fix what they are right about.

## Next, when someone needs it

| If you need | What gets built |
|---|---|
| Results typed to the shape you asked for | `rayfold gen ts --client` with typed hooks, and a published VS Code extension that runs the language server |
| A Rayfold service inside an Apollo supergraph | `rayfold gen graphql` already prints the SDL, and says what it could not carry; the endpoint that answers GraphQL queries from the Rayfold engine, and the Federation directives, do not exist |
| To move an API you already have | Readers exist for OpenAPI and GraphQL SDL (`rayfold import`); running the old and the new side by side, and gRPC, do not |

## Waiting for Core 0.2

Core 0.1 is frozen, which means errata only ([spec/process.md](spec/process.md)); a change that is not an erratum
waits here rather than being made quietly. These are worth doing together, when there is enough to justify a version:

- **An `Upload` scalar.** A file argument is an `ID` naming an upload today ([04 §9](spec/04-frames-and-transport.md)),
  so nothing in the schema says it is a file, and code generation, OpenAPI (`format: binary`), the MCP bridge and the
  explorer cannot show it as one.
- **Entity revisions**, which would turn the ordering caveat of [13 §6](spec/13-patches.md) into a rule and let a
  client tell a patch it has already applied from one it has not. Reserved in that chapter.
- **Resume**, so a live query that lost its connection is told what changed while it was gone instead of refetching.
  It needs retention, a revision to count from, and an answer for a cursor that is too old. Reserved in 13 §6.

## Known gaps in 0.1

- Several servers need the shared stores to behave as one: idempotency records in `PgIdempotencyStore` or
  `JdbcIdempotencyStore`, changes and events over `PgRelay`. With the in-memory defaults each process decides on its
  own, so a retry reaching another one runs the command again and a live query there never hears it. Shapes a server
  learned from requests are its own; shapes registered in code have the same id everywhere
  ([Deployment](docs/guide/deployment.md)).
- Uploads live in a database row ([04 §9](spec/04-frames-and-transport.md)), which suits the sizes the extension is
  for and not a file server: `PgUploadStore` and `JdbcUploadStore` hold the bytes whole on the way out, and pgjdbc
  holds them whole on the way in. For hundreds of megabytes, hand the client a URL from object storage instead.
- Credit-based flow control on streams (spec 04, section 5) is not implemented in either runtime.
- `@http` REST routes are served on Node only: `createBindingHandler` is written against `IncomingMessage`/
  `ServerResponse`, so a fetch runtime serves batches but not the REST bindings ([Runtimes](docs/guide/runtimes.md)).
- `client.upload()` needs a fetch transport; over a WebSocket it answers `unimplemented`.
- The Kotlin client speaks JSON only: no RB, and no `upload()`.
- `JdbcStore` has no `screen()`, so the whole-screen single-statement compiler is Node-only.
- Not yet tested on Safari itself (WebKit stands in for it), a real Android device, a commercial CDN, or load across
  several machines.
- No independent security review yet. `spec/12-security.md` lists the rules the test suite checks.

## Not planned for now

- More language runtimes. The conformance suite (`@rayfold/conformance`) is there for anyone who wants to write one.
- HTTP/3 and WebTransport in the runtimes. The spec already allows both as transports
  ([04 §6](spec/04-frames-and-transport.md)); what is not planned is implementing them here.
- CRDT text merging and sync sessions (spec 08).
