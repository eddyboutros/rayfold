package dev.rayfold.jdbc

import dev.rayfold.core.EventBus
import dev.rayfold.core.FieldLoader
import dev.rayfold.core.Policy
import dev.rayfold.core.RayfoldContext
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import dev.rayfold.core.RootResolver
import dev.rayfold.core.SchemaText
import dev.rayfold.core.exprOrNull
import dev.rayfold.core.find
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.sql.Connection
import java.sql.DriverManager
import java.sql.PreparedStatement
import java.sql.ResultSet
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * The JDBC adapter against a real database (H2), mirroring packages/postgres/src/postgres.test.ts: batch loads,
 * keyset pages, one query for a whole level of one-to-many pages, and the read policy pushed into the WHERE clause.
 * The policy tests drive a [RayfoldServer] whose resolvers are backed by the store, over a connection that records
 * every statement, so they show the SQL a policy became, the rows it read, and what the client was sent.
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
            s.execute(
                """CREATE TABLE "tickets" ("id" varchar primary key, "desk_id" varchar not null, "status" varchar, "region" varchar not null,
                   "owner_id" varchar, "priority" varchar not null, "rank" int not null)""",
            )
            s.execute(
                """INSERT INTO "tickets" VALUES ('t1','d1','open','eu','u1','urgent',3), ('t2','d1','closed','us','u2','urgent',1),
                   ('t3','d1',null,'apac','u1','low',5), ('t4','d2','open','eu',null,'urgent',2), ('t5','d1','closed','eu','u1','urgent',4)""",
            )
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

    // ------------------------------------------------------------------ policies through the server

    private val ticketSchema = """
        entity OpenTicket @allow(read: status != "closed") { id: ID deskId: ID status: String? }
        entity RegionalTicket @allow(read: region in viewer.regions) { id: ID deskId: ID region: String }
        entity MyUrgentTicket @allow(read: ownerId == viewer.id && priority == "urgent") { id: ID deskId: ID ownerId: ID? priority: String }
        entity VisibleTicket @allow(read: viewer.role == "admin" || ownerId == viewer.id) { id: ID deskId: ID ownerId: ID? }
        entity RankedTicket @allow(read: rank > 2) { id: ID deskId: ID rank: Int }
        entity UnsharedTicket @deny(read: status == "closed") { id: ID deskId: ID status: String? }
        entity UnownedTicket @allow(read: ownerId == null) { id: ID deskId: ID ownerId: ID? }
        entity NotClosedTicket @allow(read: !(status == "closed")) { id: ID deskId: ID status: String? }
        entity Desk { id: ID mine: [MyUrgentTicket] }
        query openTickets: [OpenTicket]
        query regionalTickets(page: PageArgs = { first: 20 }): Page<RegionalTicket>
        query visibleTickets: [VisibleTicket]
        query rankedTickets: [RankedTicket]
        query unsharedTickets: [UnsharedTicket]
        query unownedTickets: [UnownedTicket]
        query notClosedTickets: [NotClosedTicket]
        query desk(id: ID): Desk?
    """.trimIndent()

    private val ticketIr = SchemaText.load(ticketSchema).ir

    /** One statement the store prepared: its SQL, the values bound to it in order, and the rows read from its result. */
    private class Sent(val sql: String) {
        val params = CopyOnWriteArrayList<Any?>()
        val rows = AtomicInteger()
    }

    private val sent = CopyOnWriteArrayList<Sent>()

    /** The policy each resolver was handed, by operation or field. */
    private val handed = ConcurrentHashMap<String, JsonElement>()

    private fun <T : Any> intercept(type: Class<T>, target: T, after: (method: String, args: Array<out Any?>, result: Any?) -> Any?): T =
        type.cast(
            Proxy.newProxyInstance(JdbcStoreTest::class.java.classLoader, arrayOf(type)) { _, method, args ->
                val a: Array<out Any?> = args ?: emptyArray()
                val result = try {
                    method.invoke(target, *a)
                } catch (e: InvocationTargetException) {
                    throw e.targetException
                }
                after(method.name, a, result)
            },
        )

    /** The real H2 connection, with every prepared statement, bound value and row read written down in [sent]. */
    private fun recorded(connection: Connection): Connection = intercept(Connection::class.java, connection) { name, args, result ->
        if (name != "prepareStatement") return@intercept result
        val s = Sent(args[0] as String).also { sent.add(it) }
        intercept(PreparedStatement::class.java, result as PreparedStatement) { n, a, r ->
            when (n) {
                "setObject", "setString" -> r.also { s.params.add(a[1]) }
                "executeQuery" -> intercept(ResultSet::class.java, r as ResultSet) { rn, _, rr -> rr.also { if (rn == "next" && rr == true) s.rows.incrementAndGet() } }
                else -> r
            }
        }
    }

    private fun ticketServer(): RayfoldServer {
        val store = JdbcStore(
            { recorded(DriverManager.getConnection(url)) },
            JdbcStoreOptions(
                ticketIr,
                listOf("OpenTicket", "RegionalTicket", "MyUrgentTicket", "VisibleTicket", "RankedTicket", "UnsharedTicket", "UnownedTicket", "NotClosedTicket").associateWith { JdbcTable("tickets") },
                Naming.SNAKE,
            ),
        )
        fun note(key: String, ctx: RayfoldContext) = ctx.policy?.let { handed[key] = it }
        fun list(op: String, type: String): RootResolver = { _, ctx -> note(op, ctx); JsonArray(store.find(type, ctx = ctx)) }
        val regional: RootResolver = { args, ctx ->
            note("regionalTickets", ctx)
            val first = ((args["page"] as? JsonObject)?.get("first") as? JsonPrimitive)?.content?.toInt() ?: 20
            val p = store.page("RegionalTicket", first, ctx = ctx)
            buildJsonObject { put("items", JsonArray(p.items)); put("cursor", p.cursor); put("hasMore", p.hasMore); put("total", p.total) }
        }
        val mine: FieldLoader = { parents, _, ctx ->
            note("Desk.mine", ctx)
            store.pagesByField("MyUrgentTicket", "deskId", parents.map { it["id"] }, first = 100, ctx = ctx).map { JsonArray(it.items) }
        }
        return RayfoldServer(
            ticketIr,
            Resolvers(
                queries = mapOf(
                    "openTickets" to list("openTickets", "OpenTicket"),
                    "regionalTickets" to regional,
                    "visibleTickets" to list("visibleTickets", "VisibleTicket"),
                    "rankedTickets" to list("rankedTickets", "RankedTicket"),
                    "unsharedTickets" to list("unsharedTickets", "UnsharedTicket"),
                    "unownedTickets" to list("unownedTickets", "UnownedTicket"),
                    "notClosedTickets" to list("notClosedTickets", "NotClosedTicket"),
                    "desk" to { args, _ -> buildJsonObject { put("id", args["id"] ?: error("no id")) } },
                ),
                fields = mapOf("Desk" to mapOf("mine" to mine)),
            ),
        )
    }

    private fun collect(server: RayfoldServer, op: String, viewer: String): List<JsonObject> {
        sent.clear()
        handed.clear()
        return runBlocking { withTimeout(5_000) { server.collect(Json.parseToJsonElement("""{"ops":[$op]}""").jsonObject, Json.parseToJsonElement(viewer)) } }
    }

    private fun frame(text: String): List<JsonObject> = listOf(Json.parseToJsonElement(text).jsonObject)

    /** Every ticket id in the table, read past the adapter: the rows a policy kept from a viewer are there. */
    private fun allTicketIds(): List<String> = keepAlive.createStatement().use { s ->
        s.executeQuery("""SELECT "id" FROM "tickets" ORDER BY "id"""").use { rows -> generateSequence { if (rows.next()) rows.getString(1) else null }.toList() }
    }

    private fun readPolicyOf(type: String): JsonElement? = ticketIr.types.getValue(type).annotations.find("allow")?.args?.get("read").exprOrNull()

    private val agent = """{"id":"u1","role":"agent","regions":["eu","apac"]}"""

    @Test
    fun `!= is pushed down with the rows whose column is null kept, as the policy keeps them`() {
        val frames = collect(ticketServer(), """{"id":1,"op":"openTickets"}""", agent)
        assertEquals(
            frame("""{"id":1,"data":[{"${'$'}type":"OpenTicket","id":"t1","deskId":"d1","status":"open"},{"${'$'}type":"OpenTicket","id":"t3","deskId":"d1","status":null},{"${'$'}type":"OpenTicket","id":"t4","deskId":"d2","status":"open"}],"meta":{"cost":1},"fin":true}"""),
            frames,
        )
        assertEquals(mapOf("openTickets" to readPolicyOf("OpenTicket")), handed.toMap())
        val s = sent.single()
        assertEquals("""SELECT * FROM "tickets" WHERE ("status" IS NULL OR "status" <> ?) ORDER BY "id"""", s.sql)
        assertEquals(listOf<Any?>("closed"), s.params.toList())
        assertEquals(3, s.rows.get(), "the closed tickets were never read")
        assertEquals(listOf("t1", "t2", "t3", "t4", "t5"), allTicketIds(), "guard: t2 and t5 are in the table")
    }

    @Test
    fun `in is pushed down with the viewer's own list, and the page total counts only what the viewer may see`() {
        val server = ticketServer()
        val shape = """"shape":"{ items { id region } total }""""
        val frames = collect(server, """{"id":1,"op":"regionalTickets",$shape}""", agent)
        assertEquals(
            frame("""{"id":1,"data":{"items":[{"${'$'}type":"RegionalTicket","id":"t1","region":"eu"},{"${'$'}type":"RegionalTicket","id":"t3","region":"apac"},{"${'$'}type":"RegionalTicket","id":"t4","region":"eu"},{"${'$'}type":"RegionalTicket","id":"t5","region":"eu"}],"total":4},"meta":{"cost":22},"fin":true}"""),
            frames,
        )
        val s = sent.single()
        assertEquals(
            """SELECT * FROM (SELECT *, COUNT(*) OVER () AS "__total" FROM "tickets" WHERE ("region" IN (?, ?))) AS "__s" ORDER BY CAST("__s"."id" AS VARCHAR) LIMIT ?""",
            s.sql,
        )
        assertEquals(listOf<Any?>("eu", "apac", 21), s.params.toList())
        assertEquals(4, s.rows.get())

        // guard: the values come from the viewer, so another viewer's list selects the ticket this one could not see
        val other = collect(server, """{"id":1,"op":"regionalTickets",$shape}""", """{"id":"u2","role":"agent","regions":["us"]}""")
        assertEquals(frame("""{"id":1,"data":{"items":[{"${'$'}type":"RegionalTicket","id":"t2","region":"us"}],"total":1},"meta":{"cost":22},"fin":true}"""), other)
        assertEquals(listOf<Any?>("us", 21), sent.single().params.toList())
    }

    @Test
    fun `&& is pushed down into a field loader's one query for the whole level`() {
        val server = ticketServer()
        val op = """{"id":1,"op":"desk","args":{"id":"d1"},"shape":"{ id mine { id priority } }"}"""
        val frames = collect(server, op, agent)
        assertEquals(
            frame("""{"id":1,"data":{"${'$'}type":"Desk","id":"d1","mine":[{"${'$'}type":"MyUrgentTicket","id":"t1","priority":"urgent"},{"${'$'}type":"MyUrgentTicket","id":"t5","priority":"urgent"}]},"meta":{"cost":2},"fin":true}"""),
            frames,
        )
        assertEquals(mapOf("Desk.mine" to readPolicyOf("MyUrgentTicket")), handed.toMap())
        val s = sent.single()
        assertEquals(
            """SELECT * FROM (SELECT *, COUNT(*) OVER (PARTITION BY "desk_id") AS "__total", ROW_NUMBER() OVER (PARTITION BY "desk_id" ORDER BY CAST("id" AS VARCHAR)) AS "__n" """ +
                """FROM "tickets" WHERE CAST("desk_id" AS VARCHAR) IN (?) AND (("owner_id" = ?) AND ("priority" = ?))) AS "__s" WHERE "__s"."__n" <= ? ORDER BY CAST("__s"."id" AS VARCHAR)""",
            s.sql,
        )
        assertEquals(listOf<Any?>("d1", "u1", "urgent", 101), s.params.toList())
        assertEquals(2, s.rows.get(), "t3 is the viewer's but not urgent, t2 is urgent but not theirs: neither was read")

        // guard: both sides decide, so the other owner gets their own urgent ticket and nothing else
        val theirs = collect(server, op, """{"id":"u2","role":"agent"}""")
        assertEquals(frame("""{"id":1,"data":{"${'$'}type":"Desk","id":"d1","mine":[{"${'$'}type":"MyUrgentTicket","id":"t2","priority":"urgent"}]},"meta":{"cost":2},"fin":true}"""), theirs)
    }

    @Test
    fun `|| is pushed down with the side that reads only the viewer settled before the query runs`() {
        val server = ticketServer()
        val frames = collect(server, """{"id":1,"op":"visibleTickets","shape":"{ id ownerId }"}""", agent)
        assertEquals(
            frame("""{"id":1,"data":[{"${'$'}type":"VisibleTicket","id":"t1","ownerId":"u1"},{"${'$'}type":"VisibleTicket","id":"t3","ownerId":"u1"},{"${'$'}type":"VisibleTicket","id":"t5","ownerId":"u1"}],"meta":{"cost":1},"fin":true}"""),
            frames,
        )
        assertEquals("""SELECT * FROM "tickets" WHERE (FALSE OR ("owner_id" = ?)) ORDER BY "id"""", sent.single().sql)
        assertEquals(listOf<Any?>("u1"), sent.single().params.toList())
        assertEquals(3, sent.single().rows.get())

        // guard: for an admin the viewer's side holds, so every ticket is read and served
        val admin = collect(server, """{"id":1,"op":"visibleTickets","shape":"{ id ownerId }"}""", """{"id":"u9","role":"admin"}""")
        assertEquals(
            frame("""{"id":1,"data":[{"${'$'}type":"VisibleTicket","id":"t1","ownerId":"u1"},{"${'$'}type":"VisibleTicket","id":"t2","ownerId":"u2"},{"${'$'}type":"VisibleTicket","id":"t3","ownerId":"u1"},{"${'$'}type":"VisibleTicket","id":"t4","ownerId":null},{"${'$'}type":"VisibleTicket","id":"t5","ownerId":"u1"}],"meta":{"cost":1},"fin":true}"""),
            admin,
        )
        assertEquals("""SELECT * FROM "tickets" WHERE (TRUE OR ("owner_id" = ?)) ORDER BY "id"""", sent.single().sql)
        assertEquals(5, sent.single().rows.get())
    }

    @Test
    fun `a comparison the adapter cannot translate reads every row, and the runtime filters them in memory`() {
        val frames = collect(ticketServer(), """{"id":1,"op":"rankedTickets"}""", agent)
        assertEquals(mapOf("rankedTickets" to readPolicyOf("RankedTicket")), handed.toMap(), "the runtime offered the policy")
        assertEquals("""SELECT * FROM "tickets" ORDER BY "id"""", sent.single().sql, "the adapter left it out rather than risk dropping an allowed row")
        assertEquals(5, sent.single().rows.get())
        // the default view reads a denied row as null: t2 (rank 1) and t4 (rank 2) are filtered after the query
        assertEquals(
            frame("""{"id":1,"data":[{"${'$'}type":"RankedTicket","id":"t1","deskId":"d1","rank":3},null,{"${'$'}type":"RankedTicket","id":"t3","deskId":"d1","rank":5},null,{"${'$'}type":"RankedTicket","id":"t5","deskId":"d1","rank":4}],"meta":{"cost":1},"fin":true}"""),
            frames,
        )
    }

    @Test
    fun `a policy that cannot be pushed at all hands the resolver nothing, and the runtime filters every row it read`() {
        val frames = collect(ticketServer(), """{"id":1,"op":"unsharedTickets"}""", agent)
        assertEquals(emptyMap(), handed.toMap(), "a deny needs the runtime's own check, so nothing is pushed")
        assertEquals("""SELECT * FROM "tickets" ORDER BY "id"""", sent.single().sql)
        assertEquals(emptyList(), sent.single().params.toList())
        assertEquals(5, sent.single().rows.get())
        assertEquals(
            frame("""{"id":1,"data":[{"${'$'}type":"UnsharedTicket","id":"t1","deskId":"d1","status":"open"},null,{"${'$'}type":"UnsharedTicket","id":"t3","deskId":"d1","status":null},{"${'$'}type":"UnsharedTicket","id":"t4","deskId":"d2","status":"open"},null],"meta":{"cost":1},"fin":true}"""),
            frames,
        )
    }

    @Test
    fun `== null is pushed down as IS NULL`() {
        val frames = collect(ticketServer(), """{"id":1,"op":"unownedTickets"}""", agent)
        assertEquals(frame("""{"id":1,"data":[{"${'$'}type":"UnownedTicket","id":"t4","deskId":"d2","ownerId":null}],"meta":{"cost":1},"fin":true}"""), frames)
        assertEquals("""SELECT * FROM "tickets" WHERE ("owner_id" IS NULL) ORDER BY "id"""", sent.single().sql)
        assertEquals(emptyList(), sent.single().params.toList())
        assertEquals(1, sent.single().rows.get())
    }

    @Test
    fun `in over an empty list is pushed down as FALSE, and reads nothing`() {
        val shape = """"shape":"{ items { id region } total }""""
        val frames = collect(ticketServer(), """{"id":1,"op":"regionalTickets",$shape}""", """{"id":"u3","role":"agent","regions":[]}""")
        assertEquals(frame("""{"id":1,"data":{"items":[],"total":0},"meta":{"cost":22},"fin":true}"""), frames)
        assertEquals(
            """SELECT * FROM (SELECT *, COUNT(*) OVER () AS "__total" FROM "tickets" WHERE FALSE) AS "__s" ORDER BY CAST("__s"."id" AS VARCHAR) LIMIT ?""",
            sent.single().sql,
        )
        assertEquals(listOf<Any?>(21), sent.single().params.toList())
        assertEquals(0, sent.single().rows.get())
    }

    /**
     * SQL's NOT of an unknown is unknown, and a WHERE drops it; the policy language reads `null == "closed"` as false,
     * so its negation keeps the row. t3's status is null: the policy allows it, and the pushed-down filter must too.
     */
    @Test
    fun `not is pushed down without dropping a row whose column is null, which the policy allows`() {
        val frames = collect(ticketServer(), """{"id":1,"op":"notClosedTickets"}""", agent)
        assertEquals(
            frame("""{"id":1,"data":[{"${'$'}type":"NotClosedTicket","id":"t1","deskId":"d1","status":"open"},{"${'$'}type":"NotClosedTicket","id":"t3","deskId":"d1","status":null},{"${'$'}type":"NotClosedTicket","id":"t4","deskId":"d2","status":"open"}],"meta":{"cost":1},"fin":true}"""),
            frames,
        )
        assertEquals("""SELECT * FROM "tickets" WHERE (NOT COALESCE(("status" = ?), FALSE)) ORDER BY "id"""", sent.single().sql)
        assertEquals(listOf<Any?>("closed"), sent.single().params.toList())
        assertEquals(3, sent.single().rows.get(), "the closed tickets were never read")
    }

    /** A store over the tickets whose connections record into [sent], for calls made straight to the store. */
    private fun recordedStore(ir: dev.rayfold.core.RayfoldSchemaIR, tables: Map<String, JdbcTable>, naming: Naming) =
        JdbcStore({ recorded(DriverManager.getConnection(url)) }, JdbcStoreOptions(ir, tables, naming))

    private val plainTickets = SchemaText.load("entity Ticket { id: ID deskId: ID status: String? }").ir

    @Test
    fun `where equalities become one condition each, and a null value is IS NULL`() {
        val store = recordedStore(plainTickets, mapOf("Ticket" to JdbcTable("tickets")), Naming.SNAKE)
        val rows = store.find("Ticket", mapOf("deskId" to JsonPrimitive("d1"), "status" to JsonNull))
        assertEquals(listOf(Json.parseToJsonElement("""{"id":"t3","deskId":"d1","status":null}""")), rows.map { JsonObject(it.filterKeys { k -> k in setOf("id", "deskId", "status") }) })
        assertEquals("""SELECT * FROM "tickets" WHERE "desk_id" = ? AND "status" IS NULL ORDER BY "id"""", sent.single().sql)
        assertEquals(listOf<Any?>("d1"), sent.single().params.toList())
        assertEquals(1, sent.single().rows.get())

        // guard: a value is bound, not written as IS NULL
        sent.clear()
        assertEquals(listOf("t1"), store.find("Ticket", mapOf("deskId" to JsonPrimitive("d1"), "status" to JsonPrimitive("open"))).map { text(it, "id") })
        assertEquals("""SELECT * FROM "tickets" WHERE "desk_id" = ? AND "status" = ? ORDER BY "id"""", sent.single().sql)
        assertEquals(listOf<Any?>("d1", "open"), sent.single().params.toList())

        // and a page takes the same conditions, counting only what matches them
        sent.clear()
        val page = store.page("Ticket", first = 10, where = mapOf("status" to JsonNull))
        assertEquals(listOf("t3") to 1, page.items.map { text(it, "id") } to page.total)
        assertEquals(
            """SELECT * FROM (SELECT *, COUNT(*) OVER () AS "__total" FROM "tickets" WHERE "status" IS NULL) AS "__s" ORDER BY CAST("__s"."id" AS VARCHAR) LIMIT ?""",
            sent.single().sql,
        )
        assertEquals(listOf<Any?>(11), sent.single().params.toList())
    }

    @Test
    fun `Naming SAME uses the field name as the column, and a column override wins over either naming`() {
        keepAlive.createStatement().use { s ->
            s.execute("""CREATE TABLE "notes" ("id" varchar primary key, "deskRef" varchar not null, "body_text" varchar not null)""")
            s.execute("""INSERT INTO "notes" VALUES ('n1','d1','hello'), ('n2','d2','bye')""")
        }
        val ir = SchemaText.load("entity Note { id: ID deskRef: ID body: String }").ir
        val store = recordedStore(ir, mapOf("Note" to JdbcTable("notes", columns = mapOf("body" to "body_text"))), Naming.SAME)
        val rows = store.find("Note", mapOf("deskRef" to JsonPrimitive("d1"), "body" to JsonPrimitive("hello")))
        assertEquals(listOf(Json.parseToJsonElement("""{"id":"n1","deskRef":"d1","body":"hello"}""")), rows)
        assertEquals("""SELECT * FROM "notes" WHERE "deskRef" = ? AND "body_text" = ? ORDER BY "id"""", sent.single().sql)
        assertEquals(listOf<Any?>("d1", "hello"), sent.single().params.toList())
    }
}
