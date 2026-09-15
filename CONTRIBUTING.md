# Contributing to Rayfold

Thank you for helping. Rayfold is a specification with two implementations, so most changes touch more than one
place; this page explains how they fit together.

## Set up

- Node.js 22 or 24, and a JDK 21 or newer.
- `npm ci`, then `npm test` (TypeScript: every package, the conformance suite, the end-to-end comparisons) and
  `npm run typecheck`.
- `cd kotlin && ./gradlew test` runs the JVM modules: the Kotlin runtime, the Java API, the Spring Boot starter and
  the Kotlin client.
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

- **No sleeping and no wall-clock assertions.** Inject a clock or use fake timers, assert on counters and frames, and
  bound every wait (the helpers in `e2e/wait.ts`, 5 s) so a missed signal fails instead of hanging.
- **Every "must not" has a guard.** A test that proves something is refused sits next to one proving the honest
  request still works, so an exemption cannot quietly become a blanket one.
- **Clean up.** Every server, socket and subscription a test opens is closed when it ends.

## Pull requests

- Keep a pull request to one change, and say in the description what it changes for a user.
- CI must pass: TypeScript on Node 22 and 24, the JVM modules, the oracle check, the package smoke test, and the
  dependency and secret scans.
- By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the project's
  license.

Please report security problems privately, as [SECURITY.md](SECURITY.md) describes, and follow the
[code of conduct](CODE_OF_CONDUCT.md).
