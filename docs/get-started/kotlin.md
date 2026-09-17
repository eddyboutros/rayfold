---
title: Kotlin
description: A Rayfold server and client in Kotlin on the JVM, step by step.
---

<StackNav current="kotlin" />

# Get started with Kotlin

A bookshop server with four operations, and a client that reads a book, watches it and buys a copy. The client
library also runs on Android. The finished project is [examples/kotlin](../../examples/kotlin). You need JDK 21.

## 1. Create the project

A Kotlin JVM project with Gradle's `application` plugin. Add the Rayfold server and client:

<<< @/../examples/kotlin/build.gradle.kts#deps{kotlin}

## 2. Describe the API

Save the schema as `src/main/resources/bookshop.rayfold`, so it ships inside the jar:

<<< @/../examples/kotlin/src/main/resources/bookshop.rayfold

The server reads this file when it starts and checks every request against it. `npx rayfold check` validates it
from the command line, and `npx rayfold gen kotlin` generates data classes from it if you want them.

## 3. Write the resolvers

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Server.kt#resolvers{kotlin}

- `queries` and `commands` have one function per operation, named as in the schema. Arguments arrive as JSON already
  checked against the schema, `@range` included, which is why the helpers can read them without checks.
- The `author` loader in `fields` receives every book in the result at once and returns their authors in the same
  order. A page of 50 books looks up authors once.
- `RayfoldException.domain("OutOfStock", ...)` is the error the schema declared. Clients receive it by name, with
  its data.
- A command returns the book it changed, which becomes a patch for every client cache, and the `StockChanged` event
  the schema says it emits.

## 4. Say who is calling

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Server.kt#auth{kotlin}

What this returns is `viewer` in the schema's `@allow` rules. The resolvers never check permissions themselves.

## 5. Start the server

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Server.kt#server{kotlin}

```sh
./gradlew run
```

Open http://localhost:4000/rayfold/explorer to browse the operations and send requests; type `customer` or `staff` in
the auth field to try the commands, as the explorer adds the `Bearer` itself. Or call it with curl:

```sh
curl -s localhost:4000/rayfold -H 'content-type: application/rayfold+json' -H 'rayfold-safe: true' \
  -d '{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock author { name } }"}]}'
```

## 6. Call it from Kotlin

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Client.kt#client{kotlin}

`watch` is a flow of the book as the client's cache holds it. The purchase comes back with a patch for `Book:b1`, the
cache applies it, and the flow emits the new stock without a second request.

```sh
./gradlew runClient
```

On Android, the same client works with an OkHttp transport; see [Kotlin and Android](../guide/kotlin.md).

## Next

- A web UI for the same server: [React](./react.md). Any Rayfold client works with any Rayfold server.
- How shapes, loaders and pages work: [Queries and shapes](../learn/queries.md).
- More of the Kotlin API, including live queries and WebSocket: the [Kotlin guide](../guide/kotlin.md).
