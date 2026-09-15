# Bookshop on Spring Boot

The bookshop API in a Spring Boot 4 application with `rayfold-spring-boot-starter`: resolvers are annotated methods
on a bean, and Spring Security supplies the viewer. Built with Maven.

| File | What |
|---|---|
| `src/main/resources/bookshop.rayfold` | The schema |
| `src/main/resources/application.properties` | Where the schema is, the port, the explorer |
| `src/main/java/com/example/bookshop/BookResolvers.java` | `@RayfoldQuery`, `@RayfoldCommand` and the batched `@RayfoldField` loader |
| `src/main/java/com/example/bookshop/SecurityConfig.java` | Two demo bearer tokens, checked by Spring Security |
| `src/test/java/com/example/bookshop/BookshopApplicationTests.java` | Tests over HTTP against the application on a free port |

## Prerequisites

JDK 21 or later. The Maven wrapper downloads Maven.

Inside the Rayfold repository, publish the runtime to your local Maven repository first:

```sh
cd ../../kotlin && ./gradlew publishToMavenLocal
```

## Run

```sh
./mvnw spring-boot:run   # the application, on port 4000
./mvnw test
```

On Windows, use `mvnw.cmd` instead of `./mvnw`.

## Call it

```sh
curl http://localhost:4000/rayfold \
  -H 'Content-Type: application/rayfold+json' \
  -H 'Authorization: Bearer staff' \
  -d '{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock costPrice author { name } }"}]}'
```

`Bearer customer` may buy. `Bearer staff` may also restock and see `costPrice`. Without a token, you can only read;
an unknown token gets 401 from Spring Security before Rayfold sees the request.

## Explorer

While the application runs, open http://localhost:4000/rayfold/explorer. To sign in there, type `customer` or `staff`
in the auth field.
