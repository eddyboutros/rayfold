package dev.rayfold.jdbc

import dev.rayfold.core.EventBus
import dev.rayfold.core.Policy
import dev.rayfold.core.RayfoldContext
import dev.rayfold.core.SchemaText
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.sql.Connection
import java.sql.DriverManager
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The JDBC adapter against a real database (H2), mirroring packages/postgres/src/postgres.test.ts: batch loads,
 * keyset pages, one query for a whole level of one-to-many pages, and the read policy pushed into the WHERE clause.
 */
class JdbcStoreTest {
    private val schema = """
        entity Order @allow(read: viewer.id == customerId) { id: ID customerId: ID? total: Decimal }
        entity Item { id: ID orderId: ID name: String }
        query orders(page: PageArgs = { first: 20 }): Page<Order>
        query items: [Item]
    """.trimIndent()

    private val ir = SchemaText.load(schema).ir
    private companion object {
        /** JUnit builds a fresh instance per test, so the counter that names each database has to outlive it. */
        val databases = AtomicInteger()
    }
    private lateinit var url: String
    private lateinit var keepAlive: Connection

    private fun store() = JdbcStore(
        { DriverManager.getConnection(url) },
        JdbcStoreOptions(
            ir,
            mapOf("Order" to JdbcTable("orders"), "Item" to JdbcTable("items")),
            Naming.SNAKE,
        ),
    )

    @BeforeEach
    fun open() {
        url = "jdbc:h2:mem:rayfold${databases.incrementAndGet()}" // a database of its own, alive while this connection is
        keepAlive = DriverManager.getConnection(url)
        keepAlive.createStatement().use { s ->
            // the adapter quotes every identifier, as the Postgres one does, so these tables are named in lower case
            s.execute("""CREATE TABLE "orders" ("id" varchar primary key, "customer_id" varchar, "total" numeric(10,2) not null)""")
            s.execute("""CREATE TABLE "items" ("id" varchar primary key, "order_id" varchar not null, "name" varchar not null)""")
            s.execute("""INSERT INTO "orders" VALUES ('o1','u1',12.50), ('o2','u2',8.00), ('o3','u1',30.00), ('o4',null,5.00)""")
            s.execute("""INSERT INTO "items" VALUES ('i1','o1','pen'), ('i2','o1','ink'), ('i3','o1','pad'), ('i4','o2','clip'), ('i5','o3','tape')""")
        }
    }

    @AfterEach
    fun close() {
        keepAlive.close()
    }

    private fun text(row: JsonObject?, field: String): String? = (row?.get(field) as? JsonPrimitive)?.content

    private fun viewerContext(type: String, viewer: JsonElement): RayfoldContext {
        val filter = ir.types[type]?.annotations?.let { Policy.pushableFilter(it) }
        return RayfoldContext(viewer, false, 1, "orders", JsonObject(emptyMap()), EventBus(), policy = filter)
    }

    private fun viewer(id: String): JsonObject = JsonObject(mapOf("id" to JsonPrimitive(id)))

    @Test
    fun `loads by id in the order asked, with null for one that is missing`() {
        val rows = store().byIds("Order", listOf(JsonPrimitive("o3"), JsonPrimitive("nope"), JsonPrimitive("o1"), null))
        assertEquals(listOf("o3", null, "o1", null), rows.map { text(it, "id") })
        assertEquals("u1", text(rows[0], "customerId"))
        assertEquals("30.00", text(rows[0], "total"))
    }

    @Test
    fun `walks every page with the cursor, with the total on each`() {
        val store = store()
        val seen = mutableListOf<String>()
        var after: String? = null
        var guard = 0
        while (guard++ < 10) {
            val page = store.page("Order", first = 3, after = after)
            assertEquals(4, page.total)
            seen.addAll(page.items.mapNotNull { text(it, "id") })
            if (!page.hasMore) break
            after = page.cursor
        }
        assertEquals(listOf("o1", "o2", "o3", "o4"), seen)
        val past = store.page("Order", first = 3, after = "o4")
        assertEquals(0, past.items.size)
        assertEquals(4, past.total)
        assertNull(past.cursor)
    }

    @Test
    fun `one query gives every parent its own page`() {
        val pages = store().pagesByField("Item", "orderId", listOf(JsonPrimitive("o1"), JsonPrimitive("o2"), JsonPrimitive("o9")), first = 2)
        assertEquals(listOf(listOf("i1", "i2"), listOf("i4"), emptyList()), pages.map { p -> p.items.mapNotNull { text(it, "id") } })
        assertEquals(listOf(3, 1, 0), pages.map { it.total })
        assertEquals(listOf(true, false, false), pages.map { it.hasMore })
    }

    @Test
    fun `the read policy is pushed into the query, and counts only what the viewer may see`() {
        val mine = store().page("Order", first = 10, ctx = viewerContext("Order", viewer("u1")))
        assertEquals(listOf("o1", "o3"), mine.items.mapNotNull { text(it, "id") })
        assertEquals(2, mine.total, "the total counts the viewer's rows, not every row")

        val theirs = store().page("Order", first = 10, ctx = viewerContext("Order", viewer("u2")))
        assertEquals(listOf("o2"), theirs.items.mapNotNull { text(it, "id") })

        // a row nobody owns belongs to nobody: never served to a viewer, and never counted for one
        assertEquals(emptyList(), store().byIds("Order", listOf(JsonPrimitive("o4")), viewerContext("Order", viewer("u1"))).mapNotNull { it })

        // guard: without the hint the store filters nothing, and the runtime's own check does the work
        assertEquals(4, store().page("Order", first = 10).total)
    }

    @Test
    fun `a type with no policy is left alone`() {
        val all = store().find("Item", ctx = viewerContext("Item", viewer("u1")))
        assertEquals(5, all.size)
    }
}
