# @rayfold/cli

The `rayfold` command: validate schemas, catch breaking changes before they ship, see how a query will run, and
generate types.

```sh
npm install --save-dev @rayfold/cli
npx rayfold check schema.rayfold
```

| Command | What it does |
|---|---|
| `check <schema> [--against <old schema or lock file>] [--strict]` | Validates the schema. With `--against`, lists every change and fails on breaking ones (a removed field before its sunset date, a narrowed type, ...). |
| `check <schema> --resolvers <module>` | Do the resolvers cover the schema? Every operation wired, a loader for every field that takes arguments, and a warning for a resolver the schema no longer has. |
| `lock <schema> [--out rayfold.lock.json]` | Records field ordinals and the schema hash. Commit it and check later versions against it. |
| `hash <schema>` | Prints the schema hash. |
| `explain <schema> <op> [--shape "{...}"] [--args '{...}']` | Shows the plan: cost, depth, one loader call per level, and which policies push down to the data source. |
| `gen ts\|kotlin\|java <schema> [--out file] [--package pkg] [--class Name]` | Generates TypeScript types, Kotlin data classes, or Java records (one file, one class). |
| `shapes <schema> <file>` | Prints the shape id of each shape in the file, for registering trusted shapes. |
| `import openapi\|graphql <file> [--out schema.rayfold]` | Reads a first draft of a schema from an OpenAPI document or a GraphQL SDL. What the source cannot say is listed on stderr. |
| `mock <schema.rayfold> [--port 4500]` | Serves the schema with data the schema itself describes, and the explorer beside it, before any resolver exists. The same call always gives the same answer. |
| `lsp` | Runs the language server for `.rayfold` over stdin and stdout: errors as you type, completion, hover, go to definition and an outline, for any editor that speaks LSP. |
| `dev <dir> [--port 4400]` | Runs an example from a Rayfold repository checkout (a folder whose `src/index.ts` exports `createBookstore()`) with the explorer, WebSocket and MCP. |

In CI, `rayfold check schema.rayfold --against rayfold.lock.json` exits non-zero on a breaking change.

Apache-2.0.
