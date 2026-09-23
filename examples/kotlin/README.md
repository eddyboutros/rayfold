# Bookshop in Kotlin

The bookshop API served by `rayfold-core` on the JDK's HTTP server, and a small app on `rayfold-client` that reads a
book, watches it, buys a copy and prints the stock the purchase left. One Gradle build holds both.

| File | What |
|---|---|
| `src/main/resources/bookshop.rayfold` | The schema |
| `src/main/kotlin/com/example/bookshop/Store.kt` | The shelves, in memory |
| `src/main/kotlin/com/example/bookshop/Server.kt` | Resolvers, the batched `Book.author` loader, the server |
| `src/main/kotlin/com/example/bookshop/Auth.kt` | Who the caller is, from a signed token (JWT); `devToken` for local runs |
| `src/main/kotlin/com/example/bookshop/Token.kt` | Prints a development token (`./gradlew -q token`) |
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

## Signing in

The server believes who a caller is only from a signed token (a JWT) whose signature, issuer, audience and expiry it
checks. With no identity provider configured, it signs and checks tokens with a development key. This prints a
customer's token, who may buy:

```sh
./gradlew -q token
```

and this a member of staff's, who may also restock and see `costPrice`:

```sh
./gradlew -q token --args=staff
```

Without a token you can only read. A token that does not verify, including a bare role name such as `Bearer staff`, is
not a credential: the server refuses it with 401 before anything runs.

In production, set `AUTH_JWKS_URL` (the provider's published keys) and `AUTH_ISSUER` in the environment. The server then accepts
tokens that provider signed for the audience `bookshop`, and the development key is never used.

## Call it

```sh
TOKEN=$(./gradlew -q token --args=staff)
curl http://localhost:4000/rayfold \
  -H 'Content-Type: application/rayfold+json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock costPrice author { name } }"}]}'
```

## Explorer

While the server runs, open http://localhost:4000/rayfold/explorer, and paste a token into the auth field.
