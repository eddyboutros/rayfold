# 11 - Evolution

Rayfold schemas have no version numbers. Compatibility is enforced by tooling on every change.

Every change is one of three kinds: compatible, a warning, or breaking. `rayfold check --against <old>` reports all
three and fails on breaking ones; `--strict` also fails on warnings.

## Compatible changes (allowed)
* Adding a type, operation, field, enum value, event to an `emits` list.
* Removing an error from a `throws` list: a client's exhaustive handling still compiles.
* Making a required argument optional (giving it a default), or a nullable result field non-null.
* Adding an annotation that does not restrict (`@cost`, `@example`, `@deprecated`).

## Warnings (allowed, and fatal under `--strict`)
* Adding an error to a `throws` list: nothing breaks on the wire, but a client that handles the union exhaustively
  has a case it does not know.
* Adding a policy that can deny where none existed.
* Removing a policy: nothing breaks, but something that was guarded no longer is, which is worth seeing in a diff.

## Breaking changes (rejected by `rayfold check`)
* Removing or renaming anything that is not past its `@deprecated(sunset:)` date.
* Changing a field or argument type, including nullability in the restrictive direction (result field non-null to nullable is breaking for clients that rely on it; argument optional to required is breaking for callers).
* Removing an enum value or union member.
* Removing a view: a client that asks for it by name gets nothing.
* Dropping an interface a type declared.
* Adding a required argument without a default.
* Changing an ordinal.

## Deprecation
`@deprecated(reason:, sunset: Date, replacement:)`. Removal is allowed only after `sunset`. Servers report usage of deprecated members per client (`Rayfold-Client`) so removal is a fact, not a guess.

## Field usage telemetry
Runtimes record (op, field path, client, last seen). `rayfold check --unused --since 30d` lists members with no traffic, using an exported usage snapshot.

## Lockfile
`rayfold.lock.json` records ordinals and the schema hash. `rayfold lock` updates it; committing it and running
`rayfold check --against rayfold.lock.json` in CI is what turns these rules into a build failure rather than a
convention.

## What implements this
Unlike the rest of Core, evolution is a tooling contract rather than a wire contract: it is the `rayfold` CLI that
enforces it, and there is no obligation on a server at runtime. An implementation in another language is conformant
without shipping a diff tool.
