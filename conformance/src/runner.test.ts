import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRayfoldServer } from "@rayfold/server";
import { fixtureResolvers, groupFrames, seedStore, type Fixture } from "./fixture.ts";

const root = fileURLToPath(new URL("../fixtures", import.meta.url));

for (const profile of readdirSync(root)) {
  const dir = join(root, profile);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const fixture = JSON.parse(readFileSync(join(dir, file), "utf8")) as Fixture;
    describe(`${profile}/${file}: ${fixture.name}`, () => {
      for (const c of fixture.cases) {
        it(c.name, async () => {
          const store = seedStore(fixture);
          const server = createRayfoldServer({
            schema: fixture.schema,
            resolvers: fixtureResolvers(fixture, store),
            ...(fixture.options?.budget !== undefined ? { budget: fixture.options.budget } : {}),
            ...(fixture.options?.maxDepth !== undefined ? { maxDepth: fixture.options.maxDepth } : {}),
            ...(fixture.options?.trustedShapes !== undefined ? { trustedShapes: fixture.options.trustedShapes } : {}),
          });
          for (const s of fixture.options?.registerShapes ?? []) server.registerShape(s);
          let frames: unknown[] = [];
          for (let i = 0; i < (c.repeat ?? 1); i++) frames = await server.collect(c.request, { viewer: c.viewer ?? null });
          expect(groupFrames(frames as never)).toEqual(groupFrames(c.frames));
          if (c.calls) expect(store.calls).toEqual(c.calls);
        });
      }
    });
  }
}
