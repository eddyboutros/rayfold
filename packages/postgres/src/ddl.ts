import type { Queryable } from "./index.ts";

/**
 * Runs a DDL statement the way several servers starting at once need it run. `CREATE ... IF NOT EXISTS` is not atomic
 * between sessions: when two run it at the same moment, Postgres blocks the second until the first commits and then
 * refuses it with a duplicate key on its catalogue (`23505`) or "already exists" (`42P07`). The object exists by then,
 * which is all that was wanted, so the statement is run once more and passes.
 */
export async function ensure(sql: Queryable, statement: string): Promise<void> {
  try {
    await sql.query(statement);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code !== "23505" && code !== "42P07") throw e;
    await sql.query(statement);
  }
}
