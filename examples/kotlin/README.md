# Bookshop in Kotlin

The bookshop API served by `rayfold-core` on the JDK's HTTP server, and a small app on `rayfold-client` that reads a
book, watches it, buys a copy and prints the stock the purchase left. One Gradle build holds both.

| File | What |
|---|---|
| `src/main/resources/bookshop.rayfold` | The schema |
| `src/main/kotlin/com/example/bookshop/Server.kt` | Resolvers, the batched `Book.author` loader, the viewer, the server |
| `src/main/kotlin/com/example/bookshop/Client.kt` | The client app |
| `src/test/kotlin/com/example/bookshop/` | Tests over HTTP against a server on a free port |

## Prerequisites

JDK 21 or later. The Gradle wrapper downloads Gradle.

Inside the Rayfold repository, this build compiles the runtime from `../../kotlin` (see `settings.gradle.kts`), so
nothing has to be published. In a copy of the project anywhere else, delete the `includeBuild` block and the
`dev.rayfold` artifacts come from Maven Central.

## Run

```sh
./gradlew run          # the server, on port 4000
./gradlew runClient    # in a second terminal, while the server runs
./gradlew test
```

On Windows, use `gradlew.bat` instead of `./gradlew`.

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
