# Versioning

Three things carry a version, and they move independently.

## Packages

The npm packages (`@rayfold/*`) and the Maven artifacts (`dev.rayfold:*`) share one version number, set everywhere at
once by `node scripts/set-version.mjs <version>`. They follow [Semantic Versioning](https://semver.org):

- **Before 1.0**, a minor version (0.1 to 0.2) may change public APIs; the changelog says what changed and how to
  move. A patch version (0.1.0 to 0.1.1) only fixes bugs and security problems.
- **From 1.0**, breaking changes wait for a major version, and anything removed is deprecated for at least one minor
  version first.
- Only the latest minor version gets fixes ([SECURITY.md](../SECURITY.md)).

A published version is never replaced: a mistake is fixed by the next patch version.

## The protocol

The `rayfold` field of an envelope and of the manifest names the protocol version (`"0.1"`). Core 0.1 is frozen with
the first release; extensions are drafts until they are declared stable. [spec/process.md](../spec/process.md) says
what may change in each and how changes are proposed. A package release may add or change draft extensions; it never
changes what a Core 0.1 request means.

## Your schema

APIs built on Rayfold do not carry version numbers. A schema evolves additively: add fields, operations and enum
values; mark what is going away with `@deprecated(sunset: 2027-06-30, replacement: "...")`; and let `rayfold check`
refuse removals before their sunset date and changes that would break existing clients ([spec 11](../spec/11-evolution.md)).
