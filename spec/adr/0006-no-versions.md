# ADR 0006: No API versions

Status: accepted (2026-09-09)

Schemas evolve additively. `rayfold check --against rayfold.lock.json` rejects breaking changes; removal requires
`@deprecated(sunset:)` and a date in the past; field usage is recorded per client so removal is a fact.
Ordinals in the lockfile are reserved for a future compact-struct encoding; RB does not use them today, and
`rayfold check` only guards them against changing.
