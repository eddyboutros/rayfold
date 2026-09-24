---
title: The binary format
description: Carry the same frames in about half the bytes with RB, and choose it per request.
---

# The binary format

RB, short for Rayfold Binary, is a second encoding of the frames you have seen as JSON. It changes the bytes on the
wire, not what they mean: the same request gives the same frames, and a client picks JSON or RB for each request. This
page explains what makes RB smaller, when it is worth it, how client and server agree on it, and what it saves on the
bookshop.

## What RB is

- **Keys from the schema.** Both sides number the protocol's own keys (`id`, `data`, `fin`, `$type` and the rest),
  then every field, argument, enum value and operation name in the schema, sorted. A key like `title` goes on the
  wire as a small number.
- **Strings written once.** Each message keeps a string table. The second time `"Book"` or an author's name appears,
  RB writes a reference to the first.
- **Short numbers.** Integers take as few bytes as they need; 0 to 127 take one.
- **Length-prefixed frames.** Each frame starts with its length, so a streamed response or a live query decodes frame
  by frame as the bytes arrive.

The byte layout is in [spec 09](../../spec/09-binary-format.md).

## When to use it

Use RB when payload size matters: phones on slow networks, long lists, a steady flow of live updates. Keep JSON where
people read the traffic, such as curl, the explorer and logs, and for callers without a copy of the schema, such as
scripts and AI agents. One server answers both at the same time, so you can move one client over and compare.

## How client and server agree

Over HTTP, two headers decide, independently of each other:

| Header | Value | Meaning |
|---|---|---|
| `Content-Type` | `application/rayfold` | the request body is RB |
| `Content-Type` | `application/rayfold+json` | the request body is JSON |
| `Accept` | `application/rayfold` | answer with RB frames |
| `Accept` | `application/json`, one op that ends in one frame | answer with that frame as a single JSON document, the HTTP status derived from its error code |
| `Accept` | anything else | answer with JSON frames, one per line |

A JSON body sent with `Accept: application/rayfold` gets an RB answer. An `Accept` that lists RB and a JSON type as
well gets JSON. Here is `book` for `b1` with its author, both ways RB:

```http
POST /rayfold
Content-Type: application/rayfold
Accept: application/rayfold
Rayfold-Safe: true

(64 bytes)

HTTP/1.1 200 OK
Content-Type: application/rayfold

(79 bytes)
```

The same request as JSON is 107 bytes up and 158 bytes down. Decoded, both answers are this frame:

```json
{"id":1,"data":{"$type":"Book","title":"A Wizard of Earthsea","stock":3,"author":{"$type":"Author","name":"Ursula K. Le Guin"}},"meta":{"cost":2},"fin":true}
```

Over WebSocket, text messages are JSON and binary messages are RB, and one socket can carry both.

A server lists `rb` among its extensions in `GET /rayfold/manifest` (`"extensions":["live","rb"]`), next to the schema
a client needs to build the key numbers. That schema leaves out how access policies decide, which RB does not need:
it encodes exactly like the server's own copy.

## Turn it on

The codec is `@rayfold/rb` on npm, and `dev.rayfold:rayfold-core` carries the JVM one. You rarely use it directly —
the client and server negotiate it for you — but it is a package you can depend on if you are writing a client of
your own.

## TypeScript

Load the manifest, then give it to the transport:

```ts
import { RayfoldClient, createFetchTransport } from "@rayfold/client";
import { accessToken } from "./session.ts"; // the signed-in user's token, from your identity provider

const url = "http://localhost:4000/rayfold";
const manifest = await (await fetch(`${url}/manifest`)).json();

const client = new RayfoldClient({
  transport: createFetchTransport({ url, binary: manifest, headers: async () => ({ authorization: `Bearer ${await accessToken()}` }) }),
  schema: manifest.schema,
});

const book = await client.query<Book>("book", { id: "b1" }, { shape: "{ title stock author { name } }" });
```

- `binary: manifest` on the transport sends and reads RB. It takes the whole manifest, schema and `schemaHash`, so it
  can check that the server still holds that schema before it trusts the key numbers (see
  [Keep the schema in step](#keep-the-schema-in-step)).
- `schema` on the client asks for compact frames: the server leaves out `$type` wherever the schema already fixes it,
  and the client puts it back. It works with JSON too, and the savings add up.

Queries and commands return the same values as over JSON. A WebSocket transport takes the schema too:
`createWebSocketTransport({ url: "ws://localhost:4000/rayfold/ws", binary: manifest })`. The bookshop example
serves HTTP only; `attachWebSocket(http, server)` from `@rayfold/server` adds the socket.

## Kotlin

The Kotlin client sends JSON. Its `HttpTransport` and WebSocket transports have no RB option yet, so there is nothing
to turn on. The Kotlin server in `rayfold-core` answers RB over HTTP and WebSocket like the TypeScript server does, so
a TypeScript or browser client can use RB against it.

## Keep the schema in step

The key numbers come from the schema, and adding one name moves the numbers of every name sorted after it, so client
and server must hold the same schema. Every response carries the server's schema hash in the `Rayfold-Schema` header,
and the manifest has the same hash as `schemaHash`. The HTTP transport compares them:

- It sends JSON until a response shows that the server's hash is the manifest's, then switches to RB. The first
  request of a new transport always goes as JSON.
- When a response reports another hash, as after a deploy, the requests after it go as JSON again. Load the manifest
  again and create a new transport to use RB.
- An RB answer that arrives with another hash is not decoded, because its key numbers would give fields the wrong
  names. The request fails with [`unavailable`](/errors/unavailable), which is safe to retry, and the retry goes as
  JSON.

A bare schema IR works in place of the manifest when it is the server's full schema. The manifest's `schema` alone
does not: it leaves out how policies decide, so it hashes differently, and the transport would stay on JSON.

A socket has no header per answer, so the WebSocket transport names the manifest's hash when it connects. A server
holding another schema closes the socket with code `4409` before anything is decoded: the batches sent on it fail with
[`unavailable`](/errors/unavailable), and every socket the transport opens after that speaks JSON. Load the manifest
again and create a new transport to use RB.

## What it saves

On the bookshop over loopback, counting the bytes of the HTTP bodies:

| Request | Direction | JSON | JSON, compact | RB | RB, compact |
|---|---|---:|---:|---:|---:|
| `book` b1 `{ title stock author { name } }` | up | 107 | 122 | 64 | 73 |
| | down | 158 | 108 | 79 | 58 |
| `books` first 20 `{ items { id title stock author { name } } total hasMore cursor }` | up | 152 | 167 | 99 | 108 |
| | down | 452 | 337 | 187 | 154 |

Compact requests are a few bytes larger going up, because each op says `"compact": true`. The bookshop has three
books; the gap grows with the result.

The repository's benchmark, `npm run bench`, runs three flows against a store of 36 books, with compact frames. Bytes
down:

| Flow | GraphQL | Rayfold, JSON | Rayfold, RB |
|---|---:|---:|---:|
| Book page: a book, its author and 3 reviews | 282 | 302 | 177 |
| List: 20 books with author names | 2074 | 2083 | 1080 |
| Place an order and read it back with stock | 157 | 220 | 101 |

## Next

- Where RB saves on every change: [Live updates](./live.md).
- Round trips, latency and the other flows: [Comparison](../comparison.md).
- The byte layout: [spec 09, Binary format](../../spec/09-binary-format.md).
