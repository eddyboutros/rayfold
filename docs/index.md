---
layout: home
title: Rayfold
titleTemplate: One protocol for your app's API

hero:
  name: Rayfold
  text: The rules live in the schema
  tagline: An API protocol that carries not just the shape of a request, but who may make it, what may be cached, how clients stay consistent, and what may change later. Describe the API once, in one place. For TypeScript, React, Kotlin, Java and Spring Boot.
  image:
    light: /logo.svg
    dark: /logo-dark.svg
    alt: ""
  actions:
    - theme: brand
      text: Get started
      link: /get-started/
    - theme: alt
      text: Try it in your browser
      link: /playground
    - theme: alt
      text: View on GitHub
      link: https://github.com/eddyboutros/rayfold

features:
  - title: One request per screen
    details: Send several operations together, and let a later one use an earlier one's result. Placing an order and showing it is one round trip.
    link: /learn/batches
    linkText: Batches
  - title: Screens that stay current
    details: Every command returns patches for what it changed, and the client cache applies them. Add live true to a query and other people's changes arrive too.
    link: /learn/live
    linkText: Live updates
  - title: Rules in the schema
    details: Who may read or change what, what a request may cost and how long a result may be cached are declared once and enforced on every request.
    link: /learn/auth
    linkText: Who can do what
  - title: No N+1 by accident
    details: A loader gets every parent at once, so a page of 50 books loads its authors in one call, not 50.
    link: /learn/queries
    linkText: Queries and shapes
  - title: Errors with names
    details: Commands declare what can go wrong. Clients handle OutOfStock by name, with its data, instead of parsing a message.
    link: /learn/commands
    linkText: Commands and errors
  - title: Plain HTTP when you want it
    details: JSON over POST, cacheable GET, REST routes bound in the schema, a generated OpenAPI document, and an MCP endpoint so AI agents can use the same API.
    link: /guide/rest-bindings
    linkText: REST routes and OpenAPI
---

<div class="home-section">

::: info The published version is 0.1.0
Everything on this page is in **0.1.0**, which is what npm and Maven Central carry today. **0.2.0 is not published
yet** — it is written and tested in the repository, and the few pages that document it say so.
[Which feature came with which version](/versioning#what-each-version-added).
:::

## What it looks like

A schema, a request for one screen, and what comes back. The same request works against a TypeScript, Kotlin,
Java or Spring Boot server.

<div class="home-trio">
<div>

**The schema**

```rayfold
entity Book {
  id: ID
  title: String
  stock: Int
  author: Author
}

query book(id: ID): Book?

command buy(bookId: ID, qty: Int = 1): Book
  throws OutOfStock
  @allow(write: viewer != null)
```

</div>
<div>

**One request, two steps**

```json
{
  "rayfold": "0.1",
  "ops": [
    { "id": 1, "op": "buy",
      "args": { "bookId": "b1" },
      "key": "7f3c9a2e4b1d4c6f" },
    { "id": 2, "op": "book",
      "args": { "id": { "$ref": "1.id" } },
      "shape": "{ title stock author { name } }",
      "live": true }
  ]
}
```

</div>
<div>

**Frames back**

```json
{ "id": 1,
  "ok": { "$type": "Book", "id": "b1",
    "title": "A Wizard of Earthsea", "stock": 2 },
  "patch": [{ "set": "Book:b1", "value": {
    "$type": "Book", "id": "b1",
    "title": "A Wizard of Earthsea", "stock": 2 } }],
  "meta": { "cost": 1 }, "fin": true }
{ "id": 2,
  "data": { "$type": "Book",
    "title": "A Wizard of Earthsea", "stock": 2,
    "author": { "$type": "Author",
      "name": "Ursula K. Le Guin" } },
  "meta": { "cost": 2 } }
{ "id": 2,
  "patch": [{ "at": "", "value": { "stock": 7 } }] }
```

</div>
</div>

The last frame comes later, when a member of staff restocks the book: the query was sent with `live: true`, so the
server keeps it open and sends only what changed.

</div>

<div class="home-section">

## Before and after

The advantage is not that the requests are smaller. It is that the server says what changed, so the code that keeps
screens correct after a write stops existing. Here is the same feature — buy a book, show it, and leave every other
open screen correct — written the usual way and then in Rayfold.

**Before.** Nothing here is wrong or unusual; this is what careful code looks like today.

```ts
// 1. the write
await client.mutate({ mutation: BUY, variables: { bookId: "b3", qty: 2 } });

// 2. the read it implies: a second round trip, because the mutation's result
//    does not carry the fields this screen shows
const { data } = await client.query({
  query: BOOK,
  variables: { id: "b3" },
  fetchPolicy: "network-only",
});

// 3. every other open view holding that book is now stale. Either refetch them,
//    or write a cache update for each, and keep that list correct as screens are added
await client.refetchQueries({ include: [CATALOGUE, CART_BADGE, STOCK_BANNER] });
```

**After.**

```ts
const batch = client.batch();
const bought = batch.command<Book>("buy", { bookId: "b3", qty: 2 }, { shape: "{ id }" });
const book = batch.query<Book>("book", { id: bought.ref("id") }, { shape: "{ title stock }" });
await batch.run();

const { title, stock } = await book.promise;
// step 3 is not shortened, it is gone: `buy` answered with patches for what it
// changed, and every cached view holding that book has already applied them
```

Two round trips become one, because step 2 travels in the same request and takes its argument from step 1's result.
Step 3 disappears, because the command's answer carries the patch. Add `live: true` to the query and another
customer's purchase arrives through the same mechanism, with no second system to run.

The cost of that: your API has to be described in a schema, and your team learns one more protocol.
<a href="/should-you-use-rayfold.html">Should you use Rayfold?</a> is the honest version of that trade, and
[the comparison](/comparison) says which rows are defaults rather than things the alternatives cannot do.

</div>

<div class="home-section">

## Pick your stack

Every guide builds the same small bookshop, and every example project runs its tests on each change to the
repository, so the code you copy is code that works.

<div class="home-stacks">
  <a href="./get-started/typescript"><strong>TypeScript</strong><span>Server and client on Node.js</span></a>
  <a href="./get-started/react"><strong>React</strong><span>Hooks that follow the cache</span></a>
  <a href="./get-started/kotlin"><strong>Kotlin</strong><span>Server and client, Android-ready</span></a>
  <a href="./get-started/java"><strong>Java</strong><span>Plain Java 21 server</span></a>
  <a href="./get-started/spring-boot"><strong>Spring Boot</strong><span>Annotated beans and Spring Security</span></a>
</div>

</div>
