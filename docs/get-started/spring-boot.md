---
title: Spring Boot
description: A Rayfold API in Spring Boot, with annotated beans and Spring Security.
---

<StackNav current="spring-boot" />

# Get started with Spring Boot

The bookshop as a Spring Boot application: resolvers are annotated methods on a bean, and Spring Security says who is
calling. The finished project is [examples/spring-boot](../../examples/spring-boot). You need JDK 21.

## 1. Add the starter

Start from a Spring Boot 4 project, for example from start.spring.io, and add the Rayfold starter. The OAuth2 resource
server starter is only there for the demo tokens in step 4:

<<< @/../examples/spring-boot/pom.xml#deps{xml}

## 2. Describe the API

Save the schema as `src/main/resources/bookshop.rayfold`:

<<< @/../examples/spring-boot/src/main/resources/bookshop.rayfold

Point the starter at it in `application.properties`, and turn on the explorer:

<<< @/../examples/spring-boot/src/main/resources/application.properties#settings{properties}

## 3. Write the resolvers

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/BookResolvers.java#resolvers{java}

- `@RayfoldQuery` and `@RayfoldCommand` name the operation each method serves, and `@Arg` binds its arguments,
  already checked against the schema.
- Return plain records; the runtime turns them into the shape the client asked for.
- `Rayfold.domainError("OutOfStock", ...)` is the error the schema declared. Clients receive it by name, with its
  data.

Related data is loaded in batches:

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/BookResolvers.java#loader{java}

`@RayfoldField` gets every book in the result at once and returns their authors in the same order, so a page of 50
books looks up authors once.

## 4. Say who is calling

The starter takes the viewer from Spring Security: the signed-in principal's name becomes `viewer.id` and its role
becomes `viewer.role`, which the schema's `@allow` rules check. Here two fixed tokens stand in for a real
authorization server:

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/SecurityConfig.java#auth{java}

## 5. Start the application

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/BookshopApplication.java#server{java}

```sh
./mvnw spring-boot:run
```

The endpoint is at http://localhost:4000/rayfold and the explorer at http://localhost:4000/rayfold/explorer. Paste
`customer` or `staff` as the token to try the commands. Or call it with curl:

```sh
curl -s localhost:4000/rayfold -H 'content-type: application/rayfold+json' -H 'authorization: Bearer staff' \
  -d '{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock costPrice }"}]}'
```

## 6. Call it

Any Rayfold client works with this application: the [TypeScript client](./typescript.md#6-call-it-from-typescript),
the [React hooks](./react.md), or the [Kotlin client](./kotlin.md#6-call-it-from-kotlin).

## Next

- How shapes, loaders and pages work: [Queries and shapes](../learn/queries.md).
- Rules in the schema: [Who can do what](../learn/auth.md).
- Configuration, generated records and tracing: the [Java and Spring Boot guide](../guide/java-spring.md).
