---
title: Kotlin
description: A Rayfold server and client in Kotlin on the JVM, step by step.
---

<StackNav current="kotlin" />

# Get started with Kotlin

A bookshop server with four operations, and a client that reads a book, watches it and buys a copy. The client
library also runs on Android. The finished project is [examples/kotlin](../../examples/kotlin). You need JDK 21.

## 1. Create the project

A Kotlin JVM project with Gradle's `application` plugin, the Rayfold server and client, and Nimbus to verify tokens.
`build.gradle.kts`, with a `runClient` task for step 6 and a `token` task for step 5:

<<< @/../examples/kotlin/build.gradle.kts{kotlin}

## 2. Describe the API

Save the schema as `src/main/resources/bookshop.rayfold`, so it ships inside the jar:

<<< @/../examples/kotlin/src/main/resources/bookshop.rayfold

The server reads this file when it starts and checks every request against it. `npx @rayfold/cli check` validates it
from the command line, and `npx @rayfold/cli gen kotlin` generates data classes from it if you want them.

## 3. Write the resolvers

The books live in memory, in `Store.kt`:

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Store.kt{kotlin}

`Server.kt` starts the server and holds one resolver per operation, with the small helpers they share at the bottom:

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Server.kt{kotlin}

- `queries` and `commands` have one function per operation, named as in the schema. Arguments arrive as JSON already
  checked against the schema, `@range` included, which is why the helpers can read them without checks.
- The `author` loader in `fields` receives every book in the result at once and returns their authors in the same
  order. A page of 50 books looks up authors once.
- `RayfoldException.domain("OutOfStock", ...)` is the error the schema declared. Clients receive it by name, with
  its data.
- A command returns the book it changed, which becomes a patch for every client cache, and the `StockChanged` event
  the schema says it emits.

## 4. Say who is calling

Your identity provider signs the user in and gives the client an access token (a JWT). The server verifies it with
[Nimbus JOSE + JWT](https://connect2id.com/products/nimbus-jose-jwt) against the provider's published keys, and turns
its claims into the viewer:

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Auth.kt{kotlin}

What `viewerOf` returns is `viewer` in the schema's `@allow` rules, and the resolvers never check permissions
themselves. Until you have a provider, the server signs and checks tokens with the development key at the top of the
file; `devToken` makes one as a provider would, and `Token.kt` prints one:

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Token.kt{kotlin}

## 5. Start the server

`main` and `startServer`, at the top of `Server.kt`, serve the endpoint on port 4000 with the explorer beside it:

```sh
./gradlew run
```

Open http://localhost:4000/rayfold/explorer to browse the operations and send requests. To try the commands, paste a
token into the auth field: `./gradlew -q token` prints a customer's, `./gradlew -q token --args=staff` a member of
staff's. Or call it with curl:

```sh
curl -s localhost:4000/rayfold -H 'content-type: application/rayfold+json' -H 'rayfold-safe: true' \
  -d '{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock author { name } }"}]}'
```

## 6. Call it from Kotlin

`Client.kt`:

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Client.kt{kotlin}

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
