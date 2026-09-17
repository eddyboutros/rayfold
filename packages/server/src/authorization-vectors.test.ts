import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRayfoldServer } from "./server.ts";
import type { Frame } from "./protocol.ts";

/**
 * The published `authorization/` vectors, run against this runtime.
 *
 * Not a pure function, so the vector carries a schema, a viewer, a shape and the outcome spec 06 §3 says to expect;
 * the runner builds a server per case. What is pinned is the table, not either implementation — the two are known to
 * disagree on one row, and the table is what decides which is right. `VectorsTest.kt` runs the same file.
 */
const PATH = new URL("../../../conformance/vectors/authorization/denial-outcomes.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const doc = JSON.parse(readFileSync(PATH, "utf8")) as {
  schema: string;
  viewer: unknown;
  cases: Array<{
    name: string;
    op: string;
    shape?: string;
    viewer?: unknown;
    expect: "error" | "partial" | "null" | "nullElement" | "omitted" | "ok";
    code?: string;
    path?: string;
    at?: string;
    field?: string;
    why?: string;
  }>;
};

const notes = new Map([["n1", { id: "n1", title: "A note", owner: "u9", sometimes: "s", secretId: "s1", mustHaveId: "s1" }]]);
const secrets = new Map([["s1", { id: "s1", code: "hunter2" }]]);

function serve() {
  return createRayfoldServer({
    schema: doc.schema,
    resolvers: {
      Query: {
        note: ({ id }: { id: string }) => notes.get(id) ?? null,
        adminOnly: ({ id }: { id: string }) => notes.get(id) ?? null,
        box: ({ id }: { id: string }) => ({ id, itemIds: ["s1"] }),
        // a list with a real gap in it, so the denial rule can be told apart from "any null in a list"
        boxWithGap: ({ id }: { id: string }) => ({ id, itemIds: [null] }),
      },
      Note: {
        secret: (rows: Array<{ secretId: string }>) => rows.map((r) => secrets.get(r.secretId) ?? null),
        mustHave: (rows: Array<{ mustHaveId: string }>) => rows.map((r) => secrets.get(r.mustHaveId) ?? null),
      },
      Box: {
        items: (rows: Array<{ itemIds: Array<string | null> }>) => rows.map((r) => r.itemIds.map((i) => (i === null ? null : (secrets.get(i) ?? null)))),
        maybe: (rows: Array<{ itemIds: Array<string | null> }>) => rows.map((r) => r.itemIds.map((i) => (i === null ? null : (secrets.get(i) ?? null)))),
      },
    },
  });
}

const run = async (c: (typeof doc.cases)[number]): Promise<Frame[]> => {
  const viewer = "viewer" in c ? c.viewer : doc.viewer;
  return serve().collect({ ops: [{ id: 1, op: c.op, args: { id: c.op.startsWith("box") ? "b1" : "n1" }, ...(c.shape ? { shape: c.shape } : {}) }] }, { viewer });
};

const dataOf = (frames: Frame[]): Record<string, unknown> => {
  const f = frames.find((x) => "data" in x) as { data: Record<string, unknown> } | undefined;
  return f?.data ?? {};
};

describe("conformance vectors: authorization", () => {
  for (const c of doc.cases) {
    it(c.name, async () => {
      const frames = await run(c);
      const why = c.why ?? c.name;
      const error = frames.find((f) => "error" in f) as { error: { code: string; path?: string } } | undefined;

      switch (c.expect) {
        case "error":
          expect(error?.error.code, why).toBe(c.code);
          if (c.path) expect(error!.error.path, why).toBe(c.path);
          break;
        case "partial": {
          expect(error, why).toBeUndefined();
          const frame = frames.find((f) => "data" in f) as { data: Record<string, unknown>; errors?: unknown[] };
          expect(frame.data[c.field!], why).toBeNull();
          expect(frame.errors?.length, why).toBeGreaterThan(0);
          break;
        }
        case "null":
          expect(error, why).toBeUndefined();
          expect(dataOf(frames)[c.at!], why).toBeNull();
          break;
        case "nullElement":
          expect(error, why).toBeUndefined();
          expect(dataOf(frames)[c.at!], why).toEqual([null]);
          break;
        case "omitted":
          expect(error, why).toBeUndefined();
          expect(Object.keys(dataOf(frames)), why).not.toContain(c.field);
          break;
        case "ok":
          expect(error, why).toBeUndefined();
          expect(dataOf(frames)["title"], why).toBe("A note");
          break;
      }
    });
  }
});
