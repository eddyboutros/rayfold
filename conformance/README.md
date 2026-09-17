# Conformance suite

Two kinds of artifact live here. A **fixture** is a request and the frames a server must answer it with; a **vector**
is a pure function and the answer the specification says it has — its own input, canonical form, hash or error. The
vectors have their own README, [`vectors/README.md`](vectors/README.md), and the rule that makes them worth having:
expectations are written from the specification, never captured from a runtime.

Fixtures are JSON files under `fixtures/<profile>/`. Each fixture provides a schema (inline `.rayfold` text), its parsed `ir`, a set of in-memory data and resolvers described declaratively, and a list of `cases`. Each case carries its own request batch, the viewer it runs as, and the exact frames expected, in order (frames for different ops may interleave; the runner compares per-op sequences); a case may also declare the loader `calls` it expects and a `repeat` count.

Both the TypeScript and Kotlin runtimes load the same fixtures. A runtime is Core-conformant when every fixture under `fixtures/core/` passes.

Fixture shape: see `src/fixture.ts`, which declares everything but the `ir` field that `src/add-ir.ts` writes into each file.
