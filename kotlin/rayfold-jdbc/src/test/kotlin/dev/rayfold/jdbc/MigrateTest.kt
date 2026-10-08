package dev.rayfold.jdbc

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.sql.Connection
import java.sql.DriverManager
import java.sql.SQLException
import java.sql.Statement
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * Two servers running `migrate()` at the same instant: Postgres blocks the second `CREATE TABLE IF NOT EXISTS` until
 * the first commits, then refuses it although the table now exists. Both stores run the statement once more on that
 * refusal and on nothing else. The refusal itself comes from a connection that fails the way Postgres does, once.
 */
class MigrateTest {
    private companion object {
        val databases = AtomicInteger()
    }

    private lateinit var url: String
    private lateinit var keepAlive: Connection

    @BeforeEach
    fun open() {
        url = "jdbc:h2:mem:rayfoldddl${databases.incrementAndGet()}"
        keepAlive = DriverManager.getConnection(url)
        keepAlive.createStatement().use { it.execute("CREATE DOMAIN jsonb AS JSON") }
    }

    /** Every real connection a [refusing] proxy opened, to see that migrate() gave each one back. */
    private val opened = CopyOnWriteArrayList<Connection>()

    @AfterEach
    fun close() {
        try {
            assertEquals(0, opened.count { !it.isClosed }, "every connection migrate() took was closed")
        } finally {
            opened.forEach { it.close() }
            keepAlive.close()
        }
    }

    /** Every DDL executed on the connection, in order. */
    private val executed = CopyOnWriteArrayList<String>()

    /**
     * One real H2 connection whose statements refuse, one each, with the SQL states in [refusals] before running. Every
     * call, close() included, goes to that one connection.
     */
    private fun refusing(refusals: ArrayDeque<String>): Connection {
        val real = DriverManager.getConnection(url).also { opened.add(it) }
        return Proxy.newProxyInstance(MigrateTest::class.java.classLoader, arrayOf(Connection::class.java)) { _, method, args ->
            val result = try {
                method.invoke(real, *(args ?: emptyArray()))
            } catch (e: InvocationTargetException) {
                throw e.targetException
            }
            if (method.name != "createStatement") return@newProxyInstance result
            val statement = result as Statement
            Proxy.newProxyInstance(MigrateTest::class.java.classLoader, arrayOf(Statement::class.java)) { _, m, a ->
                if (m.name == "execute") {
                    executed.add(a?.get(0) as String)
                    refusals.removeFirstOrNull()?.let { state -> throw SQLException("another session got there first", state) }
                }
                try {
                    m.invoke(statement, *(a ?: emptyArray()))
                } catch (e: InvocationTargetException) {
                    throw e.targetException
                }
            } as Statement
        } as Connection
    }

    private val silent = object : Notifications {
        override suspend fun listen(channel: String, onPayload: (String) -> Unit): suspend () -> Unit = {}
        override suspend fun notify(channel: String, payload: String) {}
    }

    private fun relay(refusals: ArrayDeque<String>) = PgRelay(silent, { refusing(refusals) })

    private fun store(refusals: ArrayDeque<String>) = JdbcIdempotencyStore({ refusing(refusals) })

    private fun uploads(refusals: ArrayDeque<String>) = JdbcUploadStore({ refusing(refusals) })

    /** The statements an upload store's migrate() runs, read back from one that nobody refuses. */
    private fun uploadDdl(): List<String> {
        executed.clear()
        uploads(ArrayDeque()).migrate()
        return executed.toList().also { executed.clear() }
    }

    @Test
    fun `a migration refused because another server created the table first runs once more, and the table is there`() {
        // 42710 is the table's row type, which Postgres reported when six fleet members booted at once
        for (state in listOf("23505", "42P07", "42710")) {
            executed.clear()
            relay(ArrayDeque(listOf(state))).migrate()
            assertEquals(2, executed.size, "state $state: refused once, then run once more")
            assertEquals(setOf(PgRelay(silent, { keepAlive }).schema()), executed.toSet())

            executed.clear()
            store(ArrayDeque(listOf(state))).migrate()
            val reference = JdbcIdempotencyStore({ keepAlive })
            assertEquals(3, executed.size, "state $state: the table was refused once and run again, then the index")
            assertEquals(listOf(reference.schema(), reference.schema(), reference.index()), executed.toList())

            val (table, index) = uploadDdl()
            uploads(ArrayDeque(listOf(state))).migrate()
            assertEquals(listOf(table, table, index), executed.toList(), "state $state: the uploads table refused once and run again, then its index")
        }
        keepAlive.createStatement().use { s ->
            s.executeQuery("SELECT COUNT(*) FROM rayfold_relay").use { r -> r.next(); assertEquals(0, r.getInt(1), "the relay table exists") }
            s.executeQuery("""SELECT COUNT(*) FROM "rayfold_idempotency"""").use { r -> r.next(); assertEquals(0, r.getInt(1), "the idempotency table exists") }
            s.executeQuery("SELECT COUNT(*) FROM rayfold_uploads").use { r -> r.next(); assertEquals(0, r.getInt(1), "the uploads table exists") }
        }
    }

    @Test
    fun `guard - any other refusal propagates after one attempt`() {
        val refused = assertFailsWith<SQLException> { relay(ArrayDeque(listOf("42601"))).migrate() }
        assertEquals("42601", refused.sqlState)
        assertEquals(1, executed.size)
        executed.clear()
        assertEquals("42601", assertFailsWith<SQLException> { store(ArrayDeque(listOf("42601"))).migrate() }.sqlState)
        assertEquals(1, executed.size)
        executed.clear()
        assertEquals("42601", assertFailsWith<SQLException> { uploads(ArrayDeque(listOf("42601"))).migrate() }.sqlState)
        assertEquals(1, executed.size)
    }

    @Test
    fun `guard - a migration nobody refuses runs each statement once`() {
        relay(ArrayDeque()).migrate()
        assertEquals(1, executed.size, "the relay has only its table")
        executed.clear()
        store(ArrayDeque()).migrate()
        assertEquals(2, executed.size, "the idempotency store has its table and the index the sweep reads")
        executed.clear()
        store(ArrayDeque()).migrate()
        assertEquals(2, executed.size, "and again when both already exist: IF NOT EXISTS, nothing refused")
        assertEquals(2, uploadDdl().size, "the upload store has its table and its index")
    }
}

/**
 * The same migrations against a real Postgres, at the same instant from several sessions: the race MigrateTest stands
 * in for, and the refusal it fakes, happen here for real. Set RAYFOLD_JDBC_URL to run it.
 */
@org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable(named = "RAYFOLD_JDBC_URL", matches = ".+")
class JdbcPostgresMigrateTest {
    private val url = System.getenv("RAYFOLD_JDBC_URL")
    private val suffix = ProcessHandle.current().pid()
    private val schemaName = "rayfold_migrate_$suffix"
    private val silent = object : Notifications {
        override suspend fun listen(channel: String, onPayload: (String) -> Unit): suspend () -> Unit = {}
        override suspend fun notify(channel: String, payload: String) {}
    }

    @AfterEach
    fun drop() {
        DriverManager.getConnection(url).use { c -> c.createStatement().use { it.execute("DROP SCHEMA IF EXISTS $schemaName CASCADE") } }
    }

    /** Runs [migrate] on [n] threads released together, each with a session of its own; the first failure is thrown. */
    private fun atOnce(n: Int, migrate: () -> Unit) {
        val pool = java.util.concurrent.Executors.newFixedThreadPool(n)
        try {
            val go = java.util.concurrent.CountDownLatch(1)
            val runs = (0 until n).map { pool.submit<Unit> { check(go.await(5, java.util.concurrent.TimeUnit.SECONDS)) { "never released" }; migrate() } }
            go.countDown()
            for (r in runs) r.get(10, java.util.concurrent.TimeUnit.SECONDS)
        } finally {
            pool.shutdownNow()
        }
    }

    private fun tables(): List<String> = DriverManager.getConnection(url).use { c ->
        c.prepareStatement("SELECT tablename FROM pg_tables WHERE schemaname = ? ORDER BY tablename").use { s ->
            s.setString(1, schemaName)
            s.executeQuery().use { r -> generateSequence { if (r.next()) r.getString(1) else null }.toList() }
        }
    }

    private fun indexes(): List<String> = DriverManager.getConnection(url).use { c ->
        c.prepareStatement("SELECT indexname FROM pg_indexes WHERE schemaname = ? AND indexname NOT LIKE '%pkey' ORDER BY indexname").use { s ->
            s.setString(1, schemaName)
            s.executeQuery().use { r -> generateSequence { if (r.next()) r.getString(1) else null }.toList() }
        }
    }

    @Test
    fun `six servers migrating every store at the same instant all start, and each table and index exists once`() {
        DriverManager.getConnection(url).use { c -> c.createStatement().use { it.execute("CREATE SCHEMA $schemaName") } }
        val connections = { DriverManager.getConnection(url) }
        atOnce(6) { JdbcIdempotencyStore(connections, JdbcIdempotencyOptions(table = "$schemaName.idem")).migrate() }
        atOnce(6) { JdbcUploadStore(connections, JdbcUploadOptions(table = "$schemaName.uploads")).migrate() }
        atOnce(6) { PgRelay(silent, connections, PgRelayOptions(table = "$schemaName.relay")).migrate() }
        assertEquals(listOf("idem", "relay", "uploads"), tables())
        // a schema-qualified table gets an index named after the whole name, in that schema
        assertEquals(listOf("${schemaName}_idem_at", "${schemaName}_uploads_at"), indexes())
    }

    @Test
    fun `two servers claiming one key on Postgres - one owns it, the other sees it in flight`() {
        DriverManager.getConnection(url).use { c -> c.createStatement().use { it.execute("CREATE SCHEMA $schemaName") } }
        val store = { JdbcIdempotencyStore({ DriverManager.getConnection(url) }, JdbcIdempotencyOptions(table = "$schemaName.idem")) }
        store().migrate()
        val claims = java.util.concurrent.CopyOnWriteArrayList<dev.rayfold.core.IdempotencyClaim>()
        atOnce(2) { claims.add(store().claim("scope", "0123456789abcdef", 30_000)) }
        assertEquals(listOf("InFlight", "Owned"), claims.map { it::class.java.simpleName }.sorted(), "the loser of the INSERT race reads the winner's claim")
    }
}
