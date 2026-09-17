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

    @AfterEach
    fun close() {
        keepAlive.close()
    }

    /** Every DDL executed on the connection, in order. */
    private val executed = CopyOnWriteArrayList<String>()

    /** A real H2 connection whose statements refuse, one each, with the SQL states in [refusals] before running. */
    private fun refusing(refusals: ArrayDeque<String>): Connection = Proxy.newProxyInstance(MigrateTest::class.java.classLoader, arrayOf(Connection::class.java)) { _, method, args ->
        val real = DriverManager.getConnection(url)
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

    private val silent = object : Notifications {
        override suspend fun listen(channel: String, onPayload: (String) -> Unit): suspend () -> Unit = {}
        override suspend fun notify(channel: String, payload: String) {}
    }

    private fun relay(refusals: ArrayDeque<String>) = PgRelay(silent, { refusing(refusals) })

    private fun store(refusals: ArrayDeque<String>) = JdbcIdempotencyStore({ refusing(refusals) })

    @Test
    fun `a migration refused because another server created the table first runs once more, and the table is there`() {
        for (state in listOf("23505", "42P07")) {
            executed.clear()
            relay(ArrayDeque(listOf(state))).migrate()
            assertEquals(2, executed.size, "state $state: refused once, then run once more")
            assertEquals(setOf(PgRelay(silent, { keepAlive }).schema()), executed.toSet())

            executed.clear()
            store(ArrayDeque(listOf(state))).migrate()
            val reference = JdbcIdempotencyStore({ keepAlive })
            assertEquals(3, executed.size, "state $state: the table was refused once and run again, then the index")
            assertEquals(listOf(reference.schema(), reference.schema(), reference.index()), executed.toList())
        }
        keepAlive.createStatement().use { s ->
            s.executeQuery("SELECT COUNT(*) FROM rayfold_relay").use { r -> r.next(); assertEquals(0, r.getInt(1), "the relay table exists") }
            s.executeQuery("""SELECT COUNT(*) FROM "rayfold_idempotency"""").use { r -> r.next(); assertEquals(0, r.getInt(1), "the idempotency table exists") }
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
    }
}
