# ADR 0001: Nullability is opt-in

Status: accepted (2026-09-09)

Fields and results are non-null unless written `Type?`. GraphQL's default-nullable model pushes null
handling onto every client and makes "is this really optional" a guess. Real APIs are mostly required;
optional is the exception and should be spelled out.

Consequences: generated types are tighter; a resolver returning null for a non-null field is an
`internal` error (atomic), or `null` plus an `errors` entry when the field is `@partial`.
