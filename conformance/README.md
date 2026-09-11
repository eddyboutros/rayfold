# Conformance suite

Fixtures are JSON files under `fixtures/<profile>/`. Each fixture provides a schema (inline `.rayfold` text), a set of in-memory data and resolvers described declaratively, a request batch, and the exact frames expected, in order (frames for different ops may interleave; the runner compares per-op sequences).

Both the TypeScript and Kotlin runtimes load the same fixtures. A runtime is Core-conformant when every fixture under `fixtures/core/` passes.

Fixture shape: see `src/fixture.ts`.
