# 03 - Batches and pipelining

Every Rayfold request is a **batch** of one or more operations. Operations in a batch may depend on each
other's results, so a create-then-read flow is one round trip (promise pipelining, after Cap'n Proto).

## 1. Request envelope

```json
{
  "rayfold": "0.1",
  "ops": [
    { "id": 1, "op": "placeOrder", "args": { "input": { "bookId": "b1", "qty": 2 } }, "key": "5c9c..." },
    { "id": 2, "op": "order",      "args": { "id": { "$ref": "1.id" } }, "shape": "sha256:...", "vars": { "n": 5 } }
  ],
  "meta": { "client": "web/3.4.1", "deadline": 5000 }
}
```

The envelope's own `rayfold` member names the protocol version. It is optional and advisory: a server MUST NOT refuse
a batch for omitting it, and MUST NOT refuse one for carrying a version it does not know, because the version that
governs is the schema the manifest publishes. The remaining members are per-op:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Positive integer, unique within the batch. Frames are addressed by it. |
| `op` | yes | Operation name from the schema. |
| `args` | no | Object matching the operation's declared arguments. Missing args with defaults take the default. An absent argument or input field without a default stays **absent** in the resolver. An explicit `null` stays `null` and is never replaced by a default; on a non-null argument it is rejected with `invalid_argument`. Partial updates depend on the difference. |
| `shape` | no | Inline shape text or `sha256:` id ([02](02-shapes.md)). Absent = default view. |
| `vars` | no | Values for `$name` references inside the shape. |
| `key` | commands | Idempotency key, 16-128 characters, chosen by the client. Not required when the command declares `@idempotent(false)`, or when it is reached through a `PUT`, `PATCH` or `DELETE` binding ([04 §8](04-frames-and-transport.md)). |
| `live` | no | `true` to keep a query subscribed (`live` extension). |
| `deadline` | no | Milliseconds; overrides `meta.deadline` for this op. |
| `simulate` | no | `true` runs a command without committing; result and patches describe what would happen. Only for commands that declare `@simulate` ([12 §6](12-security.md)). |
| `ifVersion` | no | Conditional command: the version of the target entity the client last saw ([§4a](#4a-conditional-commands)). |
| `compact` | no | `true` asks for compact frames: `$type` is omitted wherever the schema already fixes the type (kept on union members), `meta` is omitted unless it carries `replay`, and a command's patch drops the `set` entries a normalizing client can derive from `ok` ([04 §2](04-frames-and-transport.md)). Only for schema-aware clients. |

`meta.client` SHOULD be `name/version` and is recorded for field-usage telemetry ([11](11-evolution.md)).
`meta.deadline` is the whole-batch deadline in milliseconds; the server MUST cancel work past it and answer
`deadline_exceeded` for every unfinished op.

## 2. References

Any value inside `args` MAY be the object `{ "$ref": "<id>.<path>" }`. It is replaced by the value at
`<path>` in the referenced op's result (`data` for queries, `ok` for commands; a stream records no result, so a
reference to one never resolves).
`<path>` is dot-separated; list indices are integers (`1.items.0.id`).

Rules:

* A reference may only point to an op with a smaller `id`. Forward or self references are `invalid_argument`
  for the whole batch (nothing executes).
* If the referenced op ends in an error, every dependent op answers `{ "id": 2, "error": { "code":
  "failed_precondition", "type": "DependencyFailed", "data": { "op": 1 } }, "fin": true }` without executing.
* If the path resolves to `undefined`, the dependent op is `invalid_argument`.

## 3. Execution order

1. Ops with no unresolved references form the first wave; each wave runs concurrently.
2. **Commands within a batch execute in ascending `id` order, one at a time**, even when independent. A
   command starts only after all previous commands have finished (success or error). This gives batches
   transactional readability without a transaction: "do A, then B" means what it says.
3. Queries and streams start as soon as their references are resolved and may overlap with anything.
4. Frames for different ops MAY interleave. Frames for one op are delivered in order.

## 4. Idempotency

A command with `key` K, operation O, args A and viewer V is executed at most once per (K, V), even when
repeats arrive at the same time: a later repeat waits for the first. A repeat with the same (K, V, O, A) returns
the stored result and patches with `"meta": { "replay": true }`, in the form (compact or full) the repeat asks for.
A repeat with the same (K, V) but a different O or A is `already_exists`. The command's write policy is checked
before a replay is served. A keyed command from a caller with no viewer is `unauthenticated`, because anonymous
callers would share one replay scope. Servers MUST retain keys for at least 24 hours and MUST bound the store
([12 §3-4](12-security.md)).

A command that failed before it changed anything leaves no record, so a repeat runs it. One that failed after its
effect keeps that failure, and one whose op was canceled or ran out of time after its effect keeps a `canceled` answer
saying the command committed, so a repeat learns that its effect happened instead of being told nothing did. While the command runs its key is held under a lease, and repeats wait. Servers that
share one store therefore execute once between them; if the server holding a key stops, the lease runs out and a later
repeat takes the key over ([12 §4](12-security.md)).

Commands without a `key` are rejected with `invalid_argument` unless the command is annotated
`@idempotent(false)`, which opts it out of the guarantee. Whether and when to repeat a failed request is the
client's choice, guided by `retryable` ([05](05-errors.md)); a client that repeats keyed commands on its own
SHOULD NOT repeat one annotated `@idempotent(false)`.

## 4a. Conditional commands

An entity MAY declare one `@version` field. A command that edits such an entity calls the runtime's
`checkVersion(key, storedVersion, storedEntity)` before writing and bumps the version when it writes. When the
request op carries `ifVersion` and it differs from the stored version, the command fails without side effects:

```json
{ "id": 1, "error": { "code": "failed_precondition", "type": "VersionConflict",
  "message": "Review:r2 is at version 2, not 1",
  "data": { "key": "Review:r2", "expected": 1, "actual": 2,
            "current": { "$type": "Review", "id": "r2", "rating": 5, "version": 2 } } }, "fin": true }
```

`data.current` is the stored entity **projected through the op's shape**, so the client repairs its cache and
retries without a separate read. Without `ifVersion` the write is unconditional. This is HTTP's `If-Match` for
every command and every transport; the HTTP binding maps `If-Match` onto it and answers `412`.

## 5. Batch limits

Default caps: 50 ops per batch, 1 MiB request body, cost budget per [06 §5](06-auth.md). Exceeding a cap is a
batch-level `resource_exhausted` ([05 §2](05-errors.md)).
