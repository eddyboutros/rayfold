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
Authorization: Bearer <access token>

{"rayfold":"0.1","ops":[{"id":1,"op":"buy","args":{"bookId":"b3"},"key":"6c1f0d2e-buy-b3-0001"}]}
```

:::

## Safe to retry

Every command carries a `key` of 16 to 128 characters, unless the schema marks it `@idempotent(false)` or it arrives
through a `PUT`, `PATCH` or `DELETE` REST binding, whose method is already idempotent. Without one the server refuses
it:

```json
{"id":1,"error":{"code":"invalid_argument","message":"buy(): commands require an idempotency key of 16-128 characters"},"fin":true}
```

Send the same command with the same key again, after a timeout or a dropped connection, and the server answers with
the original result instead of running it a second time. `meta.replay` says so:

```json
{"id":1,"ok":{"$type":"Book","id":"b3","title":"Dune","stock":6},"patch":[{"set":"Book:b3","value":{"$type":"Book","id":"b3","title":"Dune","stock":6}}],"meta":{"cost":1,"replay":true},"fin":true}
```

The client libraries create a key for each call and keep it when they retry or replay a command queued offline.

A record belongs to the caller who made it and to the exact command it answered. Send a key with no viewer and the
server answers `unauthenticated`: a replay scope needs someone to scope it to. Send a key that was used for another
operation, or the same operation with different arguments, and it answers `already_exists` rather than handing back an
answer to a question you did not ask.

Records live in the server's memory by default, which holds for one server. Point every instance at a shared store
([`PgIdempotencyStore`](../guide/postgres.md) on Node, `JdbcIdempotencyStore` on the JVM) and the guarantee holds across
a fleet: a retry that lands on another instance replays the first answer, and two retries that arrive together take the
key with one statement, so one of them runs the command and the other waits for it. A fleet needs a
[`relay`](../guide/deployment.md) too, or the patch a command produced on one instance never reaches the live queries
held by the others.

There is one case where a command can still run twice: a server that dies between making the change and writing the
record leaves a lease that eventually expires, and the next retry takes the key over and runs it again
([spec 12 §4.6](../../spec/12-security.md)).

A command that failed before it changed anything leaves no record, so a retry runs it. When the caller goes away or the
deadline passes *after* the command committed, the record says exactly that:

```json
{"id":1,"error":{"code":"canceled","message":"buy() committed, then the op ended before its result was delivered"},"meta":{"replay":true},"fin":true}
```

The retry is told its effect happened. Replaying the op's own `deadline_exceeded` would say the opposite, and since that
code is retryable the client would come back with a fresh key and buy a second copy.

## Conditional writes

Retrying safely is one half of writing from several places at once; not overwriting someone else's change is the
other. Mark the field that says which version of a row you have:

```rayfold
entity Book {
  id: ID
  title: String
  stock: Int
  version: Int @version
}
```

Then send the version you read with the command. The resolver checks it against the row with `ctx.checkVersion`
before it writes, and the server refuses the command if the row has moved on since:

```ts
const book = await client.query<Book>("book", { id: "b1" }, { shape: "{ id stock version }" });
await client.command("restock", { bookId: "b1", qty: 5 }, { ifVersion: book.version });
```

A stale version comes back as the typed error `VersionConflict`, carrying the key, the version you expected and the
version the row is actually at — so a client can show the current value, or retry against it, without a second
round trip to find out what happened. Over a [REST binding](../guide/rest-bindings.md) this is `If-Match`, and the
refusal is `412 Precondition Failed`.

A `@version` field can be an `Int`, a `Long`, a `String` or an `Instant`; the resolver bumps it on every write. The
comparison is the resolver's to make, because only it reads the row: `ctx.checkVersion(key, actual, current)` compares
the version the command sent with the one the row has, and throws `VersionConflict` if they differ. A resolver that
does not call it writes whatever version the client sent.

```ts
restock: ({ bookId, qty }, ctx) => {
  const book = store.books.get(bookId);
  ctx.checkVersion(`Book:${bookId}`, book.version, book); // refuses a stale ifVersion, with the current book
  book.stock += qty;
  book.version += 1;
  return book;
},
```

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
else reaches the client as [`internal`](/errors/internal) with the message `Internal error`, so nothing about the
server leaks. The runtime does not keep the original exception, so log it in the resolver, or in an
[`Instrumentation`](../guide/tracing.md) hook, before it escapes.

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
