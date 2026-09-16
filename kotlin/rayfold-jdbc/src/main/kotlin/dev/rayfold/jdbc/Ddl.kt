package dev.rayfold.jdbc

import java.sql.Connection
import java.sql.SQLException

/**
 * Runs a `CREATE ... IF NOT EXISTS` so that every server may run it as it starts. The statement is not atomic across
 * sessions: Postgres blocks the second until the first commits, then refuses it with 23505 (a duplicate key in
 * pg_type) or 42P07 (the relation already exists). The object exists by then, which is all that was wanted, so the
 * statement runs once more, which finds it there. Anything else propagates untouched.
 */
internal fun ensure(connection: Connection, ddl: String) {
    try {
        connection.createStatement().use { it.execute(ddl) }
    } catch (e: SQLException) {
        if (e.sqlState != "23505" && e.sqlState != "42P07") throw e
        connection.createStatement().use { it.execute(ddl) }
    }
}
