---
title: Versioning
description: Which Rayfold version is published, which features each one added, and how packages, the protocol and your own schema are versioned.
---

# Versioning

## What is published

| Version | Date | Status |
|---|---|---|
| **0.1.0** | 2026-09-15 | Published. `npm install @rayfold/server` and `dev.rayfold:rayfold-core:0.1.0` give you this. |
| **0.2.0** | — | **Not published yet.** It is written, tested and documented in the repository; nothing on npm or Maven Central carries it. |

This site documents both, so a few pages describe things 0.1.0 does not have. Each of those says so where it is
taught, and the table below lists them together. Until 0.2.0 ships, pin `0.1.0` in a JVM build and let npm take the
latest — it is 0.1.0.

## What each version added

Everything the protocol itself does — batches, shapes, loaders, commands with declared errors, patches, live queries,
streams, policies, caching, idempotency, uploads, capability tokens, RB, MCP, `@http` routes and OpenAPI, relays,
health and readiness, the CLI and the editor server — is 0.1.0. Later versions add tooling and fix defects; Core 0.1
is frozen, so none of them changes what a request means.

| Feature | Since | Where |
|---|---|---|
| The protocol, both runtimes, and every client package | 0.1.0 | [Get started](./get-started/) |
| `@rayfold/react` | 0.1.0 | [React](./guide/react.md) |
| `@rayfold/postgres`, `@rayfold/otel`, the JDBC and Spring Boot modules | 0.1.0 | [Postgres](./guide/postgres.md), [Tracing](./guide/tracing.md) |
| `@rayfold/angular` | **0.2.0** | [Angular](./guide/angular.md) |
| Server identity and `GET {base}/stats` | **0.2.0** | [Deployment](./guide/deployment.md#what-a-server-will-tell-you) |
| `Counters` and `MemoryCounters` | **0.2.0** | [Deployment](./guide/deployment.md#counting-what-happened) |
| `maxStreamItems` on the TypeScript server (the JVM always had one) | **0.2.0** | [Streams](./learn/streams.md) |
| `closeTimeoutMs`, so a server still connecting to its relay can shut down | **0.2.0** | [CHANGELOG](https://github.com/eddyboutros/rayfold/blob/main/CHANGELOG.md) |
| Published conformance vectors | **0.2.0** | [Conformance](https://github.com/eddyboutros/rayfold/tree/main/conformance) |

[CHANGELOG.md](https://github.com/eddyboutros/rayfold/blob/main/CHANGELOG.md) has the rest, including the defects
each version fixed.

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
