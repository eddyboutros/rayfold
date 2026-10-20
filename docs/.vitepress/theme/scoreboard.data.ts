/**
 * The rows the home page shows from the end-to-end comparison (e2e/comparison.test.ts), read from the file that test
 * writes, so the page can only ever show what was measured. A row the comparison no longer has fails the build.
 */
import { readFileSync } from "node:fs";

export interface Score {
  label: string;
  rest: number;
  graphql: number;
  rayfold: number;
}

export interface Scoreboard {
  rows: Score[];
  /** How many of the comparison's aspects Rayfold leads on, of how many. */
  leads: number;
  total: number;
}

interface Row {
  aspect: string;
  better: "lower" | "higher";
  verdict: string;
  values?: { REST: number; GraphQL: number; Rayfold: number };
}

/** The aspect as the comparison names it, and the question it answers in a line. Every one is fewer-is-better. */
export const SHOWN: ReadonlyArray<readonly [aspect: string, label: string]> = [
  ["Place an order, then pay for it", "Round trips to order and pay"],
  ["List view after placing an order", "Refetches to keep a list right after a write"],
  ["Retrying a create", "Duplicate orders when a retry has no key"],
  ["List of 20 books with author names", "Author lookups for 20 books, written plainly"],
  ["Realtime stock updates", "Pieces you write for live stock"],
  ["Exposing the API to an AI agent", "Extra parts to serve an AI agent"],
];

export function scoreboard(results: { rows: Row[] }): Scoreboard {
  const rows = SHOWN.map(([aspect, label]) => {
    const row = results.rows.find((r) => r.aspect === aspect);
    if (!row?.values) throw new Error(`the home page shows "${aspect}", which e2e/results.json does not measure`);
    if (row.better !== "lower") throw new Error(`the home page reads "${aspect}" as fewer-is-better, and it is not`);
    return { label, rest: row.values.REST, graphql: row.values.GraphQL, rayfold: row.values.Rayfold };
  });
  return { rows, leads: results.rows.filter((r) => r.verdict === "lead").length, total: results.rows.length };
}

export default {
  watch: ["../../../e2e/results.json"],
  load(files: string[]): Scoreboard {
    const file = files[0];
    if (!file) throw new Error("e2e/results.json is missing: run npm run e2e");
    return scoreboard(JSON.parse(readFileSync(file, "utf8")) as { rows: Row[] });
  },
};
