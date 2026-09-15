---
title: The schema
description: "The schema language, with the bookshop as the example: types, nullability, operations, annotations and views."
---

# The schema

A Rayfold API starts with a schema. It is the contract between server and clients: the server is checked against
it, clients learn from it what they can ask for, and the rules about who may do what, what things cost and how long
results may be cached live in it too, instead of in code scattered across handlers.

Here is the bookshop every guide on this site builds:

<<< @/../examples/typescript/src/bookshop.rayfold

## Types

| Kind | What it is |
|---|---|
| `entity` | Something with identity. It has an `id: ID`, and caches and patches know it as `Book:b1`. |
| `object` | A value without identity, such as an address. It lives inside the entity that holds it. |
| `input` | A structured argument. Inputs contain only scalars, enums and other inputs. |
| `enum` | A fixed set of names: `enum Format { HARDCOVER PAPERBACK EBOOK }`. |
| `union` | One of several types: `union SearchHit = Book | Author`. |
| `error` | An error an operation can end with, and the data it carries. |
| `event` | A fact a command publishes, such as `StockChanged`. |

Built-in scalars are `ID`, `String`, `Int`, `Long`, `Float`, `Boolean`, `Decimal`, `Instant`, `Date`, `Duration`,
`Bytes` and `JSON`, plus the generic `Page<T>`. `Decimal` travels as a string so no digit is lost, and a `Long` above
2^53 does too.

## Required unless marked

A field is required unless its type ends in `?`:

```rayfold
entity Book {
  id: ID
  title: String        // always there
  subtitle: String?    // may be null
  tags: [String]       // a list, never null, of strings that are never null
  notes: [String?]?    // both may be null
}
```

This is the other way round from GraphQL, and it matches how APIs are used: most fields are always there, so the
schema marks the exceptions.

## Operations

```rayfold
query book(id: ID): Book?
query books(page: PageArgs = { first: 20 }): Page<Book>

command buy(bookId: ID, qty: Int = 1 @range(min: 1, max: 10)): Book
  throws OutOfStock
  emits StockChanged
  @allow(write: viewer != null)
```

| Kind | What it does |
|---|---|
| `query` | Reads. Safe to repeat, cacheable, and any query can be kept open with `live: true`. |
| `command` | Changes something. Carries an idempotency key, returns its result with patches, declares its errors with `throws` and its events with `emits`. |
| `stream` | Sends items until it finishes, such as a feed of `StockChanged` events. |

An argument with a default is optional for the caller and always has a value in the resolver.

## Descriptions

A `"""triple-quoted"""` string before a definition, field or argument is its description. Descriptions are part of
the schema that clients and tools receive: the explorer shows them, and an AI agent calling the API through MCP reads
them to decide what to call.

## Annotations

Annotations put rules and hints next to the thing they apply to. The ones you will use most:

| Annotation | Meaning |
|---|---|
| `@allow(read: ..., write: ...)` | Who may read or change it. See [Who can do what](./auth.md). |
| `@range(min: ..., max: ...)` | Allowed values, or lengths for strings and lists. Checked before any resolver runs. |
| `@cache(maxAge: 60s, scope: public)` | How long a result may be cached, and whether a shared cache may keep it. |
| `@cost(base: 5, perItem: 1)` | What a query costs against the caller's budget. |
| `@deprecated(reason: "...", sunset: "2027-01-01")` | Going away, and from when. Tooling refuses to remove it earlier. |
| `@simulate` | The command accepts dry runs. |
| `@partial` | The field may fail on its own instead of failing the whole operation. |
| `@http(method: GET, path: "/books/{id}")` | Also serve the operation as a REST route. |

The [schema chapter of the specification](../../spec/01-schema.md#4-annotations) lists them all.

## Views

A view is a named shape for a type. The view called `default` is what a caller gets when it asks for no fields:

```rayfold
view Book.default = { id title stock author { name } }
view Book.card    = { ...Book.default costPrice }
```

Without a `default` view, a type's own scalar fields are its default. Clients can include a view in any shape with
`...Book.card`.

## Check it

`rayfold check` validates a schema and says what is wrong and where:

```sh
npx rayfold check bookshop.rayfold
```

```
error    unknown-type  Book.stock: Unknown type Integer
 --> bookshop.rayfold:9:3
  |
9 |   stock: Integer
  |   ^^^^^
  = no type named Integer is defined; declare it, or import the document that has it
```

Run it in CI with `--against` the previous version of the schema and it also reports breaking changes. Editors get
the same diagnostics through the [language server](../guide/editors.md).

## Types for your code

The schema can generate types for each stack:

```sh
npx rayfold gen ts bookshop.rayfold --out src/schema.ts
npx rayfold gen kotlin bookshop.rayfold --package com.example.bookshop --out Bookshop.kt
npx rayfold gen java bookshop.rayfold --package com.example.bookshop --out Bookshop.java
```

In TypeScript you can also write the schema in code with `@rayfold/builder` and get the types inferred; see
[Schema in TypeScript](../guide/typescript.md).

## Next

- Read data: [Queries and shapes](./queries.md).
- Change data: [Commands and errors](./commands.md).
