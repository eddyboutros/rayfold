# 04 — Frames and transport

A response is an ordered sequence of **frames**. Every operation produces one or more frames; the last
frame for an operation carries `"fin": true`. A unary query is therefore one frame; a stream is many; a
live query is one `data` frame followed by `patch` frames until unsubscribed.

## 1. Frame kinds

All frames are JSON objects (or RB frames, [09](09-binary-format.md)) with an `id` matching the request op,
except batch-level frames, which have no `id`.

| Frame | Shape | Produced by |
|---|---|---|
| data | `{ id, data, meta?, errors?, fin? }` | query result, default `fin: true` |
| ok | `{ id, ok, patch?, meta?, errors?, fin: true }` | command result |
| item | `{ id, item, meta? }` | one stream element |
| patch | `{ id, patch, meta? }` | live-query update ([08](08-live-and-sync.md)) |
| defer | `{ id, at, data, errors? }` | a `@defer` block or `@lazy` field, `at` is the result path |
| error | `{ id, error, fin: true }` | terminal failure of the op ([05](05-errors.md)) |
| fin | `{ id, fin: true }` | end of a stream/live/deferred op with nothing else to say |
| batch error | `{ error, fin: true }` | the whole batch failed |

`meta` is an open object; Core defines `cost` (integer), `cache` (`"hit"`, `"miss"`, `"stale"`), `ms`
(server time), `replay` (boolean) and `cursor` (string). `errors` is the list of non-fatal `@partial` errors
([05 §4](05-errors.md)).

A frame with `fin: true` is the last frame for that id. Servers MUST NOT send frames for an id after `fin`.
When a `data` frame omits `fin`, it means more frames follow (defer, live).

## 2. Patches

A patch is a list of operations on the client's normalized cache, keyed by global identity `Type:id`.

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
| `list` | `{ "list": "items", "del": [3], "ins": [{ "at": 0, "value": { … } }] }` removes those positions of the list at that path, then inserts those elements at those positions. `del` names positions in the list as the client currently holds it; `ins` positions are in the list after the removals, applied in order. |

An `ins` carries the projected element exactly as a `data` frame would carry it, so the client stores its
entities and records which fields the result selected. A server MUST NOT also send those entities as `set`
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
| `GET /rayfold/{op}?a=…&s=…&v=…` | none | one query; `a` = base64url canonical-JSON args, `s` = shape id, `v` = base64url vars |

Request content type `application/rayfold+json`. Clients that cannot send `QUERY` (browsers today) send `POST`
with header `Rayfold-Safe: true`; servers treat it as `QUERY` for caching purposes.

**Response:** status `200`, content type `application/rayfold-frames+json`: newline-delimited JSON, one frame per
line, flushed as produced. When the request carries `Accept: application/json` and the batch has exactly one
op that finishes in one frame, the server MAY respond with that single frame as a JSON document; the status
is then derived from the error code ([05 §3](05-errors.md)).

**Keep-alive.** While a streaming response is idle, such as a live query waiting for its next change, a server
SHOULD write a keep-alive at least every 30 seconds: an empty line in NDJSON, a zero-length frame in RB
([09 §1](09-binary-format.md)). Clients MUST ignore both. Keep-alives stop proxies from closing an idle response,
and they are how a server notices a client that went away, since many HTTP servers only see a closed connection
when they write to it.

Batch-level failures (malformed body, unauthenticated, too large, over budget) use the derived status and an
RFC 9457 `application/problem+json` body whose `code` member is the Rayfold error code.

Headers:

| Header | Direction | Meaning |
|---|---|---|
| `Rayfold-Client` | request | same as `meta.client` |
| `Rayfold-Deadline` | request | milliseconds, same as `meta.deadline` |
| `traceparent` / `tracestate` | request | W3C trace context, propagated to loaders |
| `Rayfold-Schema` | response | schema hash; clients detect drift |
| `ETag`, `Cache-Control`, `Vary` | response | per [07](07-cache.md), on `GET`/`QUERY` only |
| `Server-Timing` | response | `rayfold;dur=…`, per-op timings in debug mode |
| `RateLimit`, `RateLimit-Policy` | response | per draft-ietf-httpapi-ratelimit-headers (provisional) |

## 5. WebSocket transport

Path `/rayfold/ws`, subprotocol `rayfold.0.1`. Text messages are JSON; binary messages are RB.

Client → server messages:

| Message | Meaning |
|---|---|
| batch envelope | as in HTTP; ids MUST be unique for the lifetime of the socket |
| `{ "cancel": id }` | stop an op; the server answers `{ id, fin: true }` (or nothing more if already finished) |
| `{ "id": id, "item": … }` | an item on a bidirectional stream |
| `{ "id": id, "fin": true }` | client side of a bidirectional stream is done |
| `{ "credit": id, "n": N }` | flow control: allow N more items on stream `id` |

Server → client messages are frames. Initial credit per stream is 32 items; a server MUST NOT exceed
outstanding credit.

## 6. Other transports

Any transport that delivers ordered chunks can carry Rayfold: HTTP/2 and HTTP/3 (identical to §4 with real
multiplexing), Server-Sent Events (frames as `data:` lines, queries only), WebTransport (one bidirectional
stream per batch, RB frames). None of these change frame semantics.

## 7. Cancellation and deadlines

A cancelled or expired op MUST stop calling loaders; in-flight loader calls receive an abort signal.
The op ends with `{ id, error: { code: "canceled" | "deadline_exceeded" }, fin: true }` unless it had
already finished.

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
  Status: `VersionConflict` → 412, `domain` → 422, others per [05 §3](05-errors.md).
* A path that matches with another method answers `405` with `Allow`.

`GET /rayfold/openapi.json` returns an **OpenAPI 3.2** document generated from the IR and the bindings (3.2 is the
first version with a `query` operation): parameters, request bodies, result schemas, `@range` as JSON Schema
keywords, the `Idempotency-Key` and `If-Match` headers, and one `422` schema per declared error. The published
contract and the enforced rules come from the same source and cannot drift.
