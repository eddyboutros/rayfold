# Coming from REST

You do not have to move everything at once. A Rayfold server can serve REST-style routes from the same schema, so the
usual path is: describe what you have, serve it both ways, and move screens one at a time.

## How the ideas map

| REST | Rayfold |
|---|---|
| A resource and its URL, `GET /books/{id}` | A query, `query book(id: ID): Book?`, and if you keep the URL, `@http(method: GET, path: "/books/{id}")` |
| `POST`/`PUT`/`PATCH`/`DELETE` handlers | Commands. Each carries an idempotency key, so a retry never runs twice |
| `?fields=` or a family of endpoints per screen | A shape: `{ title author { name } }`. Without one, the type's default view |
| Several requests per screen, often in waves | One batch; a later op can use an earlier result (`{ "$ref": "1.id" }`) |
| OpenAPI written beside the code | The schema is the contract; `GET /rayfold/openapi.json` is generated from it |
| `ETag`, `Cache-Control`, `304` | The same, derived from `@cache` and the read policies ([spec 07](../../spec/07-cache.md)) |
| `If-Match` and `412` | `ifVersion` on commands, or `If-Match` on bound routes; a conflict is a typed `VersionConflict` with the current entity |
| Status codes plus an error body | 16 error codes, plus the errors a command declares with `throws`, with typed data |
| Middleware for authorization | `@allow`/`@deny` in the schema, evaluated on every path: queries, commands, live updates, MCP |
| Webhooks or SSE for changes | `live: true` on any query; commands return patches that keep every client cache current |

## Start from the document you have

If you publish an OpenAPI document, the first draft of the schema can be read from it:

```sh
npx rayfold import openapi openapi.json --out api.rayfold
```

A `GET` becomes a query, anything that changes data becomes a command, `components.schemas` become types, and every
operation keeps the URL it already has with `@http`. An object with a non-null `id` becomes an entity, since that is
what gives the cache and the patches something to address.

What the document cannot say, the importer does not invent: what may be cached, who may read what, which errors a
command throws, which events it emits. Those are the parts that make the schema worth having, and they go in by hand.
Everything it had to assume is listed on stderr, so the schema on stdout stays a schema.

## A migration in five steps

1. **Write the schema for the resources you have.** Entities for your resources, queries for your `GET` endpoints,
   commands for everything that changes data. Keep the names clients already know.
2. **Keep your URLs.** Add `@http` to each operation that has a REST route today:
   `command placeOrder(input: OrderInput): Order @http(method: POST, path: "/orders", body: "*")`. Existing clients keep
   calling the same routes, with the same `ETag`/`If-Match` behaviour, now served by the Rayfold runtime.
3. **Move the resolvers.** A REST handler becomes a resolver that returns the entity; the loop that fetched each
   author becomes a batch field loader that gets every book of the level at once.
4. **Move one screen.** Replace its requests with one batch through `@rayfold/client` (or the Kotlin client). Its data
   now lands in the normalized cache, so other screens reading the same books stay current.
5. **Retire routes by usage, not by version.** Mark what is going away with `@deprecated(sunset: 2027-06-30)`;
   `rayfold check new.rayfold --against old.rayfold` refuses removing it before that date.

## What to watch for

- **Idempotency keys.** Commands need a key of 16 to 128 characters. The clients add one; `curl` users must too, or
  the route opts out with `@idempotent(false)`. Bound `PUT`, `PATCH` and `DELETE` routes do not need one.
- **Cross-site requests.** Rayfold accepts only JSON bodies and checks the Origin of every request that can change
  data. Behind a proxy that rewrites Host, list your public origin in `allowedOrigins`.
- **Costs.** Every batch has a budget (1 000 by default); a list's cost grows with its page size. Raise it for trusted
  internal callers instead of turning it off.
