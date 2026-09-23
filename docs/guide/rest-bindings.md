---
title: REST routes and OpenAPI
description: Bind operations to HTTP routes with @http, serve them beside the batch endpoint, and publish an OpenAPI 3.2 document for them.
---

# REST routes and OpenAPI

A Rayfold operation can also answer on an ordinary HTTP route. That matters when something must call your API without
a Rayfold client: a webhook, a partner, a curl in a runbook, a tool that only speaks REST. The operation is the same
one — same resolver, same policies, same cost limits — reached a second way.

This is for the callers who need it, not a second API to maintain. Everything a route does is derived from the
`@http` annotation on an operation you already wrote.

## Bind an operation

```rayfold
query book(id: ID): Book?
  @http(method: GET, path: "/books/{id}")

query books(filter: BookFilter?, page: PageArgs): Page<Book>
  @http(method: QUERY, path: "/books", body: "*")

command buy(bookId: ID, qty: Int = 1): Order
  @http(method: POST, path: "/orders", body: "*", location: "/orders/{id}")

command updateBook(id: ID, patch: BookPatch): Book
  @http(method: PATCH, path: "/books/{id}", body: patch)

command deleteReview(id: ID): Review
  @http(method: DELETE, path: "/reviews/{id}")
```

- **`method`** — queries bind `GET` or `QUERY`; commands bind `POST`, `PUT`, `PATCH` or `DELETE`.
- **`path`** — `{name}` segments are arguments, taken from the path and coerced to their declared types.
- **`body`** — names the argument the request body carries, or `"*"` for "all the arguments". A `GET` binding cannot
  take a body.
- **`location`** — on a `POST`, the path of the thing that was created. It makes the response `201` with a `Location`
  header built from the result.

Path segments fill their arguments. On `GET` the rest come from the query string. Any other method reads the request
body only when the binding names `body`, one argument or `"*"` for all of them; without `body`, the body is ignored.

## Serve them

The route handler sits beside the batch endpoint and answers `false` for a path that is not one of its routes, so it
chains:

```ts
import { createServer } from "node:http";
import { createRayfoldServer, createHttpHandler, createBindingHandler } from "@rayfold/server";

const server = createRayfoldServer({ schema, resolvers });
const rayfold = createHttpHandler(server, { viewer });
const rest = createBindingHandler(server, { viewer }); // the same viewer as the batch endpoint, or routes run anonymous

createServer(async (req, res) => {
  if (await rest(req, res)) return;
  await rayfold(req, res);
}).listen(4000);
```

`createBindingHandler` is written against Node's `req`/`res`, so REST routes are served on Node only — a fetch
runtime serves batches but not these ([Runtimes](./runtimes.md)). On the JVM the equivalent is `RayfoldBindings`.

## What the routes do for you

These are the behaviours that surprise people, all of them derived from the schema:

**A bound `POST` requires an `Idempotency-Key` header** (16–128 characters), because a `POST` that is retried must
not buy the book twice. An operation that is genuinely safe to repeat can say `@idempotent(false)` and opt out.
`PUT`, `PATCH` and `DELETE` are idempotent methods already, so they need no key.

**`If-Match` becomes a conditional write.** The header's value is used as `ifVersion`, and a stale one is refused
with `412 Precondition Failed` rather than the generic error code. Queries answer `ETag` and honour `If-None-Match`
with a `304`.

**A replayed command says so** with `Idempotent-Replayed: true`, so a caller can tell "it worked" from "it had
already worked".

**`PATCH` accepts `application/merge-patch+json`** as well as `application/json`.

**`?shape=` picks the fields**, exactly as a shape does on the batch endpoint, so a REST caller can ask for less
without a second route.

Errors come back as RFC 9457 problem documents, and a declared domain error keeps its own name in `type` and `title`
so a REST client can branch on it ([Errors](../errors/)).

## The OpenAPI document

Everything above is already described by the schema, so the OpenAPI document is generated rather than written:

```ts
import { openApiFor } from "@rayfold/server";

const doc = openApiFor(server.ir, { title: "Bookshop", version: "1.0.0", prefix: "/api" });
```

A server also serves it at `GET /rayfold/openapi.json`. It is OpenAPI **3.2**, with request and response schemas
derived from the types your operations take and return, so it cannot drift from the API the way a hand-written
document does. Point Swagger UI, Stoplight or a client generator at it.

On the JVM, `OpenApi.document(ir)` produces the same thing.

## Next

- [Coming from REST](./from-rest.md) — moving an existing REST API over, one route at a time.
- [Caching](../learn/caching.md) — the `ETag` and `Cache-Control` rules these routes follow.
- [Command line](./cli.md) — `rayfold import openapi` reads a document back the other way.
