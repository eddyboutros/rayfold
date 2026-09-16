package dev.rayfold.jdbc

import dev.rayfold.core.Code
import dev.rayfold.core.IdempotencyClaim
import dev.rayfold.core.IdempotencyRecord
import dev.rayfold.core.IdempotencyStore
import dev.rayfold.core.RayfoldException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.sql.Connection
import java.sql.SQLException
import java.sql.SQLIntegrityConstraintViolationException
import java.util.UUID

/**
 * Idempotency records in a SQL table, so that several server processes keep one guarantee between them: a command
 * with a key runs once (spec 03 section 4). With the in-memory store each process decides on its own, and the same
 * retry reaching two of them runs the command twice; here the database decides, and only one process runs it.
 *
 * Only JDBC is required, and the SQL is plain enough for Postgres, H2 and friends: no upsert syntax, no locking
 * hints. A claim is an INSERT; when the row is already there it is read, and a key nobody holds any more is taken
 * over with a conditional UPDATE, which fails harmlessly when another process got there first, and the attempt
 * starts again. Every value travels as a bound parameter and every identifier is quoted.
 *
 * Run [migrate] as each server starts, or let the application's migrations own the table ([schema] is its DDL).
 */
class JdbcIdempotencyStore @JvmOverloads constructor(
    private val connections: () -> Connection,
    private val opts: JdbcIdempotencyOptions = JdbcIdempotencyOptions(),
) : IdempotencyStore {
    private val table = opts.table.split(".").joinToString(".") { quote(it) }

    /** The DDL for the table this store reads, for Postgres, H2 and anything close to them. */
    fun schema(): String =
        "CREATE TABLE IF NOT EXISTS $table (" +
            "\"scope\" varchar(64) not null, " +
            "\"key\" varchar(128) not null, " +
            "\"args_hash\" varchar(64), " +
            "\"frame\" text, " +
            "\"compact_frame\" text, " +
            "\"token\" varchar(64) not null, " +
            "\"held_until\" bigint not null, " +
            "\"at\" bigint not null, " +
            "primary key (\"scope\", \"key\"))"

    /** Runs [schema] if the table is not there yet. Safe to call from every server as it starts, at the same instant included. */
    fun migrate() {
        connections().use { ensure(it, schema()) }
    }

    override fun get(scope: String, key: String): IdempotencyRecord? = connections().use { c ->
        val row = read(c, scope, key) ?: return null
        val record = row.record ?: return null
        if (opts.now() - row.at >= opts.ttlMs) {
            update(c, "DELETE FROM $table WHERE \"scope\" = ? AND \"key\" = ? AND \"at\" = ?", listOf(scope, key, row.at))
            return null
        }
        record
    }

    override fun claim(scope: String, key: String, leaseMs: Long): IdempotencyClaim = connections().use { c ->
        repeat(ATTEMPTS) {
            val t = opts.now()
            val token = UUID.randomUUID().toString()
            if (insert(c, scope, key, token, t + leaseMs, t)) return IdempotencyClaim.Owned(token)
            // the key is taken: either it holds an answer, or a run is holding it, or whoever held it is gone
            val row = read(c, scope, key) ?: return@repeat
            val record = row.record
            if (record != null && t - row.at < opts.ttlMs) return IdempotencyClaim.Done(record)
            if (record == null && row.heldUntil > t) return IdempotencyClaim.InFlight(row.heldUntil)
            if (takeOver(c, scope, key, row, token, t + leaseMs, t)) return IdempotencyClaim.Owned(token)
        }
        // every attempt lost a race, which means other processes are making progress on this key: the caller retries
        throw RayfoldException(Code.UNAVAILABLE, "rayfold-jdbc: idempotency key $key changed hands $ATTEMPTS times")
    }

    override fun renew(scope: String, key: String, token: String, leaseMs: Long): Boolean = connections().use { c ->
        val sql = "UPDATE $table SET \"held_until\" = ? WHERE \"scope\" = ? AND \"key\" = ? AND \"token\" = ? AND \"frame\" IS NULL"
        update(c, sql, listOf(opts.now() + leaseMs, scope, key, token)) == 1
    }

    override fun put(scope: String, key: String, record: IdempotencyRecord, token: String) {
        connections().use { c ->
            val t = opts.now()
            val sql = "UPDATE $table SET \"args_hash\" = ?, \"frame\" = ?, \"compact_frame\" = ?, \"held_until\" = 0, \"at\" = ? " +
                "WHERE \"scope\" = ? AND \"key\" = ? AND \"token\" = ?"
            val params = listOf(record.argsHash, record.frame.toString(), record.compactFrame.toString(), t, scope, key, token)
            // 0 rows: the lease ran out and another run holds the key, so its answer is the one retries must get
            if (update(c, sql, params) == 1) sweep(c, t)
        }
    }

    override fun release(scope: String, key: String, token: String) {
        connections().use { c ->
            update(c, "DELETE FROM $table WHERE \"scope\" = ? AND \"key\" = ? AND \"token\" = ? AND \"frame\" IS NULL", listOf(scope, key, token))
        }
    }

    // ------------------------------------------------------------------ rows

    private class Row(val record: IdempotencyRecord?, val token: String, val heldUntil: Long, val at: Long)

    private fun read(c: Connection, scope: String, key: String): Row? {
        val sql = "SELECT \"args_hash\", \"frame\", \"compact_frame\", \"token\", \"held_until\", \"at\" FROM $table WHERE \"scope\" = ? AND \"key\" = ?"
        return c.prepareStatement(sql).use { s ->
            s.setObject(1, scope)
            s.setObject(2, key)
            s.executeQuery().use { rows ->
                if (!rows.next()) return null
                val hash = rows.getString(1)
                val frame = rows.getString(2)
                val compact = rows.getString(3)
                val record = if (hash == null || frame == null || compact == null) null else IdempotencyRecord(hash, json(frame), json(compact))
                Row(record, rows.getString(4), rows.getLong(5), rows.getLong(6))
            }
        }
    }

    /** A claim on a key nobody has yet; false when another process inserted it first. */
    private fun insert(c: Connection, scope: String, key: String, token: String, heldUntil: Long, at: Long): Boolean {
        val sql = "INSERT INTO $table (\"scope\", \"key\", \"args_hash\", \"frame\", \"compact_frame\", \"token\", \"held_until\", \"at\") " +
            "VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?)"
        return try {
            update(c, sql, listOf(scope, key, token, heldUntil, at)) == 1
        } catch (e: SQLException) {
            if (e is SQLIntegrityConstraintViolationException || e.sqlState?.startsWith("23") == true) false else throw e
        }
    }

    /**
     * Claims a key whose record expired or whose holder let its lease run out. The row must still be the one
     * [read] returned, so of two processes taking the same key over, exactly one wins.
     */
    private fun takeOver(c: Connection, scope: String, key: String, row: Row, token: String, heldUntil: Long, at: Long): Boolean {
        val sql = "UPDATE $table SET \"args_hash\" = NULL, \"frame\" = NULL, \"compact_frame\" = NULL, \"token\" = ?, \"held_until\" = ?, \"at\" = ? " +
            "WHERE \"scope\" = ? AND \"key\" = ? AND \"token\" = ? AND \"held_until\" = ? AND \"at\" = ?"
        return update(c, sql, listOf(token, heldUntil, at, scope, key, row.token, row.heldUntil, row.at)) == 1
    }

    /**
     * Drops what the store may no longer keep (spec 12 section 3.6): records past the TTL and claims nobody holds
     * go first, then the oldest records while the table is over [JdbcIdempotencyOptions.maxSize]. A claim in flight
     * is never evicted: dropping one would let a concurrent duplicate run.
     */
    private fun sweep(c: Connection, t: Long) {
        update(c, "DELETE FROM $table WHERE (\"frame\" IS NOT NULL AND \"at\" <= ?) OR (\"frame\" IS NULL AND \"held_until\" <= ?)", listOf(t - opts.ttlMs, t))
        val over = count(c) - opts.maxSize
        if (over <= 0) return
        val oldest = mutableListOf<Pair<String, String>>()
        c.prepareStatement("SELECT \"scope\", \"key\" FROM $table WHERE \"frame\" IS NOT NULL ORDER BY \"at\" LIMIT ?").use { s ->
            s.setObject(1, over)
            s.executeQuery().use { rows -> while (rows.next()) oldest.add(rows.getString(1) to rows.getString(2)) }
        }
        c.prepareStatement("DELETE FROM $table WHERE \"scope\" = ? AND \"key\" = ? AND \"frame\" IS NOT NULL").use { s ->
            for ((scope, key) in oldest) {
                s.setObject(1, scope)
                s.setObject(2, key)
                s.addBatch()
            }
            s.executeBatch()
        }
    }

    private fun count(c: Connection): Int = c.prepareStatement("SELECT COUNT(*) FROM $table").use { s ->
        s.executeQuery().use { rows -> if (rows.next()) rows.getInt(1) else 0 }
    }

    private fun update(c: Connection, sql: String, params: List<Any?>): Int = c.prepareStatement(sql).use { s ->
        params.forEachIndexed { i, p -> s.setObject(i + 1, p) }
        s.executeUpdate()
    }

    private companion object {
        /** Attempts before a claim gives up: each one lost means another process claimed, answered or let go. */
        const val ATTEMPTS = 8

        fun quote(name: String): String = "\"" + name.replace("\"", "\"\"") + "\""

        fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    }
}

/** Where the records live, how long they are kept, and how many. */
data class JdbcIdempotencyOptions(
    val table: String = "rayfold_idempotency",
    val ttlMs: Long = 24 * 60 * 60 * 1000L,
    val maxSize: Int = 100_000,
    /** The clock leases are measured against; injectable so a test can let one run out without waiting. */
    val now: () -> Long = System::currentTimeMillis,
)
