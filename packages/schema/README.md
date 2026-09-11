# @rayfold/schema

The Rayfold schema language: the `.rayfold` parser and validator, the canonical IR every other package reads,
shapes, policy expressions, breaking-change detection and code generators. Runs in Node.js and browsers.

```sh
npm install @rayfold/schema
```

```ts
import { loadSchema, diffSchemas, isBreaking, generateTypeScript } from "@rayfold/schema";

const v1 = loadSchema(`
  entity Book {
    id: ID
    title: String
  }
  query book(id: ID): Book?
`);

console.log(v1.hash);                    // sha256 of the canonical IR
console.log(generateTypeScript(v1.ir));  // TypeScript types for the schema

const v2 = loadSchema(`
  entity Book {
    id: ID
  }
  query book(id: ID): Book?
`);
const changes = diffSchemas(v1.ir, v2.ir);
console.log(isBreaking(changes));        // true: a field was removed without a sunset date
```

`loadSchema` throws `RayfoldSchemaError` with every diagnostic when the schema is invalid.

The language is specified in `spec/01-schema.md` and `spec/02-shapes.md` in the Rayfold repository.

Apache-2.0.
