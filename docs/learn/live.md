---
title: Live updates
description: Keep any query open with live true, and receive what changed as patches, whoever changed it.
---

# Live updates

Any query becomes a subscription when you add `live: true`. The server sends the first result, keeps the query open,
and sends what changed whenever a command touches the data it read. There is no subscription type to write, no event
wiring on the server, and no refetching on the client.

## Ask for it

::: code-group

<<< @/../examples/typescript/src/client.ts#live{ts} [TypeScript]

<<< @/../examples/react/src/App.tsx#live{tsx} [React]

```http [HTTP]
POST /rayfold
Content-Type: application/rayfold+json

{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock }","live":true}]}
```

:::

## What comes back

The first frame is the normal result, but without `fin`: the operation stays open.

```json
{"id":1,"data":{"$type":"Book","title":"A Wizard of Earthsea","stock":3},"meta":{"cost":1}}
```

A member of staff restocks the book with five copies. The server sends only the change:

```json
{"id":1,"patch":[{"at":"","value":{"stock":8}}]}
```

When the client stops listening, the operation ends:

```json
{"id":1,"error":{"code":"canceled","message":"Canceled"},"fin":true}
```

| Frame | When |
|---|---|
| `data` without `fin` | the first result, and whenever a change cannot be described as a patch, such as rows in a new order |
| `patch` | the change can be described: `set` for entities whose fields changed, `at` and `list` for parts of the result |
| `error` with `fin` | the client cancelled, or running the query again failed, for example because the viewer lost access |

A change that leaves the result as it was sends nothing.

## How the server knows

You do not tell the server what to watch. Every command's patch goes onto the server's change bus. Each live query
remembers the entities its last result contained and the types it can reach; when a change touches one of them, the
server runs the query again with the same arguments, shape and viewer, and sends the difference. Changes that arrive
while it runs are folded into one more run.

That makes live queries correct by default: the same policies apply to every update as to the first result, and a
query can never show a field its viewer may not read. A server can also put changes from elsewhere, such as rows
written by another system, onto the same bus.

Because every change re-runs the query, some queries are a poor fit — a search whose results depend on a keyword
rather than on any one entity would re-run on every write to a type it can reach, and pay for it. Mark such a query
`@live(false)` and the server refuses to open it live:

```rayfold
query search(q: String, page: PageArgs = { first: 20 }): Page<SearchHit> @live(false)
```

A client asking for it with `live: true` is refused with `invalid_argument`, and the whole batch is refused before it
runs; the same query still answers normally without `live`.

The bus belongs to one server. Behind a load balancer that is silently wrong: a command that runs on the second
server never reaches a live query held by the first, and the screen sits there showing stale data with no error to
say so. Give every server the same `relay` and the changes cross between them — `MemoryRelay` for servers sharing a
process, `PgRelay` over Postgres `LISTEN`/`NOTIFY` for separate ones ([Deployment](../guide/deployment.md)).

## On the client

The client applies `patch` frames to its cache exactly as it applies a command's patch. Every other query showing
that book updates too, not only the live one. In React, only the components showing the changed data render again.

## Connections

- Over HTTP, a live query is a response that stays open. The TypeScript server sends an empty line when nothing has
  happened for 15 seconds (`keepAliveMs`), so proxies do not close an idle connection.
- A live op gets no cache headers. Sent as a safe request (`Rayfold-Safe: true`, `GET` or `QUERY`), it is streamed
  with `Cache-Control: no-store`, like a plain `POST`. Servers up to 0.2.1 buffered a safe request whole, so a live op
  sent that way never answered; the clients send live ops as plain `POST`s, which works with every version.
- To share one connection between many live queries, give the TypeScript client
  `createWebSocketTransport({ url: "wss://example.com/rayfold/ws" })`. On the server, attach the endpoint to the same
  Node HTTP server your batch endpoint runs on:

  ```ts
  import { attachWebSocket } from "@rayfold/server";

  const http = createServer(handler);
  attachWebSocket(http, server, { viewer, allowedOrigins: ["https://app.example.com"] });
  http.listen(4000);
  ```

  It serves `/rayfold/ws` by default, speaks the `rayfold.0.1` subprotocol, and checks the handshake's `Origin` —
  browsers attach cookies to a WebSocket handshake, so without that check any site could open a socket as your user.
  `maxMessage` bounds an assembled message (1 MiB by default). One socket carries many operations, and
  `{ "cancel": <id> }` cancels one of them without closing it. On the JVM, `RayfoldWebSocket` does the same job.
- A dropped connection is not the end of the subscription. Both clients reopen it after half a second, doubling to
  thirty, so a screen survives a deploy; `onError` says whether it is coming back (`{ retrying }` in TypeScript, the
  second argument in Kotlin), and only an error that would recur ends it.
- Reopening re-runs the query, so what comes back is the current answer rather than the changes you missed. The
  guarantee is that the screen catches up, not that you see every step it took to get there: a value that changed and
  changed back while you were away leaves no trace. If you need the steps, [an event stream](./streams.md) is the
  right shape for it, not a live query.
- Stop by calling the function `live` returned, by unmounting the component, or by aborting the request.

## Next

- Commands are what live queries react to: [Commands and errors](./commands.md).
- Every step rather than the current answer: [Streams and events](./streams.md).
- Show a change before the server confirms it: [Offline and optimistic](../guide/offline.md).
- The [live chapter of the specification](../../spec/08-live-and-sync.md) describes change detection exactly.
