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
| `lock <schema> [--out rayfold.lock.json]` | Records field ordinals and the schema hash. Commit it and check later versions against it. |
| `hash <schema>` | Prints the schema hash. |
| `explain <schema> <op> [--shape "{...}"] [--args '{...}']` | Shows the plan: cost, depth, one loader call per level, and which policies push down to the data source. |
| `gen ts\|kotlin\|java <schema> [--out file] [--package pkg] [--class Name]` | Generates TypeScript types, Kotlin data classes, or Java records (one file, one class). |
| `shapes <schema> <file>` | Prints the shape id of each shape in the file, for registering trusted shapes. |
| `dev <dir> [--port 4400]` | Runs an example from a Rayfold repository checkout (a folder whose `src/index.ts` exports `createBookstore()`) with the playground, WebSocket and MCP. |

In CI, `rayfold check schema.rayfold --against rayfold.lock.json` exits non-zero on a breaking change.

Apache-2.0.
