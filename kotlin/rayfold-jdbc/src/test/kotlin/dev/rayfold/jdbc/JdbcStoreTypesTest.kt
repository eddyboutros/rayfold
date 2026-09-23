package dev.rayfold.jdbc

import dev.rayfold.core.EventBus
import dev.rayfold.core.Policy
import dev.rayfold.core.RayfoldContext
import dev.rayfold.core.SchemaText
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import java.sql.Connection
import java.sql.DriverManager
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals

/**
 * Policies the store cannot translate exactly, and values of the column's own type. A pushed-down filter may select
 * more rows than the policy allows, never fewer (the runtime removes the rest); these are the cases where it did
 * select fewer, or where the statement could not run at all.
 */
class JdbcStoreTypesTest {
    private val schema = SchemaText.load(
        """
        entity Mine @allow(read: !(ownerId == viewer.id && rank > 2)) { id: ID ownerId: ID? rank: Int }
        entity OpenOrUnset @allow(read: status in [null, "open"]) { id: ID status: String? }
        entity NotOpenAsList @allow(read: !(["open"] in status)) { id: ID status: String? }
        entity NotMine @allow(read: !(ownerId == viewer.id)) { id: ID ownerId: ID? rank: Int }
        entity Open @allow(read: status in ["open"]) { id: ID status: String? }
        """.trimIndent(),
    ).ir

    private companion object {
        val databases = AtomicInteger()
    }

    private lateinit var url: String
    private lateinit var keepAlive: Connection

    @BeforeEach
    fun open() {
        url = "jdbc:h2:mem:rayfoldtypes${databases.incrementAndGet()}"
        keepAlive = DriverManager.getConnection(url)
        keepAlive.createStatement().use { s ->
            s.execute("""CREATE TABLE "tickets" ("id" varchar primary key, "owner_id" varchar, "status" varchar, "rank" int not null)""")
            s.execute("""INSERT INTO "tickets" VALUES ('t1','u1','open',3), ('t2','u2','closed',1), ('t3','u1',null,5), ('t4',null,'open',2)""")
        }
    }

    @AfterEach
    fun close() {
        keepAlive.close()
    }

    private fun store() = JdbcStore(
        { DriverManager.getConnection(url) },
        JdbcStoreOptions(schema, listOf("Mine", "OpenOrUnset", "NotOpenAsList", "NotMine", "Open").associateWith { JdbcTable("tickets") }, Naming.SNAKE),
    )

    private fun ctx(type: String, viewer: JsonElement = JsonObject(mapOf("id" to JsonPrimitive("u1")))) =
        RayfoldContext(viewer, false, 1, type, JsonObject(emptyMap()), EventBus(), policy = schema.types.getValue(type).annotations.let { Policy.pushableFilter(it) })

    private fun ids(type: String): List<String> = store().find(type, ctx = ctx(type)).map { it.getValue("id").jsonPrimitive.content }

    @Test
    fun `a negation it cannot translate keeps every row and binds nothing it does not use`() {
        // `rank > 2` is left to the runtime, so the && under the ! is not exact: its bound viewer id used to stay behind
        // with no ? to fill, and every read of the type failed
        assertEquals(listOf("t1", "t2", "t3", "t4"), ids("Mine"))
        // guard: a negation it can translate still filters, and a null owner is kept as the policy keeps it
        assertEquals(listOf("t2", "t4"), ids("NotMine"))
    }

    @Test
    fun `a list holding null is left to the runtime rather than dropping the rows whose column is null`() {
        // the policy lets t3 (status null) through, and IN never matches a null: the store now selects every row and
        // the runtime keeps t1, t3 and t4, where `status IN (?, ?)` selected only t1 and t4
        assertEquals(listOf("t1", "t2", "t3", "t4"), ids("OpenOrUnset"))
        // guard: a list of values only is still pushed down, exactly
        assertEquals(listOf("t1", "t4"), ids("Open"))
    }

    @Test
    fun `a field on the right of in is left to the runtime, which reads it as a list being an element of the field`() {
        // `["open"] in status` is false for every row, so its negation allows them all; as `status IN (...)` the
        // negation dropped the open ones
        assertEquals(listOf("t1", "t2", "t3", "t4"), ids("NotOpenAsList"))
    }
}

/**
 * The same store against a real Postgres, whose comparisons are typed where H2's convert: a string bound as `varchar`
 * meets no `uuid`, `boolean` or `integer` column. Set RAYFOLD_JDBC_URL, for example
 * `jdbc:postgresql://127.0.0.1:5432/postgres?user=postgres&password=secret`, to run it.
 */
@EnabledIfEnvironmentVariable(named = "RAYFOLD_JDBC_URL", matches = ".+")
class JdbcStorePostgresTest {
    private val schema = SchemaText.load(
        """
        entity Doc @allow(read: ownerId == viewer.id && published == true && rank == 3) { id: ID ownerId: ID published: Boolean rank: Int }
        entity Anyone { id: ID ownerId: ID published: Boolean rank: Int }
        """.trimIndent(),
    ).ir
    private val url = System.getenv("RAYFOLD_JDBC_URL")
    private val table = "rayfold_types_${ProcessHandle.current().pid()}"
    private val alice = "7a3c2f0e-2b1d-4c1e-9a8b-1f2e3d4c5b6a"

    @BeforeEach
    fun open() {
        DriverManager.getConnection(url).use { c ->
            c.createStatement().use { s ->
                s.execute("""CREATE TABLE "$table" ("id" uuid primary key, "owner_id" uuid not null, "published" boolean not null, "rank" int not null)""")
                s.execute(
                    """INSERT INTO "$table" VALUES ('00000000-0000-0000-0000-000000000001','$alice',true,3), ('00000000-0000-0000-0000-000000000002','$alice',false,3),
                       ('00000000-0000-0000-0000-000000000003','$alice',true,1), ('00000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',true,3)""",
                )
            }
        }
    }

    @AfterEach
    fun close() {
        DriverManager.getConnection(url).use { c -> c.createStatement().use { it.execute("""DROP TABLE "$table"""") } }
    }

    private fun store() = JdbcStore({ DriverManager.getConnection(url) }, JdbcStoreOptions(schema, mapOf("Doc" to JdbcTable(table), "Anyone" to JdbcTable(table)), Naming.SNAKE))

    @Test
    fun `a policy over uuid, boolean and integer columns runs, and keeps exactly the rows it allows`() {
        val ctx = RayfoldContext(JsonObject(mapOf("id" to JsonPrimitive(alice))), false, 1, "docs", JsonObject(emptyMap()), EventBus(), policy = Policy.pushableFilter(schema.types.getValue("Doc").annotations))
        // these threw `operator does not exist: uuid = character varying` (and boolean, and integer) before
        assertEquals(listOf("00000000-0000-0000-0000-000000000001"), store().find("Doc", ctx = ctx).map { it.getValue("id").jsonPrimitive.content })
    }

    @Test
    fun `a resolver's own equality on a uuid column runs`() {
        val rows = store().find("Anyone", where = mapOf("ownerId" to JsonPrimitive(alice), "rank" to JsonPrimitive(3)))
        assertEquals(2, rows.size)
        val page = store().page("Anyone", first = 10, where = mapOf("published" to JsonPrimitive(true)))
        assertEquals(3, page.total)
    }
}
