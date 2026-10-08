# Contributing to Rayfold

Thank you for helping. Rayfold is a specification with two implementations, so most changes touch more than one
place; this page explains how they fit together.

## Set up

- Node.js 22 or 24, and a JDK 21 or newer.
- `npm ci`, then `npm test` (TypeScript: every package, the conformance suite, the end-to-end comparisons) and
  `npm run typecheck`.
- `cd kotlin && ./gradlew test` runs every JVM module: the Kotlin runtime, the Java API, the Spring Boot starter, the
  Kotlin client and its OkHttp transport, OpenTelemetry, the JDBC stores, and the test support.
- `npm run e2e:html` renders the comparison report from the last test run; `npm run docs:dev` serves the docs site
  with the playground, and `npm run docs:build` builds it (a broken link fails the build).
- The code on the site comes from `examples/`. Change an example, and its tests and the pages that show it change
  with it; `node scripts/examples-jvm.mjs` builds and tests the Kotlin, Java and Spring Boot examples.

## Where a change goes

| Change | Also update |
|---|---|
| Protocol behaviour (anything a client can observe) | the spec in `spec/`, a conformance fixture in `conformance/fixtures/`, and **both** runtimes |
| Wire format (frames, RB) | `scripts/kotlin-oracle.ts` if the Kotlin side is checked against a TypeScript oracle, then `npx tsx scripts/kotlin-oracle.ts` |
| A package's public API | its README and the guide in `docs/guide/` |
| Anything a user will notice | `CHANGELOG.md`, under "Unreleased" |

The conformance fixtures are the contract: the TypeScript and Kotlin runtimes must produce identical frames for every
case. Changes to the specification follow [spec/process.md](spec/process.md).

## Tests

Tests are deep and functional: they drive the real entry point (the HTTP handler, the WebSocket connection, the batch
runner) rather than only a helper.

- **No sleeping and no wall-clock assertions.** Inject a clock (`now` on either server, `clock` on the Java builder) or
  use fake timers, assert on counters and frames, and bound every wait (the helpers in `e2e/wait.ts`, 5 s; `collect`
  from `@rayfold/client/testing`, 4 s; `RayfoldTest` and its `LiveQuery`, 5 s) so a missed signal fails instead of
  hanging.
- **Every "must not" has a guard.** A test that proves something is refused sits next to one proving the honest
  request still works, so an exemption cannot quietly become a blanket one.
- **Clean up.** Every server, socket and subscription a test opens is closed when it ends.

## What "supported" means for a language

Rayfold supports a language or a framework when all three of these hold, and a new one is added with all three in
the same release:

1. **It passes the conformance vectors** in `conformance/vectors/`, every case and rule, run in CI.
2. **An application written in it can be unit tested without a network**: a client, or a caller, runs against a real
   server in the test's own process, and every wait it offers is bounded.
3. **It has its tab in the [testing guide](docs/guide/testing.md)**, embedded from a test in `examples/` that CI
   runs, covering a resolver, a policy, a declared error, a retried command, a live query and the clock.

A client-only language (no server runtime) meets 2 with a transport a test can script or point at a server in
another runtime, and says so in its guide.

## Pull requests

- Keep a pull request to one change, and say in the description what it changes for a user.
- CI must pass: TypeScript on Node 22 and 24, the JVM modules, the oracle check, the package smoke test, the two-server
  fleet against a real Postgres, the docs build, the JVM examples, the browser runs (Chromium, Firefox, WebKit), the
  nginx shared-cache check, and the dependency and secret scans.
- By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the project's
  license.

Please report security problems privately, as [SECURITY.md](SECURITY.md) describes, and follow the
[code of conduct](CODE_OF_CONDUCT.md).
