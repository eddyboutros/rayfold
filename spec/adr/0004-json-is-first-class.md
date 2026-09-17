# ADR 0004: JSON is a first-class wire, RB is an optimisation

Status: accepted (2026-09-09)

Every feature must work over JSON with curl. RB (binary) encodes exactly the same frames using a
schema-derived key dictionary and a per-frame string table; a hash mismatch falls back to JSON.
Compact structs keyed by field ordinals are deferred: the dictionary approach represents unknown keys
(extensions, `JSON` scalars) without a schema round trip.

Measured (bench/results/latest.md): RB is roughly half the JSON size on the same frames.
