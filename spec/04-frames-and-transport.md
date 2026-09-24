# 04 - Frames and transport

A response is an ordered sequence of **frames**. Every operation produces one or more frames; the last
frame for an operation carries `"fin": true`. A unary query is therefore one frame; a stream is many; a
live query is one `data` frame followed by `patch` frames until unsubscribed.

## 1. Frame kinds

All frames are JSON objects (or RB frames, [09](09-binary-format.md)) with an `id` matching the request op,
except batch-level frames, which have no `id`.

| Frame | Shape | Produced by |
|---|---|---|
| data | `{ id, data, meta?, errors?, fin? }` | query result, default `fin: true` |
| ok | `{ id, ok, patch, meta?, errors?, fin: true }` | command result; `patch` is always present, empty when the command touched nothing |
| item | `{ id, item, meta?, errors? }` | one stream element |
| patch | `{ id, patch, meta? }` | live-query update ([08](08-live-and-sync.md)) |
| defer | `{ id, at, data, errors? }` | a `@defer` block or `@lazy` field, `at` is the result path |
| error | `{ id, error, fin: true }` | terminal failure of the op ([05](05-errors.md)) |
| fin | `{ id, fin: true }` | end of a stream/live/deferred op with nothing else to say |
| batch error | `{ error, fin: true }` | the whole batch failed |

`meta` is an open object; Core defines `cost` (integer) and `replay` (boolean), which servers send, and `ms` (server
time), which a server MAY send when it is built to report timings. `cache` (`"hit"`, `"miss"`, `"stale"`) is reserved
for the server result cache of [07 §4](07-cache.md), which no runtime implements yet, so nothing sends it today.
`errors` is the list of non-fatal `@partial` errors ([05 §4](05-errors.md)).

A frame with `fin: true` is the last frame for that id. Servers MUST NOT send frames for an id after `fin`.
When a `data` frame omits `fin`, it means more frames follow (defer, live).

## 2. Patches

A patch is a list of operations on the client's normalized cache, keyed by global identity `Type:id`. This section
defines what a server sends; [13](13-patches.md) defines what a client does with it, and which of these operations
may safely be applied twice.

```json
[
  { "set": "Order:9",  "value": { "$type": "Order", "id": "9", "status": "PLACED", "total": "41.98" } },
  { "set": "Book:b1",  "value": { "stock": 3 } },
  { "del": "Cart:c7" },
  { "inv": ["Book:b2"] },
  { "invOp": ["books", "recommendations"] }
]
```

| Op | Meaning |
|---|---|
| `set` | Merge `value` fields into the entity; create it if absent. Nested entities in `value` are themselves normalized. |
| `del` | Remove the entity; any list containing it drops it. |
| `inv` | Mark entities stale; the client refetches on next read. |
| `invOp` | Mark every cached result of these operations stale. |

### 2b. Result-scoped operations

Two operations describe one operation's own result rather than the cache as a whole, and are valid only in a
`patch` frame that carries an `id` (live queries, [08](08-live-and-sync.md)). A client that does not track the
result of that operation ignores them.

| Operation | Meaning |
|---|---|
| `at` | `{ "at": "columns.2", "value": { "count": 9 } }` merges these fields into the plain object at this path of the result. The path is dotted, array positions included; `""` is the result itself. |
| `list` | `{ "list": "items", "del": [3], "ins": [{ "at": 0, "value": { ... } }] }` removes those positions of the list at that path, then inserts those elements at those positions. `del` names positions in the list as the client currently holds it; `ins` positions are in the list after the removals, applied in order. |

An `ins` carries the projected element in full form — `$type` retained even when the op asked for compact frames,
because a patch is applied to the cache rather than read as a result — so the client stores its entities and records
which fields the result selected. A server MUST NOT also send those entities as `set`
operations in the same patch. A server MUST NOT describe a change it cannot express this way (a reordering, a
different set of fields): it sends a fresh `data` frame instead.

A command's `ok` frame MUST include a `patch` that makes the client cache consistent with the command's
effect for every entity the command returned or the resolver declared as touched. In compact mode
([03 §1](03-batch-and-pipelining.md)) the server omits the `set` entries that merely restate entities already
present in `ok`, because a normalizing client derives them from `ok`; side-effect patches are always sent. A server that cannot
compute a precise patch MUST at least emit `inv` for touched entities and `invOp` for affected queries.

## 3. Deferred delivery

`{ "id": 2, "at": "author.stats", "data": { "salesRank": 12 } }` fills the result at path `at`. Paths use
dots and integer indices. Deferred frames arrive after the op's first `data` frame and before its `fin`.

## 4. HTTP transport

**Endpoint:** a single path, conventionally `/rayfold`.

| Method | Body | Use |
|---|---|---|
| `POST /rayfold` | batch envelope | anything |
| `QUERY /rayfold` | batch envelope | batches containing only queries ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008.html)); cacheable by body |
| `GET /rayfold/{op}?a=...&s=...&v=...` | none | one query; `a` = base64url canonical-JSON args, `s` = shape text or `sha256:` id, `v` = base64url vars |

These sub-paths of the endpoint are reserved and are never treated as an operation name: `manifest`,
`openapi.json`, `health`, `ready`, `uploads`, `ws` and `explorer`. An operation whose name collides with one of them
is still reachable by `POST`, but not by `GET /rayfold/{op}`.

A request body MUST carry one of three content types: `application/rayfold+json`, `application/json`, or the binary
`application/rayfold` ([09](09-binary-format.md)). Accepting no others is half of what stops a page on another origin
writing to the endpoint ([12 §2.1](12-security.md)); the uploads route of [§9](#9-uploads-extension-upload) accepts
`application/octet-stream` and nothing else, for the same reason. Clients that cannot send `QUERY` (browsers today)
send `POST` with header `Rayfold-Safe: true`; servers treat it as `QUERY` for caching purposes.

**Response:** status `200`, content type `application/rayfold-frames+json`: newline-delimited JSON, one frame per
line, flushed as produced. When the request carries `Accept: application/json` and the batch has exactly one
op that finishes in one frame, the server MAY respond with that single frame as a JSON document; the status
is then derived from the error code ([05 §3](05-errors.md)).

A streaming response is paced by the client reading it. A server MUST bound what it holds for a client that stops
reading, and MAY end the batch at that bound, which unsubscribes its live queries, cutting the response short rather
than completing it. A client that cancels the body or closes the connection ends the batch the same way.

**Keep-alive.** While a streaming response is idle, such as a live query waiting for its next change, a server
SHOULD write a keep-alive at least every 30 seconds: an empty line in NDJSON, a zero-length frame in RB
([09 §1](09-binary-format.md)). Clients MUST ignore both. Keep-alives stop proxies from closing an idle response,
and they are how a server notices a client that went away, since many HTTP servers only see a closed connection
when they write to it.

Failures the server refuses before it parses a batch — a malformed body, a media type it does not read, a bad Origin
or Host, a body over the limit — are answered with an RFC 9457 `application/problem+json` body whose `code` member is
the Rayfold error code, with the status derived from that code except in two cases HTTP names itself: a media type it
does not read is `415` (code `invalid_argument`, problem type `unsupported_media_type`, with `Accept-Post` or
`Accept-Query`), and a body over the limit is `413` (code `resource_exhausted`, problem type `payload_too_large`). A batch that parses and then fails as a whole, such as one over budget, is an
`error` frame on the frame channel rather than a problem document ([05 §5](05-errors.md)).

Headers:

| Header | Direction | Meaning |
|---|---|---|
| `Rayfold-Client` | request | same as `meta.client`, for a client that cannot set it in the envelope; Rayfold clients use `meta` |
| `Rayfold-Deadline` | request | milliseconds, same as `meta.deadline`, on the same terms |
| `traceparent` / `tracestate` | request | W3C trace context, carried into the batch's `meta` |
| `Rayfold-Schema` | response | schema hash; clients detect drift |
| `ETag`, `Cache-Control`, `Vary` | response | per [07](07-cache.md), on safe requests: `GET`, `QUERY`, and `POST` with `Rayfold-Safe: true` |
| `X-Content-Type-Options: nosniff` | response | on every response |
| `Cache-Control: no-store` | response | on a streaming response and on every problem document |
| `Retry-After` | response | on `503` while the server is draining ([§4b](#4b-health-and-readiness)) |
| `Accept-Post`, `Accept-Query`, `Allow` | response | on `415` and on a method the endpoint does not serve |

## 4a. Manifest

`GET {path}/manifest` is how a client learns what it is talking to, before it sends anything:

```json
{
  "rayfold": "0.1",
  "schemaHash": "a7178902819ae544d6de0d1e099df33720cbe7abd5070aba79bbfcee33e3ae49",
  "extensions": ["live", "rb", "http", "mcp", "upload"],
  "limits": { "budget": 1000, "maxOps": 50, "maxDepth": 8, "maxFields": 500 },
  "schema": { "rayfold": "0.1", "types": {}, "ops": {}, "views": {} }
}
```

| Member | Meaning |
|---|---|
| `rayfold` | the protocol version this server speaks |
| `schemaHash` | SHA-256 of the canonical IR ([01 §9](01-schema.md)), lower-case hexadecimal and **not** prefixed — unlike a shape id ([02 §3](02-shapes.md)), which is. The same value the `Rayfold-Schema` response header carries. |
| `extensions` | exactly the extensions this server serves. A client MUST NOT use an extension that is not listed ([process.md](process.md)). |
| `limits` | the bounds a batch is judged against ([06 §5](06-auth.md), [12 §3](12-security.md)), so a client can size a batch rather than discover a refusal. `budget`, `maxOps`, `maxDepth` and `maxFields` are defined; a server MAY name others it enforces. |
| `schema` | the IR ([01 §9](01-schema.md)), with policy expressions redacted unless the server is configured to serve them ([12 §5.6](12-security.md)) |

**`schemaHash` is not recomputable from `schema`.** It is taken over the IR the server holds, and what it serves here
is redacted by default, so hashing the `schema` member gives a different value. The hash is an identity to compare
against — the one in this document, the one in the `Rayfold-Schema` header on every response — and not a checksum of
what was sent. A client detects drift by noticing the two stop matching, and a client that needs to verify the hash
itself has to be served the full IR.

A server MUST NOT put anything in this document that it would not publish. It is served without a viewer, to anyone
who can reach the endpoint, so a member is added to it deliberately rather than by exposing whatever configuration
happens to exist.

## 4b. Health and readiness

Two routes beside the endpoint, so a load balancer can tell a process that is alive from one that should be sent
traffic:

| Route | Answers |
|---|---|
| `GET {path}/health` | `200 {"status":"ok"}` for as long as the process runs. `Cache-Control: no-store`. |
| `GET {path}/ready` | `200 {"ready":true,"reasons":[]}`, or `503 {"ready":false,"reasons":[...]}` naming every reason it should not take traffic. |

A server MAY be unready for reasons of its own; it MUST be unready while it is draining. **Draining** is what a
rolling deploy needs: readiness turns false so the balancer stops choosing this server, batches already in flight are
allowed to finish, long-lived operations (streams and live queries) end with a retryable `unavailable`, and any new
request is refused `503` with `Retry-After`. A WebSocket connection closes with code `1001`.

Preflight is answered by the endpoint: an `OPTIONS` request gets `204` with the `Access-Control-Allow-*` headers the
configured origins imply ([12 §2.1](12-security.md)). An origin listed as allowed, or any origin when `*` is listed,
gets `Access-Control-Allow-Origin` naming it, with `Vary: Origin`, on the preflight and on the responses that follow
it; any other origin gets the `204` without them, so its browser stops there.

## 5. WebSocket transport

Path `/rayfold/ws`, subprotocol `rayfold.0.1`. Text messages are JSON; binary messages are RB.

RB keys are numbered from the schema ([09 §3](09-binary-format.md)), and a socket carries no `Rayfold-Schema` header
per answer. A client that sends RB therefore names the schema hash its dictionary was built from in the `schema` query
parameter of the socket URL. A server whose hash differs completes the upgrade and at once closes the socket with code
`4409` and its own hash as the reason: a browser cannot read a refused handshake, but it can read a close. The client
fails the batches it sent on that socket with `unavailable` and uses JSON on the sockets it opens after it. Without the
parameter the server makes no check.

Client-to-server messages:

| Message | Meaning |
|---|---|
| batch envelope | as in HTTP; ids MUST be unique among the ops currently open on the socket. An id is free again as soon as the client has seen that op's `fin`. |
| `{ "cancel": id }` | stop an op. The op ends as any cancelled op does, with `{ id, error: { "code": "canceled" }, fin: true }` ([§7](#7-cancellation-and-deadlines)); a server that has already finished the op sends nothing more. The other ops of its batch keep running. |

Server-to-client messages are frames.

A batch refused as a whole (a bad envelope, an unknown operation, over budget) is answered on this transport with one
`{ id, error, fin: true }` per op id the batch named, rather than the one frame without an id that HTTP sends: a
socket carries several batches, and a client routes frames by op id, so a frame without one belongs to none of them.
A message whose ops carry no usable id gets the frame without one.

A socket whose viewer holds a capability ([06 §6](06-auth.md)) is served until that capability's `exp`. Then its open
ops end with `unauthenticated`, a batch sent after it is refused for each of its ops the same way, and the socket
closes with code `1008`. Like a streaming HTTP response, what a socket holds for a client that stops reading is
bounded, and a server MAY stop its ops and drop the connection at that bound.

Three further client messages are reserved and not part of 0.1: `{ "id": id, "item": ... }` and
`{ "id": id, "fin": true }` belong to the unshipped `@input` extension for bidirectional streams, and
`{ "credit": id, "n": N }` to credit-based flow control. A server that does not implement them refuses them as
`invalid_argument`. Until flow control is specified as a requirement, a server emits stream items as its resolver
yields them, bounded by its own per-stream item limit.

## 6. Other transports

Any transport that delivers ordered chunks can carry Rayfold, and this section sketches how rather than defining
bindings: HTTP/2 and HTTP/3 (identical to §4 with real multiplexing), Server-Sent Events (frames as `data:` lines,
queries only), WebTransport (one bidirectional stream per batch, RB frames). None of these change frame semantics,
none is required for conformance, and no runtime implements them today.

## 7. Cancellation and deadlines

A cancelled or expired op MUST stop calling loaders, and a resolver already running MUST be given a way to notice:
cancellation is cooperative, so the runtime offers the signal and the resolver is expected to observe it. How it is
offered is the runtime's own business — an `AbortSignal` on the context, a cancelled coroutine — but a resolver that
never looks will run to completion, and only its result is discarded. The op ends with
`{ id, error: { code: "canceled" | "deadline_exceeded" }, fin: true }` unless it had already finished.

## 8. HTTP bindings (extension `http`)

`@http` ([01 §4](01-schema.md)) exposes a query or command on a REST-shaped route with its natural method. A
binding is a projection of the same operation: arguments are validated against the schema, policies apply,
declared errors stay typed and idempotency keys work. Clients that speak Rayfold keep using `/rayfold`; bindings serve
curl scripts, webhooks, gateways and teams that expect resources.

| Kind | Method | Request | Success |
|---|---|---|---|
| query | `GET` | path parameters + query-string arguments; optional `shape` parameter (text or `sha256:` id) | `200` JSON result in the default view; `ETag`, derived `Cache-Control`, `304` on `If-None-Match` |
| query | `QUERY` | path parameters + JSON body (`body: "*"` spreads it into the arguments) | same as `GET`; cacheable by body ([RFC 10008](https://www.rfc-editor.org/rfc/rfc10008.html)) |
| command | `POST` | JSON body bound to one argument or spread | `201` + `Location` when `location` is declared, else `200`; `Idempotency-Key` header **required** unless `@idempotent(false)` |
| command | `PUT`, `PATCH`, `DELETE` | path parameters + JSON body (`application/merge-patch+json` accepted for PATCH) | `200` with the result; `Idempotency-Key` optional because the method is idempotent |

* `Idempotency-Key` maps to the op's `key`; a replay answers the original result with `Idempotent-Replayed: true`,
  so a retried `DELETE` reports its first success instead of `404`.
* `If-Match: "<version>"` maps to `ifVersion`; a conflict answers `412` with the current entity in `data.current`.
  Responses to commands whose result has a `@version` field carry `ETag: "<version>"`.
* Errors are RFC 9457 problems whose `title` is the Rayfold error type and whose `data` is the typed payload.
  Status: `VersionConflict` -> 412, `domain` -> 422, others per [05 §3](05-errors.md).
* A path that matches with another method answers `405` with `Allow`.

`GET /rayfold/openapi.json` returns an **OpenAPI 3.2** document generated from the IR and the bindings (3.2 is the
first version with a `query` operation): parameters, request bodies, result schemas, the `Idempotency-Key` and
`If-Match` headers, and one `422` schema per declared error. `@range` becomes `minimum`/`maximum` on `Int`, `Long` and
`Float`, and `minLength`/`maxLength` on `String`; on a `Decimal` or a list, where JSON Schema's keywords do not carry
the same meaning, it becomes the extension `x-rayfold-range`. The published contract and the enforced rules come from
the same source and cannot drift.

## 9. Uploads (extension `upload`)

Bytes that are awkward as an argument arrive on a route of their own, and the command that uses them names what
arrived rather than carrying it:

```
POST /rayfold/uploads
Content-Type: application/octet-stream
Rayfold-Upload-Name: avatar.png          (optional, a label; never a path)
Rayfold-Upload-Type: image/png           (optional, what the client claims it is)

<bytes>

201 { "id": "d9f1…", "size": 20481, "name": "avatar.png", "type": "image/png" }
```

```json
{ "ops": [{ "id": 1, "op": "setAvatar", "args": { "userId": "u1", "upload": "d9f1…" }, "key": "…" }] }
```

A server that serves this route lists `upload` in its manifest's `extensions` ([§4a](#4a-manifest)).

**Why a route and not a multipart batch.** A browser may send `multipart/form-data`, `text/plain` and
`application/x-www-form-urlencoded` to any origin without a preflight, which is why the batch endpoint takes JSON only
([12 §2.1](12-security.md)). `application/octet-stream` is not one of those, so this route keeps that protection, and
bytes travelling as bytes cost what they weigh rather than a third more as base64.

Requirements:

1. The route MUST accept `application/octet-stream` only, and MUST apply the Origin rule as for any write
   ([12 §2](12-security.md)): an upload changes what the server holds.
2. A server MUST bound one upload's size and MUST enforce that bound as the bytes arrive, not from `Content-Length`
   alone, which a client may understate. Over it: `413` with problem type `payload_too_large`.
3. An upload SHOULD need an identified viewer, since an open upload route fills a server's storage with nothing to
   trace it to. A server MAY allow anonymous uploads where that is what it wants.
4. An id MUST be unguessable: holding one is what lets a command read those bytes.
5. Stored bytes MUST expire, and the store MUST be bounded, as idempotency records are ([12 §3.6](12-security.md)).
6. `name` and `type` are what the client said. A server MUST NOT treat `name` as a path, and SHOULD check the type
   itself where it matters rather than believe it.

For files measured in hundreds of megabytes, a command that answers with a URL from the application's own storage,
which the client then uploads to, costs the protocol nothing and the server less; this extension is for the sizes
where a round trip through the API is the simpler thing.
