# 07 - Caching

Rayfold reads are cacheable at three layers with one set of declarations: shared HTTP caches (CDN, proxies),
the client's normalized entity cache, and the server's own result cache. The declarations are the
`@cache` annotation and the policies from [06](06-auth.md).

## 1. Declarations

`@cache(maxAge: Duration, scope: public | private, swr: Duration?)` on entities and queries.

* `maxAge`: how long a result may be served without revalidation.
* `scope`: `public` may be stored by shared caches; `private` only by the client.
* `swr`: stale-while-revalidate window.

**Derived scope:** any entity or field carrying a policy that references `viewer`, and any query whose result touches
such a field, is `private` regardless of what `@cache` says; so is any response produced for an identified viewer,
whatever the schema declares. The runtime computes this from the IR and from the request. Private data can therefore
never leak through a shared cache by misconfiguration.

## 2. Effective freshness of a response

For a `GET` or `QUERY` batch, the effective `maxAge` is the minimum over every query and every entity type
present in the results; the scope is `public` only if all are public. The server emits:

```
Cache-Control: public, max-age=60, stale-while-revalidate=300
ETag: "sha256-..."         (hash of the frame payload, excluding meta.ms)
Vary: Rayfold-Client, Accept, Authorization
```

When neither `maxAge` nor `swr` survives the minimum — the case for a schema with no `@cache` at all — the header
carries `no-cache` as well: `public, max-age=0, no-cache`, or `private, max-age=0, no-cache` for an identified
viewer.

Conditional requests (`If-None-Match`) answer `304` with no body. A `POST` batch that is not marked safe MUST carry
`Cache-Control: no-store`, so it is never held by a shared cache; clients that want shared caching for a read use `QUERY` (or `POST` + `Rayfold-Safe: true` where `QUERY`
is unavailable) or `GET`. Because a whole batch of queries is one safe request, a complete screen (for
example book + author + reviews) is one cache entry and one `304`, where resource-per-URL designs need one
revalidation per resource and query-in-POST designs cannot use shared caches at all.

## 3. Client normalized cache

A client is not required to keep a cache: a script or a service calling another can read frames and ignore
`patch` operations. A client that does keep one MUST key entities by `$type:id` and merge fields on every
`data`, `item`, `defer` and `patch` frame. Query results are stored as references (lists of keys plus scalar
payload) so that a later patch to an entity is visible in every query that contained it. Each entity records
`maxAge` from the schema (shipped in the manifest); how a read of a stale entity is revalidated is the client's
choice. The reference clients do not do this yet: they mark a result stale when an `inv` or `invOp` patch says so,
and have no time-based expiry or `swr` refetch.

What a client holds and how a patch changes it are defined in [13](13-patches.md). Optimistic updates, offline
queues and live invalidation are defined in [08](08-live-and-sync.md).

## 4. Server result cache

A server MAY cache canonical (op, args, vars, shape, viewer-scope) -> frames for `maxAge`. Cache hits report
`meta.cache: "hit"`. No runtime implements this yet, so `meta.cache` is reserved rather than sent. Any command that emits a patch touching an entity MUST invalidate cached results that
contain it; servers that cannot track containment MUST invalidate by op name (`invOp`).
