# Roadmap

Rayfold 0.1.0 is out. This page says what comes next, and just as plainly what does not. It changes as people use
Rayfold: if something here would unblock you, or something you need is missing, open an
[issue](https://github.com/eddyboutros/rayfold/issues) and say what you are building.

## Now

- Keep what is published correct: the docs, the spec (errata only for Core 0.1), and the rough edges filed as issues.
- Hear from people trying it: what they build, and where they get stuck.

## Next, when someone needs it

| If you need | What gets built |
|---|---|
| A GraphQL schema from a Rayfold schema | `rayfold gen graphql`: the SDL, plus the list of what GraphQL cannot express (typed errors, cache patches, idempotency keys, live queries, several steps in one request) |
| Hono, Next.js, Bun, Deno or Cloudflare Workers | A fetch `Request`/`Response` handler next to the Node one |
| More than one server instance | Commands already run once across instances, through a shared idempotency store. Still to come: a shared change bus for live queries, health and readiness endpoints, and a deployment guide |
| Results typed to the shape you asked for | `rayfold gen ts --client` with typed hooks, and a published VS Code extension that runs the language server |
| A Rayfold service inside an Apollo supergraph | A GraphQL endpoint and Federation subgraph answered by the Rayfold engine |

## Known gaps in 0.1

- Live queries and learned shapes live in each process; two instances do not share them. Idempotency records can be
  shared (`PgIdempotencyStore`, `JdbcIdempotencyStore`), and then a keyed command runs once across instances; with the
  default in-memory store each process decides on its own, so a retry reaching another one runs the command again.
- Credit-based flow control on streams (spec 04, section 5) is not implemented in either runtime.
- Not yet tested on Safari itself (WebKit stands in for it), a real Android device, a commercial CDN, or load across
  several machines.
- No independent security review yet. `spec/12-security.md` lists the rules the test suite checks.

## Not planned for now

- More language runtimes. The conformance suite (`@rayfold/conformance`) is there for anyone who wants to write one.
- HTTP/3 and WebTransport.
- CRDT text merging and sync sessions (spec 08).
