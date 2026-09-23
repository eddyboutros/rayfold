---
title: Changing a schema safely
description: Add to a schema freely, retire what you no longer need with a sunset date, and let rayfold check stop breaking changes before they ship.
---

# Changing a schema safely

A Rayfold schema has no version number. There is no `/v2`: you keep one schema and change it in ways that clients
already in the field survive, and `rayfold check` refuses the changes they would not survive. This page shows which
changes are safe, how to retire a field, and how to run the check in CI with a lockfile.

## Record what shipped

`rayfold lock` writes the schema as it is now to `rayfold.lock.json`: the whole schema, its hash, the field ordinals
and when it was locked. Commit that file with the release.

```sh
npx rayfold lock src/bookshop.rayfold
# wrote rayfold.lock.json (hash 683ba13db169)
```

`rayfold` comes with `@rayfold/cli`, installed in the project with `npm install --save-dev @rayfold/cli`; without it,
`npx @rayfold/cli` runs it instead.

From then on `rayfold check src/bookshop.rayfold` compares the schema against `rayfold.lock.json` in the current
directory, or against the file you name with `--against`, which may also be an older copy of the `.rayfold` file. It
exits with status 1 when a change would break a client, so the same command fails a CI build. Run `rayfold lock`
again when the next release ships.

## Add freely

A client never asks for what it does not know about, so adding is safe. Here the bookshop gets a biography for
authors, a page count for books, an `author` query and an optional filter on `books`:

```rayfold
entity Author {
  id: ID
  name: String
  bio: String?
}

entity Book @cache(maxAge: 60s, scope: public) {
  id: ID
  title: String
  stock: Int
  author: Author
  """What the shop paid. Only staff can see it."""
  costPrice: Decimal? @allow(read: viewer.role == "staff")
  pages: Int?
}

query books(page: PageArgs = { first: 20 }, inStock: Boolean = false): Page<Book>
query author(id: ID): Author?
```

```
ok        Author.bio: field added [field-added]
ok        Book.pages: field added [field-added]
ok        books().inStock: optional argument added [arg-added]
ok        author(): query author added [op-added]

OK: compatible with rayfold.lock.json (4 changes)
```

## Put new fields last

Fields are numbered by position, and the lockfile records those numbers. Adding `pages` between `title` and `stock`
instead of at the end renumbers the fields after it:

```
BREAKING  Book.stock: ordinal changed 3 -> 4 [ordinal-changed]
BREAKING  Book.author: ordinal changed 4 -> 5 [ordinal-changed]
BREAKING  Book.costPrice: ordinal changed 5 -> 6 [ordinal-changed]
ok        Book.pages: field added [field-added]

FAILED: breaking changes against rayfold.lock.json
```

## What breaks a client

This version of the schema makes four mistakes at once:

```rayfold
entity Book @cache(maxAge: 60s, scope: public) {
  id: ID
  title: String?
  stock: Int
  author: Author
}

command buy(bookId: ID, qty: Int = 1 @range(min: 1, max: 10), note: String): Book
  throws OutOfStock
  emits StockChanged
  @allow(write: viewer != null)

command addStock(bookId: ID, qty: Int @range(min: 1, max: 1000)): Book
  emits StockChanged
  @allow(write: viewer.role == "staff")
```

```
BREAKING  Book.title: String -> String? [field-nullable]
BREAKING  Book.costPrice: field Book.costPrice removed (deprecate with a sunset date first) [field-removed]
BREAKING  buy().note: required argument added without a default [arg-added-required]
BREAKING  restock(): command restock removed (deprecate with a sunset date first) [op-removed]
ok        addStock(): command addStock added [op-added]

FAILED: breaking changes against rayfold.lock.json
```

- `title: String?`: code that shows the title without checking for `null` would now fail. The other direction, a
  nullable result field becoming non-null, is allowed. For arguments and input fields the rule flips: optional to
  required breaks callers.
- Removing `costPrice` breaks every client that still reads it. Deprecate it with a sunset date first.
- `note: String` has no default, so every existing `buy` call is now missing an argument.
- A rename is a removal plus an addition. Add `addStock`, deprecate `restock`, and remove it after its sunset.

Changing a field's type and removing an enum value or union member are breaking too.

## Changes that need a look

Some changes are safe for most clients but not all. The check reports them as warnings and still passes:

```rayfold
error ShelfFull { bookId: ID, space: Int }

query books(page: PageArgs = { first: 20 }): Page<Book> @allow(read: viewer != null)

command restock(bookId: ID, qty: Int @range(min: 1, max: 1000)): Book
  throws ShelfFull
  emits StockChanged
  @allow(write: viewer.role == "staff")
```

```
warning   books(): a policy was added where none existed; some callers may now be denied [policy-added]
warning   restock(): now throws ShelfFull; clients with exhaustive handling must be updated [throws-added]
ok        ShelfFull: error ShelfFull added [type-added]

OK: compatible with rayfold.lock.json (3 changes)
```

Anonymous callers of `books` are now refused, and a client that handles each error type of `restock` by name has
one more to handle. With `--strict`, as in `npx rayfold check src/bookshop.rayfold --strict`, warnings fail the check
too: the same three lines print, then `FAILED: warnings against rayfold.lock.json (--strict)`, and the exit status is 1.

## Retire a field

To remove something, first mark it `@deprecated` with a `sunset` date and ship that:

```rayfold
  """What the shop paid. Only staff can see it."""
  costPrice: Decimal? @allow(read: viewer.role == "staff")
    @deprecated(reason: "Read it from the staff stock report", sunset: "2026-12-31")
```

Adding the annotation changes nothing for clients (`OK: compatible with rayfold.lock.json (0 changes)`). Lock that
version. Removing the field before its sunset date still fails:

```
BREAKING  Book.costPrice: field Book.costPrice removed (deprecate with a sunset date first) [field-removed]

FAILED: breaking changes against rayfold.lock.json
```

On or after the sunset date the same removal passes. With a locked sunset of `2026-09-01` and the check run on
2026-09-15:

```
ok        Book.costPrice: field Book.costPrice removed after its sunset date [field-removed-after-sunset]

OK: compatible with rayfold.lock.json (1 change)
```

The check reads the sunset from the locked schema and compares it with today's date, so the deprecation has to be in
the lockfile before the removal.

## Find out who still uses it

A sunset date is a promise; traffic tells you whether anyone still relies on the field. Give the server a usage sink
and it records, per client, each operation and field that requests touch: no arguments, no values, no viewer.

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { MemoryUsage, createRayfoldServer } from "@rayfold/server";
import { resolvers, seed } from "./resolvers.ts";

const schema = readFileSync(new URL("./bookshop.rayfold", import.meta.url), "utf8");
const usage = new MemoryUsage();
const server = createRayfoldServer({ schema, resolvers: resolvers(seed()), usage });
writeFileSync("usage.json", JSON.stringify(usage.snapshot(), null, 2)); // later: from an admin route or a timer
```

Clients name themselves with the `Rayfold-Client` header, or the `client` option of the TypeScript client, such as
`client: "web/1.4.0"`. Each entry of the snapshot looks like this:

```json
{ "op": "book", "path": "Book.costPrice", "client": "admin/0.9.2", "lastSeen": "2026-09-15T08:21:51.201Z", "count": 1 }
```

After a web client read `{ title stock author { name } }` and a staff tool read `{ title costPrice }`, run it against
the schema from the section above — the one where `costPrice` carries `@deprecated`, since that is what the
`still used` line reports on:

```sh
npx rayfold check src/bookshop.rayfold --unused usage.json --since 30d
```

```
unused      books(): no traffic
unused      buy(): no traffic
unused      restock(): no traffic
unused      Author.id: no traffic
unused      Book.id: no traffic
still used  Book.costPrice: admin/0.9.2

5 members with no traffic from 2 clients; 0 records older than the window.
```

`still used` lists deprecated members and the clients that asked for them inside the window (`30d`, `12h`, `90m`).
"Unused" means no traffic was seen, not that nothing could call it, so the snapshot should cover every server and a
long enough period. `MemoryUsage` keeps one process's records in memory; in production, pass your own object with a
`record(event, at)` method that forwards to the metrics you already run.

## Next

- Everything the schema can declare: [The schema](./schema.md).
- Every `rayfold` command: [the CLI reference](../guide/cli.md).
- The rules in full: [spec 11, Evolution](../../spec/11-evolution.md).
