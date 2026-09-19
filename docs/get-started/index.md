---
title: Get started
description: Build a small bookshop API with Rayfold in TypeScript, React, Kotlin, Java or Spring Boot.
---

# Get started

Pick the stack you work in. Each guide builds the same bookshop: books with an author and a stock count, a cost
price only staff can see, and two commands, `buy` and `restock`. Every server listens on port 4000, serves the same
schema byte for byte, and speaks the same protocol, so the React app works just as well against the Kotlin, Java or
Spring server as against the TypeScript one.

<div class="home-stacks">
  <a href="./typescript"><strong>TypeScript</strong><span>Server and client on Node.js</span></a>
  <a href="./react"><strong>React</strong><span>Hooks that follow the cache</span></a>
  <a href="./kotlin"><strong>Kotlin</strong><span>Server and client, Android-ready</span></a>
  <a href="./java"><strong>Java</strong><span>Plain Java 21 server</span></a>
  <a href="./spring-boot"><strong>Spring Boot</strong><span>Annotated beans and Spring Security</span></a>
</div>

The code on these pages comes from the [example projects](../../examples), whose tests run on every change to the
repository. Not ready to install anything? The [playground](../playground.md) runs the bookshop server in your
browser.

::: info You will install 0.1.0
That is the published version, and everything in these guides is in it. **0.2.0 is not published yet**; see
[versioning](../versioning.md) for what it adds.
:::

## The schema you will serve

Every guide starts from this file. It is the contract: the server is checked against it, and clients learn from it
what they can ask for.

<<< @/../examples/typescript/src/bookshop.rayfold

- Fields are required unless they end in `?`.
- `@allow` says who may read `costPrice` or run `restock`, and the server enforces it on every request.
- `buy` declares that it can fail with `OutOfStock`, so clients can handle that case by name.
- `Page<Book>` gives `books` a cursor, a total and a `hasMore` flag without declaring a wrapper type of your own;
  the resolver fills those fields in.
