---
title: Queries and shapes
description: Ask for exactly the fields a screen shows, load related data without N+1, and page through lists.
---

# Queries and shapes

A query reads data. The caller sends a shape that lists the fields it wants, and the server resolves those fields
and nothing else. When a screen needs one more field, the client asks for it: no new endpoint, no field fetched just
in case.

## Ask for fields

::: code-group

<<< @/../examples/typescript/src/client.ts#client{ts} [TypeScript]

<<< @/../examples/react/src/App.tsx#list{tsx} [React]

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Client.kt#client{kotlin} [Kotlin]

```http [HTTP]
POST /rayfold
Content-Type: application/rayfold+json
Rayfold-Safe: true

{"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title stock author { name } }"}]}
```

:::

The answer is a frame for operation 1:

```json
{
  "id": 1,
  "data": {
    "$type": "Book",
    "title": "A Wizard of Earthsea",
    "stock": 3,
    "author": { "$type": "Author", "name": "Ursula K. Le Guin" }
  },
  "meta": { "cost": 2 },
  "fin": true
}
```

`$type` names the type of each entity in the result. `meta.cost` is what the query cost against the caller's budget,
and `fin` says this operation is finished.

## What a shape can say

A shape is a list of field names, with nested braces for fields that hold objects:

```
{ title stock author { name } }
```

- A field that takes arguments gets them in parentheses: `{ reviews(page: { first: 3 }) { items { rating } } }`.
- `cheap: price` returns the field under another name, which you need when you select one field twice with different
  arguments.
- `$name` in an argument is filled from the operation's `vars`, so the shape text stays the same for every call and
  can be cached and registered once.
- `...Book.card` includes a named view: a shape the schema defines once for everyone.
- `@defer { reviews { ... } }` sends that part in a later frame, so the rest of the screen can show first.

The [shapes chapter of the specification](../../spec/02-shapes.md) has the full grammar.

## Or leave the shape out

Without a shape, the result is the type's default view: its own scalar fields, unless the schema names another
view `default`. Here is `book b1` without a shape, for a customer and then for staff:

```json
{"id":1,"data":{"$type":"Book","id":"b1","title":"A Wizard of Earthsea","stock":3},"meta":{"cost":1},"fin":true}
{"id":1,"data":{"$type":"Book","id":"b1","title":"A Wizard of Earthsea","stock":3,"costPrice":"4.20"},"meta":{"cost":1},"fin":true}
```

A field the caller may not read is left out of a default view without an error, which is why only staff see
`costPrice`. Asking for it by name is different: the customer gets `permission_denied`. Default views make a bare
call from curl or an AI agent return something useful, and never leak.

## Related data without N+1

Fields that hold other entities are resolved by loaders, and a loader receives every parent at once:

::: code-group

<<< @/../examples/typescript/src/resolvers.ts#loader{ts} [TypeScript]

<<< @/../examples/kotlin/src/main/kotlin/com/example/bookshop/Server.kt#loader{kotlin} [Kotlin]

<<< @/../examples/java/src/main/java/com/example/bookshop/Bookshop.java#loader{java} [Java]

<<< @/../examples/spring-boot/src/main/java/com/example/bookshop/BookResolvers.java#loader{java} [Spring Boot]

:::

The server resolves a shape level by level. For a page of 20 books, `Book.author` is called once with all 20 books
and returns their authors in the same order — one entry per book, `null` only where the field's type allows it
(`author: Author?`). On a non-null field a `null` is an `internal` error naming the field, not a missing value. You
get one lookup per level however many rows there are, without writing a DataLoader.

`rayfold explain` shows the plan for a query before you run it:

```sh
npx rayfold explain src/bookshop.rayfold books --shape "{ items { title author { name } } }"
```

## Pages

A query that returns `Page<Book>` gets a cursor, `hasMore` and `total` without any extra schema. Its resolver returns
those along with the items; see `books` in the [resolvers](../get-started/typescript.md#3-write-the-resolvers).

```json
{ "id": 1, "op": "books", "args": { "page": { "first": 2 } }, "shape": "{ items { id title } cursor hasMore total }" }
```

```json
{
  "id": 1,
  "data": {
    "items": [
      { "$type": "Book", "id": "b1", "title": "A Wizard of Earthsea" },
      { "$type": "Book", "id": "b2", "title": "The Left Hand of Darkness" }
    ],
    "cursor": "b2",
    "hasMore": true,
    "total": 3
  },
  "meta": { "cost": 4 },
  "fin": true
}
```

The next page passes the cursor back: `"page": { "first": 2, "after": "b2" }`.

## What a query costs

Before it runs anything, the server works out what a batch can cost from the page sizes it asks for and the schema's
`@cost` hints, and refuses a batch over the caller's budget (1000 by default) with
[`resource_exhausted`](/errors/resource_exhausted). Loading rows costs; reading a scalar field of a row already
loaded does not. Each frame reports its cost in `meta.cost`: 2 for the book with its author above, 4 for the page of
two books.

## Next

- Change data: [Commands and errors](./commands.md).
- Who may read which field: [Who can do what](./auth.md).
- Keep a query open and receive changes: [Live updates](./live.md).
- Try shapes on the bookshop: the [playground](../playground.md).
