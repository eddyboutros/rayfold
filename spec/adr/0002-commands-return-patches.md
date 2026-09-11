# ADR 0002: Commands always return result plus patches

Status: accepted (2026-09-09)

Every command frame carries a `patch` list keyed by global identity `Type:id`. The runtime derives `set`
patches from the projected result automatically; resolvers add `set`/`del`/`inv`/`invOp` for side effects.
Clients apply patches to a normalized cache, so every earlier query result that contained an affected
entity is updated without a refetch.

Alternatives rejected: refetch-on-mutation (N extra round trips, stale windows), cache invalidation only
(loses the new values), client-side hand-written cache updates (the Apollo/Relay failure mode).
