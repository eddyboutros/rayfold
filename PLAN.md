# Working plan — towards 0.2.0

Tracking file for the current block of work. Not part of the published docs; delete before release or keep as a
contributor note.

## Where this plan came from

An external technical review of 0.1.0, my response, and the reviewer's follow-up (`engineer-response.md`). His answer
to "what would move your confidence most" reframed the work:

> An implementation-independent, published conformance suite whose fixtures are derived from a normative protocol
> specification and are sufficient for a third party to implement Rayfold without reading the TypeScript or Kotlin
> source.

with the rule that makes it worth anything:

> The fixtures must not be generated exclusively from the TypeScript implementation… Otherwise the two
> implementations can agree on the same wrong answer.

That is the correction. Vectors captured *from* a runtime prove the runtimes agree — which was true the whole time
the RB dictionary was wrong. Expectations have to be written from the spec, then run at both runtimes, and every
disagreement is a finding.

**The one-sentence goal:** don't prove TypeScript and Kotlin agree with each other; prove both agree with a protocol
that exists independently of either.

---

## Verification gate (run ALL of these before any push)

I have shipped three CI failures by running a subset. The full local equivalent of the `typescript` job:

```sh
npm run typecheck
npm test                                    # includes fuzz + property tests at default depth
npx tsx scripts/kotlin-oracle.ts && git diff --exit-code kotlin/rayfold-core/src/test/resources/oracle
npm run build                               # per-package configs are stricter than the root tsconfig
npm run smoke:packages
npm run docs:build
cd kotlin && ./gradlew check                # count JUnit XML; "up-to-date" means it did NOT run
```

Traps that have actually bitten, in order of how much time each cost:

- **`npm run typecheck` is not `npm run build`.** The root tsconfig has node types; per-package build configs set
  `"types": []`. `Buffer` in `packages/postgres` passed typecheck and failed the build. → CI failure.
- **The oracle files are generated and committed.** Changing any string the TS runtime emits into
  `kotlin/rayfold-core/src/test/resources/oracle` requires regenerating them *and* changing the Kotlin side to match.
  → CI failure, twice.
- **Gradle "up-to-date" means nothing ran.** Count `tests=` from the JUnit XML, don't trust `BUILD SUCCESSFUL`.
  Also `./gradlew` lives in `kotlin/`, not the repo root — running it from the root exits 0 having done nothing.
- **The fleet suite is skipped locally** (needs Postgres + the built JVM member) and several of its tests are
  `skipIf(win32)`. Anything touching drain, live queries or the relay is effectively untested here.
- **`e2e/*.json` churn on every test run** (timestamps, random idempotency keys). Restore them before committing.
- **A property test you have not seen fail proves nothing.** Run new properties against the pre-fix code.

---

## Done

- [x] **Security: capability attenuation cannot widen.** Facts may be dropped, not changed or added; the token's own
      `ops`/`exp`/`jti`/`iss` applied last so a fact cannot shadow the authorisation gate. (`6e8f637`)
- [x] **Security: MCP serves the redacted IR by default**, `schema: "full" | "off"` to choose. (`6e8f637`)
- [x] **Security: `resources/read` cannot run a command** — the op's kind decides, not the URI. (`6e8f637`)
- [x] **Both invariants as properties**, verified to fail against the pre-fix code. (`4730edd`)
- [x] **Status vocabulary** in `spec/process.md`: normative / implemented / reserved / experimental / informative,
      with "a reference implementation MUST NOT silently implement less than the normative specification". (`4730edd`)
- [x] **Live-query guarantee stated**: eventual re-establishment by refetch, not exactly-once delivery. Resume named
      as a different guarantee rather than the next step. (`4730edd`)
- [x] Kotlin MCP description aligned + oracle regenerated (CI fix).

## Next: the conformance fixture pack

`conformance/fixtures/` gains the directories he named. Each fixture carries `input`, `expected canonical form`,
`expected hash`, `expected error`, `protocol version`; and where it is a state machine, `initial state`,
`operations`, `expected final state`.

Order chosen so the early ones have a source of truth outside Rayfold:

- [x] **`numbers/`** — 21 vectors written from ECMA-262 `Number::toString`, run by both runtimes
      (`packages/schema/src/vectors.test.ts`, `VectorsTest.kt`). **Found a real divergence on the first run:** Kotlin
      wrote `4.9e-324` for the minimum denormal because Java's `Double.toString` must emit a digit after the point,
      where ECMAScript asks only for the fewest digits that read back — `5e-324`. Fixed by shortening while the value
      still round-trips. Neither runtime's existing tests covered a denormal, so they had agreed with each other and
      not with the spec: the method working exactly as intended, on day one.
- [ ] **`canonicalization/`** — key ordering, escaping, unicode, duplicate keys, nesting depth. RFC 8785 is the
      reference point for what canonical JSON usually means; document where Rayfold differs and why.
- [ ] **`hashing/`** — schema hash and binding hash over the above. Expected hash written into the fixture.
- [x] **`shapes/`** — 11 vectors: text → canonical form → id, each id the SHA-256 of the canonical text in the same
      case taken with a general-purpose digest. **Two findings.** (1) Writing them exposed a spec gap: §3 never said
      how *arguments* are separated, so `reviews(after: "r1" first: 2)` and `reviews(after: "r1", first: 2)` were
      both defensible and would give different ids — spec 02 §3 now gives every separator in a table. (2) Kotlin
      accepted `@defer(foo: "x")` and turned `@defer(label: 5)` into a null label, where the grammar admits neither;
      its parser is now strict. All 9 valid cases already produced identical canonical text and ids in both runtimes.
- [ ] **`binary/`** — the RB dictionary (40 keys, the count is load-bearing), tag bytes, per-frame string table,
      the `0x09` raw-bytes case TS emits and Kotlin does not.
- [ ] **`manifest/`** — the document now defined in spec 04 §4a. TS serves `schemaHash` and `limits`; Kotlin does not.
- [ ] **`errors/`** — problem documents vs error frames, the lower-case title, the op-rooted detail path.
- [ ] **`idempotency/`** — viewer scope, binding hash, `already_exists` on reuse, the lease/takeover rules.
- [ ] **`authorization/`** — the denial table of spec 06, including the list-element case the runtimes disagree on.
- [ ] **`patch/`** — last, because it needs the chapter below first.

**Method:** write the expectation from the spec, then run both runtimes. Every disagreement is a finding, and the
13 known divergences should surface here rather than being fixed pairwise. Where a fixture cannot be written because
the spec does not say, that is the most valuable output of the exercise — it is the ambiguity an independent
implementer would have hit.

## Then: the patch chapter

Not a formalism — an executable model. The reviewer's framing: the question stops being "can Rayfold send a patch?"
and becomes "can a client maintain a correct representation of server state over time?"

- [ ] State machine: client state at revision N, patch N+1 arrives, contiguous → apply, gap → resync.
- [ ] Deterministic answers for: authorization change, entity deletion, collection membership change, pagination
      boundary change, reconnect, duplicate patch, old patch.
- [ ] Entity revisions (do not exist today), patch ordering, replay.
- [ ] Property test, the invariant he proposed:
      `apply(all patches, initial state) == fresh query(final server state)`
      over generated sequences of insert/update/delete/invalidate/reorder/pagination/authorization change.

## Then: Rayfold Commerce

The reference application, deliberately exercising the hard combinations at once: multi-tenant + authorization +
pagination + live orders + nested entities + idempotency + reconnect + multiple servers + cache. Then break it
on purpose — his Tests A–D (authorization change, collection mutation across a page boundary, reconnect, kill a
server mid-flight).

## Then: an independent implementation

Someone who has not read either runtime, given only the spec, the fixture pack and examples. Where they ask "what
does this mean?" is the specification's remaining ambiguity.

---

## Open defects from the documentation audit (25 of 28 remain)

Full list with file:line in `scratchpad/code-bugs-next-phase.md`. Most should be closed *by the fixture pack*
rather than individually — that is the point of writing the expectations from the spec.

**13 cross-runtime divergences.** Kotlin IR omits `extensions` (different schema hash); Kotlin's shape `@defer`
parser is lax (different shape ids); policy denial on a list element (TS returns null, Kotlin fails the op — spec
says Kotlin); Kotlin drops stream-item `errors`; Kotlin `isCancelled` never wired; Kotlin context has no `meta` so
`traceparent` never reaches resolvers; Kotlin ETag does not strip `meta.ms`; Kotlin 501 sends no `Allow`; manifests
differ; `cap` in neither manifest; Kotlin client has no RB and no `upload()`; `maxRecords` counts in-flight claims
on memory/JDBC but not on Postgres; `errorType` vs `type`/`title` between `fetch.ts` and `bindings.ts`.

**12 correctness.** TS live query loses changes committed during its first run; post-`fin` frames reachable on a
throwing idempotency `put`; `@live(false)` enforced nowhere; unsafe `POST` single-frame response carries no
`Cache-Control`; `@range` on a default never checked; `@page` on a query has no return-type check; reachability
never seeds from `ir.views`; `createBindingHandler` is Node-only so REST bindings cannot be served on a fetch
runtime; `client.upload()` is fetch-transport only; `JdbcStore` has no `screen()`; credit-based flow control
implemented nowhere (now Reserved); misleading WebSocket error strings.

## Not doing yet, and why

GraphQL endpoint, hosted registry, more runtimes. Every new surface multiplies the compatibility matrix, and the
reviewer and I agree the protocol should be reproducible by a third party before it grows another face.
