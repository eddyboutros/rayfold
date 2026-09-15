# 07 - Caching

Rayfold reads are cacheable at three layers with one set of declarations: shared HTTP caches (CDN, proxies),
the client's normalized entity cache, and the server's own result cache. The declarations are the
`@cache` annotation and the policies from [06](06-auth.md).

## 1. Declarations

`@cache(maxAge: Duration, scope: public | private, swr: Duration?)` on entities and queries.

* `maxAge`: how long a result may be served without revalidation.
* `scope`: `public` may be stored by shared caches; `private` only by the client.
* `swr`: stale-while-revalidate window.

**Derived scope:** any entity or field that carries a read policy referencing `viewer`, and any query whose
result touches such a field, is `private` regardless of what `@cache` says. The runtime computes this from
the IR and `rayfold check` reports it. Private data can therefore never leak through a shared cache by
misconfiguration.

## 2. Effective freshness of a response

For a `GET` or `QUERY` batch, the effective `maxAge` is the minimum over every query and every entity type
present in the results; the scope is `public` only if all are public. The server emits:

```
Cache-Control: public, max-age=60, stale-while-revalidate=300
ETag: "sha256-..."         (hash of the frame payload, excluding meta.ms)
Vary: Rayfold-Client, Accept
```

Conditional requests (`If-None-Match`) answer `304` with no body. `POST` batches are never cached by shared
caches; clients that want shared caching for a read use `QUERY` (or `POST` + `Rayfold-Safe: true` where `QUERY`
is unavailable) or `GET`. Because a whole batch of queries is one safe request, a complete screen (for
example book + author + reviews) is one cache entry and one `304`, where resource-per-URL designs need one
revalidation per resource and query-in-POST designs cannot use shared caches at all.

## 3. Client normalized cache

Clients MUST key entities by `$type:id` and merge fields on every `data`, `item`, `defer` and `patch` frame.
Query results are stored as references (lists of keys plus scalar payload) so that a later patch to an entity
is visible in every query that contained it. Each entity records `maxAge` from the schema (shipped in the
manifest); a read of a stale entity triggers revalidation according to the client's policy (default:
serve stale, refetch in background when `swr` allows, else block).

Optimistic updates, offline queues and live invalidation are defined in [08](08-live-and-sync.md).

## 4. Server result cache

A server MAY cache canonical (op, args, vars, shape, viewer-scope) -> frames for `maxAge`. Cache hits report
`meta.cache: "hit"`. Any command that emits a patch touching an entity MUST invalidate cached results that
contain it; servers that cannot track containment MUST invalidate by op name (`invOp`).
