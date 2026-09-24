---
title: Command line
description: Every rayfold command — validate a schema, record its ordinals, generate types, read a plan, mock a server, and run the language server.
---

# Command line

`rayfold` ships with `@rayfold/cli`. Run it without installing anything:

```sh
npx @rayfold/cli check schema.rayfold
```

Or add it to the project with `npm install --save-dev @rayfold/cli`, after which `npx rayfold ...` runs the installed
copy. The examples on this page use the short form.

Every command takes a `.rayfold` file and does its work without a server, a database or a network. That is what makes
them usable in CI: `check` is the one that belongs in a pipeline, and the rest are for the desk.

**Exit codes.** `0` succeeded. `2` the command line was malformed: an unknown command, a missing argument, a bad
`--since`. `1` everything else: an invalid schema, a refused change, resolvers that do not cover the schema, or a file
or target that could not be read or is not supported. A pipeline can treat anything non-zero as failure.

## check

```sh
rayfold check <schema.rayfold> [--against <old.rayfold|rayfold.lock.json>] [--strict]
rayfold check <schema.rayfold> --resolvers <module>
rayfold check <schema.rayfold> --unused <usage.json> [--since 30d]
```

Validates the schema and prints every finding with the line it is on. On its own it answers whether the schema is
valid at all:

```
OK: examples/bookstore-ts/bookstore.rayfold is valid (hash 7fb44054edd7)
```

`--against` compares with an earlier schema, or with a lockfile, and refuses a breaking change. With no `--against`
it uses `rayfold.lock.json` when one is beside you, so in a repository that has a lockfile the bare command already
checks compatibility. `--strict` additionally fails on warnings — changes that are compatible but worth a look, such
as a policy added to an operation that had none. See
[Changing a schema safely](../learn/evolution.md) for what counts as breaking.

Ordinals are compared by name. Against a lockfile, every field and enum value keeps the ordinal the lock recorded for
it, so adding a field between two others, or reordering them, is compatible; only an `@ordinal(n)` that disagrees with
the lock (`ordinal-changed`), or a new member taking an ordinal the lock gave another (`ordinal-reused`), breaks.
Between two `.rayfold` files there is no record of what was assigned, so both number by position: a member that moved
is a warning (`ordinal-shifted`, fatal under `--strict`), and a changed `@ordinal(n)` is still breaking. Lock the schema
to make a mid-type insertion pass cleanly.

`--resolvers` loads a module and reports fields the schema declares that nothing resolves, and resolvers with no
field to attach to. It answers "are the resolvers complete?" before a request does. It runs beside the compatibility
check, not instead of it, and either one failing fails the command.

`--unused` reads an exported usage snapshot and lists members no client asked for inside `--since` (default `30d`),
so a removal is a fact rather than a guess. Servers record usage per client from the `Rayfold-Client` header.

## lock

```sh
rayfold lock <schema.rayfold> [--out rayfold.lock.json]
```

Writes `rayfold.lock.json`: the field ordinals the binary format depends on, and the schema hash. Commit it. With it
in the repository, `check` compares against it by default, so a changed or reused ordinal fails in CI rather than
corrupting a decode in production.

Run again over an existing lock, it keeps the ordinals that lock recorded: every field and enum value keeps its
number by name, wherever it now sits in the type, and a new one gets the next number above any the type has ever
used, so the number of a removed member is never handed out again. A written `@ordinal(n)` is recorded as written.
The lock keeps each type's highest number so far in `highestOrdinals`.

## hash

```sh
rayfold hash <schema.rayfold>
```

Prints the schema hash alone, with no other output:

```
7fb44054edd70f691d3560cc27959509a762762ba7a914a573f741cb6daf58a3
```

This is the value a server publishes in its manifest and sends as `Rayfold-Schema` on every response. Useful for
asserting in a deploy script that the schema you built is the schema that is running. It is SHA-256 of the canonical
IR, and [spec 01 §9](../../spec/01-schema.md) defines that exactly, so an independent implementation computes the
same value.

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

"1 call" per level is the thing to read: a page of fifty books loads its authors in one call, not fifty. A level that
says otherwise is an N+1 you can see before shipping it. `--args` matters when cost depends on a page size.

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
idempotency keys or several steps in one request — see [Coming from GraphQL](from-graphql.md).

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

This is the other half of running with `trustedShapes` on. A hardened server refuses shape text it was not given in
advance and accepts only ids; these are the ids, and the canonical form beside each one is what the id was taken
over — note that `{ id title author { name } }` canonicalises with its fields sorted, which is why the same selection
written in another order has the same id. Register them in code so every server in a fleet agrees
([Deployment](deployment.md)).

## import

```sh
rayfold import openapi|graphql <file> [--out schema.rayfold]
```

Reads an OpenAPI document or a GraphQL SDL and writes a Rayfold schema. It tells you on standard error what it could
not bring over, so the gaps are a list to work through rather than a surprise later. See
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
in front of it. This is what `npm run dev` uses in this repository. It believes any bearer token as a user id, so it
is for local development only.

## lsp

```sh
rayfold lsp
```

The language server for `.rayfold` files, speaking LSP over stdio: diagnostics as you type, completion, hover,
go-to-definition and document symbols. Editors start it themselves — see [Editors](editors.md) for the VS Code and
Neovim configuration.

## In CI

The one line worth having in a pipeline:

```sh
npx @rayfold/cli check schema.rayfold --against rayfold.lock.json --strict --resolvers ./src/resolvers.ts
```

It fails the build on a breaking change, on a compatible one nobody meant to make, and, with `--resolvers`, when the
schema and the code have drifted apart. The module must export `resolvers`, a default export, or a function that
returns them.
