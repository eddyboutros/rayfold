# Coming from GraphQL

Most of what you know carries over: a schema, client-chosen fields, nested selections, batch loaders. What changes is
that the parts GraphQL leaves to libraries and conventions are part of the contract.

## How the ideas map

| GraphQL | Rayfold |
|---|---|
| SDL types | `.rayfold` types. Fields are non-null unless marked `?` (the opposite default) |
| `Query` fields | `query` operations |
| `Mutation` fields | `command` operations, each with an idempotency key, typed errors (`throws`) and cache patches |
| `Subscription` | `live: true` on any query, or a `stream`; events with `event` |
| Selection sets | Shapes: `{ title author { name } }`. A type's default view answers when there is no shape |
| Fragments | Views: `view Book.card = { id title }`, spread with `...Book.card` |
| `@defer`, `@stream` | `@lazy` fields, `@defer` blocks and streams, all delivered as frames |
| DataLoader | Built in: field resolvers are batch loaders, called once per nesting level |
| Persisted queries | Shape ids (`sha256:...`), and trusted-shapes mode for production |
| One `POST /graphql` | `POST /rayfold` for batches, `GET` and `QUERY` for cacheable reads with `ETag` and `Cache-Control` |
| `errors[]` beside partial data | Every op fails or succeeds on its own; partial results only where a field opts in with `@partial` |
| Directives for auth, from a library | `@allow`/`@deny` in the schema, enforced by the runtime everywhere |
| Query cost plugins | Static cost from `@cost` and page sizes, checked against a budget before anything runs |
| Apollo or Relay cache updates after a mutation | Commands return patches; the client cache applies them, so no `update` functions and no refetching |

## Start from the SDL you have

```sh
npm install graphql       # the importer reads the SDL with it
npx @rayfold/cli import graphql schema.graphql --out api.rayfold
```

`Query` fields become queries, `Mutation` fields commands, `Subscription` fields streams, and the type system carries
across almost whole. The change that touches every line is nullability, which is the other way round: `String!`
becomes `String`, and `String` becomes `String?`. A type with a non-null `id` becomes an entity, its `id` an `ID`
even where the SDL said `String!` or `Int!`. A type named like one Rayfold defines, such as `Page`, is renamed, and
descriptions and `@deprecated` reasons come across.

A mutation says nothing about what it can fail with or what it emits, and a Relay connection is not a `Page`, so the
importer leaves a note rather than inventing either. The notes go to stderr; the schema goes to stdout.

## Going the other way

`rayfold gen graphql` prints a GraphQL schema for a Rayfold one, for GraphQL tooling or to compare the two:

```sh
npx @rayfold/cli gen graphql api.rayfold --out schema.graphql
```

Types, fields, arguments, defaults, descriptions and deprecations carry over, and nullability flips back. Queries become
`Query` fields, commands `Mutation` fields and streams `Subscription` fields. `Page<Book>` becomes a `BookPage` type,
since GraphQL has no generics. Every `Query`, `Mutation` and `Subscription` field is nullable, because each Rayfold
operation succeeds or fails on its own. A type with no fields, which GraphQL does not allow, gets a placeholder field
`_`.

What GraphQL has no way to say is listed on stderr rather than dropped without a word: the errors an operation throws,
the idempotency key and patches of a command, live queries, cacheable reads, operations that use each other's results,
and rules such as `@allow`, `@cost` and `@cache`. The output describes the API; it does not serve it.

## A migration in four steps

1. **Translate the SDL.** Types map almost one to one. Mark the fields that can be null with `?`, turn mutations into
   commands with their error types, and list what each command changes if its patches should say so.
2. **Move the resolvers.** Resolvers keep their shape; DataLoader wrappers go away, since a field resolver already gets
   every parent of its level.
3. **Move the queries.** A GraphQL document becomes one or more ops in a batch with a shape each. Variables become
   arguments, or `$name` inside the shape.
4. **Move the client.** Replace Apollo or Relay with `@rayfold/client` and `@rayfold/react` (`useQuery`, `useLive`,
   `useCommand`), or `@rayfold/angular` (`injectQuery`, `injectLive`, `injectCommand`). Remove the cache-update code after mutations: the patches do that now.

## What to watch for

- **Nullability flips.** In GraphQL everything is nullable unless `!`; in Rayfold everything is non-null unless `?`.
  A resolver that returns null for a non-null field is an error.
- **One op, one outcome.** A GraphQL response can hold data and errors for different fields. In Rayfold an op either
  succeeds or fails as a whole, unless a field is marked `@partial`; batches hold several ops, each with its own result.
- **Aliases and arguments on fields** work the same way: `{ recent: reviews(page: { first: 3 }) { items { rating } } }`.
- **Introspection** is `GET /rayfold/manifest`, which by default leaves out how policies decide.
