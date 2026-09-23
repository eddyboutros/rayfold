# Bookshop on Spring Boot

The bookshop API in a Spring Boot 4 application with `rayfold-spring-boot-starter`: resolvers are annotated methods
on a bean, and Spring Security supplies the viewer. Built with Maven.

| File | What |
|---|---|
| `src/main/resources/bookshop.rayfold` | The schema |
| `src/main/resources/application.properties` | Where the schema is, the port, the explorer |
| `src/main/java/com/example/bookshop/BookshopApplication.java` | The entry point `./mvnw spring-boot:run` starts |
| `src/main/java/com/example/bookshop/Book.java`, `Author.java`, `Store.java` | The records and the shelves, in memory |
| `src/main/java/com/example/bookshop/BookResolvers.java` | `@RayfoldQuery`, `@RayfoldCommand` and the batched `@RayfoldField` loader |
| `src/main/java/com/example/bookshop/SecurityConfig.java` | Spring Security checks each bearer token (a JWT); a development key signs them until an issuer is set |
| `src/main/java/com/example/bookshop/DevTokens.java` | Development tokens, for local runs and tests |
| `src/test/java/com/example/bookshop/BookshopApplicationTests.java` | Tests over HTTP against the application on a free port |

## Prerequisites

JDK 21 or later. The Maven wrapper downloads Maven.

The `dev.rayfold` artifacts come from Maven Central. To try changes to the runtime that are not released yet, run
`cd ../../kotlin && ./gradlew publishToMavenLocal` and set the version in `pom.xml` to the local one.

## Run

```sh
./mvnw spring-boot:run   # the application, on port 4000
./mvnw test
```

On Windows, use `mvnw.cmd` instead of `./mvnw`.

## Signing in

The application believes who a caller is only from a signed token (a JWT) whose signature, issuer, audience and expiry it
checks. With no identity provider configured, it signs and checks tokens with a development key. This prints a
customer's token, who may buy:

```sh
./mvnw -q compile exec:java
```

and this a member of staff's, who may also restock and see `costPrice`:

```sh
./mvnw -q compile exec:java -Dexec.args=staff
```

Without a token you can only read. A token that does not verify, including a bare role name such as `Bearer staff`, is
not a credential: Spring Security refuses it with 401 before anything runs.

In production, set `spring.security.oauth2.resourceserver.jwt.issuer-uri` in `application.properties` to your
identity provider's issuer. Spring then reads its signing keys from the provider, and the development key is never
used.

## Call it

```sh
TOKEN=$(./mvnw -q compile exec:java -Dexec.args=staff)
curl http://localhost:4000/rayfold \
  -H 'Content-Type: application/rayfold+json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock costPrice author { name } }"}]}'
```

## Explorer

While the application runs, open http://localhost:4000/rayfold/explorer, and paste a token into the auth field.
