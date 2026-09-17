# How the specification changes

The specification has other implementers in mind: anyone who passes the conformance fixtures can call their server
Rayfold. That only works if the documents change slowly and in the open.

## Status of each part

| Part | Status | What may change |
|---|---|---|
| Core 0.1 (documents 01 to 07, 12, 13) | **Frozen** with the 0.1.0 release | Errata and clarifications that no conformant implementation fails. Anything else waits for Core 0.2. |
| Core tooling 0.1 (document 11) | **Frozen** with the 0.1.0 release | As above. Evolution binds the `rayfold` CLI rather than a server, so an implementation is conformant without it. |
| Extension `live` (08) | Draft | Anything, announced in the changelog, with the fixtures updated in the same change. |
| Extension `rb` (09) | Draft | As above. The byte format keeps decoding what earlier 0.1 encoders wrote. |
| Extension `mcp` (10) | Draft | Follows the MCP specification it bridges to. |
| Extension `http` (04 §8) | Draft | As above. |
| Extension `upload` (04 §9) | Draft | As above. |
| Extension `cap` (06 §6) | Draft | As above. |

A server says which extensions it serves in the manifest (`GET /rayfold/manifest`, `extensions`), and a client uses an
extension only when it is listed there.

## What a requirement's status means

The table above says how fast a document may change. This one says what a requirement inside it obliges, because the
two are different questions and conflating them is how a specification comes to describe something nothing does.

| Status | Meaning |
|---|---|
| **Normative** | Required for conformance. An implementation that does not do it is not conformant. |
| **Implemented** | Normative, and done by both reference runtimes today. |
| **Reserved** | Specified so the shape is fixed and the name is taken, but not usable yet. A server refuses it; a client must not send it. |
| **Experimental** | Usable, and subject to change without waiting for the next Core version. |
| **Informative** | Explanation. Nothing is obliged by it. |

Unmarked text in a Core document is normative. The rule that matters:

> A reference implementation MUST NOT silently implement less than the normative specification.

Where an implementation falls short, one of two things happens and both are visible: the requirement is demoted to
**Reserved** in the same change, or the gap is recorded as a known defect. What must not happen is a MUST sitting in a
document that neither runtime honours — a reader has no way to tell that from a MUST that works, and an implementer
building from the text will get it wrong in a way the reference implementations never will.

Credit-based flow control ([04 §5](04-frames-and-transport.md)) is the worked example: it was written as a MUST,
implemented nowhere, and is now Reserved.

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
