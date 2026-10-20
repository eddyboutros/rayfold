/**
 * The home page's scoreboard shows only what the end-to-end comparison measured: the loader the site calls reads the
 * file that comparison writes, and a row it cannot find stops the build instead of disappearing from the page.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import loader, { SHOWN, scoreboard } from "./scoreboard.data.ts";

const RESULTS = fileURLToPath(new URL("../../../e2e/results.json", import.meta.url));
const results = JSON.parse(readFileSync(RESULTS, "utf8")) as { rows: Array<{ aspect: string; better: string; verdict: string; values?: Record<string, number> }> };

describe("the home page scoreboard", () => {
  it("is what e2e/results.json measured, through the loader the site calls", () => {
    const board = loader.load([RESULTS]);
    expect(board.rows.map((r) => r.label)).toEqual(SHOWN.map(([, label]) => label));
    for (const [i, [aspect]] of SHOWN.entries()) {
      const row = results.rows.find((r) => r.aspect === aspect)!;
      expect(board.rows[i], aspect).toMatchObject({ rest: row.values!["REST"], graphql: row.values!["GraphQL"], rayfold: row.values!["Rayfold"] });
      // the page says fewer is better, and Rayfold is the fewest on every row it shows
      expect(row.better, aspect).toBe("lower");
      expect(board.rows[i]!.rayfold, aspect).toBeLessThan(Math.min(board.rows[i]!.rest, board.rows[i]!.graphql));
    }
    expect(board.total).toBe(results.rows.length);
    expect(board.leads).toBe(results.rows.filter((r) => r.verdict === "lead").length);
  });

  it("stops the build when the comparison no longer has a row it shows, or reads it the other way round", () => {
    const renamed = { rows: results.rows.map((r) => (r.aspect === SHOWN[0]![0] ? { ...r, aspect: "Something else" } : r)) } as Parameters<typeof scoreboard>[0];
    expect(() => scoreboard(renamed)).toThrow(`the home page shows "${SHOWN[0]![0]}", which e2e/results.json does not measure`);
    const flipped = { rows: results.rows.map((r) => (r.aspect === SHOWN[1]![0] ? { ...r, better: "higher" } : r)) } as Parameters<typeof scoreboard>[0];
    expect(() => scoreboard(flipped)).toThrow("as fewer-is-better, and it is not");
  });

  it("counts a row Rayfold does not lead on (guard - the count is not fixed at the total)", () => {
    const one = { rows: results.rows.map((r, i) => (i === results.rows.length - 1 ? { ...r, verdict: "behind" } : r)) } as Parameters<typeof scoreboard>[0];
    expect(scoreboard(one).leads).toBe(results.rows.filter((r) => r.verdict === "lead").length - 1);
  });
});
