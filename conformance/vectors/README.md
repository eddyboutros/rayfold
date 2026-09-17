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
| `shapes/` | `shape`, `canonical`, `id`, or `rejected` | Text → canonical form → shape id (spec 02 §3). The id is the SHA-256 of the canonical text in the same case, taken with a general-purpose digest, so a runtime is checked against the text *and* against the identity rather than only against itself. A `rejected` case is a shape the grammar does not admit. |
| `binary/` | `dictionary`, and `values` of `json` → `bytes` | RB tag bytes and the protocol key dictionary (spec 09 §2, §3). `dictionary` is the ordered list of 40 keys; the runner encodes `{key: 1}` for each and checks the id it lands on, since that is the id's only observable effect. Byte strings are hex. |
| `canonicalization/` | `json`, `canonical` | Canonical JSON (spec 01 §9) — the form the schema hash is taken over. Key ordering by UTF-16 code unit, the escape set, and the unpaired-surrogate rule. |
| `manifest/` | `members`, `rules` | The discovery document (spec 04 §4a). A document rather than a pure function, so this file pins the *contract* — which members exist, what kind of thing each is, and the rules relating them — and leaves the values free, since they depend on the schema and the configuration. Run against a live server on both sides. |
| `hashing/` | `bindings`, `scopes` | The idempotency binding and viewer scope (spec 12 §4.2): `SHA-256(canonical JSON)`, with the number rule. Each case carries the canonical text as well as the digest, so a failure says whether the canonicaliser or the hashing is at fault. |

**What `hashing/` cannot cover yet.** The third hash the protocol depends on — the **schema hash** — has no vector,
because spec 01 §9 gives the IR's top-level shape and then says the canonical definition is
`packages/schema/src/ir.ts`. The structure the protocol's identity is computed over is therefore defined by pointing
at one implementation, and an independent implementer cannot reproduce the hash without reading that file. That is
the reviewer's central warning sitting at the centre of the protocol, and writing the IR out normatively is the
prerequisite for closing it.

## Still to come

`canonicalization/`, `hashing/`, `shapes/` (input → canonical text → shape id), `binary/` (the RB dictionary, whose
key count is load-bearing), `manifest/`, `errors/`, `idempotency/`, `authorization/`, and `patch/` last, since it
needs semantics that are not yet written down. See `PLAN.md`.
