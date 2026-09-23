---
title: Java
description: A Rayfold server in plain Java 21, step by step.
---

<StackNav current="java" />

# Get started with Java

A bookshop server with four operations, in plain Java with no framework. The finished project is
[examples/java](../../examples/java). You need JDK 21. Using Spring Boot? The [Spring Boot guide](./spring-boot.md)
builds the same server with annotated beans.

## 1. Create the project

A Maven project with the Rayfold dependency, Nimbus to verify tokens, JUnit for the tests, and the exec plugin that runs
the server. `pom.xml`:

<<< @/../examples/java/pom.xml{xml}

## 2. Describe the API

Save the schema as `src/main/resources/bookshop.rayfold`:

<<< @/../examples/java/src/main/resources/bookshop.rayfold

The server reads it at startup and checks every request against it. `npx @rayfold/cli gen java` generates records
from it if you want them.

## 3. Write the resolvers

The books are records, kept in memory by `Store.java`:

::: code-group

<<< @/../examples/java/src/main/java/com/example/bookshop/Book.java{java} [Book.java]

<<< @/../examples/java/src/main/java/com/example/bookshop/Author.java{java} [Author.java]

<<< @/../examples/java/src/main/java/com/example/bookshop/Store.java{java} [Store.java]

:::

`Bookshop.java` starts the server and holds one resolver per operation:

<<< @/../examples/java/src/main/java/com/example/bookshop/Bookshop.java{java}

- `Rayfold.server(schema)` takes one function per operation, named as in the schema. Arguments arrive already checked
  against it, `@range` included.
- Return plain records such as `Book`; the runtime turns them into the shape the client asked for.
- The `author` field loader receives every book in the result at once and returns their authors in the same order,
  so a page of 50 books looks up authors once.
- `Rayfold.domainError("OutOfStock", ...)` is the error the schema declared. Clients receive it by name, with its
  data.
- `Rayfold.result(book).emit(...)` returns the changed book, which becomes a patch for every client cache, and the
  event the schema says the command emits.

## 4. Say who is calling

Your identity provider signs the user in and gives the client an access token (a JWT). The server verifies it with
[Nimbus JOSE + JWT](https://connect2id.com/products/nimbus-jose-jwt) against the provider's published keys, and turns
its claims into the viewer:

<<< @/../examples/java/src/main/java/com/example/bookshop/Auth.java{java}

What `viewerOf` returns is `viewer` in the schema's `@allow` rules, and the resolvers never check permissions
themselves. Until you have a provider, the server signs and checks tokens with the development key at the top of the
class; `devToken` makes one as a provider would, and `main` prints one.

## 5. Start the server

`main` and `start`, at the top of `Bookshop.java`, serve the endpoint on port 4000 with the explorer beside it:

```sh
./mvnw compile exec:java
```

Open http://localhost:4000/rayfold/explorer to browse the operations and send requests. To try the commands, paste a
development token into the auth field; this prints a customer's, and `-Dexec.args=staff` a member of staff's:

```sh
./mvnw -q compile exec:java -Dexec.mainClass=com.example.bookshop.Auth
```

Or call it with curl:

```sh
TOKEN=$(./mvnw -q compile exec:java -Dexec.mainClass=com.example.bookshop.Auth)
curl -s localhost:4000/rayfold -H 'content-type: application/rayfold+json' -H "authorization: Bearer $TOKEN" \
  -d '{"rayfold":"0.1","ops":[{"id":1,"op":"buy","args":{"bookId":"b1"},"key":"first-purchase-0001"}]}'
```

## 6. Call it

Any Rayfold client works with this server: the [TypeScript client](./typescript.md#6-call-it-from-typescript), the
[React hooks](./react.md), or the [Kotlin client](./kotlin.md#6-call-it-from-kotlin), which Java code can use too.

## Next

- How shapes, loaders and pages work: [Queries and shapes](../learn/queries.md).
- Rules in the schema: [Who can do what](../learn/auth.md).
- Generated records and the rest of the Java API: the [Java and Spring Boot guide](../guide/java-spring.md).
