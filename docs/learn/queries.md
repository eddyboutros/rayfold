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

A read goes out as a `POST` because a request is a batch: several operations, each with its arguments and shape,
which do not fit in a URL. `Rayfold-Safe: true` marks it as a read. The server then refuses anything in it that is not
a query, and the answer may be cached like a `GET`. HTTP's `QUERY` method, a `POST` that is safe by definition, says
the same where the client and the proxies support it, and a single query can also be a plain `GET` by URL. Commands
go as a plain `POST`. [Caching](./caching.md#which-requests-are-cacheable) has all three forms.

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

`$type` names the type of each entity in the result. `meta.cost` is what the query counts against the batch's budget,
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
- `...on Book { title }` selects fields that only exist on one of the types a field can hold.

The [shapes chapter of the specification](../../spec/02-shapes.md) has the full grammar.

## One field, many types

A field typed as an interface or a [union](./schema.md#interfaces-and-unions) can hold more than one kind of thing,
so a shape says what to take from each:

```
{
  results {
    ...on Book   { id title }
    ...on Author { id name }
  }
}
```

Fields the types share can be selected once outside the conditions; each `...on` adds what is particular to that
type. Every result carries its `$type`, so a client knows which arm it got.

## Deliver a field later

Not every field has to arrive with the first frame. Four things control that, and they work together:

| | Where it goes | What it does |
|---|---|---|
| `@defer { ... }` | in the shape | Send this part in a later `at` frame. The caller decides. |
| `@lazy` | on the field | The field arrives in a later frame by default. The schema decides, for a field that is usually expensive and rarely needed. |
| `@eager` | in the shape | Overrides `@lazy` for this request: send it with everything else. |
| `@partial` | on the field | The field may fail on its own — `null`, and an entry in the frame's `errors` — instead of failing the operation. |

A deferred part arrives as an `at` frame naming its path, and a client fills it in when it lands. The first frame is
what a screen can paint immediately, so the choice is really "what does this screen need before it can show
anything".

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

`rayfold` comes with `@rayfold/cli`, installed in the project with `npm install --save-dev @rayfold/cli`; without it,
`npx @rayfold/cli` runs it instead.

### Tuning a loader

A loader gets every parent at once by default, which is what avoids the N+1. `@load(single)` marks a field whose
source can only be asked one parent at a time; the executor then calls it per parent rather than pretending it
batches.

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

## Cursors or offsets

`@page(cursor)` is the default and the one to prefer: a cursor names a position in the result, so a row inserted
while the reader is on page two does not shift everything down and show them a row twice. Pass the `cursor` from one
page as `after` on the next.

`@page(offset)` numbers pages instead, and `PageArgs.offset` skips that many rows. Use it when the caller genuinely
needs to jump to page seven — a table with numbered pages — and accept that concurrent inserts can duplicate or skip
a row at a boundary.

## What a query costs

Before it runs anything, the server works out what a batch can cost from the page sizes it asks for and the schema's
`@cost` hints, and refuses a batch over the server's per-batch budget (1000 by default) with
[`resource_exhausted`](/errors/resource_exhausted). Loading rows costs; reading a scalar field of a row already
loaded does not. Each frame reports its cost in `meta.cost`: 2 for the book with its author above, 4 for the page of
two books.

## Next

- Change data: [Commands and errors](./commands.md).
- Who may read which field: [Who can do what](./auth.md).
- Keep a query open and receive changes: [Live updates](./live.md).
- Try shapes on the bookshop: the [playground](../playground.md).
