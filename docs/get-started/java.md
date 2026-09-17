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

A Maven project with one Rayfold dependency, plus JUnit for the tests:

<<< @/../examples/java/pom.xml#deps{xml}

## 2. Describe the API

Save the schema as `src/main/resources/bookshop.rayfold`:

<<< @/../examples/java/src/main/resources/bookshop.rayfold

The server reads it at startup and checks every request against it. `npx rayfold gen java` generates records from
it if you want them.

## 3. Write the resolvers

<<< @/../examples/java/src/main/java/com/example/bookshop/Bookshop.java#resolvers{java}

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

<<< @/../examples/java/src/main/java/com/example/bookshop/Bookshop.java#auth{java}

What this returns is `viewer` in the schema's `@allow` rules. The resolvers never check permissions themselves.

## 5. Start the server

<<< @/../examples/java/src/main/java/com/example/bookshop/Bookshop.java#server{java}

```sh
./mvnw compile exec:java
```

Open http://localhost:4000/rayfold/explorer to browse the operations and send requests; type `customer` or `staff` in
the auth field to try the commands, as the explorer adds the `Bearer` itself. Or call it with curl:

```sh
curl -s localhost:4000/rayfold -H 'content-type: application/rayfold+json' -H 'authorization: Bearer customer' \
  -d '{"rayfold":"0.1","ops":[{"id":1,"op":"buy","args":{"bookId":"b1"},"key":"first-purchase-0001"}]}'
```

## 6. Call it

Any Rayfold client works with this server: the [TypeScript client](./typescript.md#6-call-it-from-typescript), the
[React hooks](./react.md), or the [Kotlin client](./kotlin.md#6-call-it-from-kotlin), which Java code can use too.

## Next

- How shapes, loaders and pages work: [Queries and shapes](../learn/queries.md).
- Rules in the schema: [Who can do what](../learn/auth.md).
- Generated records and the rest of the Java API: the [Java and Spring Boot guide](../guide/java-spring.md).
