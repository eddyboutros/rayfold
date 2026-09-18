# @rayfold/conformance

The shared test cases that every Rayfold implementation must pass. The TypeScript and Kotlin runtimes both run them.
If you write a Rayfold server in another language, run these and you can show it behaves like the reference.

```sh
npm install --save-dev @rayfold/conformance
```

The package holds two kinds of artifact. A **fixture** is a request and the frames a server must answer it with. A
**vector** is a pure function and the answer the specification says it has: a number's canonical form, a shape's id,
a hash, the status an error code derives, the outcome of a denial.

The difference matters. Every vector's expectation is written from the specification, never captured from a runtime —
a vector taken from an implementation proves only that the implementations agree, and two implementations can agree
on the same wrong answer. Rayfold's own history makes the point: the specification listed 38 binary-format dictionary
keys while both codecs held 40, and every test passed for months.

What the package contains:

- `fixtures/core/*.json`: one file per topic (default views, shapes, pipelining, commands, errors, auth, defer,
  streams, limits, trusted shapes, ...). Each file holds a `.rayfold` schema, its parsed IR, seed data, and cases:
  a request, the viewer, and the exact frames expected back.
- `vectors/*/*.json`: ten areas — `numbers`, `canonicalization`, `shapes`, `binary`, `hashing`, `manifest`,
  `errors`, `idempotency`, `authorization`, `patch`. Each file carries the normative rule restated in prose, the
  specification section it comes from, and its cases. `vectors/README.md` explains how to run them.
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

Reading a vector area is the same shape of work:

```ts
const vectors = join(dirname(createRequire(import.meta.url).resolve("@rayfold/conformance/package.json")), "vectors");
const doc = JSON.parse(readFileSync(join(vectors, "numbers/ecmascript-number-form.json"), "utf8"));
for (const c of doc.cases) console.log(c.literal, "->", c.canonical);
```

The fixture format is documented in `conformance/README.md` and `conformance/src/fixture.ts` in the Rayfold
repository; the vectors in `conformance/vectors/README.md`.

Apache-2.0.
