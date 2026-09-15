---
title: Commands and errors
description: Change data with commands that return patches, are safe to retry, and fail with errors the schema declares.
---

# Commands and errors

A command changes data. Three things set it apart from a POST endpoint or a GraphQL mutation: it always comes back
with a patch that tells every client cache what changed, it carries an idempotency key so sending it twice never does
it twice, and the errors it can end with are part of the schema.

## Declare it

```rayfold
"""Take copies off the shelf. Fails if there are not enough."""
command buy(bookId: ID, qty: Int = 1 @range(min: 1, max: 10)): Book
  throws OutOfStock
  emits StockChanged
  @allow(write: viewer != null)

error OutOfStock { bookId: ID, available: Int }
```

The arguments, the result, what can go wrong, the events it publishes and who may call it are all in these lines.

## Write the resolver

::: code-group

<<< @/../examples/typescript/src/resolvers.ts#errors{ts} [TypeScript]

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Server.kt#errors{kotlin} [Kotlin]

<<< @/../examples/java/src/main/java/com/example/bookshop/Bookshop.java#errors{java} [Java]

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/BookResolvers.java#errors{java} [Spring Boot]

:::

Throw the declared error when the command cannot go ahead. Otherwise return the entity the command changed, with the
events the schema says it emits: `ok(book, { emit })` in TypeScript, `CommandResult(book, emit = ...)` in Kotlin,
`Rayfold.result(book).emit(...)` in Java.

## What comes back

```json
{
  "id": 1,
  "ok": { "$type": "Book", "id": "b3", "title": "Dune", "stock": 6 },
  "patch": [
    { "set": "Book:b3", "value": { "$type": "Book", "id": "b3", "title": "Dune", "stock": 6 } }
  ],
  "meta": { "cost": 1 },
  "fin": true
}
```

`ok` is the result. `patch` lists the entities to update: `set` gives the new fields of `Book:b3` to every client cache
that holds that book, so the list, the detail page and the cart badge all show 6 without asking again. You do not
write patches by hand; the server derives them from what the command returns.

## Call it

::: code-group

<<< @/../examples/typescript/src/client.ts#watch{ts} [TypeScript]

<<< @/../examples/react/src/App.tsx#buy{tsx} [React]

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Client.kt#client{kotlin} [Kotlin]

```http [HTTP]
POST /rayfold
Content-Type: application/rayfold+json
Authorization: Bearer customer

{"rayfold":"0.1","ops":[{"id":1,"op":"buy","args":{"bookId":"b3"},"key":"6c1f0d2e-buy-b3-0001"}]}
```

:::

## Safe to retry

Every command carries a `key` of 16 to 128 characters. Without one the server refuses it:

```json
{"id":1,"error":{"code":"invalid_argument","message":"buy(): commands require an idempotency key of 16-128 characters"},"fin":true}
```

Send the same command with the same key again, after a timeout or a dropped connection, and the server answers with
the original result instead of running it a second time. `meta.replay` says so:

```json
{"id":1,"ok":{"$type":"Book","id":"b3","title":"Dune","stock":6},"patch":[{"set":"Book:b3","value":{"$type":"Book","id":"b3","title":"Dune","stock":6}}],"meta":{"cost":1,"replay":true},"fin":true}
```

The client libraries create a key for each call and keep it when they retry or replay a command queued offline.

## Errors the schema declares

When the resolver throws `OutOfStock`, the client receives it by name, with the data the schema describes:

```json
{"id":1,"error":{"code":"domain","message":"Only 0 left","type":"OutOfStock","data":{"bookId":"b2","available":0}},"fin":true}
```

::: code-group

<<< @/../examples/typescript/src/client.ts#errors{ts} [TypeScript]

<<< @/../examples/react/src/App.tsx#buy{tsx} [React]

:::

The message is for people; code branches on `type`. A resolver may only throw errors its operation declares. Anything
else reaches the client as [`internal`](/errors/internal), and the details stay in the server's log.

## Errors every API shares

Some failures are the same in every Rayfold API, so they have fixed codes that work with retries, alerts and HTTP
status codes. The bookshop produces these without any code of its own:

```json
{"id":1,"error":{"code":"invalid_argument","message":"buy().qty: must be <= 10"},"fin":true}
{"id":1,"error":{"code":"unauthenticated","message":"Sign in to access buy()"},"fin":true}
{"id":1,"error":{"code":"permission_denied","message":"Not allowed to access restock()"},"fin":true}
```

Arguments are checked against the schema, `@range` included, before your resolver runs. [Every error
type](../errors/index.md) has a page with its causes and what to do.

## Dry runs

A command marked `@simulate` accepts `"simulate": true`. The resolver sees `ctx.simulate` and returns what would
happen without writing anything, which lets a form preview a result or an AI agent check a plan before acting.
Without the annotation, a dry run is refused with [`failed_precondition`](/errors/failed_precondition).

## Next

- Who may run which command: [Who can do what](./auth.md).
- See other people's changes as they happen: [Live updates](./live.md).
- Show a command's result before the server answers: [Offline and optimistic](../guide/offline.md).
