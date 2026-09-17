# Working plan — towards 0.2.0

Tracking file for the current block of work. Not part of the published docs; decide before release whether it stays
as a contributor note — it is candid about defects and about my own mistakes, which suits a contributor and may not
suit a shop window.

## Where this plan came from

An external technical review of 0.1.0, my response, and the reviewer's follow-up (`engineer-response.md`). His answer
to "what would move your confidence most" reframed the work:

> An implementation-independent, published conformance suite whose fixtures are derived from a normative protocol
> specification and are sufficient for a third party to implement Rayfold without reading the TypeScript or Kotlin
> source.

with the rule that makes it worth anything:

> The fixtures must not be generated exclusively from the TypeScript implementation… Otherwise the two
> implementations can agree on the same wrong answer.

**The one-sentence goal:** don't prove TypeScript and Kotlin agree with each other; prove both agree with a protocol
that exists independently of either.

---

## Verification gate (run ALL of these before any push)

Three CI failures so far, each from running a subset. The full local equivalent:

```sh
npm run typecheck
npm test                                    # includes fuzz + property tests at default depth
npx tsx scripts/kotlin-oracle.ts && git diff --exit-code kotlin/rayfold-core/src/test/resources/oracle
npm run build                               # per-package configs are stricter than the root tsconfig
npm run smoke:packages
npm run docs:build
cd kotlin && ./gradlew check                # count JUnit XML; "up-to-date" means it did NOT run
```

Traps that have actually bitten, worst first:

- **`typecheck` is not `build`.** Root tsconfig has node types; per-package build configs set `"types": []`.
  `Buffer` in `packages/postgres` passed typecheck, failed the build. → CI failure.
- **The oracle files are generated *and* committed.** Changing any string the TS runtime emits into
  `kotlin/.../resources/oracle` needs them regenerated *and* the Kotlin side changed to match. → CI failure, twice.
- **Gradle "up-to-date" means nothing ran.** Count `tests=` from the JUnit XML. `./gradlew` lives in `kotlin/`;
  from the repo root it exits 0 having done nothing.
- **The fleet suite is skipped locally** (needs Postgres + the built JVM member) and several tests are
  `skipIf(win32)`. Anything touching drain, live queries or the relay is effectively untested here.
- **`e2e/*.json` churn on every run** (timestamps, random keys). Restore before committing.
- **A property test you have not seen fail proves nothing.** Run new properties against the pre-fix code. One of
  mine passed against the vulnerable code because its URLs used the wrong argument names.

---

## 1. The conformance vector pack — **complete, 10 of 10 areas**

`conformance/vectors/`, run by `packages/schema/src/vectors.test.ts`, `packages/rb/src/vectors.test.ts`,
`packages/server/src/manifest-vectors.test.ts` and `VectorsTest.kt`.

**Method:** write the expectation from the spec, *then* run both runtimes. Every disagreement is a finding. Where a
vector cannot be written because the spec does not say, that is the most valuable output — it is the ambiguity an
independent implementer would have hit.

- [x] **`numbers/`** — 21 cases from ECMA-262 `Number::toString`. Found: Kotlin wrote `4.9e-324` for the minimum
      denormal where the rule gives `5e-324`, because Java's `Double.toString` must emit a digit after the point.
      Fixed by shortening while the value still round-trips.
- [x] **`canonicalization/`** — 15 cases. Found: spec 01 §9 defined canonical JSON — what the **schema hash** is
      taken over — in one sentence, never saying key order or escaping. Now specifies UTF-16 code-unit ordering, the
      escape set and the unpaired-surrogate rule. And Kotlin wrote unpaired surrogates through literally, which has
      no UTF-8 encoding, so the hash stopped being a function of the value. Fixed.
- [x] **`shapes/`** — 11 cases, text → canonical → id. Found: §3 never said how *arguments* separate, so two
      readings gave different ids for one shape; now a table of every separator. And Kotlin's `@defer` parser
      accepted what the grammar refuses. Fixed.
- [x] **`binary/`** — 18 cases plus all 40 dictionary ids. Both runtimes already correct; the count spec 09 got
      wrong is now pinned. Found: §2 never said which encoding form an encoder must use, so RB bytes were not a
      function of the value. Now shortest-form.
- [x] **`manifest/`** — the contract, not values. Found: Kotlin served 3 of 5 members; my own §4a had two errors (a
      `sha256:` prefix that does not exist, and calling the hash recomputable from a document that is redacted); and
      `manifest()` published every server option except `now` — a denylist where a public document needs an
      allowlist. All fixed. **UNCOMMITTED as of now.**
- [x] **`hashing/`** — 8 cases for the idempotency binding and viewer scope, each digest taken over the canonical
      text with a general-purpose SHA-256. Both runtimes agreed. **The finding is what could not be written:** the
      *schema hash* has no vector, because spec 01 §9 gives the IR's top-level shape and then defers to
      `packages/schema/src/ir.ts` for the canonical definition. The structure the protocol's identity is computed
      over is defined by pointing at one implementation — the reviewer's central warning, at the centre of the
      protocol. See the new task below.

- [x] **The IR is written out normatively** (spec 01 §9): document, TypeRef, TypeDef by kind, OpDef, ViewDef and
      Shape, FieldDef/ArgDef/EnumValueDef, Annotation and the four tagged values (`$ident`, `$duration`, `$expr`,
      `$type`), plus the two rules that make the hash stable — an optional member appears only when set, a flag only
      when true. §9 no longer says "canonical definition in `packages/schema/src/ir.ts`".
      **This settles the `extensions` divergence rather than picking a winner:** the hashed form now excludes
      `extensions`, because vendor data is ignored by implementations that do not know it, so an identity that moved
      with it would make two servers offering the same conversation look different and a gateway that strips vendor
      metadata look like a schema change. Kotlin already projected it out; TypeScript hashed the whole object and
      now does not. No published hash moves — nothing populates `extensions` today.
- [x] **`hashing/schema.json`** — the end-to-end proof. I built the IR by hand from §9 and §9.1a alone, with my own
      canonicaliser and a general-purpose digest, and **both hashes matched the runtime exactly** (`3035c666…` for
      the empty schema, `a7178902…` for one entity and one query). A third party can now reproduce a schema hash
      from the document.
      **Writing it found the gap in §9 immediately:** every IR carries the built-in definitions — twelve scalars,
      `Page`, `PageArgs`, each `builtin: true` — before a line of schema is read, and §9 as committed did not say so.
      An implementer would have hashed only their own declarations and matched nobody. Now §9.1a.
      **Only TypeScript ran it until 2026-09-17**, because `hashing()` on the JVM reads `bindings` and `scopes` and
      this file has neither — so the protocol's identity was checked against the document on one runtime. There is
      now a `schemaHash()` factory: the JVM agrees with both hand-built hashes and with the 1946-byte canonical
      length. It also runs `documentCases`, stated over the IR document because no schema text produces an
      `extensions` member, which is how Kotlin's inability to hold that member finally surfaced.
- [x] **`errors/`** — the 16-code status table plus the rule that decides *how* a refusal arrives: a problem
      document before a batch is parsed, an error frame once it has been. Both runtimes agreed on all of it. The one
      correction was mine — I guessed the 415 problem type was `payload_unsupported` when it is
      `unsupported_media_type`.
- [x] **`idempotency/`** — 10 cases: replay vs re-run (counted at the resolver, since matching answers alone would
      also be satisfied by a deterministic command), `meta.replay`, `already_exists` for a key reused on another
      operation or other arguments, the key bounds either side of 16 and 128, `@idempotent(false)`, and the row that
      matters most — **two viewers choosing the same key do not collide**, which an implementation scoping globally
      would turn into one caller receiving another's answer. Both runtimes agreed on all of it.
- [x] **`authorization/`** — 11 cases, the denial table row for row. **The first vector to fault TypeScript.** A
      denied entity in a `[Secret?]` list read as `null` there and failed the operation on the JVM; spec 06 §3 says a
      list element fails whatever its nullability, so TypeScript was wrong and is fixed. Two call sites needed it —
      the nested-field path (`executor.ts:479`) as well as the top-level list path — and only the second showed up
      first, so the fix looked applied while the vector stayed red.
      Worth noting what was *not* done: the other reading is defensible — `[Secret?]` does admit null, so returning
      one leaks nothing — but rewriting a frozen Core rule to match whichever runtime was looked at last is the exact
      failure this pack exists to prevent. If the rule is wrong it is a Core 0.2 question.
- [x] **`patch/`** — 10 cases: `set` field-level and idempotent, ordering, `del` keeping later positions, `list`
      del-then-ins positions, an insertion storing the row it carries, and **a regression case for the two-row
      deletion bug**, so that fix cannot be undone quietly. Both runtimes agree. The JVM runner lives in
      `rayfold-client` rather than `VectorsTest`, because the cache does.

**Scoreboard: 8 spec gaps, 6 code defects** — 4 in Kotlin, 1 in TypeScript, 1 in both clients (the two-row
deletion, which the property test in §2 found and `patch/` now guards). `errors/` and `idempotency/` found nothing
new and `authorization/` found one row, which is the shape you want near the end of a sweep. Six of the eight gaps were found before
running any code, including the two biggest: a vector that could not be written at all (the IR defined by pointing at
a file), and the built-in definitions the rewritten §9 still omitted.

## 2. The patch chapter — `spec/13-patches.md` written; the 0.2 half is not

Structured on the reviewer's §8 advice: make refetch deterministic *first*, and do not let resume inherit an
ambiguity. So 13 specifies what 0.1 actually guarantees, and names the rest Reserved rather than designing it.

- [x] **The chapter exists.** Patches were spread across 04 §2, 07 §3 and 08 and stated nowhere in one place, which
      is a large part of why the semantics were never pinned. 13 is Core, as a *clarification*: it adds no
      requirement a conformant 0.1 implementation does not already meet.
- [x] **The client model**: entities, results-as-references, staleness. Every operation, precisely — `set` is
      field-level, `del` removes every reference including a result's root (verified: that result holds `null`).
- [x] **Idempotence, and the one exception.** `set`, `del`, `inv`, `invOp` and `at` are all idempotent; **`list` is
      positional and corrupts if applied twice**. That single fact is why a resume cursor cannot be bolted on, and
      it had never been written down.
- [x] **Deterministic answers** for deletion, membership change, pagination boundary (a fresh `data` frame — there
      is no patch for a window that shifted), authorization change (nothing special: a denial is a change in the
      answer), a patch for a dropped result, and reconnect.
- [x] **What 0.1 does not guarantee**, said plainly: no cross-response ordering. `set` carries absolute values, so
      two patches for one entity racing on different connections settle by arrival order. Converges in practice
      because the live query re-executes after the command; not guaranteed. That is the honest case for revisions.
- [ ] **Reserved → 0.2: entity revisions.** Would turn the ordering caveat into a rule and make a duplicate `list`
      detectable, which is the precondition for any replay.
- [ ] **Reserved → 0.2: resume.** Needs retention, a revision to count from, and an answer for a cursor that is too
      old. Deliberately after the above.
- [x] **The property test** (`packages/client/src/patch-invariant.test.ts`): a live query open throughout, a
      generated sequence of adds, stock changes and removals, then the client's own view compared against a fresh
      execution. **It found a data-loss bug on the first sequence, in both clients.** A command deleting an entity
      while a live query held a list containing it removed *two* rows: `del` is cache-wide and shortened the
      client's list, then the positional `list del: [0]` computed against the list the server had last sent took out
      whatever moved into the slot. Fixed in both caches — a deleted entity now leaves a gap that holds its position
      and is hidden when materialising, so the server's positional information stays true. 250 sequences clean.
- [x] **`patch/` vectors** — see the pack above.

## 3. Rayfold Commerce, then an independent implementation

- [ ] The reference app: multi-tenant + authorization + pagination + live orders + nested entities + idempotency +
      reconnect + multiple servers + cache, all at once. Then broken on purpose — his Tests A–D (authorization
      change mid-subscription, collection mutation across a page boundary, reconnect, kill a server mid-flight).
- [ ] An independent implementation, by someone given only the spec, the vectors and examples. Where they ask
      "what does this mean?" is the specification's remaining ambiguity.

## 4. Open defects — 5 left, all feature-sized

Fifteen closed on 2026-09-18, each with a test and each mirrored in both runtimes where both were wrong:

- **Conformance:** an unsafe `POST` single-frame response now carries `no-store` (spec 07 §3) in both runtimes; a
  second terminal frame for one op is impossible, guarded in `FrameSink` rather than at each call site that could
  push one (spec 04 §2); an `item` frame carries `errors` top-level rather than inside `meta`, and Kotlin no longer
  drops them; `@live(false)` is enforced; the RFC 9457 problem document uses one name for a domain error's type
  instead of `errorType` beside it; the WebSocket handler no longer advertises stream items it cannot handle.
- **Validator, both runtimes:** `@page` on a non-`Page` operation is refused; a field returning `Page<T>` must accept
  page arguments, as spec 01 §9 always said; views seed reachability (rule 9); and an unquoted `@deprecated(sunset:)`
  date is refused instead of lexing into three numbers and leaving a deprecation that could never be retired.
- **JVM:** `isCancelled` is wired to the op's job, so `Values.isCancelled()` answers truthfully; the context carries
  the envelope's `meta`, so `traceparent` reaches resolvers; a 501 says `Allow`; the ETag stops digesting `meta.ms`.
- **Postgres:** `maxRecords` counts keys in flight and never evicts a live claim (spec 12 §3), so the bound means
  what it means on the memory and JDBC stores.
- **Specification:** `cap` is documented as not negotiated through the manifest (spec 06 §6) — a token is a bearer
  credential, so there was never anything to negotiate, and 04's unlisted-extension rule does not reach it.

What is left is not defect work. Each is a feature someone has to want:

- [ ] **A fetch-runtime `@http` binding handler.** `createBindingHandler` is written against Node's `req`/`res`, so
      REST routes are served on Node only. `docs/guide/runtimes.md` says so.
- [ ] **`upload()` on the WebSocket transport.** It throws `unimplemented` there; a fetch transport is the way.
- [ ] **RB and `upload()` in the Kotlin client** (`Transport.kt:92` hard-codes JSON).
- [ ] **`JdbcStore.screen()`**: the whole-screen single-statement compiler is Node-only.
- [ ] **Credit-based flow control** (spec 04 §5), which the spec now calls Reserved rather than a MUST, so there is
      no non-conformance to fix — only a feature to build.

One thing deliberately left as it is: `@range` on a default is never checked (`args.ts:20`, `Args.kt:23`). Spec 01
scopes the rule to values a caller actually sent, so both runtimes are conformant; checking defaults would be better
but it is a change to the rule, not a fix to the code.

## 5. Not doing yet, and why

GraphQL endpoint, hosted registry, more runtimes. Every new surface multiplies the compatibility matrix, and the
reviewer and I agree the protocol should be reproducible by a third party before it grows another face.

## 6. Owner's own list

- [ ] Reply to the reviewer — he asked for the fixture pack when it exists, and there is now a concrete result to
      send: eight spec gaps and six code defects, six of the gaps found before running any code.
- [ ] `rayfold check --strict` wording; "Enforce HTTPS" in the Pages settings.
- [ ] Decide whether `PLAN.md` belongs in a public repo (`engineer-response.md` is deleted).

## 7. Cutting 0.2.0

- [ ] Re-read the markdown against the code one more time, as agreed at the start of this block: the pack, the patch
      chapter and the IR rewrite all moved text, and 67 files were corrected before any of that landed.
- [ ] Bump 0.1.0 to 0.2.0 across the npm workspaces and the Gradle build, write the changelog entry, tag, publish to
      npm and Maven Central, then check rayfold.dev.
- [ ] Decide which of the 20 open defects block the release. The most serious left are post-`fin` frames being
      reachable (a spec 04 violation), `@live(false)` enforced nowhere while an example declares it, and an unsafe
      `POST` single-frame response missing `no-store`. None is a cross-runtime disagreement.
