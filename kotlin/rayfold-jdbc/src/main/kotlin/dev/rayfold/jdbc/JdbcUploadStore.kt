package dev.rayfold.jdbc

import dev.rayfold.core.Canonical
import dev.rayfold.core.Upload
import dev.rayfold.core.UploadStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.sql.Connection
import java.util.UUID

data class JdbcUploadOptions(
    /** Quoted as written, so keep it a plain identifier or schema-qualify it yourself. */
    val table: String = "rayfold_uploads",
    /** How long an upload waits to be used. */
    val ttlMs: Long = 60 * 60 * 1000L,
    /** Most bytes the store holds at once, over every upload; past it the oldest go first. */
    val maxBytes: Long = 1024L * 1024 * 1024,
    /** Wall clock, injectable for tests. */
    val now: () -> Long = System::currentTimeMillis,
    /** Ids. Must be unguessable: an id is what lets a command read those bytes. */
    val id: () -> String = { UUID.randomUUID().toString() },
)

/**
 * Uploads in a SQL database, so several servers share them: a file sent to one server is there for the command that
 * runs on another (spec 04 section 9). Kept in memory, an upload belongs to the process that received it, which is
 * right for one server and wrong for a fleet, exactly as idempotency records are.
 *
 * `PgUploadStore` in `@rayfold/postgres` creates the same columns, so a fleet may hold servers of both runtimes and
 * either may create the table. On Postgres the bytes live in a `bytea` column, which is the form that matters for a
 * mixed fleet; every other database gets `varbinary`, which is what lets these tests run on H2. The column type is
 * chosen from the connection's product name, so neither runtime has to be told which database it is on.
 *
 * What is and is not streamed, since the sizes here are bounded but not small. Going in, the bytes are handed to the
 * driver as a stream ([java.sql.PreparedStatement.setBinaryStream]) and never held whole by this class; whether the
 * driver streams them to the server is the driver's business, and pgjdbc does not for `bytea` - it builds the value
 * in memory, where H2 writes it through. Coming out, the row is read as a stream and copied before the connection
 * closes, because the stream this returns outlives it. For bytes measured in hundreds of megabytes, hand the client a
 * URL from object storage instead; this extension is for the sizes where a row is the simplest thing that works.
 */
class JdbcUploadStore(
    private val connections: () -> Connection,
    private val opts: JdbcUploadOptions = JdbcUploadOptions(),
) : UploadStore {
    /** The DDL for the table this store reads, as the database it is pointed at spells it. */
    fun schema(): String = connections().use { ddl(it).joinToString(";\n", postfix = ";") }

    /** Creates the table and its index if they are not there yet. Safe to call from every server as it starts, at the same instant included. */
    fun migrate() {
        connections().use { c -> for (statement in ddl(c)) ensure(c, statement) }
    }

    private fun ddl(c: Connection): List<String> {
        // bytea is Postgres's own spelling and has no equivalent elsewhere; varbinary is what H2 takes for a byte stream
        val binary = if (c.metaData.databaseProductName.contains("postgres", ignoreCase = true)) "bytea" else "varbinary"
        return listOf(
            "CREATE TABLE IF NOT EXISTS ${opts.table} (\n" +
                "  id text NOT NULL,\n" +
                "  name text,\n" +
                "  type text,\n" +
                "  viewer text,\n" +
                "  size bigint NOT NULL,\n" +
                "  at bigint NOT NULL,\n" +
                "  bytes $binary NOT NULL,\n" +
                "  PRIMARY KEY (id)\n" +
                ")",
            "CREATE INDEX IF NOT EXISTS ${opts.table.replace(Regex("[^A-Za-z0-9_]"), "_")}_at ON ${opts.table} (at)",
        )
    }

    override suspend fun put(body: InputStream, name: String?, type: String?, viewer: JsonElement): Upload = withContext(Dispatchers.IO) {
        val t = opts.now()
        val id = opts.id()
        // the size is only known once the driver has read the stream, so the row is written and then told how much it holds
        val counted = Counting(body)
        connections().use { c ->
            val auto = c.autoCommit
            c.autoCommit = false
            try {
                c.prepareStatement("INSERT INTO ${opts.table} (id, name, type, viewer, size, at, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)").use { s ->
                    s.setString(1, id)
                    s.setString(2, name)
                    s.setString(3, type)
                    s.setString(4, if (viewer is JsonNull) null else Canonical.json(viewer))
                    s.setLong(5, 0)
                    s.setLong(6, t)
                    s.setBinaryStream(7, counted)
                    s.executeUpdate()
                }
                c.prepareStatement("UPDATE ${opts.table} SET size = ? WHERE id = ?").use { s ->
                    s.setLong(1, counted.count)
                    s.setString(2, id)
                    s.executeUpdate()
                }
                sweep(c, t) // in the same transaction, so what was just written counts towards the bound
                c.commit()
            } catch (e: Throwable) {
                runCatching { c.rollback() }
                throw e
            } finally {
                runCatching { c.autoCommit = auto }
            }
        }
        Upload(id, counted.count, t, name, type, viewer)
    }

    override suspend fun open(id: String): Pair<Upload, InputStream>? = withContext(Dispatchers.IO) {
        val kept = connections().use { c ->
            c.prepareStatement("SELECT name, type, viewer, size, at, bytes FROM ${opts.table} WHERE id = ?").use { s ->
                s.setString(1, id)
                s.executeQuery().use { r ->
                    if (!r.next()) return@withContext null
                    val at = r.getLong("at")
                    if (opts.now() - at >= opts.ttlMs) null
                    else {
                        val viewer = r.getString("viewer")?.let { Json.parseToJsonElement(it) } ?: JsonNull
                        // copied while the row is open: the stream handed back outlives this connection
                        val bytes = r.getBinaryStream("bytes")?.use { it.readBytes() } ?: ByteArray(0)
                        Upload(id, r.getLong("size"), at, r.getString("name"), r.getString("type"), viewer) to bytes
                    }
                }
            }
        }
        if (kept == null) {
            delete(id) // past its lifetime: reading it is what drops it
            return@withContext null
        }
        kept.first to ByteArrayInputStream(kept.second)
    }

    override suspend fun delete(id: String) {
        withContext(Dispatchers.IO) {
            connections().use { c ->
                c.prepareStatement("DELETE FROM ${opts.table} WHERE id = ?").use { s ->
                    s.setString(1, id)
                    s.executeUpdate()
                }
            }
        }
    }

    /** Uploads held right now, for tests and for a health check. */
    fun count(): Int = connections().use { c ->
        c.prepareStatement("SELECT COUNT(*) FROM ${opts.table}").use { s ->
            s.executeQuery().use { r -> if (r.next()) r.getInt(1) else 0 }
        }
    }

    /** Bytes held right now. */
    fun bytes(): Long = connections().use { c -> total(c) }

    private fun total(c: Connection): Long = c.prepareStatement("SELECT COALESCE(SUM(size), 0) FROM ${opts.table}").use { s ->
        s.executeQuery().use { r -> if (r.next()) r.getLong(1) else 0 }
    }

    /** Expired uploads go on every write, then the oldest while the store is over its bound. */
    private fun sweep(c: Connection, t: Long) {
        c.prepareStatement("DELETE FROM ${opts.table} WHERE at < ?").use { s ->
            s.setLong(1, t - opts.ttlMs)
            s.executeUpdate()
        }
        var held = total(c)
        if (held <= opts.maxBytes) return
        val oldest = mutableListOf<Pair<String, Long>>()
        c.prepareStatement("SELECT id, size FROM ${opts.table} ORDER BY at ASC").use { s ->
            s.executeQuery().use { r -> while (r.next()) oldest.add(r.getString(1) to r.getLong(2)) }
        }
        c.prepareStatement("DELETE FROM ${opts.table} WHERE id = ?").use { s ->
            for ((id, size) in oldest) {
                if (held <= opts.maxBytes) break
                s.setString(1, id)
                s.executeUpdate()
                held -= size
            }
        }
    }

    /** The body as it goes to the driver, counting what passes: the row's size is what was actually written. */
    private class Counting(private val source: InputStream) : InputStream() {
        var count = 0L
            private set

        override fun read(): Int = source.read().also { if (it >= 0) count += 1 }

        override fun read(b: ByteArray, off: Int, len: Int): Int = source.read(b, off, len).also { if (it > 0) count += it }
    }
}
