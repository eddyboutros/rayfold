---
title: Caching
description: Declare freshness once with @cache, get Cache-Control and ETag headers on every read, and answer repeat queries from the client cache.
---

# Caching

You say how long data stays fresh once, in the schema. The server turns that into `Cache-Control` and `ETag` headers
on every read, keeps private data out of shared caches, and answers `304` when nothing changed. The client keeps each
entity once in a normalized cache, so a read it has already made needs no request. This page covers both, on the
bookshop.

## Declare it

The bookshop marks books as fresh for a minute and safe for shared caches:

```rayfold
entity Book @cache(maxAge: 60s, scope: public) {
  id: ID
  title: String
  stock: Int
  author: Author
  """What the shop paid. Only staff can see it."""
  costPrice: Decimal? @allow(read: viewer.role == "staff")
}
```

- `maxAge` is how long a result may be used without asking again: `60s`, `5m`.
- `scope` is `public` when a CDN or proxy may store the result, `private` when only the caller's own browser or app
  may.
- `swr`, optional, is how long a cache may keep serving a stale result while it fetches a fresh one.

`@cache` goes on entity types and on queries.

## What a response gets

The server works out the headers from the queries in the request and the entity types in their results:

1. `max-age` is the smallest `maxAge` among them, and `stale-while-revalidate` the smallest `swr` among those that
   declare one. Types and queries without `@cache` do not count. When nothing in
   the response declares one, the answer is `public, max-age=0, no-cache` — or `private, max-age=0, no-cache` when
   the request carried a viewer.
2. The scope is `public` unless something makes it `private`: a `scope: private`, a request that carries a viewer
   (the bookshop's viewer comes from `Authorization`), or a type or field in the result whose policy mentions
   `viewer`.

The second rule means private data cannot reach a shared cache by mistake. `costPrice` has a policy on `viewer`, so
a response that contains it is private whatever `Book` says. Here is what the bookshop answers:

| Read | `Cache-Control` |
|---|---|
| `book` without credentials | `public, max-age=60` |
| `book` with a customer's access token | `private, max-age=60` |
| `book` with shape `{ id costPrice }`, as staff | `private, max-age=60` |
| `books` with `@cache(maxAge: 10s)` on the query and `swr: 5m` on `Book` | `public, max-age=10, stale-while-revalidate=300` |
| `book` sent as a plain `POST`, without `Rayfold-Safe` | `no-store` |

The fourth row uses a variation of the bookshop schema with those two annotations added. Every cacheable response
also carries `Vary: Rayfold-Client, Accept, Authorization`, so a shared cache keeps one copy per credentials and
format.

## Which requests are cacheable

Only reads that cannot change anything get these headers:

| Request | Holds |
|---|---|
| `GET /rayfold/{op}?a=...&s=...&v=...` | one query |
| `QUERY /rayfold` | a batch of queries in the body |
| `POST /rayfold` with `Rayfold-Safe: true` | a batch of queries, from runtimes that cannot send `QUERY` |

A command in any of them is refused before anything runs, with `400` and `Safe requests (GET/QUERY) may only contain
queries`. A batch of queries is one response with one `ETag`, so a whole screen revalidates at once. CDNs and
browsers store `GET` responses; for a shared cache in front of your API, use `GET`.

## Read a query by URL

`a` holds the arguments and `v` the shape's vars, each as canonical JSON in base64url. `s` is the shape. Canonical JSON
sorts object keys, so the same arguments always make the same URL and hit the same cache entry:

```ts
import { base64url, canonicalJson } from "@rayfold/schema";

const url = `http://localhost:4000/rayfold/book?a=${base64url(canonicalJson({ id: "b1" }))}`;
// http://localhost:4000/rayfold/book?a=eyJpZCI6ImIxIn0
```

```http
GET /rayfold/book?a=eyJpZCI6ImIxIn0

HTTP/1.1 200 OK
Content-Type: application/rayfold-frames+json
Cache-Control: public, max-age=60
ETag: "sha256-2bb3560f97fce4601507e62eaab8c1c8c181550463cb49da01319f52a94e7333"
Vary: Rayfold-Client, Accept, Authorization
Rayfold-Schema: 683ba13db1697a2f4714aac7338e87d0f0120aaddd9a5a93ed1dc91283ff2d38

{"id":1,"data":{"$type":"Book","id":"b1","title":"A Wizard of Earthsea","stock":3},"meta":{"cost":1},"fin":true}
```

Without `s` you get the default view. `s` takes shape text, URL-encoded (`s=%7B%20title%20stock%20%7D`), or a shape
id, which keeps URLs short. A server learns an id when it runs that shape as text, and forgets it when it restarts —
or sooner, since learned ids are held in an LRU of 10,000 and the oldest fall out. Register the shapes your pages use
when it starts and they are pinned instead:

```ts
const id = server.registerShape("{ title stock }");
// sha256:b93981ecceb69c58ab38523bcdb0489bf4d203e3bd498e5a0faf4f0da24dd837
```

An id the server has not seen fails that query with `not_found` and `Unknown shape sha256:...`.

## ETag and 304

The `ETag` is a hash of the response's frames. Send it back in `If-None-Match` and, while the data is the same, the
answer has no body:

```http
GET /rayfold/book?a=eyJpZCI6ImIxIn0
If-None-Match: "sha256-2bb3560f97fce4601507e62eaab8c1c8c181550463cb49da01319f52a94e7333"

HTTP/1.1 304 Not Modified
Cache-Control: public, max-age=60
ETag: "sha256-2bb3560f97fce4601507e62eaab8c1c8c181550463cb49da01319f52a94e7333"
Vary: Rayfold-Client, Accept, Authorization
Rayfold-Schema: 683ba13db1697a2f4714aac7338e87d0f0120aaddd9a5a93ed1dc91283ff2d38
```

A weak form of the tag (`W/"sha256-..."`, what nginx sends on when it compresses the response), a list of tags that
names it, and `*` all get the `304` too.

After a customer buys a copy, the same request gets `200`, `"stock":2` and a new `ETag`. The server still runs the
query to compute the hash: a `304` saves bytes and parsing on the way back, not work on the server.

## The client cache

The TypeScript and Kotlin clients store every entity they receive once, under its type and id (`Book:b1`), and keep
each query result as references to those entities. A command's patch updates the entity, so every stored result that
contains it changes too.

A field asked for under an alias (`left: stock`) or with arguments (`reviews(page: { first: 3 })`) is kept with the
result that asked for it instead: another screen may ask for the same field with other arguments, and one answer
must not overwrite the other. It updates when that result is read again, or when a live query resends it.

With `policy: "cache"`, a query is answered from the cache when it holds a result for the same operation, arguments,
shape and vars, and nothing marked it stale. Otherwise the client asks the server, as it always does by default:

::: code-group

```ts [TypeScript]
const shape = "{ id title stock }";

await client.query<Book>("book", { id: "b1" }, { shape }); // asks the server
await client.query<Book>("book", { id: "b1" }, { shape, policy: "cache" }); // no request

await client.command("buy", { bookId: "b1", qty: 1 }, { shape: "{ id stock }" });
const book = await client.query<Book>("book", { id: "b1" }, { shape, policy: "cache" }); // no request
console.log(book.stock); // 2: the purchase's patch updated Book:b1
```

```kotlin [Kotlin]
val shape = "{ id title stock }"

client.query("book", args("id" to "b1"), shape = shape) // asks the server
client.query("book", args("id" to "b1"), shape = shape, policy = Policy.CACHE) // no request

client.command("buy", args("bookId" to "b1", "qty" to 1), shape = "{ id stock }")
val book = client.query("book", args("id" to "b1"), shape = shape, policy = Policy.CACHE) // no request
```

:::

`client.cache.get("Book:b1")` shows the stored entity: `{ $type: "Book", id: "b1", title: "A Wizard of Earthsea",
stock: 2 }`. A different shape, such as `{ id title }`, is a different result and goes to the server.

The clients do not expire entries by `maxAge`. A cached result stays usable until a patch marks its entities
(`inv`) or its operation (`invOp`) stale; the next `policy: "cache"` read then asks the server. To follow changes as
they happen instead of reading again, use `watch` or a live query ([Live updates](./live.md)).

## Send the client's reads as safe requests

The client sends a batch as a safe request only when it knows every op in it is a query. Without that, a read goes
out as a plain `POST` and gets `no-store`:

::: code-group

```ts [TypeScript]
client.markQueries(["book", "books"]);
```

```kotlin [Kotlin]
client.markQueries("book", "books")
```

:::

A TypeScript client given `schema` (the IR from `GET /rayfold/manifest`) knows its queries without being told, and
`createFetchTransport({ url, useQueryMethod: true })` sends `QUERY` instead of `POST` with `Rayfold-Safe`. A client
given `schema` also asks for compact frames, which leave out `$type`. The server finds the entity types in a result
from the schema rather than from `$type`, so a compact read gets the same `Cache-Control` as a full one.

## Next

- A whole screen in one cacheable request: [Several steps, one request](./batches.md).
- Which policies make data private: [Who can do what](./auth.md).
- Changes pushed as they happen: [Live updates](./live.md).
- The rules in full: [spec 07, Caching](../../spec/07-cache.md).
