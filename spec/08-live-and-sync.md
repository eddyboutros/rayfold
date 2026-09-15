# 08 - Live queries and sync (extension `live`)

The query is the subscription. A client asks for a query with `"live": true`; the server answers the normal
`data` frame **without** `fin`, then keeps the operation open and pushes updates until it is cancelled.
No polling, no separate subscription type, no client-side invalidation logic: the same shape, the same
policies, the same cache patches.

## 1. Request

`{ "id": 7, "op": "books", "args": {...}, "shape": "...", "live": true }`. Only queries may be live; a query
annotated `@live(false)` refuses with `invalid_argument`. The manifest lists `"live"` in `extensions`.

## 2. Frames

| Frame | When |
|---|---|
| `{ id, data, meta }` (no `fin`) | first result; also whenever the change cannot be described as operations (rows reordered, a different set of fields, or a patch that would cost more than the result) |
| `{ id, patch }` | the change can be described: one `set` per entity whose fields changed, plus result-scoped `at` and `list` operations for plain objects and list membership (spec 04 section 2b) |
| `{ id, at, data }` | deferred parts of the first result, as for any query |
| `{ id, error: { code: "canceled" }, fin: true }` | the client cancelled (WebSocket `cancel`, HTTP connection closed, batch signal aborted) |
| `{ id, error: ..., fin: true }` | a re-execution failed (e.g. the viewer lost access) |

A re-execution that produces an identical result sends nothing.

## 3. Change detection

Every command's `patch` (spec 04 §2) is published on the server's **change bus** as a set of entity keys
(`set`, `del`, `inv`) and operation names (`invOp`). Servers MAY publish additional changes from adapters
(database replication, event buses) through the same bus.

A live query records its **read set**: the entity keys present in its last result, plus the entity **types**
reachable from its result type (so that a newly created entity can change list membership). A change
intersects when it names the operation, one of the keys, or a key whose type is reachable. Intersection
triggers a re-execution with the original args, shape, vars and viewer; the new result is diffed against
the previous one (§2). Re-executions are coalesced: changes arriving during a run schedule exactly one more.

This is deliberately conservative (a change to any entity of a reachable type re-runs the query). Adapters
that can compute exact dependencies (row-level replication, query-level read tracking) MAY narrow the
intersection test; they MUST NOT widen the frames' meaning.

## 4. Client behaviour

The client applies `patch` frames to its normalized cache exactly as it does for command patches, and
treats a new `data` frame as a replacement of the stored result. `at` and `list` operations are applied to the
stored result of the operation whose frame carried them, so a list that gained or lost rows costs the rows that
moved rather than the whole page. Because every query result is normalized,
a live query keeps *every* view of the affected entities coherent, not only its own.

## 5. Optimistic commands, offline queue, sync sessions

Defined by the `sync` sub-profile. The first two are client behaviour, implemented by `@rayfold/client` and the
Kotlin client ([guide](../docs/guide/offline.md)); the rest are drafts.

* Optimistic commands: the client applies a predicted patch tagged with the idempotency key, then rebases or
  rolls back when the `ok`/`error` frame arrives.
* Offline queue: commands are queued with their keys and drained in order on reconnect; idempotency
  guarantees make replay safe.
* Sync sessions: `{ "op": "sync", "args": { "since": cursor } }` resumes a set of live queries from a server
  cursor; the server may answer `must-refetch`.
* Conflict policy per field: `@merge(serverWins | keepLocal | lww | crdtText | custom)` on a field. A client that
  holds the schema applies it when a server value arrives for a field a prediction also set: `serverWins` and `lww`
  drop the predicted value at once (the server's write is the later one), `keepLocal` and no annotation keep the
  prediction until its command settles. `crdtText` and `custom` are declared but not implemented: a client refuses to
  predict such a field rather than merge it wrongly.
* Lowest-common-denominator transport: an Electric-style shape log over plain HTTP (offset/handle,
  long-poll or SSE).
