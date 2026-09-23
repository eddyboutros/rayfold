# 10 - MCP bridge (extension `mcp`)

Any Rayfold server is a Model Context Protocol server. The bridge is a pure projection of the schema; there is
no second definition of tools, no hand-written descriptions and no separate auth path: an agent calling a
tool goes through the same policies, idempotency, typed errors and patches as any other client.

Target revision: MCP **2026-07-28** (stateless; Streamable HTTP; JSON Schema 2020-12).

## 1. Endpoint

`POST /mcp` with a JSON-RPC 2.0 request (or batch) -> JSON-RPC response. The server sets
`MCP-Protocol-Version: 2026-07-28` on every JSON-RPC response; a refusal made before the body is understood (a wrong
media type, a bad Origin, an unparseable body) is a transport-level error and carries no such header. If the request
carries `Mcp-Method`, it MUST equal the body's `method`, otherwise the server answers HTTP 400 with JSON-RPC error
`-32020 HeaderMismatch`. Notifications answer HTTP 202 with no body. No session state is kept. `initialize` and
`server/discover` both describe the server's capabilities; `initialize` is the fuller document, naming the
`listChanged` and `subscribe` flags a client needs before it relies on them.


The endpoint accepts only `application/json` (415 otherwise). It refuses a request whose `Origin` is neither the
server's own nor an allowed origin (403), as the MCP transport requires, and a server reached on a loopback address
also checks the `Host` header against DNS rebinding ([12 §2](12-security.md)). A `.simulate` tool is listed only for
commands that declare `@simulate`, and a tool call that uses an idempotency key needs an identified caller.
## 2. Tools

| Rayfold | MCP tool |
|---|---|
| `command name(args): R` | tool `name`, whose `annotations` are `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`; and tool `name.simulate` (`readOnlyHint: true`) that runs with `simulate: true` |
| `query name(args): R` | tool `name`, whose `annotations` are `readOnlyHint: true`, `idempotentHint: true` |
| `stream` | not exposed as a tool |

* `inputSchema`: JSON Schema 2020-12 generated from the argument list; input types become `$defs`; enums
  become `enum`; nullability becomes `anyOf [.., {type: null}]`; defaults make properties optional.
* `outputSchema`: `{ result: <schema of R> }`; entities include `$type` as a `const`.
* `description`: the operation's schema description, then `May fail with: A, B.` from `throws`, then
  `Read-only.` or `Changes state; idempotent per call key.`
* `tools/list` includes `ttlMs: 300000` and `cacheScope: "public"` (SEP-2549).

### Calling

`tools/call` runs one Rayfold op with the default view (agents get the curated shape). Commands use the
idempotency key `mcp-` followed by the SHA-256 of the canonical JSON of `{"op": <name>, "args": <arguments>}`, so a
retried tool call with identical arguments replays instead of double-executing, and two commands called with the same
arguments are two calls. Results:

* success -> `content: [{ type: "text", text: <pretty JSON of result> }]`, `structuredContent: { result, effects? }`
  where `effects` is the command's patch list, `resultType: "complete"`;
* any Rayfold error -> `isError: true`, a text line `code Type: message` (the type omitted when the error has none),
  and `structuredContent.error` with the full error object (typed domain errors keep `type` and `data`).

## 3. Resources

* `rayfold://schema`: the IR as JSON (`application/json`), with policy expressions redacted by default
  ([12 §5.6](12-security.md)). A server MAY be configured to serve the full IR, or to serve no schema resource at all.
* `rayfold://query/<name>[?arg=value...]`: every **query** whose arguments are all optional; reading it runs the
  query with the default view. A resource URI MUST NOT name a command: reading a resource is a read, and a bridge
  that executes a command behind one turns a safe MCP verb into a write. Listed with `ttlMs`/`cacheScope` like tools.

## 4. Authorization

The bridge resolves the viewer from the HTTP request exactly as the Rayfold endpoint does (Bearer tokens by
convention; the MCP OAuth 2.1 profile applies unchanged). Tool calls the viewer may not perform fail with
`permission_denied` / `unauthenticated` in `structuredContent.error`; nothing is executed.

## 5. Human in the loop

Reserved: a command annotated `@confirm` will answer `resultType: "input_required"` with an MCP
`inputRequests` form (SEP-2322) before committing; the retry carries `requestState` = the simulate result
hash so the confirmed call commits exactly what was previewed.
