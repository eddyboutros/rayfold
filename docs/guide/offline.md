# Offline and optimistic updates

A screen should not wait for the server to show what the user just did, and an app that loses its connection should
not lose what the user did meanwhile. The Rayfold clients do both (sub-profile `sync`, [spec 08 §5](../../spec/08-live-and-sync.md)):

- **Optimistic commands.** A command can carry the change it is expected to make. The client shows it in the cache at
  once, so every watch and live query on those entities updates immediately. When the server answers, its own patch
  replaces the prediction; when the command fails, the prediction is rolled back.
- **The offline queue.** A command made while the server cannot be reached waits, with its prediction still shown,
  and goes out when the connection is back: in the order the commands were made, each with its idempotency key. The
  key is what makes the resend safe. If the server ran the command before its answer was lost, the retry gets the
  recorded answer; the command does not run twice.

## TypeScript and React

```ts
import { RayfoldClient, createFetchTransport, localStorageQueue } from "@rayfold/client";

const client = new RayfoldClient({
  transport: createFetchTransport({ url: "/rayfold" }),
  offline: { storage: localStorageQueue("orders") }, // survives a reload; memoryQueue() is the default
});

await client.command("placeOrder", { input: { lines: [{ bookId: "b1", qty: 1 }] } }, {
  shape: "{ id status }",
  // what the order will do to the stock, shown at once
  optimistic: (cache) => [{ set: "Book:b1", value: { stock: (cache.get("Book:b1")?.stock as number) - 1 } }],
});
```

- The queue drains by itself: when the client starts with commands a reload brought back, on the browser's `online`
  event, and when a new command is made while others wait (it goes out behind them), which is what brings the queue
  back after a server outage that never took the network down. Call `client.drain()` yourself after your own
  reconnect logic; it resolves to how many commands still wait. `offline: { drainOnReconnect: false }` turns the
  automatic drains off and leaves every send of the queue to `client.drain()`.
- `client.queued` lists the waiting commands; `client.onQueue(fn)` reports each one queued, sent, or refused
  (`failed`, with the server's error), which is what a "3 changes waiting" banner needs.
- A queued command's promise settles when it finally goes out. After a reload the caller is gone, so follow
  `onQueue` for those.
- In React, `useCommand` takes the same `optimistic` option:
  `const [buy] = useCommand("placeOrder", { optimistic: (cache) => [...] })`.

## Kotlin and Android

```kotlin
val client = RayfoldClient(
    OkHttpWebSocketTransport("wss://api.example/rayfold/ws"),
    ClientOptions(offline = OfflineOptions(FileQueueStorage(File(context.filesDir, "rayfold-queue.json")))),
)

client.command(
    "placeOrder",
    args("input" to mapOf("lines" to listOf(mapOf("bookId" to "b1", "qty" to 1)))),
    shape = "{ id status }",
    optimistic = listOf(OptimisticOp("Book:b1", buildJsonObject { put("stock", stock - 1) })),
)
```

A new command made while others wait sends the queue first and then itself. The client has no network events of its
own, so call `client.drain()` when the app starts, to send a queue restored from the file before the next command, and
when the device is back online, for example from a `ConnectivityManager.NetworkCallback`. Follow `client.onQueue { }`
for the banner. `FileQueueStorage` replaces its file atomically, so a queue survives the
app being killed. `command` suspends until a queued command has gone out, so launch it in a scope that outlives the
screen when the user may leave it.

## What counts as unreachable

A transport failure (fetch's `TypeError`, an `IOException` on the JVM) or an `unavailable` error from the server. Any
other error, such as a permission denial or a domain error like `OutOfStock`, is the server's answer: the command
leaves the queue, its prediction is rolled back, and the error reaches the caller.

## When a prediction and the server disagree

A prediction stands until its command settles. If the server changes the same field while the command is still in
flight, the field decides what happens, by declaring a policy in the schema:

```
entity Doc {
  id: ID
  title: String @merge(serverWins)
  notes: String
}
```

`serverWins` (and `lww`, which settles the same way: the server's write is the later one) drops the predicted value
the moment the server speaks for that field, so the screen shows the truth immediately. `keepLocal`, and a field with
no annotation, keep the prediction until the command settles and the server's answer replaces it.

A client picks this up on its own, as long as it was given the schema:

```ts
const client = new RayfoldClient({ transport, schema });
```

The Kotlin client takes the policies rather than the schema, which keeps it free of the schema types — a
`rayfold-core` server can produce the map from its IR:

```kotlin
val client = RayfoldClient(transport, ClientOptions(mergePolicies = mapOf("Doc.title" to "serverWins")))
```

`@merge(crdtText)` and `@merge(custom)` are declared in the specification but not implemented here. A client refuses
to predict such a field, with a message naming it, rather than merge it wrongly.

## Limits

- A prediction sets fields of entities; it does not add an entity to a list or remove one.
- Commands are ordered by when they were made. A command made while an earlier one is still on its way is not held
  back for it: when the network drops, both queue in order, but a command that reaches the server may overtake one that
  did not.
- Sync sessions (resuming a set of live queries from a server cursor) are still a draft in spec 08 and not
  implemented.
