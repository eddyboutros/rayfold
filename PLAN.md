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

## 1. The conformance vector pack — 7 of 10 areas

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
- [ ] **`errors/`** — problem documents vs error frames, the lower-case title, the op-rooted detail path.
- [ ] **`idempotency/`** — viewer scope, binding hash, `already_exists` on reuse, lease and takeover.
- [x] **`authorization/`** — 11 cases, the denial table row for row. **The first vector to fault TypeScript.** A
      denied entity in a `[Secret?]` list read as `null` there and failed the operation on the JVM; spec 06 §3 says a
      list element fails whatever its nullability, so TypeScript was wrong and is fixed. Two call sites needed it —
      the nested-field path (`executor.ts:479`) as well as the top-level list path — and only the second showed up
      first, so the fix looked applied while the vector stayed red.
      Worth noting what was *not* done: the other reading is defensible — `[Secret?]` does admit null, so returning
      one leaks nothing — but rewriting a frozen Core rule to match whichever runtime was looked at last is the exact
      failure this pack exists to prevent. If the rule is wrong it is a Core 0.2 question.
- [ ] **`patch/`** — blocked on the chapter below.

**Scoreboard: 8 spec gaps, 5 code defects** — 4 in Kotlin, 1 in TypeScript. Six of the eight gaps were found before
running any code, including the two biggest: a vector that could not be written at all (the IR defined by pointing at
a file), and the built-in definitions the rewritten §9 still omitted.

## 2. The patch chapter — largest piece, not started

The reviewer's framing: the question stops being "can Rayfold send a patch?" and becomes **"can a client maintain a
correct representation of server state over time?"** Not a formalism — an executable model.

- [ ] State machine: client at revision N, patch N+1 arrives, contiguous → apply, gap → resync.
- [ ] **Entity revisions, which do not exist today.**
- [ ] Patch ordering, atomicity, replay.
- [ ] Deterministic answers for: authorization change, entity deletion, collection membership change, pagination
      boundary change, reconnect, duplicate patch, old patch.
- [ ] Property test: `apply(all patches, initial state) == fresh query(final server state)` over generated sequences
      of insert/update/delete/invalidate/reorder/pagination/authorization change.
- [ ] Then `patch/` vectors, with `initial state` / `operations` / `expected final state`.

## 3. Rayfold Commerce, then an independent implementation

- [ ] The reference app: multi-tenant + authorization + pagination + live orders + nested entities + idempotency +
      reconnect + multiple servers + cache, all at once. Then broken on purpose — his Tests A–D (authorization
      change mid-subscription, collection mutation across a page boundary, reconnect, kill a server mid-flight).
- [ ] An independent implementation, by someone given only the spec, the vectors and examples. Where they ask
      "what does this mean?" is the specification's remaining ambiguity.

## 4. Open defects from the documentation audit — 22 of 28

Full list with file:line in `scratchpad/code-bugs-next-phase.md`. Six are closed: the three security defects, and
Kotlin's number form, `@defer` parser, unpaired surrogate and manifest members — **the last four closed by the vector
pack rather than individually**, which is the point of building it.

**Pull forward regardless of the pack:**
- [ ] **Kotlin's IR omits `extensions`** (`Ir.kt`), and `IrJson.of` leaves it out of the hash input — a genuine
      schema-hash divergence. `hashing/` should catch it.
- [ ] **TS live query loses changes committed during its first run** (`batch.ts:475` awaits `collect()`, subscribes
      at `:493`). Kotlin subscribes first and treats an unset read set as dirty. A silent data-correctness race.

**Remaining cross-runtime (~8):** list-element policy denial (TS returns null, Kotlin fails the op — spec says
Kotlin); Kotlin drops stream-item `errors`; `isCancelled` never wired, so `Values.isCancelled()` is always false;
no `meta` on the Kotlin context, so `traceparent` never reaches resolvers; ETag does not strip `meta.ms`; 501
without `Allow`; `cap` in neither manifest, so by process.md no client may use capability tokens; Kotlin client has
no RB and no `upload()`; `maxRecords` counts in-flight claims on memory/JDBC but not on Postgres.

**Remaining correctness (~12):** post-`fin` frames reachable on a throwing idempotency `put`; `@live(false)`
enforced nowhere; unsafe `POST` single-frame response carries no `Cache-Control`; `@range` on a default never
checked; `@page` on a query has no return-type check; reachability never seeds from `ir.views`;
`createBindingHandler` is Node-only so REST bindings cannot be served on a fetch runtime; `client.upload()` is
fetch-transport only; `JdbcStore` has no `screen()`; credit-based flow control implemented nowhere (now Reserved);
misleading WebSocket error strings; `errorType` vs `type`/`title` between `fetch.ts` and `bindings.ts`.

## 5. Not doing yet, and why

GraphQL endpoint, hosted registry, more runtimes. Every new surface multiplies the compatibility matrix, and the
reviewer and I agree the protocol should be reproducible by a third party before it grows another face.

## 6. Owner's own list

- [ ] Reply to the reviewer — he asked for the fixture pack when it exists, and there is now a concrete result to
      send: five spec gaps and four code defects, four of the gaps found before running any code.
- [ ] `rayfold check --strict` wording; "Enforce HTTPS" in the Pages settings.
- [ ] Decide whether `PLAN.md` and `engineer-response.md` belong in a public repo.
