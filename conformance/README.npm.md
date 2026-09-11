# @rayfold/conformance

The shared test cases that every Rayfold implementation must pass. The TypeScript and Kotlin runtimes both run them.
If you write a Rayfold server in another language, run these and you can show it behaves like the reference.

What the package contains:

- `fixtures/core/*.json`: one file per topic (default views, shapes, pipelining, commands, errors, auth, defer,
  streams, limits, trusted shapes, ...). Each file holds a `.rayfold` schema, its parsed IR, seed data, and cases:
  a request, the viewer, and the exact frames expected back.
- The harness the reference runtime uses (`seedStore`, `fixtureResolvers`, `groupFrames`): it turns a fixture's
  data and declarative resolver specs into resolvers for `@rayfold/server`, so you can see how each case is meant
  to be served.

```ts
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const dir = join(dirname(createRequire(import.meta.url).resolve("@rayfold/conformance/package.json")), "fixtures/core");
for (const file of readdirSync(dir)) {
  const fixture = JSON.parse(readFileSync(join(dir, file), "utf8"));
  console.log(file, fixture.cases.length, "cases");
}
```

The fixture format is documented in `conformance/README.md` and `conformance/src/fixture.ts` in the Rayfold repository.

Apache-2.0.
