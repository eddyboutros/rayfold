---
title: Command line
description: Every rayfold command. Validate a schema, record its ordinals, generate types, read a plan, mock a server, and run the language server.
---

# Command line

`rayfold` ships with `@rayfold/cli`. Run it without installing anything:

```sh
npx @rayfold/cli check schema.rayfold
```

Or add it to the project with `npm install --save-dev @rayfold/cli`, after which `npx rayfold ...` runs the installed
copy. The examples on this page use the short form.

Apart from `mock` and `dev`, which serve, and `lsp`, which talks to an editor, every command reads its files and does
its work without a server, a database or a network, so each one runs in CI. `check` is the one that belongs in a
pipeline; the others are for local use.

**Exit codes.** `0` succeeded. `2` the command line was malformed: an unknown command, a missing argument, a bad
`--since`. `1` everything else: an invalid schema, a refused change, resolvers that do not cover the schema, or a file
or target that could not be read or is not supported. A pipeline can treat anything non-zero as failure.

## check

```sh
rayfold check <schema.rayfold> [--against <old.rayfold|rayfold.lock.json>] [--strict]
rayfold check <schema.rayfold> --resolvers <module>
rayfold check <schema.rayfold> --unused <usage.json> [--since 30d]
```

Validates the schema and prints every finding with the line it is on. With no options it reports whether the schema
is valid:

```
OK: examples/bookstore-ts/bookstore.rayfold is valid (hash 7fb44054edd7)
```

`--against` compares with an earlier schema, or with a lockfile, and refuses a breaking change. With no `--against`
it uses `rayfold.lock.json` when one is beside you, so in a repository that has a lockfile the bare command already
checks compatibility. `--strict` also fails on warnings: compatible changes that deserve a look, such as a policy
added to an operation that had none. See
[Changing a schema safely](../learn/evolution.md) for what counts as breaking.

Ordinals are compared by name. Against a lockfile, every field and enum value keeps the ordinal the lock recorded for
it, so adding a field between two others, or reordering them, is compatible. Only two changes break: an
`@ordinal(n)` that disagrees with the lock (`ordinal-changed`), and a new member taking an ordinal the lock gave
another (`ordinal-reused`).

Between two `.rayfold` files there is no record of what was assigned, so both are numbered by position. A member that
moved is a warning (`ordinal-shifted`, fatal under `--strict`), and a changed `@ordinal(n)` is still breaking. Lock
the schema to let a field inserted mid-type pass without a warning.

::: info Since 0.2.2
Comparing ordinals by name, and `lock` keeping them by name with `highestOrdinals`, came with 0.2.2. In 0.2.1 both
number every type's fields by position.
:::

`--resolvers` loads a module and reports operations with no resolver and fields that take arguments with no loader
(both errors), and resolvers with nothing in the schema to attach to (warnings). A gap shows up here before a request
hits it. It runs alongside the compatibility check, and if either fails, the command fails.

`--unused` reads an exported usage snapshot and lists members no client asked for inside `--since` (default `30d`),
so you know a member is unused before you remove it. Servers record usage per client from the `Rayfold-Client` header.

## lock

```sh
rayfold lock <schema.rayfold> [--out rayfold.lock.json]
```

Writes `rayfold.lock.json`: the field ordinals the binary format depends on, and the schema hash. Commit it. With it
in the repository, `check` compares against it by default, so a changed or reused ordinal fails in CI rather than
corrupting a decode in production.

Run over an existing lock, it keeps the ordinals that lock recorded. Every field and enum value keeps its number by
name, wherever it now sits in the type. A new one gets the next number above any the type has ever used, so a
removed member's number is never handed out again. A written `@ordinal(n)` is recorded as written.
The lock keeps each type's highest number so far in `highestOrdinals`.

## hash

```sh
rayfold hash <schema.rayfold>
```

Prints the schema hash alone, with no other output:

```
7fb44054edd70f691d3560cc27959509a762762ba7a914a573f741cb6daf58a3
```

This is the value a server publishes in its manifest and sends as `Rayfold-Schema` on every response. Use it in a
deploy script to assert that the schema you built is the one running. It is the SHA-256 of the canonical IR, which
[spec 01 §9](../../spec/01-schema.md) defines exactly, so an independent implementation computes the same value.

## explain

```sh
rayfold explain <schema.rayfold> <op> [--shape "{...}"] [--args '{...}']
```

Prints what an operation would do before it does it: its cost, its depth, how many loader calls each level takes, and
which policies can be pushed down to the data source.

```sh
rayfold explain bookstore.rayfold books --shape "{ items { id title author { name } } }"
```

```
query books(): cost 46, depth 3, 5 fields
shape: { items { author { name } id title } }
policy: none
plan:
level 0: Page<Book>
  items: loader (batch, 1 call)
  level 1: [Book]
    id: property
    title: property
    author: loader (batch, 1 call)
    level 2: Author
      name: property
```

Read the call count on each level. A page of fifty books loads its authors in one call, not fifty. A level that says
otherwise is an N+1, and you see it before you ship it. `--args` matters when cost depends on a page size.

## gen

```sh
rayfold gen ts|kotlin|java|graphql <schema.rayfold> [--out file] [--package pkg] [--class Name]
```

Generates TypeScript interfaces, Kotlin data classes, Java records, or a GraphQL schema. Without `--out` it writes to
standard output.

```ts
/* Generated by `rayfold gen ts`. Do not edit. */

export interface Page<T> { items: T[]; cursor: string | null; hasMore: boolean; total?: number | null }
export interface PageArgs { first?: number; after?: string | null; offset?: number | null }
```

`--package` names the Kotlin or Java package; `--class` names the generated Java holder. `gen graphql` prints the SDL
and lists on standard error what it could not carry across, since GraphQL cannot express typed errors, live queries,
idempotency keys or several steps in one request. See [Coming from GraphQL](from-graphql.md).

If you write the schema in TypeScript with `@rayfold/builder` instead, you need none of this: the types are inferred
from the schema value ([Schema in TypeScript](typescript.md)).

## shapes

```sh
rayfold shapes <schema.rayfold> <shape-file>
```

Reads one shape per line and prints the id of each, as JSON keyed by id:

```json
{
  "sha256:8a8a5652e83f7c956b9e4fc03e448cf08471167eecee40ea410460c7e17efa07": "{ id title }",
  "sha256:eeb499070703347b22ad0472013d1cb915ba512c63c1442116735fd38c69950f": "{ author { name } id title }"
}
```

Use it with `trustedShapes` on. A server in that mode refuses shape text it was not given in advance and accepts only
ids, and this command prints those ids. Beside each id is the canonical form it was computed from.
`{ id title author { name } }` canonicalises with its fields sorted, so the same selection written in another order
has the same id. Register the ids in code so every server in a fleet agrees ([Deployment](deployment.md)).

## import

```sh
rayfold import openapi|graphql <file> [--out schema.rayfold]
```

Reads an OpenAPI document or a GraphQL SDL and writes a Rayfold schema. It lists on standard error what it could
not bring over, so you have the gaps as a list to work through. See
[Coming from REST](from-rest.md) and [Coming from GraphQL](from-graphql.md).

## mock

```sh
rayfold mock <schema.rayfold> [--port 4500]
```

Serves the schema with data the schema itself describes, and the explorer beside it, so screens can be built before
there are resolvers. The same request always gets the same answer, so a screen built against it does not flicker
between runs. `@example` values are used where a field has one.

## dev

```sh
rayfold dev <example-dir> [--port 4400]
```

Runs one of this repository's examples, a directory whose `src/index.ts` exports `createBookstore()`, with the explorer
in front of it: `npm run rayfold -- dev examples/bookstore-ts` in this repository. Beside the explorer it serves the
WebSocket endpoint and MCP at `/mcp`. It accepts any bearer token as a user id (`Bearer admin` is an admin), so use it
for local development only.

## lsp

```sh
rayfold lsp
```

The language server for `.rayfold` files, speaking LSP over stdio: diagnostics as you type, completion, hover,
go-to-definition and document symbols. Editors start it themselves; [Editors](editors.md) has the VS Code and
Neovim configuration.

## In CI

The command for a pipeline:

```sh
npx @rayfold/cli check schema.rayfold --against rayfold.lock.json --strict --resolvers ./src/resolvers.ts
```

It fails the build on a breaking change, on a compatible change that raises a warning, and, with `--resolvers`, when
the schema and the code no longer match. The module must export `resolvers`, a default export, or a function that
returns them.
