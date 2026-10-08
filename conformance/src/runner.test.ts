import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRayfoldServer } from "@rayfold/server";
import { CASE_KEYS, FIXTURE_KEYS, OPTION_KEYS, fixtureResolvers, groupFrames, seedStore, type Fixture } from "./fixture.ts";

const root = fileURLToPath(new URL("../fixtures", import.meta.url));

/** A member this runner does not know is an expectation it would silently skip, so it fails instead. */
function known(where: string, o: object | undefined, keys: string[]): void {
  for (const k of Object.keys(o ?? {})) if (!keys.includes(k)) throw new Error(`${where}: no runner support for "${k}"`);
}

for (const profile of readdirSync(root)) {
  const dir = join(root, profile);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const fixture = JSON.parse(readFileSync(join(dir, file), "utf8")) as Fixture;
    describe(`${profile}/${file}: ${fixture.name}`, () => {
      it("carries only members the runner knows", () => {
        known(file, fixture, FIXTURE_KEYS);
        known(`${file} options`, fixture.options, OPTION_KEYS);
        for (const c of fixture.cases) known(`${file}: ${c.name}`, c, CASE_KEYS);
      });
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
          for (let i = 0; i < (c.repeat ?? 1); i++) {
            frames = [];
            // leaving the loop early returns the batch's iterator, which cancels what is still running
            for await (const f of server.execute(c.request, { viewer: c.viewer ?? null })) {
              frames.push(f);
              if (c.take !== undefined && frames.length >= c.take) break;
            }
          }
          // compared as the wire carries them: a value JSON cannot hold arrives as what JSON writes for it
          expect(groupFrames(JSON.parse(JSON.stringify(frames)))).toEqual(groupFrames(c.frames));
          if (c.calls) expect(store.calls).toEqual(c.calls);
        });
      }
    });
  }
}
