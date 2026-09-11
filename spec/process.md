# How the specification changes

The specification has other implementers in mind: anyone who passes the conformance fixtures can call their server
Rayfold. That only works if the documents change slowly and in the open.

## Status of each part

| Part | Status | What may change |
|---|---|---|
| Core 0.1 (documents 01 to 07, 11, 12) | **Frozen** with the 0.1.0 release | Errata and clarifications that no conformant implementation fails. Anything else waits for Core 0.2. |
| Extension `live` (08) | Draft | Anything, announced in the changelog, with the fixtures updated in the same change. |
| Extension `rb` (09) | Draft | As above. The byte format keeps decoding what earlier 0.1 encoders wrote. |
| Extension `mcp` (10) | Draft | Follows the MCP specification it bridges to. |
| Extension `http` (04 §8) | Draft | As above. |

A server says which extensions it serves in the manifest (`GET /rayfold/manifest`, `extensions`), and a client uses an
extension only when it is listed there.

## Proposing a change

1. Open an issue with the "Specification change" template: the problem, who it affects, and the change you suggest.
2. Once the approach is agreed, one pull request carries all of it: the spec text, a conformance fixture that fails
   without the change, and the change in **both** runtimes (TypeScript and Kotlin), so the fixture passes in each.
3. A change that alters what an existing request returns needs a note in `CHANGELOG.md` and, for Core, waits for the
   next Core version.

## Rules the documents keep

- **Core stays small.** Anything a plain create-read-update-delete application does not need is an extension.
- **JSON is never the lesser mode.** Every feature works over JSON with curl; RB only saves bytes.
- **The fixtures are the contract.** Prose and fixtures must agree; when they do not, the fixture shows the intent and
  the prose is fixed.
- **No version numbers in APIs.** Schemas evolve additively, with `@deprecated(sunset:)` ([11](11-evolution.md)).

Decisions with lasting consequences are recorded as architecture decision records in [`adr/`](adr/).
