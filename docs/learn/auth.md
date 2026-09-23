---
title: Who can do what
description: Say who is calling in one function, write the rules in the schema, and let the server enforce them everywhere.
---

# Who can do what

Your server works out who is calling. The schema says what they may do. Rayfold enforces those rules on every
request, before and while it runs, so resolvers never repeat a permission check and a new field cannot forget one.

## Who is calling

Rayfold does not sign anyone in. Your identity provider does (Auth0, Entra ID, Keycloak, Cognito, or your own), and
issues the client a signed access token. The server checks that token on every request and turns the claims it
signed into the **viewer**, the object the schema's rules see as `viewer`. The client never tells the server who it
is or what role it has: a role comes only from a token whose signature, issuer, audience and expiry all check out.

::: code-group

<<< @/../examples/typescript/src/auth.ts#auth{ts} [TypeScript]

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Auth.kt#auth{kotlin} [Kotlin]

<<< @/../examples/java/src/main/java/com/example/bookshop/Auth.java#auth{java} [Java]

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/SecurityConfig.java#auth{java} [Spring Boot]

:::

- The keys come from the provider's published key set (JWKS), fetched once, cached, and refreshed when the provider
  rotates them. No shared secret is copied into the server.
- A request without a token is anonymous: the viewer is `null`, and it can still do whatever the rules allow
  anonymous callers. A token that is present but does not verify is refused with
  [`unauthenticated`](/errors/unauthenticated) (HTTP 401) before anything runs.
- The viewer can be any object. Here it is the token's subject and its `role` claim; use whichever claims your provider
  puts roles, groups or tenants in. A session cookie works the same way: look the session up, and return its user.
- In Spring Boot you do not write this function. Spring Security verifies the token, and the starter builds the viewer
  from the authenticated principal: its name becomes `viewer.id`, its roles `viewer.roles`, and the first of them
  `viewer.role`.

Without a provider configured, the examples sign and check tokens with a development key, so they run on their own.
`npm run token -- staff`, `./gradlew -q token --args=staff`, or `./mvnw -q compile exec:java -Dexec.args=staff` in
the Spring Boot example prints one. Setting `AUTH_JWKS_URL` (which needs `AUTH_ISSUER` beside it) turns the
development key off; in Spring Boot, setting `spring.security.oauth2.resourceserver.jwt.issuer-uri` does.

The server calls the function once per request, or once per WebSocket connection:

::: code-group

<<< @/../examples/typescript/src/bookshop.ts#server{ts} [TypeScript]

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Server.kt#server{kotlin} [Kotlin]

<<< @/../examples/java/src/main/java/com/example/bookshop/Bookshop.java#server{java} [Java]

:::

## Rules in the schema

```rayfold
entity Book @cache(maxAge: 60s, scope: public) {
  id: ID
  title: String
  stock: Int
  author: Author
  costPrice: Decimal? @allow(read: viewer.role == "staff")
}

command buy(bookId: ID, qty: Int = 1 @range(min: 1, max: 10)): Book
  throws OutOfStock
  @allow(write: viewer != null)

command restock(bookId: ID, qty: Int @range(min: 1, max: 1000)): Book
  @allow(write: viewer.role == "staff")
```

- `read` governs queries, streams, and the reading of fields inside any result, including a command's. `write`
  governs commands.
- A rule can sit on an operation, a type or a field. A field is readable only if every level allows it, and `@deny`
  overrides `@allow`.
- Rules are expressions over `viewer`, `this` (the object being read) and `args`, with `==`, `!=`, `<`, `<=`, `>`,
  `>=`, `in`, `&&`, `||` and `!`, and the built-in functions `has()`, `len()` and `now()`. That makes rules about rows
  natural:

```rayfold
entity Order @allow(read: viewer.id == customerId || viewer.role == "admin") {
  id: ID
  customerId: ID
  total: Decimal
}
```

An expression that cannot be evaluated, such as comparing text with a boolean, fails closed: `@allow` does not allow.

## What a caller sees when a rule says no

| When the rule refuses | The caller gets |
|---|---|
| An operation, and nobody is signed in | [`unauthenticated`](/errors/unauthenticated): `Sign in to access buy()` |
| An operation | [`permission_denied`](/errors/permission_denied): `Not allowed to access restock()` |
| A field the shape asks for | `permission_denied` with `"path": "costPrice"`, and the operation fails as a whole |
| A field the shape asks for, marked `@partial` | `null` for that field, and an entry in the frame's `errors` |
| A field that is only in the default view | the field is left out, with no error |
| An entity at a position that may be `null` | `null`, exactly as if it did not exist |
| An entity at a position that may not be `null`, or an element of a list | `permission_denied` with a `path`, and the operation fails as a whole |

The row about positions that may be `null` matters: there a caller cannot tell an entity it may not see from one
that does not exist.

## Rules in the database too

A rule that only uses `viewer`, `args`, literals and plain fields of `this` can be handed to the loader as a filter,
so a list query never loads rows the viewer may not see. Loaders that do not use it still get correct results: the
runtime filters afterwards. The [Postgres adapter](../guide/postgres.md) turns these rules into SQL.

## Cost limits

The server works out what each batch can cost before it runs and refuses one over its per-batch budget (`budget`,
1000 by default) with [`resource_exhausted`](/errors/resource_exhausted). The budget is the server's, the same for
every caller. See [what a query costs](./queries.md#what-a-query-costs).

## Narrow access for agents and services

A capability token lets an AI agent or another service act for a user in a limited way, without holding the user's
credentials: it names the viewer, the operations it may call and when it expires, and it is signed. A token can be
narrowed further before being handed on, never widened. The operation list is enforced by the runtime, and the
policies on this page still run on the viewer the token names — a token narrows, it never widens.

[Capability tokens](../guide/capabilities.md) shows how to mint, use and attenuate one; the
[authorization chapter](../../spec/06-auth.md) defines the format.

## Browsers

- A Rayfold server refuses any request that is not a safe read (commands, live queries, plain `POST`s) from a browser
  origin it does not know, which stops another website from acting for your users. List your web app's origin in `allowedOrigins`; the [React guide](../get-started/react.md#2-send-api-calls-to-the-server)
  shows it.
- The batch endpoint reads only JSON and its binary format as request bodies, and the uploads route only
  `application/octet-stream`. None of those is a type a plain HTML form on another site can send without asking
  permission first.

The [security chapter](../../spec/12-security.md) lists every default.

## Next

- Keep a query open and receive changes: [Live updates](./live.md).
- The errors a refused request comes back with: [Errors](../errors/index.md).
