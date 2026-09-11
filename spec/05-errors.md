# 05 — Errors

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
| `retryable` | no | Server hint. Default: true for `unavailable`, `deadline_exceeded`, `aborted`; false otherwise. |

## 2. Protocol codes

The 16 codes of gRPC/Connect, verbatim, so existing tooling and intuitions carry over:

`canceled`, `unknown`, `invalid_argument`, `deadline_exceeded`, `not_found`, `already_exists`,
`permission_denied`, `resource_exhausted`, `failed_precondition`, `aborted`, `out_of_range`,
`unimplemented`, `internal`, `unavailable`, `data_loss`, `unauthenticated`.

Plus `domain` for declared errors.

## 3. HTTP status derivation

Used only for single-frame JSON responses and batch-level failures; frame streams are always `200`.

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

A command's `throws` list is a closed union. A resolver MUST NOT raise a domain error that is not declared;
the runtime converts an undeclared one to `internal` and logs it. Queries and streams MAY declare `throws`
too. Generated clients expose the union as a discriminated type on `error.type`.

## 6. Problem Details

Batch-level failures over HTTP use RFC 9457:

```json
{ "type": "https://rayfold.dev/errors/invalid_argument", "title": "Invalid argument", "status": 400,
  "detail": "ops[1].args.input.qty: expected Int", "code": "invalid_argument" }
```
