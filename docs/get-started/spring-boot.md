---
title: Spring Boot
description: A Rayfold API in Spring Boot, with annotated beans and Spring Security.
---

<StackNav current="spring-boot" />

# Get started with Spring Boot

The bookshop as a Spring Boot application: resolvers are annotated methods on a bean, and Spring Security says who is
calling. The finished project is [examples/spring-boot](../../examples/spring-boot). You need JDK 21.

## 1. Add the starter

Start from a Spring Boot 4 project, for example from start.spring.io, and add the Rayfold starter, with Spring's
OAuth2 resource server for the tokens in step 4:

<<< @/../examples/spring-boot/pom.xml{xml}

## 2. Describe the API

Save the schema as `src/main/resources/bookshop.rayfold`:

<<< @/../examples/spring-boot/src/main/resources/bookshop.rayfold

Point the starter at it in `application.properties`, and turn on the explorer. The identity lines are step 4's:

<<< @/../examples/spring-boot/src/main/resources/application.properties{properties}

## 3. Write the resolvers

The books are records, kept in memory by a `Store` bean:

::: code-group

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/Book.java{java} [Book.java]

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/Author.java{java} [Author.java]

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/Store.java{java} [Store.java]

:::

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/BookResolvers.java{java}

- `@RayfoldQuery` and `@RayfoldCommand` name the operation each method serves, and `@Arg` binds its arguments,
  already checked against the schema.
- Return plain records; the runtime turns them into the shape the client asked for.
- `Rayfold.domainError("OutOfStock", ...)` is the error the schema declared. Clients receive it by name, with its
  data.
- `@RayfoldField` loads related data in batches: it gets every book in the result at once and returns their authors
  in the same order, so a page of 50 books looks up authors once.

## 4. Say who is calling

Your identity provider signs the user in and gives the client an access token (a JWT). Spring Security verifies it:
the signature against the provider's published keys, then the issuer, the audience and the expiry. The starter takes
the viewer from the authenticated principal: its name, the token's `sub`, becomes `viewer.id`, and its roles
`viewer.roles`, the first of them `viewer.role`, which the schema's `@allow` rules check.

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/SecurityConfig.java{java}

The provider is the `issuer-uri` in `application.properties` above. Until you set it, `DevelopmentTokens` signs and
checks tokens with a development key instead, and `DevTokens` makes them as a provider would:

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/DevTokens.java{java}

## 5. Start the application

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/BookshopApplication.java#server{java}

```sh
./mvnw spring-boot:run
```

The endpoint is at http://localhost:4000/rayfold and the explorer at http://localhost:4000/rayfold/explorer. To try the
commands, paste a development token into the auth field; this prints a member of staff's, and without `-Dexec.args` a
customer's:

```sh
./mvnw -q compile exec:java -Dexec.args=staff
```

Or call it with curl:

```sh
TOKEN=$(./mvnw -q compile exec:java -Dexec.args=staff)
curl -s localhost:4000/rayfold -H 'content-type: application/rayfold+json' -H "authorization: Bearer $TOKEN" \
  -d '{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock costPrice }"}]}'
```

## 6. Call it

Any Rayfold client works with this application: the [TypeScript client](./typescript.md#6-call-it-from-typescript),
the [React hooks](./react.md), or the [Kotlin client](./kotlin.md#6-call-it-from-kotlin).

## Next

- How shapes, loaders and pages work: [Queries and shapes](../learn/queries.md).
- Rules in the schema: [Who can do what](../learn/auth.md).
- Configuration, generated records and tracing: the [Java and Spring Boot guide](../guide/java-spring.md).
