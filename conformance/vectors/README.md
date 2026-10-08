# Conformance vectors

A **vector** is a pure function and the answer the specification says it has: an input, the canonical form it takes,
the hash it produces, or the error it must raise. Some areas need a server and run against a real one, down to raw
HTTP requests (`http/`), a socket (`websocket/`) and JSON-RPC calls (`mcp/`). A **fixture** (`../fixtures`) is a
different artifact — a request and the frames a server must answer it with.

Both runtimes run these files, every case and every rule in them, so a change to either one fails a test rather
than quietly parting two fleets. The runners sit next to what they check: `packages/schema/src/vectors.test.ts` for
the pure functions, `packages/schema/src/validation-vectors.test.ts` for which schemas load, `packages/rb/src/vectors.test.ts`
for the codec, `packages/server/src/{manifest,error,idempotency,authorization,http,websocket,mcp}-vectors.test.ts` for
the areas that need a server, and `patch-vectors.test.ts` / `PatchVectorsTest.kt` for the client cache. On the JVM,
`VectorsTest.kt` runs the areas that were there first, standing up a real server for the ones that need one, and
`ValidationVectorsTest.kt`, `HttpVectorsTest.kt`, `WebSocketVectorsTest.kt` and `McpVectorsTest.kt` run the four
named for them. A runner that meets a case or rule it has no assertion for fails rather than skipping it.

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

Each file is one area (`hashing/` is the exception: two files, because the schema hash is a different function
from the two small ones):

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
| `binary/` | `dictionary`, and `values` of `json` → `bytes`; `nonFinite` of `double` → `bytes`; `refused` | RB tag bytes and the protocol key dictionary (spec 09 §2, §3). `nonFinite` names a double JSON cannot hold (NaN, the infinities), which RB writes as null as JSON does. `dictionary` is the ordered list of 40 keys; the runner encodes `{key: 1}` for each and checks the id it lands on, since that is the id's only observable effect. Byte strings are hex. |
| `canonicalization/` | `json`, `canonical` | Canonical JSON (spec 01 §9) — the form the schema hash is taken over. Key ordering by UTF-16 code unit, the escape set, and the unpaired-surrogate rule. |
| `manifest/` | `members`, `rules` | The discovery document (spec 04 §4a). A document rather than a pure function, so this file pins the *contract* — which members exist, what kind of thing each is, and the rules relating them — and leaves the values free, since they depend on the schema and the configuration. Run against a live server on both sides. |
| `patch/` | `result`, `patch`, `expect`; optional `shape`, `stale`, `unheld`, `merge`, `predict`, `refetch` | Applying a patch to a client's cache (spec 13 §3). An initial result, a patch, and the result a client must hold afterwards, materialised — so the expectation says nothing about how a cache stores anything, which is what lets one file check both. `shape` is the selection the result was asked with; `stale` is which of the result's entities, and whether the result itself, are marked for refetch afterwards (`inv`, `invOp`); `unheld` sends the patch for a result the client never stored — same op, other arguments — so the held one must see only the cache-wide operations. `merge`, `predict` and `refetch` pin `@merge` (spec 08 §5): the schema's policies, an optimistic prediction shown over the result, and the result's data arriving again without a `set`. |
| `errors/` | `statuses`, `cases` | Which HTTP status each code derives (spec 05 §3), and the rule that decides *how* a refusal arrives: a problem document before a batch is parsed, an error frame once it has been. |
| `idempotency/` | `ops`, `expect`; optional `store`, and an op's `at` and `with` | What a key promises and to whom (spec 12 §4, 03 §4): replay against re-run counted at the resolver, `already_exists` on reuse, the key bounds, that two viewers choosing one key do not collide, that `@idempotent(false)` ignores a key, the instant a record expires (an op's `at` sets the server clock), and that a store failing to record a committed command (`store: failsToRecord`) leaves the op its success and its dependent (`with`, sent in the same batch) running. |
| `authorization/` | `cases` | The denial table of spec 06 §3, row for row — including the list-element row the two runtimes disagreed on. |
| `hashing/` | `bindings`, `scopes`; `schema.json` has `cases` and `documentCases` | The idempotency binding and viewer scope (spec 12 §4.2): `SHA-256(canonical JSON)`, with the number rule. Each case carries the canonical text as well as the digest, so a failure says whether the canonicaliser or the hashing is at fault. |
| `validation/` | `schema`, `expect` (`accepted`/`rejected`); optional `irEdit`, `irHas`, `sameAs` | Which schemas load (spec 01 §1, §3, §4, §7, §8), each rejection beside a guard that must load. Diagnostic codes are not pinned, because the spec does not name them. `irEdit` edits the parsed IR before validation, for IR only importers, builders and lock files can write; grammar cases pin what text means through `irHas` and `sameAs` (an equal schema hash). |
| `http/` | `route`, `server`, `request`, `expect`; optional `badRequestTarget` | What the HTTP endpoint and the REST bindings answer to real requests (spec 04 §4, §4a, §4b, §8; 07 §2; 12 §2): `Accept-Post` on 415, query strings that are not percent-encoding, the exact mount, weak, listed and `*` `If-None-Match`, the smallest `swr`, the Origin rule behind TLS, CORS preflight and `Vary: Origin`, a live query sent as a safe request, `http` in the manifest only when served, a `Long` past 2^53, and `@http(name:)` wire names in bindings and OpenAPI. Run on every entry point: the Node and fetch handlers, the JDK server and `RayfoldHttp.serve`. |
| `websocket/` | `schema`, `data`, `budget`, `clock`, `viewer`; cases with `viewer`, `hook`, `connect`, `steps` | The WebSocket transport (spec 04 §5, 12 §3.1) over a real socket with a raw RFC 6455 client: 1007 on text that is not UTF-8, the `schema` parameter and 4409 (the server's own and the public manifest's hash accepted), `{cancel}` stopping one op, a refused batch answered for each op id, the viewer hook's handshake status, and a capability's socket ending at `exp` with 1008, on an injected clock. |
| `mcp/` | `steps` of `request` and `expect`; optional `runs` | The MCP bridge (spec 10, and 12 §3.1 for the body cap): notifications are 202 with no body whatever their method, a body or batch entry that is not an object is -32600, a HeaderMismatch reply carries `MCP-Protocol-Version`, resource URI arguments are coerced by type, a default-view tool result validates against its `outputSchema`, the call key separates operations and replays a repeated call, and a body over 1 MiB is a 413. |

`hashing/schema.json` is the one worth reading first. Writing it was blocked, because spec 01 §9 gave the IR's
top-level shape and then deferred to `packages/schema/src/ir.ts` for the rest — so the structure the protocol's
identity is computed over was defined by pointing at one implementation, and nobody outside could reproduce a schema
hash. §9 now carries the whole structure, and that file is the evidence it worked: both hashes in it were produced by
building the IR by hand from the document, with a canonicaliser written for the purpose and a general-purpose digest,
and both matched the runtime exactly.

Its `documentCases` are stated over the IR **document** rather than over schema text, because no schema text produces
an `extensions` member — the one part of the IR left out of the hashed form. That is the only way to state the rule
as a case, and it is worth the special shape: a runtime whose IR cannot hold the member passes the hash half of the
case by accident, so the runners check the member survives a load as well. Kotlin's did not, which is how that got
found.

## What each area has found

Writing these produced **8 specification gaps and 7 implementation defects**, and six of the gaps were found before
any code ran — by trying to state the answer and discovering the document could not. The largest were canonical JSON
defined in one sentence (spec 01 §9), the IR defined by pointing at a TypeScript file, and the built-in definitions
that the rewritten §9 still omitted. The defects were five in Kotlin, one in TypeScript, and one in both clients: a
deletion under a live list removing two rows, which the `patch/` area now has a regression case for. The last of the
five was found by the pack's own coverage rather than by a case — `hashing/schema.json` ran on one runtime only,
because the JVM's hashing runner looks for `bindings` and `scopes` and that file has neither. Writing the missing
runner is what surfaced an IR that could not hold `extensions` at all.
