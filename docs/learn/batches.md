---
title: Several steps, one request
description: Send queries and commands together in one batch, feed one step's result into the next with $ref, and know what happens when a step fails.
---

# Several steps, one request

Every Rayfold request is a batch: a list of operations sent together. A screen that needs three reads makes one round
trip, and a step can use what an earlier step returned, so "buy a copy, then show the book with its author" is one
request too. This page covers references, failures, the order steps run in and the limits, then how the clients
build a batch.

## A batch

```json
{
  "rayfold": "0.1",
  "ops": [
    { "id": 1, "op": "buy", "args": { "bookId": "b3", "qty": 2 }, "key": "7f3c9a2e4b1d4c6f", "shape": "{ id }" },
    { "id": 2, "op": "book", "args": { "id": { "$ref": "1.id" } }, "shape": "{ title stock author { name } }" }
  ]
}
```

Each op has an `id`, a positive integer unique in the batch, and each frame of the response carries the id of the op
it answers. Commands carry an idempotency `key` as always ([Commands and errors](./commands.md#safe-to-retry)). Sent
with a customer's access token, the answer is:

```json
{"id":1,"ok":{"$type":"Book","id":"b3"},"patch":[{"set":"Book:b3","value":{"$type":"Book","id":"b3"}}],"meta":{"cost":1},"fin":true}
{"id":2,"data":{"$type":"Book","title":"Dune","stock":5,"author":{"$type":"Author","name":"Frank Herbert"}},"meta":{"cost":2},"fin":true}
```

## Use an earlier result

`{ "$ref": "<id>.<path>" }` can stand in for any value in `args`. The server replaces it with the value at that path
in the result of op `<id>`: `data` for a query, `ok` for a command. Paths use dots, and list positions are numbers,
as in `1.items.0.id`.

Queries can depend on queries. This batch reads the first two pages of books, the second starting at the cursor the
first returned:

```json
{ "id": 1, "op": "books", "args": { "page": { "first": 2 } }, "shape": "{ items { title } cursor }" }
{ "id": 2, "op": "books", "args": { "page": { "first": 2, "after": { "$ref": "1.cursor" } } }, "shape": "{ items { title } cursor }" }
```

```json
{"id":1,"data":{"items":[{"$type":"Book","title":"A Wizard of Earthsea"},{"$type":"Book","title":"The Left Hand of Darkness"}],"cursor":"b2"},"meta":{"cost":4},"fin":true}
{"id":2,"data":{"items":[{"$type":"Book","title":"Dune"}],"cursor":"b3"},"meta":{"cost":4},"fin":true}
```

The path reads the result as the op's shape made it, so the shape must include the field. A path that finds nothing
fails that op:

```json
{"id":2,"error":{"code":"invalid_argument","message":"ops.2.args.id: $ref 1.items.5.id resolved to nothing"},"fin":true}
```

A reference can only point to an op with a smaller id. Anything else refuses the whole batch before it starts, with a
frame that has no `id`. A WebSocket carries many batches, so there the same error goes to each op id the batch named
instead:

```json
{"error":{"code":"invalid_argument","message":"ops[0].args: $ref to op 2 must point to an earlier op"},"fin":true}
```

## When a step fails

An op whose reference failed does not run. It ends with
[`failed_precondition`](/errors/failed_precondition) and the type `DependencyFailed`, naming the op it waited for.
Ops that do not depend on the failure run as usual. Here a customer tries to buy five copies of a book with three
left:

```json
{ "id": 1, "op": "buy", "args": { "bookId": "b1", "qty": 5 }, "key": "0b8e6d1f2a3c4e5f", "shape": "{ id }" }
{ "id": 2, "op": "book", "args": { "id": { "$ref": "1.id" } }, "shape": "{ title stock }" }
{ "id": 3, "op": "book", "args": { "id": "b1" }, "shape": "{ title stock }" }
```

```json
{"id":1,"error":{"code":"domain","message":"Only 3 left","type":"OutOfStock","data":{"bookId":"b1","available":3}},"fin":true}
{"id":3,"data":{"$type":"Book","title":"A Wizard of Earthsea","stock":3},"meta":{"cost":1},"fin":true}
{"id":2,"error":{"code":"failed_precondition","message":"Depends on op 1, which failed","type":"DependencyFailed","data":{"op":1}},"fin":true}
```

Frames of different ops arrive in whatever order the ops finish, so match them by `id`. A batch is not a transaction:
when a step fails, the steps that already succeeded stay done.

## The order steps run in

- **Commands run one at a time, in ascending id order.** Each starts after the previous command finished, whether it
  succeeded or failed. A staff batch that restocks two copies of an empty book and then buys two ends with `"stock":2`
  from op 1 and `"stock":0` from op 2, every time.
- **A query runs as soon as the ops it references have finished.** A query that references nothing starts right away,
  next to everything else, even when a command comes before it in the list. In a batch of `buy` (op 1) and `book`
  without a reference (op 2), the frame for op 2 arrived first.

To read what a command changed, reference the command, as `book` does with `1.id` in the first example.

## Limits

| Limit | Default | When exceeded |
|---|---|---|
| Ops per batch | 50 | `{"error":{"code":"resource_exhausted","message":"At most 50 ops per batch"},"fin":true}` |
| Cost of the whole batch | 1000 | `resource_exhausted`, such as `Batch cost 4 exceeds budget 3` |
| Shape depth | 8 | `resource_exhausted` before the op runs |
| Fields one shape selects | 500 | `resource_exhausted` before the op runs |
| Items one stream may yield | 10000 | `resource_exhausted`, and the stream ends |
| Request body over HTTP | 1 MiB | `413` before anything runs |

The batch limits are refused before any op runs, and all of them are server options:

```ts
const server = createRayfoldServer({
  schema,
  resolvers: resolvers(seed()),
  maxOps: 100,
  budget: 2000,
  maxDepth: 10,
  maxFields: 800,
  maxStreamItems: 50_000,
});
```

The JVM has two more of its own: `maxFrames` bounds the frames one batch's resolvers may produce (a live query's
later frames do not count), and `maxInlineShapes` how many shapes learned from requests are remembered.

`maxStreamItems` on the TypeScript server arrived in 0.2.0; the JVM has always had it. On 0.1.0 a TypeScript stream
is bounded only by the batch's cost.

`GET /rayfold/manifest` publishes the batch limits, so a client can check before it sends:
`"limits":{"budget":1000,"maxOps":50,"maxDepth":8,"maxFields":500,"trustedShapes":false}`.

## Deadlines

A caller can say how long it is willing to wait, and the server stops rather than finishing work nobody is waiting
for. Send `meta.deadline` on the envelope, or per operation, in milliseconds:

```json
{ "meta": { "deadline": 2000 }, "ops": [{ "id": 1, "op": "books", "args": {} }] }
```

Over HTTP the `Rayfold-Deadline` header does the same. An operation's own `deadline` counts from the start of the
batch, as `meta.deadline` does, so time it spends waiting for an earlier operation counts too. An operation that runs
out ends with `deadline_exceeded`. A command that had already committed records that fact, so a retry is answered
with what happened rather than running the command a second time — see [Safe to retry](./commands.md#safe-to-retry).

## Build a batch in the client

`client.batch()` collects ops; each call returns a handle, and `handle.ref(path)` makes the `$ref` for a later op.
Nothing is sent until `run()`:

::: code-group

```ts [TypeScript]
const batch = client.batch();
const bought = batch.command<Book>("buy", { bookId: "b3", qty: 2 }, { shape: "{ id }" });
const book = batch.query<Book>("book", { id: bought.ref("id") }, { shape: "{ title stock author { name } }" });
await batch.run();

const { title, stock } = await book.promise;
console.log(`${title}: ${stock} left`); // Dune: 5 left
```

```kotlin [Kotlin]
val batch = client.batch()
val bought = batch.command("buy", args("bookId" to "b3", "qty" to 2), shape = "{ id }")
val book = batch.query("book", args("id" to bought.ref("id")), shape = "{ title stock author { name } }")
batch.run()

println(book.await())
```

:::

The TypeScript client sends this envelope, numbering the ops in the order you added them and giving the command a key:

```json
{"rayfold":"0.1","ops":[{"id":1,"op":"buy","args":{"bookId":"b3","qty":2},"shape":"{ id }","key":"3f65538b6eca497786ca7e42df2f9f4f"},{"id":2,"op":"book","args":{"id":{"$ref":"1.id"}},"shape":"{ title stock author { name } }"}]}
```

Results go into the client cache as they do for single calls. `run()` resolves once the response ends, with every
frame in `frames`. It does not reject when an op fails: each handle settles on its own, with its result or a
`RayfoldClientError` (`RayfoldClientException` in Kotlin):

::: code-group

```ts [TypeScript]
const batch = client.batch();
const bought = batch.command<Book>("buy", { bookId: "b1", qty: 5 }, { shape: "{ id }" });
const book = batch.query<Book>("book", { id: bought.ref("id") }, { shape: "{ title stock }" });
await batch.run();

try {
  await book.promise;
} catch (e) {
  if (e instanceof RayfoldClientError && e.type === "DependencyFailed") console.log(e.message); // Depends on op 1, which failed
}
```

```kotlin [Kotlin]
val batch = client.batch()
val bought = batch.command("buy", args("bookId" to "b1", "qty" to 5), shape = "{ id }")
val book = batch.query("book", args("id" to bought.ref("id")), shape = "{ title stock }")
batch.run()

try { book.await() }
catch (e: RayfoldClientException) { if (e.type == "DependencyFailed") println(e.message) }
```

:::

`bought` rejects with `OutOfStock` and its data, as a single `command` call would. When the whole batch is refused,
such as for a forward reference, every handle rejects with that error.

## Next

- Keys, retries and declared errors: [Commands and errors](./commands.md).
- A batch of queries as one cacheable request: [Caching](./caching.md).
- The rules in full: [spec 03, Batches and pipelining](../../spec/03-batch-and-pipelining.md).
