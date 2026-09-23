# Bookshop in Java

The bookshop API on `rayfold-java`: resolvers are lambdas on a builder, results are records, and the JDK's HTTP server
serves it. Built with Maven.

| File | What |
|---|---|
| `src/main/resources/bookshop.rayfold` | The schema |
| `src/main/java/com/example/bookshop/Bookshop.java` | Resolvers, the batched `Book.author` loader, the server |
| `src/main/java/com/example/bookshop/Book.java`, `Author.java` | The records |
| `src/main/java/com/example/bookshop/Auth.java` | Who the caller is, from a signed token (JWT); `devToken` for local runs |
| `src/main/java/com/example/bookshop/Store.java` | The shelves, in memory |
| `src/test/java/com/example/bookshop/BookshopTest.java` | Tests over HTTP against a server on a free port |

## Prerequisites

JDK 21 or later. The Maven wrapper downloads Maven.

The `dev.rayfold` artifacts come from Maven Central. To try changes to the runtime that are not released yet, run
`cd ../../kotlin && ./gradlew publishToMavenLocal` and set the version in `pom.xml` to the local one.

## Run

```sh
./mvnw compile exec:java   # the server, on port 4000
./mvnw test
```

On Windows, use `mvnw.cmd` instead of `./mvnw`.

## Signing in

The server believes who a caller is only from a signed token (a JWT) whose signature, issuer, audience and expiry it
checks. With no identity provider configured, it signs and checks tokens with a development key. This prints a
customer's token, who may buy:

```sh
./mvnw -q compile exec:java -Dexec.mainClass=com.example.bookshop.Auth
```

and this a member of staff's, who may also restock and see `costPrice`:

```sh
./mvnw -q compile exec:java -Dexec.mainClass=com.example.bookshop.Auth -Dexec.args=staff
```

Without a token you can only read. A token that does not verify, including a bare role name such as `Bearer staff`, is
not a credential: the server refuses it with 401 before anything runs.

In production, set `AUTH_JWKS_URL` (the provider's published keys) and `AUTH_ISSUER` in the environment. The server then accepts
tokens that provider signed for the audience `bookshop`, and the development key is never used.

## Call it

```sh
TOKEN=$(./mvnw -q compile exec:java -Dexec.mainClass=com.example.bookshop.Auth -Dexec.args=staff)
curl http://localhost:4000/rayfold \
  -H 'Content-Type: application/rayfold+json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock costPrice author { name } }"}]}'
```

## Explorer

While the server runs, open http://localhost:4000/rayfold/explorer, and paste a token into the auth field.
