import { describe, expect, it } from "vitest";
import { ensure } from "./ddl.ts";
import type { Queryable } from "./index.ts";

/**
 * Two servers starting at the same moment both create the tables; Postgres refuses the second with a catalogue error
 * although the table then exists. PGlite is one session and cannot stage that race, so the statement's behaviour is
 * proven here against a client that refuses once, and the race itself by `e2e/fleet.test.ts` over a real Postgres.
 */
function refusingOnce(code: string): { sql: Queryable; calls: string[] } {
  const calls: string[] = [];
  let refused = false;
  const sql: Queryable = {
    query: async (text) => {
      calls.push(text);
      if (!refused) {
        refused = true;
        throw Object.assign(new Error("the other server got there first"), { code });
      }
      return { rows: [] };
    },
  };
  return { sql, calls };
}

describe("ensure", () => {
  it("runs the statement once more after the catalogue race, whichever error Postgres reports it as", async () => {
    for (const code of ["23505", "42P07"]) {
      const { sql, calls } = refusingOnce(code);
      await ensure(sql, "CREATE TABLE IF NOT EXISTS t (id int)");
      expect(calls).toEqual(["CREATE TABLE IF NOT EXISTS t (id int)", "CREATE TABLE IF NOT EXISTS t (id int)"]);
    }
  });

  it("guard: any other refusal is the caller's, and is not retried", async () => {
    const { sql, calls } = refusingOnce("42601");
    await expect(ensure(sql, "CREATE TABLEX")).rejects.toMatchObject({ code: "42601" });
    expect(calls).toHaveLength(1);
  });

  it("guard: a statement that passes runs once", async () => {
    const calls: string[] = [];
    await ensure({ query: async (text) => (calls.push(text), { rows: [] }) }, "CREATE TABLE IF NOT EXISTS t (id int)");
    expect(calls).toHaveLength(1);
  });
});
