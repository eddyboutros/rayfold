# Bookshop in Java

The bookshop API on `rayfold-java`: resolvers are lambdas on a builder, results are records, and the JDK's HTTP server
serves it. Built with Maven.

| File | What |
|---|---|
| `src/main/resources/bookshop.rayfold` | The schema |
| `src/main/java/com/example/bookshop/Bookshop.java` | Resolvers, the batched `Book.author` loader, the viewer, the server |
| `src/main/java/com/example/bookshop/Store.java` | The shelves, in memory |
| `src/test/java/com/example/bookshop/BookshopTest.java` | Tests over HTTP against a server on a free port |

## Prerequisites

JDK 21 or later. The Maven wrapper downloads Maven.

Inside the Rayfold repository, publish the runtime to your local Maven repository first:

```sh
cd ../../kotlin && ./gradlew publishToMavenLocal
```

## Run

```sh
./mvnw compile exec:java   # the server, on port 4000
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

`Bearer customer` may buy. `Bearer staff` may also restock and see `costPrice`. Without a token, you can only read.

## Explorer

While the server runs, open http://localhost:4000/rayfold/explorer. To sign in there, type `customer` or `staff` in
the auth field.
