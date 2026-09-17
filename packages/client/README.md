# @rayfold/client

The Rayfold client for browsers and Node.js. It batches calls into one request, keeps a normalized cache that the
server's patches update after every command, and supports live queries over HTTP or WebSocket. No `node:` imports,
so it bundles for the browser as is.

```sh
npm install @rayfold/client
```

```ts
import { RayfoldClient, createFetchTransport } from "@rayfold/client";

interface Book { id: string; title: string; stock: number }

const client = new RayfoldClient({
  transport: createFetchTransport({
    url: "http://localhost:4000/rayfold",
    headers: () => ({ authorization: "Bearer demo" }),
  }),
});

const book = await client.query<Book>("book", { id: "b1" });

// watch() calls back whenever the cached result changes. The restock below changes it through the server's
// patch, with no second request for the book.
const stop = client.watch<Book>("book", { id: "b1" }, {}, (b) => console.log("stock", b.stock));
await client.command("restock", { id: "b1", qty: 5 });
stop();

// Several ops in one round trip; a later op can use an earlier op's result.
const batch = client.batch();
const restocked = batch.command<Book>("restock", { id: "b1", qty: 1 });
const reread = batch.query<Book>("book", { id: restocked.ref("id") });
await batch.run();
console.log(await reread.promise);
```

| API | What it does |
|---|---|
| `query(op, args, { shape })` | Runs a query. `shape` picks fields, e.g. `"{ id title author { name } }"`; without it the type's default view is used. |
| `command(op, args)` | Runs a command with an idempotency key, so a retry never runs it twice. Failures throw `RayfoldClientError`; `error.is("OutOfStock")` checks for a typed error. |
| `watch(op, args, options, fn)` | Calls `fn` now and whenever the cached result changes. Returns a stop function. |
| `live(op, args, options, fn, onError)` | A live query: the server pushes changes made by anyone. A dropped connection is reopened after a short wait, so the subscription outlives a deploy; `onError(e, { retrying })` says whether it is coming back. Returns a stop function. |
| `stream(op, args)` | An async iterable over a stream op. |
| `upload(body, { name, type })` | Sends a `File`, `Blob`, bytes or a stream to the server's upload route and answers with the handle a later command names. Needs a fetch transport; over a WebSocket it fails with `unimplemented`. |
| `createWebSocketTransport({ url })` | One socket for many batches, with per-op cancel. |

Pass `offline: { storage, drainOnReconnect }` and a command made while the server is unreachable is queued and
replayed in order once it is back, under its original idempotency key so it still runs once. `memoryQueue()` keeps
the queue for the life of the tab and `localStorageQueue()` across reloads.

For React, use `@rayfold/react`.

Apache-2.0.
