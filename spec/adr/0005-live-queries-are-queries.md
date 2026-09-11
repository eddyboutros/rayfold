# ADR 0005: The query is the subscription

Status: accepted (2026-09-09)

`"live": true` keeps a query open. The server records the read set (entity keys + reachable entity types),
re-runs on intersecting changes from the change bus (fed by command patches and adapters), diffs, and
sends a minimal `patch` or a fresh `data` frame. Type-level intersection is deliberately conservative;
adapters may narrow it but must not change frame meaning.

Alternatives rejected: a separate subscription type with hand-written publishers (GraphQL), and
database-coupled sync engines (vendor lock-in).
