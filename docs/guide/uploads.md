# Uploads

A file arrives on a route of its own, and the command that uses it names what arrived:

```
POST /rayfold/uploads            →  201 { "id": "d9f1…", "size": 20481 }
POST /rayfold  { "ops": [{ "op": "setAvatar", "args": { "userId": "u1", "upload": "d9f1…" }, … }] }
```

Turn the route on by giving the server somewhere to put the bytes. Without a store there is no route at all:

```ts
import { listen, MemoryUploadStore } from "@rayfold/server";

const uploads = new MemoryUploadStore(); // for tests and one small server; see below for a real one
await listen(server, 4000, { viewer, uploads: { store: uploads, maxBytes: 8 * 1024 * 1024 } });
```

The command reads it, uses it, and drops it:

```ts
import { ok, RayfoldError } from "@rayfold/server";

const resolvers = {
  Command: {
    setAvatar: async ({ userId, upload }: { userId: string; upload: string }) => {
      const kept = await uploads.open(upload);
      if (!kept) throw new RayfoldError("not_found", "That upload is gone");
      await storeAvatarFor(userId, kept.body); // a stream: write it on, do not hold it
      await uploads.delete(upload);
      return ok({ id: userId });
    },
  },
};
```

From a browser, the client sends it for you:

```ts
const kept = await client.upload(file); // a File says its own name and type
await client.command("setAvatar", { userId, upload: kept.id });
```

`client.upload()` sends whatever `fetch` takes as a body — a `File`, a `Blob`, bytes, or a stream — through the fetch
transport, with the same headers it puts on every other request, so whatever authorises a request authorises an upload
too. It is the fetch transport that carries uploads: a client built on the WebSocket transport answers
`unimplemented`, because bytes this size do not belong in a frame. Pass `{ name, type }`
to say something other than what the file claims, and a `signal` to abort it. A refusal arrives as a
`RayfoldClientError` with the server's code (`resource_exhausted` for one over the bound, `unauthenticated` with no
viewer), so the caller reads it like any other error. Nothing is cached: the bytes go one way, and the command that
names them is what changes anything.

## Why a route rather than a multipart batch

GraphQL's upload convention posts `multipart/form-data` to the one endpoint. Rayfold does not, for a reason worth
knowing: a browser may send `multipart/form-data`, `text/plain` and `application/x-www-form-urlencoded` to **any**
origin without a preflight. The batch endpoint accepts JSON media types only for exactly that reason
([spec 12 §2.1](../../spec/12-security.md)) — it is half of what stops a foreign page writing to your API.
`application/octet-stream` is not on that list either, so the upload route keeps the same protection, and the Origin
rule applies to it as to any write.

The other half is cost: base64 in a JSON argument is a third larger than the bytes and has to be held whole at both
ends. A body that is just the bytes is neither.

## What the server enforces

| | |
|---|---|
| Size | `maxBytes` (default 25 MiB), counted **as the bytes arrive** — a `Content-Length` that understates the body does not get past it |
| Who | an identified viewer, unless you set `viewerRequired: false`; an open upload route is a way to fill your storage with nothing to trace it to |
| Where from | the Origin rule, as for any write |
| In what form | `application/octet-stream` only |
| How long | the store's lifetime (`MemoryUploadStore`: an hour), and its bound (256 MiB), oldest first |

`name` and `type` are what the client said they are. Rayfold never treats `name` as a path, and neither should you;
check the type yourself where it matters rather than believing the header.

## A store that writes them down

`MemoryUploadStore` holds bytes in the process, which suits tests and a single small server. Anything that can keep
bytes is three methods:

```ts
interface UploadStore {
  put(body: ReadableStream<Uint8Array>, meta: { name?: string; type?: string; viewer?: unknown }): Promise<Upload>;
  open(id: string): Promise<{ upload: Upload; body: ReadableStream<Uint8Array> } | undefined>;
  delete(id: string): Promise<void>;
}
```

For a fleet, the store has to be shared the way the idempotency records are ([Deployment](deployment.md)): an upload
that landed on one server is named by a command that may run on another. `PgUploadStore` keeps them in Postgres, in
the same table the JVM's `JdbcUploadStore` creates, so a mixed fleet shares one:

```ts
import { PgUploadStore } from "@rayfold/postgres";

const uploads = new PgUploadStore(pool); // ttlMs, maxBytes and table are yours to set
await uploads.migrate(); // safe from every server at once
await listen(server, 4000, { viewer, uploads: { store: uploads } });
```

Bytes live in a row, which is the simplest thing that works at the sizes this extension is for. Beyond them, the
answer below is better than a bigger table.

## On the JVM

The same route, the same bounds, the same store interface. Give the HTTP server an `UploadOptions` and it appears;
leave it out and there is no route:

::: code-group

```kotlin [Kotlin]
val uploads = MemoryUploadStore() // or JdbcUploadStore(dataSource::getConnection) for a fleet
val http = RayfoldHttp(server, HttpOptions(uploads = UploadOptions(uploads))) { viewerFrom(it) }.start(4000)
```

```java [Java]
var uploads = new MemoryUploadStore();
HttpServer http = Rayfold.http(server)
    .viewer(exchange -> userOf(exchange))
    .uploads(uploads)
    .start(4000);
```

```kotlin [Spring Boot]
// an UploadStore bean is all it takes: the starter finds it and serves the route
@Bean fun uploads(dataSource: DataSource): UploadStore = JdbcUploadStore(dataSource::getConnection)
```

:::

A resolver reads it with `store.open(id)` and drops it with `store.delete(id)`, as on Node. The Kotlin client has no
`upload()` of its own yet: post the bytes to `{path}/uploads` yourself with whatever HTTP client you already use, and
name the returned id in the command.

## When not to use this

For files measured in hundreds of megabytes, do not send them through your API at all. Have a command answer with a
URL from your own storage and let the client upload there:

```rayfold
command avatarUploadUrl(userId: ID): UploadTicket
```

That costs the protocol nothing, keeps the bytes off your servers, and is what object storage is for. This extension
is for the sizes where a round trip through the API is simply the easier thing.
