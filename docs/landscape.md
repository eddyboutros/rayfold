# Landscape refresh, 2026-09

Verified state of the incumbents Rayfold draws from, with sources. Compiled 2026-09-09.

## 1. HTTP QUERY method
- Published as **RFC 10008 "The HTTP QUERY Method"**, Proposed Standard, June 2026. Safe, idempotent, cacheable (cache key includes request content); adds the `Accept-Query` response header; requests without `Content-Type` fail with 4xx. https://www.rfc-editor.org/rfc/rfc10008.html
- Node undici fetch accepts QUERY (PR #5459, 2026-06). https://github.com/nodejs/undici/issues/5454
- No browser `fetch` support yet; Envoy, Netty 4.2.16, Tomcat 12, Vert.x 5.2, Go net/http, Spring, Rails, Express, Fastify merged; nginx pending; Cloudflare body-keyed caching "under discussion". https://gist.github.com/desiderantes/2c7e657649cb92672d68e580fb69aa1d
- QUERY is not CORS-safelisted (preflight in browsers); CDNs pass unknown methods but caching is separate config.

## 2. Model Context Protocol
- Latest revision **2026-07-28**. Protocol is now **stateless**: no `initialize`, no `Mcp-Session-Id`; each request carries version/capabilities in `_meta`; new `server/discover` RPC. https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Transports: stdio and Streamable HTTP (POST-only single endpoint; JSON or request-scoped SSE response; required `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` headers mirrored from the body, mismatch = 400). HTTP+SSE transport deprecated. https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- Tools: `name`, `title`, `description`, `icons`, `inputSchema` (JSON Schema 2020-12), `outputSchema`, `annotations`; results carry `structuredContent`, `isError`, `resultType` ("complete" | "input_required"). List results carry `ttlMs` + `cacheScope`. https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Server-to-client requests replaced by **Multi Round-Trip Requests**: server returns `input_required` with `inputRequests`; client retries with `inputResponses` + opaque `requestState`. Elicitation has `form` and `url` modes. https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- Auth: OAuth 2.1, RFC 9728 Protected Resource Metadata MUST, RFC 8707 `resource` MUST, PKCE, RFC 9207 `iss` MUST; Dynamic Client Registration deprecated in favour of Client ID Metadata Documents. https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- Deprecated: Roots, Sampling, Logging; Tasks moved to an extension.

## 3. Rocicorp Zero
- **Zero 1.0** shipped 2026-06-08. https://www.infoq.com/news/2026/06/zero-version-1/
- Synced queries: defined once for client+server; client runs locally, zero-cache asks the app server for a **ZQL** expression (server-only filters), runs it, and streams row changes from Postgres logical replication. The query is the subscription; deactivated queries keep syncing for a TTL. https://zero.rocicorp.dev/docs/synced-queries
- Mutators run optimistically on the client, then re-execute server-side inside a transaction; client effects are rebased once replication returns; permissions are plain server code. https://zero.rocicorp.dev/docs/mutators
- Apache-2.0, self-hostable; cloud tiers from $30/mo.

## 4. Convex
- Queries are deterministic functions whose **read sets** are tracked; writes matched against read sets re-run affected queries; all of a client's queries observe one timestamp. https://stack.convex.dev/how-convex-works
- Mutations are serializable OCC transactions; client mutations are queued in order. https://docs.convex.dev/functions/mutation-functions
- Sync protocol: one WebSocket with typed JSON envelopes (`Connect`, `ModifyQuerySet`, `Mutation` -> `Transition` with start/end version + modifications). Defined in the open-source client. https://github.com/get-convex/convex-js/blob/main/src/browser/sync/protocol.ts

## 5. Electric / Replicache / PowerSync
- **Electric** (1.0 GA 2025-03): read-path sync via HTTP **shapes** (`table`, `where`, `columns`); shape log from `offset=-1`, then long-poll or SSE; control messages `up-to-date`, `must-refetch`; writes through your own API. https://electric.ax/docs/api/http
- **Replicache**: push named mutations, pull patches keyed by an opaque cookie, rebase pending mutations; now maintenance mode, users pointed to Zero. https://doc.replicache.dev/concepts/how-it-works
- **PowerSync**: sync rules map rows into **buckets**; checkpoints with per-bucket checksums and PUT/REMOVE ops; client upload queue for writes. https://docs.powersync.com/architecture/powersync-protocol

## 6. Connect protocol
- `Connect-Protocol-Version: 1`; unary idempotent RPCs may use **GET** with `message`, `encoding`, `base64`, `compression`, `connect=v1` query params. https://connectrpc.com/docs/protocol/
- Streams use 5-byte envelopes; server/client streaming works on HTTP/1.1, bidi needs HTTP/2; streams always return HTTP 200 with errors in a trailing `EndStreamResponse`.
- Errors: the 16 gRPC codes as JSON `{code, message, details[]}`; unary HTTP status derived from code.
- Buf breaking-change categories, strictest to loosest: `FILE`, `PACKAGE`, `WIRE_JSON`, `WIRE`. https://buf.build/docs/breaking/rules/

## 7. GraphQL
- **September 2025 edition**: schema coordinates, `@oneOf` inputs, executable-document descriptions. https://spec.graphql.org/September2025/
- `@defer`/`@stream` still RFC Stage 2, not in any released edition. https://github.com/graphql/defer-stream-wg
- GraphQL over HTTP: Stage 2 draft (2026-09-03), `application/graphql-response+json`. https://graphql.github.io/graphql-over-http/draft/
- Persisted Documents appendix (`documentId`, SHA-256 hex) still an open PR. https://github.com/graphql/graphql-over-http/pull/264

## 8. RFC 9457 Problem Details
- July 2023, obsoletes RFC 7807. Members `type`, `title`, `status`, `detail`, `instance`; extensions allowed. https://www.rfc-editor.org/rfc/rfc9457.html

## 9. IETF RateLimit headers
- `draft-ietf-httpapi-ratelimit-headers-11` (2026-05-23), still an Internet-Draft; defines `RateLimit-Policy` and `RateLimit` as Structured Field lists. https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/

## 10. Cap'n Proto
- Promise pipelining: a result can be the target of a new request before the server has answered the first, collapsing dependent calls into one round trip. Capabilities: references both designate an object and confer permission. https://capnproto.org/rpc.html

## 11. Compression Dictionary Transport
- **RFC 9842** (Sept 2025): `Use-As-Dictionary`, `Available-Dictionary`, `Dictionary-ID`; encodings `dcb` (Brotli) and `dcz` (Zstandard); same-origin only. https://www.rfc-editor.org/rfc/rfc9842.html
- Chrome/Edge 130+; Firefox in progress; Safari none. Cloudflare open beta since 2026-04-30. https://blog.cloudflare.com/shared-dictionaries/

## 12. WebTransport
- Safari 26.4 (2026-03) shipped it; now Baseline across Chrome, Edge, Firefox, Safari. https://webkit.org/blog/17862/webkit-features-for-safari-26-4/

## 13. Apollo GraphOS field usage
- Per-field requests vs executions, first/last seen, referencing operations and clients. https://www.apollographql.com/docs/graphos/platform/insights/field-usage

## Implications for Rayfold (applied in the spec)
1. `QUERY` is an RFC: Rayfold reads are designed as `QUERY` with body, with a mandatory `POST` + `Rayfold-Safe: true` fallback for browsers (04 §4).
2. Advertise `Accept-Query`; ETag is a hash of the payload so body-keyed CDN caching works when it lands (07 §2).
3. Core is stateless like MCP 2026-07-28; the MCP bridge mirrors op names into headers and adopts the `input_required` retry pattern for human-in-the-loop instead of server-initiated requests (10).
4. MCP tool definitions use JSON Schema 2020-12 for input and output; the bridge emits `structuredContent` and `ttlMs`/`cacheScope` from `@cache` (10).
5. Sync follows Zero/Convex: the query is the subscription; versioned transitions over one stream; optimistic commands rebase on ack (08).
6. An Electric-style plain-HTTP shape log (offset/handle, `up-to-date`, long-poll or SSE) is the lowest-common-denominator sync transport (08).
7. Error model: RFC 9457 body for batch-level failures, Connect's 16 codes as the protocol code set, HTTP 200 for frame streams (05).
8. GET for single idempotent queries with base64url-encoded args, like Connect (04 §4). Rayfold defines its own incremental delivery (defer frames) rather than waiting on GraphQL's.
9. Trusted shapes (SHA-256 allowlist) are in Core now; GraphQL's persisted-documents appendix is still unmerged (02 §3).
10. `RateLimit` headers are named by the draft but neither runtime emits them yet (04 §4).
11. WebTransport is Baseline, so the spec names it as the bidirectional transport tier (04 §6); neither runtime implements it. Compression dictionaries are an opt-in optimisation in the RB extension (09).
