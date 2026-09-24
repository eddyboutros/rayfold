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
| `scalar` | A scalar of your own: `scalar Money @format("decimal")`. It travels as its base form with a name and a hint on it. |

Twelve scalars are built in, plus the generic `Page<T>`, which a field or an operation may return but an argument or
an input field may not take. Five of the scalars are text on the wire in a particular form:

| Scalar | On the wire |
|---|---|
| `ID`, `String` | a string |
| `Int`, `Float` | a number; an `Int` is 32-bit |
| `Boolean` | `true` or `false` |
| `Long` | a 64-bit number, or a string above 2^53 so no digit is lost |
| `Decimal` | a string, always, for the same reason |
| `Instant` | RFC 3339 in UTC: `2026-09-18T14:30:00Z` |
| `Date` | `YYYY-MM-DD` |
| `Duration` | `250ms`, `60s`, `5m`, `2h`, `7d` |
| `Bytes` | base64url |
| `JSON` | any JSON value, unchecked |

## Interfaces and unions

Two types can share a shape without one containing the other. An `object` marked `@interface` declares fields that
entities then promise to have:

```rayfold
object Named @interface {
  id: ID
  name: String
}

entity Person implements Named { id: ID  name: String  email: String }
entity Team   implements Named { id: ID  name: String  size: Int }
```

A field typed `Named` may hold either. A `union` is the other shape — several types with nothing in common:

```rayfold
union SearchHit = Book | Author
```

Either way a result can hold more than one kind of thing, and the shape says what to select from each
([Queries and shapes](./queries.md#one-field-many-types)).

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
| `@cost(base: 5, perItem: 1)` | What a query costs against the server's per-batch budget. |
| `@deprecated(reason: "...", sunset: "2027-01-01")` | Going away, and from when. Tooling refuses to remove it earlier. |
| `@simulate` | The command accepts dry runs. |
| `@partial` | The field may fail on its own instead of failing the whole operation. |
| `@http(method: GET, path: "/books/{id}")` | Also serve the operation as a [REST route](../guide/rest-bindings.md). |
| `@version` | The field holding an entity's version, for [conditional writes](./commands.md#conditional-writes). |
| `@page(cursor)` or `@page(offset)` | How a `Page<T>` field or query is paged. Default `cursor`. |
| `@load(batch)` or `@load(single)` | How a field's loader is called. Default `batch`, which is what avoids N+1. |
| `@lazy` | The field arrives in a later frame unless a shape asks for it eagerly. See [deliver a field later](./queries.md#deliver-a-field-later). |
| `@live(false)` | The query may not be opened [live](./live.md). |
| `@interface` | The object declares an interface other types implement. |
| `@format("...", pattern: "...")`, `@unit("...")` | Machine-readable hints for docs and agents; `pattern` is enforced on strings and must match the whole value. |
| `@example(value: ...)` | A sample value, used by docs, the explorer and `rayfold mock`. |
| `@ordinal(3)` | Fix the wire ordinal by hand instead of letting the lockfile assign it. |

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

`rayfold check` validates a schema and says what is wrong and where. It comes with `@rayfold/cli`
(`npm install --save-dev @rayfold/cli`, or run it once with `npx @rayfold/cli`):

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

Names that start with `__` are reserved for the protocol, so the check refuses them for fields, arguments and enum
values alike.

Run it in CI with `--against` the previous version of the schema and it also reports breaking changes. Editors get
the same diagnostics through the [language server](../guide/editors.md).

## Types for your code

The schema can generate types for each stack:

```sh
npx rayfold gen ts bookshop.rayfold --out src/schema.ts
npx rayfold gen kotlin bookshop.rayfold --package com.example.bookshop --out Bookshop.kt
npx rayfold gen java bookshop.rayfold --package com.example.bookshop --class Bookshop --out Bookshop.java
```

In TypeScript you can also write the schema in code with `@rayfold/builder` and get the types inferred; see
[Schema in TypeScript](../guide/typescript.md).

## Next

- Read data: [Queries and shapes](./queries.md).
- Change data: [Commands and errors](./commands.md).
