# 05 - Errors

Rayfold separates **protocol errors** (a fixed code set, the same in every API) from **domain errors** (declared
per operation in the schema, delivered as typed payloads). Clients get exhaustive unions; operators get
uniform codes for retries, alerting and HTTP status mapping.

## 1. Error object

```json
{
  "code": "domain",
  "type": "OutOfStock",
  "message": "Only 1 copy left",
  "data": { "bookId": "b1", "available": 1 },
  "path": "items.0",
  "retryable": false
}
```

| Member | Required | Meaning |
|---|---|---|
| `code` | yes | One of the codes in §2, or `domain`. |
| `type` | when `code` is `domain` | The `error` type name from the schema. |
| `message` | yes | Human-readable, not for programmatic use. |
| `data` | when `type` is set | Payload matching the error type's fields. |
| `path` | no | Result path the error applies to (partial errors). |
| `retryable` | no | Server hint, sent only when it differs from the default. A receiver that sees none derives it: true for `unavailable`, `deadline_exceeded` and `aborted`, false otherwise. |

## 2. Protocol codes

The 16 codes of gRPC/Connect, verbatim, so existing tooling and intuitions carry over:

`canceled`, `unknown`, `invalid_argument`, `deadline_exceeded`, `not_found`, `already_exists`,
`permission_denied`, `resource_exhausted`, `failed_precondition`, `aborted`, `out_of_range`,
`unimplemented`, `internal`, `unavailable`, `data_loss`, `unauthenticated`.

Plus `domain` for declared errors.

## 3. HTTP status derivation

Used for a single-frame JSON response (`Accept: application/json`, one op, one frame) and for a problem document a
server answers before it parses a batch. Frame streams are always `200`.

| Code | Status |
|---|---|
| `invalid_argument`, `failed_precondition`, `out_of_range` | 400 |
| `unauthenticated` | 401 |
| `permission_denied` | 403 |
| `not_found` | 404 |
| `already_exists`, `aborted` | 409 |
| `resource_exhausted` | 429 |
| `canceled` | 499 |
| `unimplemented` | 501 |
| `unavailable` | 503 |
| `deadline_exceeded` | 504 |
| `domain` | 422 |
| everything else | 500 |

Two protocol errors carry a `type`: `DependencyFailed` (a `$ref` target failed, [03 §2](03-batch-and-pipelining.md))
and `VersionConflict` (a conditional command saw a newer version, [03 §4a](03-batch-and-pipelining.md)); both use
`failed_precondition`. HTTP bindings answer `VersionConflict` with `412 Precondition Failed`.

## 4. Atomic by default, partial by declaration

An operation either succeeds completely or ends with one `error` frame. There is no "data plus errors" in
Core, **except** for fields annotated `@partial` in the schema or the shape: such a field becomes `null` and
an error object with its `path` is appended to the frame's `errors` list. Clients can therefore trust every
non-partial field.

## 5. Declared errors

A command's `throws` list is a closed union. A resolver MUST NOT raise a domain error that is not declared; the
runtime converts an undeclared one to `internal`. The check is made on commands, which are the operations whose
errors clients branch on; queries and streams MAY declare `throws` too, and their declarations are documentation
rather than an enforced closed set. Generated clients expose the union as a discriminated type on `error.type`.

## 6. Problem Details

Refusals a server makes before it parses a batch, and every response from an HTTP binding ([04 §8](04-frames-and-transport.md)),
use RFC 9457. A batch that parses and then fails as a whole — over budget, for one — is an `error` frame on the frame
channel instead, because by then there is a frame channel to put it on.

```json
{ "type": "https://eddyboutros.github.io/rayfold/errors/invalid_argument", "title": "invalid argument", "status": 400,
  "detail": "placeOrder().input.qty: expected Int", "code": "invalid_argument" }
```

`title` is the problem type with underscores replaced by spaces. A binding's problem document may also carry `path`
and `data`. A **declared domain error** identifies itself by its own type rather than by the protocol code: `type` is
the base URI plus the error's name, and `title` is that name.

```json
{ "type": "https://eddyboutros.github.io/rayfold/errors/OutOfStock", "title": "OutOfStock", "status": 422,
  "detail": "Only 2 left", "code": "failed_precondition", "data": { "available": 2 } }
```
