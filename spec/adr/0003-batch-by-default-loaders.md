# ADR 0003: Field loaders are batch by default

Status: accepted (2026-09-09)

An entity field resolver receives `parents[]` and returns `results[]`. The executor projects level by
level, so one loader call serves every parent at that depth, across lists and pages. N+1 cannot be
written by accident; per-parent loading is the explicit special case (`@load(single)`).

Consequences: resolver signatures differ from GraphQL's; `rayfold explain` shows one loader call per level.
