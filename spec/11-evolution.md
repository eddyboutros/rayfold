# 11 - Evolution

Rayfold schemas have no version numbers. Compatibility is enforced by tooling on every change.

## Compatible changes (allowed)
* Adding a type, operation, field, enum value, error to a `throws` list, event to an `emits` list.
* Making a required argument optional (giving it a default), or a nullable result field non-null.
* Adding an annotation that does not restrict (`@cost`, `@example`, `@deprecated`).

## Breaking changes (rejected by `rayfold check`)
* Removing or renaming anything that is not past its `@deprecated(sunset:)` date.
* Changing a field or argument type, including nullability in the restrictive direction (result field non-null to nullable is breaking for clients that rely on it; argument optional to required is breaking for callers).
* Removing an enum value or union member.
* Adding a required argument without a default.
* Adding a policy that can deny where none existed (reported as a warning in `WIRE` mode, error in `STRICT` mode).
* Changing an ordinal.

## Deprecation
`@deprecated(reason:, sunset: Date, replacement:)`. Removal is allowed only after `sunset`. Servers report usage of deprecated members per client (`Rayfold-Client`) so removal is a fact, not a guess.

## Field usage telemetry
Runtimes record (op, field path, client, last seen). `rayfold check --unused --since 30d` lists members with no traffic, using an exported usage snapshot.

## Lockfile
`rayfold.lock.json` records ordinals and the schema hash. `rayfold lock` updates it; CI runs `rayfold check --against rayfold.lock.json`.
