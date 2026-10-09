---
title: Testing
description: Unit test resolvers, policies, errors, retries, live queries and time with the real server in the test's own process — no port, no sleeping, in TypeScript, React, Angular, Kotlin, Java and Spring Boot.
---

# Testing

A Rayfold server is an object. A test can build one from the application's real schema and resolvers and call it
directly, in the test's own process: no port is opened, and nothing is mocked. Every call goes through the same
argument checks, policies, idempotency and patches as a request over HTTP, so what a test proves is what a client
will see.

Three rules keep such tests fast and honest:

- **One caller per viewer.** The viewer is who is calling, which over HTTP the server reads from a token. A test
  names it directly and keeps a caller for each kind of person: nobody, a customer, staff.
- **Never sleep.** A test waits for a value, not for time to pass. Every wait on this page is bounded: a value that
  does not come fails the test with a message saying what it waited for, instead of hanging the run.
- **Give the server its clock.** Anything that depends on time is tested by moving a clock the test owns.

Every example below is a test from this repository's bookshop examples, run in CI. What the network adds (tokens,
headers, status codes, CORS) is a transport's business; test that once, over HTTP, as the examples' other tests do.

## Set up

| For | Add | You get |
|---|---|---|
| TypeScript, React, Angular | nothing: `@rayfold/client` has it | `createLocalTransport(server, viewer)`, and `collect` from `@rayfold/client/testing` |
| Kotlin, Java, Spring Boot | `dev.rayfold:rayfold-test`, in test scope | `RayfoldTest`, a blocking caller per viewer, and `LocalTransport` for the Kotlin client |

::: info Since 0.2.2
`dev.rayfold:rayfold-test`, `@rayfold/client/testing`, the JVM server's clock and Angular's wait for a first answer
came with 0.2.2. `createLocalTransport` and the TypeScript server's `now` were already in 0.2.1.
:::

::: code-group

```kotlin [Gradle]
dependencies {
    testImplementation("dev.rayfold:rayfold-test:0.2.2")
}
```

```xml [Maven]
<dependency>
  <groupId>dev.rayfold</groupId>
  <artifactId>rayfold-test</artifactId>
  <version>0.2.2</version>
  <scope>test</scope>
</dependency>
```

:::

Then build the server under test and a caller for each viewer. Every test gets a server and a store of its own, so
no test sees what another one bought.

::: code-group

<<< @/../examples/typescript/src/bookshop.unit.test.ts#test-setup{ts} [TypeScript]

<<< @/../examples/kotlin/src/test/kotlin/com/example/bookshop/BookshopUnitTest.kt#test-setup{kotlin} [Kotlin]

<<< @/../examples/java/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-setup{java} [Java]

<<< @/../examples/spring-boot/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-setup{java} [Spring Boot]

:::

- In TypeScript the caller is the client your application already uses, over `createLocalTransport` instead of
  `createFetchTransport`.
- On the JVM, `RayfoldTest.of(server)` calls as nobody and `signedInAs(viewer)` returns a caller for that viewer.
  Kotlin passes `JsonObject` arguments and gets `JsonElement`; Java passes maps and gets plain values.
- In Spring Boot the server is the one the starter built, autowired. Spring Security is not involved: the test says
  who the viewer is.

## A resolver

Ask with a shape, and assert on the whole result. The result is exactly what a client would receive, `$type`
included.

::: code-group

<<< @/../examples/typescript/src/bookshop.unit.test.ts#test-resolver{ts} [TypeScript]

<<< @/../examples/kotlin/src/test/kotlin/com/example/bookshop/BookshopUnitTest.kt#test-resolver{kotlin} [Kotlin]

<<< @/../examples/java/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-resolver{java} [Java]

<<< @/../examples/spring-boot/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-resolver{java} [Spring Boot]

:::

## A policy

A policy test has two halves: the caller the rule refuses, with the exact [error code](../learn/auth.md#what-a-caller-sees-when-a-rule-says-no),
and the caller it allows. Without the second half, a rule that refuses everyone would pass. Assert on the store too:
a refused command must have changed nothing.

::: code-group

<<< @/../examples/typescript/src/bookshop.unit.test.ts#test-policy{ts} [TypeScript]

<<< @/../examples/kotlin/src/test/kotlin/com/example/bookshop/BookshopUnitTest.kt#test-policy{kotlin} [Kotlin]

<<< @/../examples/java/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-policy{java} [Java]

<<< @/../examples/spring-boot/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-policy{java} [Spring Boot]

:::

## A declared error

An error the schema declares arrives [by name, with its payload](../learn/commands.md). In TypeScript the client
rejects with it; on the JVM the caller throws the `RayfoldException` the server produced.

::: code-group

<<< @/../examples/typescript/src/bookshop.unit.test.ts#test-error{ts} [TypeScript]

<<< @/../examples/kotlin/src/test/kotlin/com/example/bookshop/BookshopUnitTest.kt#test-error{kotlin} [Kotlin]

<<< @/../examples/java/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-error{java} [Java]

<<< @/../examples/spring-boot/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-error{java} [Spring Boot]

:::

## A retried command

A command sent twice under one [idempotency key](../learn/commands.md#safe-to-retry) runs once. Prove it on what
the command does, the stock here, and prove the other side: another key is another purchase.

On the JVM a command without a key gets a fresh one, so a test passes a key only when the key is what it tests.
`frames(...)` returns what the server sent as it sent it, which is where `meta.replay` is.

::: code-group

<<< @/../examples/typescript/src/bookshop.unit.test.ts#test-replay{ts} [TypeScript]

<<< @/../examples/kotlin/src/test/kotlin/com/example/bookshop/BookshopUnitTest.kt#test-replay{kotlin} [Kotlin]

<<< @/../examples/java/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-replay{java} [Java]

<<< @/../examples/spring-boot/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-replay{java} [Spring Boot]

:::

## A live query

A [live query](../learn/live.md) reports a value whenever what it shows changes. The test reads those values one at
a time: each `next()` waits for one more, and fails when none comes.

- TypeScript: `collect` from `@rayfold/client/testing` takes the callbacks of `client.live` or `client.watch`.
  `next(label)` waits 4 seconds at most, under the 5 seconds a test runner allows, so the failure you read is
  `no value within 4000 ms: the restock: saw [...]` and not the runner's timeout. For a stream, return
  `client.stream(op, args, { signal })` with the signal `collect` passes as its third argument.
- JVM: `live(...)` returns once the first result is there, and `next()` waits 5 seconds at most (`within(ms)` on the
  caller, or `next(ms)`, changes that). `close()` returns once the server has its subscription back.

::: code-group

<<< @/../examples/typescript/src/bookshop.unit.test.ts#test-live{ts} [TypeScript]

<<< @/../examples/kotlin/src/test/kotlin/com/example/bookshop/BookshopUnitTest.kt#test-live{kotlin} [Kotlin]

<<< @/../examples/java/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-live{java} [Java]

<<< @/../examples/spring-boot/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-live{java} [Spring Boot]

:::

## Time

The server reads the time from one clock: for `now()` in a policy, `ctx.now` in a resolver, when an idempotency
record expires, and its uptime. It is the system clock unless you give it another. A test gives it one it can move,
and a day passes in a line.

- TypeScript: the `now` option of `createRayfoldServer`, epoch milliseconds.
- Kotlin: `RayfoldServer(..., now = ...)`, a function returning epoch milliseconds.
- Java: `.clock(...)` on the builder, a `java.time.Clock` or a `LongSupplier`; the example's
  `Bookshop.server(store, now)` passes it on.
- Spring Boot: the application's `java.time.Clock` bean, which the test replaces with one it sets.

::: code-group

<<< @/../examples/typescript/src/bookshop.unit.test.ts#test-clock{ts} [TypeScript]

<<< @/../examples/kotlin/src/test/kotlin/com/example/bookshop/BookshopUnitTest.kt#test-clock{kotlin} [Kotlin]

<<< @/../examples/java/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-clock{java} [Java]

<<< @/../examples/spring-boot/src/test/java/com/example/bookshop/BookshopUnitTest.java#test-clock{java} [Spring Boot]

:::

## The client and its cache

What the client adds, the cache, [optimistic updates](offline.md) and watches, is tested with the client itself
over the in-process transport. The server answers for real, so a prediction is checked against what the server
then says. In Kotlin that transport is `LocalTransport(server) { viewer }`; the test below wraps it to count the batches
the client sends.

::: code-group

<<< @/../examples/typescript/src/bookshop.unit.test.ts#test-client{ts} [TypeScript]

<<< @/../examples/kotlin/src/test/kotlin/com/example/bookshop/BookshopUnitTest.kt#test-client{kotlin} [Kotlin]

:::

## React

Render the real component inside `RayfoldProvider`, with a client on the in-process transport. This test uses jsdom
(`// @vitest-environment jsdom`) and React's own `createRoot`; the same setup works under Testing Library.

<<< @/../examples/react/src/App.unit.test.tsx#test-setup{tsx}

Wait for what the page shows, not for time. `until` looks again whenever the page changes, and fails with what the
page says:

<<< @/../examples/react/src/App.unit.test.tsx#test-wait{tsx}

Then a test reads like what a person does:

::: code-group

<<< @/../examples/react/src/App.unit.test.tsx#test-component{tsx} [Loading, then data]

<<< @/../examples/react/src/App.unit.test.tsx#test-command{tsx} [A click runs a command]

:::

## Angular

`provideRayfold(client)` takes a client on the in-process transport, and `injectQuery`, `injectLive` and
`injectCommand` run in an injection context as they do in a component. The signals they return are plain values, so
this test needs neither a DOM nor `TestBed`.

In a component test with `TestBed`, provide the same client and wait with `await fixture.whenStable()`: a query and
a live query keep the application unstable until their first answer, and a command while it runs.

<<< @/../packages/angular/src/testing-guide.test.ts#test-setup{ts}

To wait for a signal, follow it with `createWatch` from `@angular/core/primitives/signals` and hand its values to
`collect`:

<<< @/../packages/angular/src/testing-guide.test.ts#test-wait{ts}

::: code-group

<<< @/../packages/angular/src/testing-guide.test.ts#test-query{ts} [injectQuery]

<<< @/../packages/angular/src/testing-guide.test.ts#test-command{ts} [injectCommand]

<<< @/../packages/angular/src/testing-guide.test.ts#test-live{ts} [injectLive]

:::

## What to test over the network

Keep a few tests that go through the transport you deploy, because these are decided there and not in the server:

- **Who the caller is.** That a token becomes the right viewer, and that a bad one is refused with 401
  ([Who can do what](../learn/auth.md#who-is-calling)).
- **Browsers.** Allowed origins and the CORS preflight.
- **REST routes.** Paths, status codes and headers of [`@http` bindings](rest-bindings.md).
- **Caching.** `ETag`, `Cache-Control` and `304` ([Caching](../learn/caching.md)).

The bookshop examples have both kinds side by side: `bookshop.unit.test.ts` and `bookshop.test.ts` in TypeScript,
`BookshopUnitTest` and the HTTP tests beside it in Kotlin, Java and Spring Boot.
