# Rayfold

Rayfold is an API protocol for web apps, mobile apps and services. You describe your API once, in a schema, and
Rayfold gives you:

- **One request per screen.** A client sends several operations in one batch, and a later operation can use an
  earlier one's result. "Create an order, then show it" is one round trip.
- **Screens that stay current.** Every command returns patches for the entities it changed. The client's cache applies
  them, so every component showing that book or order updates without fetching it again. Live queries push changes
  made by other people.
- **Rules in the schema.** Who may read or change what (`@allow`), how much a request may cost (`@cost`), how long a
  result may be cached (`@cache`) and when a field goes away (`@deprecated(sunset:)`) are declared in the schema and
  enforced by the runtime. Tooling reports breaking changes before they ship.
- **No N+1 by accident.** Field resolvers are batch loaders by default: one call per nesting level, whatever the
  number of rows.
- **Plain HTTP when you want it.** JSON over `POST`, cacheable `GET`, REST routes from `@http`, an OpenAPI document,
  and an MCP endpoint so AI agents can use the same API.

```
entity Book {
  id: ID
  title: String
  stock: Int
  author: Author
}

query book(id: ID): Book?
command restock(id: ID, qty: Int): Book
```

## Start here

| You build | Read |
|---|---|
| A Node.js server and a web or Node client | [Quickstart](guide/quickstart.md) |
| A React app | [React](guide/react.md) |
| A Kotlin server, or a Kotlin or Android client | [Kotlin and Android](guide/kotlin.md) |
| A Java server, with or without Spring Boot | [Java and Spring Boot](guide/java-spring.md) |
| Screens that update before the server answers, and work offline | [Offline and optimistic updates](guide/offline.md) |
| Resolvers over Postgres, with policies in SQL | [Postgres](guide/postgres.md) |
| Traces of every batch, op and loader | [Tracing](guide/tracing.md) |
| A move from an existing REST or GraphQL API | [From REST](guide/from-rest.md), [From GraphQL](guide/from-graphql.md) |

## Reference

- [The specification](../spec/00-overview.md): the schema language, shapes, batches, frames, errors, auth, caching,
  live queries, the binary format, the MCP bridge, evolution and security.
- [How Rayfold compares](comparison.md) with REST, GraphQL and others, with measurements.
- [Versioning](versioning.md) of the packages, the protocol and your schema, and [how the specification changes](../spec/process.md).

Rayfold is open source under the Apache License 2.0.
