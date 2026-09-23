---
title: Streams and events
description: A stream sends items as they happen. Commands emit events, streams carry them, and the client reads them as an async iterable.
---

# Streams and events

A [live query](./live.md) keeps a screen current: it re-runs and tells you what the answer is *now*. A **stream** is
the other shape — it carries each thing that happened, in order, as it happens. A live query of a book's stock says
"the stock is 7"; a stream of stock changes says "it went 5, then 6, then 7".

Use a stream when the steps matter: an activity feed, a progress log, a ticker, anything where a value that changed
and changed back is two events and not a no-op. Use a live query when only the current answer matters. A live query
that reconnects re-runs and catches up, so it never owes you the steps it missed.

## Declare the event, then the stream

An `event` is a type like any other, and a command declares which events it may publish with `emits`:

```rayfold
event StockChanged { bookId: ID, stock: Int }

command restock(bookId: ID, qty: Int): Book
  emits StockChanged
  @allow(write: viewer.role == "staff")
  @simulate

stream stockUpdates(bookIds: [ID]): StockChanged
```

`emits` is enforced, not documentation: a command that publishes an event it did not declare fails with `internal`
rather than sending it. So the schema is the whole list of what can reach a client, and a reader can see which
commands feed which streams without reading a resolver.

A `stream` returns the event type. It is the third operation kind beside `query` and `command`, and it takes
arguments the same way — `bookIds` here is the filter, so a screen watching three books does not receive every
change in the shop.

## Emit from the command

A command returns its result and, beside it, what it wants published:

```ts
restock: (args: { bookId: string; qty: number }, ctx) => {
  const b = store.books.get(args.bookId);
  if (!b) throw new RayfoldError("not_found", `Book ${args.bookId} not found`);
  if (ctx.simulate) return { ...b, stock: b.stock + args.qty };
  b.stock += args.qty;
  return ok(b, { emit: [{ event: "StockChanged", payload: { bookId: b.id, stock: b.stock } }] });
},
```

The runtime never publishes the events or patches of a dry run (`@simulate`), so a simulation is visible to nobody
else; the `ctx.simulate` check is what keeps the resolver from writing.

## Resolve the stream

A stream resolver returns an async iterable. `ctx.events` is the server's event bus, and `ctx.signal` aborts when the
client goes away, so the subscription ends with the request:

```ts
stockUpdates: (args: { bookIds: string[] }, ctx) => {
  const wanted = new Set(args.bookIds);
  const source = ctx.events.subscribe<{ bookId: string; stock: number }>("StockChanged", ctx.signal);
  return (async function* () {
    for await (const ev of source) if (wanted.has(ev.bookId)) yield ev;
  })();
},
```

The bus belongs to one server, exactly as the change bus for live queries does. Behind a load balancer, give every
server the same `relay` so events cross between them ([Deployment](../guide/deployment.md)).

## Read it on the client

Each item arrives as its own frame, and the iterable ends when the server sends `fin` or you abort:

```ts
const ac = new AbortController();

for await (const ev of client.stream<{ bookId: string; stock: number }>(
  "stockUpdates",
  { bookIds: ["b1", "b2"] },
  { signal: ac.signal },
)) {
  console.log(ev.bookId, "is now", ev.stock);
}
```

Stop by aborting the signal; the loop returns rather than throwing, because a cancellation you asked for is not an
error. Anything else the server sends is thrown as a `RayfoldClientError` with its code.

In Kotlin it is a `Flow`:

```kotlin
client.stream("stockUpdates", args("bookIds" to listOf("b1", "b2"))).collect { println(it) }
```

## Where they run

A stream holds its response open, so it needs a transport that can stream: the HTTP endpoint answers with frames as
they happen, and a WebSocket carries many streams over one connection, with per-operation cancellation.

Items count against the batch's cost like anything else, and both runtimes bound how many items one stream may yield
(`maxStreamItems`; on the TypeScript server from 0.2.0). Give `ctx.signal` to whatever you subscribe to, as the
resolver above does: on a transport that cannot notice a client that went away, that signal is what ends the
subscription when the request ends.

## Next

- [Live updates](./live.md) — when you want the current answer rather than every step.
- [Commands and errors](./commands.md) — what a command returns, and what `@simulate` changes.
- [The live and sync chapter](../../spec/08-live-and-sync.md) of the specification.
