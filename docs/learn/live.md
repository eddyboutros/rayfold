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
- A live op cannot be a safe request: `Rayfold-Safe: true` (and `GET`, and `QUERY`) makes the server buffer the whole
  answer so it can compute cache headers for it, which is the opposite of staying open. Send live ops over a plain
  `POST` or the WebSocket transport.
- To share one connection between many live queries, give the TypeScript client
  `createWebSocketTransport({ url: "wss://example.com/rayfold/ws" })`.
- A dropped connection is not the end of the subscription. The TypeScript client reopens it after half a second,
  doubling to thirty, so a screen survives a deploy; `onError(e, { retrying })` says whether it is coming back, and
  only an error that would recur ends it. The Kotlin client does not retry yet: reopen it yourself.
- Stop by calling the function `live` returned, by unmounting the component, or by aborting the request.

## Next

- Commands are what live queries react to: [Commands and errors](./commands.md).
- Show a change before the server confirms it: [Offline and optimistic](../guide/offline.md).
- The [live chapter of the specification](../../spec/08-live-and-sync.md) describes change detection exactly.
