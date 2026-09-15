---
layout: home
title: Rayfold
titleTemplate: One protocol for your app's API

hero:
  name: Rayfold
  text: One protocol for your app's API
  tagline: Describe the API once. Screens ask for exactly the data they show, stay current without fetching again, and the schema decides who can do what. For TypeScript, React, Kotlin, Java and Spring Boot.
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
    details: JSON over POST, cacheable GET, REST routes, an OpenAPI document, and an MCP endpoint so AI agents can use the same API.
    link: /guide/from-rest
    linkText: Coming from REST
---

<div class="home-section">

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
      "args": { "bookId": "b1" } },
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
