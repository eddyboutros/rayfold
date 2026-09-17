# Conformance vectors

A **vector** is a pure function and the answer the specification says it has: an input, the canonical form it takes,
the hash it produces, or the error it must raise. A **fixture** (`../fixtures`) is a different artifact — a request
and the frames a server must answer it with.

Both runtimes run these files. `packages/schema/src/vectors.test.ts` and
`kotlin/rayfold-core/src/test/kotlin/dev/rayfold/core/VectorsTest.kt` read exactly what is here, so a change to
either runtime's canonicaliser fails a test rather than quietly parting two fleets.

## The rule that makes them worth having

> **Expectations are written from the specification, never captured from a runtime.**

A vector recorded from an implementation proves the implementations agree. That is not the property anyone needs.
Rayfold's own history makes the point: spec 09 listed 38 protocol keys while both codecs held 40, and every test
passed for months, because the TypeScript client only ever spoke to the TypeScript server and the Kotlin client to
the Kotlin server. Both sides agreed with each other and neither agreed with the document. A third implementation
would have failed immediately, and had nothing to check itself against.

So when a vector disagrees with a runtime, the question is not "which runtime is right" but **"what does the
specification say"** — and the answer may be that the runtime is wrong. The first file here found exactly that:
Kotlin wrote `4.9e-324` where the rule the spec names produces `5e-324`, because Java's `Double.toString` must emit a
digit after the point and ECMAScript's rule asks only for the fewest digits that read back. Both round-trip; only one
follows the rule.

If a vector cannot be written because the specification does not say, that is the most valuable thing the exercise
produces. It is the question an independent implementer would have had to guess at.

## Shape

Each file is one area:

```json
{
  "name":   "area/what-it-covers",
  "about":  "why this matters, in terms of what breaks without it",
  "source": "the external authority the expectations come from",
  "rule":   ["the normative rule, restated so a reader can check the cases by hand"],
  "cases":  [{ "name": "...", "why": "optional: why this case exists", "...": "area-specific fields" }]
}
```

| Area | Case fields | Covers |
|---|---|---|
| `numbers/` | `literal`, `canonical` | How a number is written when hashed (spec 12 §4.2). The literal is text so the file keeps it exactly as a client would send it — parsing is part of what is under test, since it is where `2.50` and `2.5` become one number. |

## Still to come

`canonicalization/`, `hashing/`, `shapes/` (input → canonical text → shape id), `binary/` (the RB dictionary, whose
key count is load-bearing), `manifest/`, `errors/`, `idempotency/`, `authorization/`, and `patch/` last, since it
needs semantics that are not yet written down. See `PLAN.md`.
