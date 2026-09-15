package dev.rayfold.core

import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.time.Duration.Companion.seconds

/**
 * The pushable read policy reaches resolvers as `ctx.policy` (spec 06 section 4), as it does in TypeScript, so a data
 * source can filter at the source instead of loading rows the viewer may not see: field loaders, root queries and
 * streams alike.
 */
class PolicyPushdownTest {
    private val schema = """
        entity Order @allow(read: viewer.id == customerId) { id: ID customerId: ID shelf: Shelf? }
        entity Note @allow(read: viewer.role == "admin" || this.owner.team == viewer.team) { id: ID owner: ID }
        entity Shelf { id: ID label: String }
        entity Desk { id: ID order: Order note: Note shelf: Shelf }
        query desk(id: ID): Desk?
        query orders: [Order]
        query shelves: [Shelf]
        stream orderFeed: Order
    """.trimIndent()

    private val ir = SchemaText.load(schema).ir
    private val desk = buildJsonObject { put("id", "d1") }
    private val viewer = buildJsonObject { put("id", "u1"); put("role", "customer") }
    private val order = buildJsonObject { put("id", "o1"); put("customerId", "u1") }

    /** The expression the schema declares for [type]'s read policy. */
    private fun allowOf(type: String): JsonObject = assertNotNull(ir.types.getValue(type).annotations.find("allow")?.args?.get("read").exprOrNull())

    private fun frames(server: RayfoldServer, op: String): List<JsonObject> {
        var frames = emptyList<JsonObject>()
        runTest(timeout = 5.seconds) { frames = server.execute(Json.parseToJsonElement("""{"ops":[$op]}""").jsonObject, viewer).toList() }
        return frames
    }

    /** Runs one op that selects [field] and returns the policy the loader for it was handed. */
    private fun policyHandedTo(field: String): JsonObject? {
        var seen: JsonObject? = null
        var called = false
        val loader: FieldLoader = { parents, _, ctx ->
            called = true
            seen = ctx.policy
            parents.map { buildJsonObject { put("id", "x1") } }
        }
        val resolvers = Resolvers(queries = mapOf("desk" to { _, _ -> desk }), fields = mapOf("Desk" to mapOf(field to loader)))
        frames(RayfoldServer(ir, resolvers), """{"id":1,"op":"desk","args":{"id":"d1"},"shape":"{ id $field { id } }"}""")
        assertEquals(true, called, "the loader for $field must run")
        return seen
    }

    @Test
    fun `a policy a data source can apply arrives as ctx-policy`() {
        val pushed = assertNotNull(policyHandedTo("order"), "the policy of Order is pushable")
        assertEquals(allowOf("Order"), pushed)
        assertEquals(true, Policy.isPushable(pushed))
    }

    @Test
    fun `a policy that reads through the row is left to the runtime`() {
        // `this.owner.team` needs more than the row's own columns, so nothing is pushed and the runtime filters
        assertNull(policyHandedTo("note"))
    }

    @Test
    fun `a type with no policy hands the loader nothing`() {
        assertNull(policyHandedTo("shelf"))
    }

    @Test
    fun `a root query and a stream are handed the policy of what they return, and the rows they return are still checked`() {
        val seen = mutableMapOf<String, JsonObject?>()
        val stranger = buildJsonObject { put("id", "o2"); put("customerId", "u2") }
        val resolvers = Resolvers(
            queries = mapOf("orders" to { _, ctx -> seen["orders"] = ctx.policy; JsonArray(listOf(order, stranger)) }),
            streams = mapOf("orderFeed" to { _, ctx -> seen["orderFeed"] = ctx.policy; flowOf(order) }),
        )
        val server = RayfoldServer(ir, resolvers)
        val listed = frames(server, """{"id":1,"op":"orders"}""")
        frames(server, """{"id":1,"op":"orderFeed"}""")
        assertEquals<Map<String, JsonObject?>>(mapOf("orders" to allowOf("Order"), "orderFeed" to allowOf("Order")), seen)
        // a resolver that ignores the hint still serves only what the policy allows: the default view reads a denied row as null
        assertEquals(listOf(obj("""{"id":1,"data":[{"${'$'}type":"Order","id":"o1","customerId":"u1"},null],"meta":{"cost":1},"fin":true}""")), listed)
    }

    @Test
    fun `guard - a root query for a type without a policy is handed nothing, and neither is a loader beneath a root that had one`() {
        val seen = mutableMapOf<String, JsonObject?>()
        val resolvers = Resolvers(
            queries = mapOf(
                "shelves" to { _, ctx -> seen["shelves"] = ctx.policy; JsonArray(listOf(buildJsonObject { put("id", "s1"); put("label", "A") })) },
                "orders" to { _, ctx -> seen["orders"] = ctx.policy; JsonArray(listOf(order)) },
            ),
            fields = mapOf("Order" to mapOf("shelf" to { parents, _, ctx -> seen["Order.shelf"] = ctx.policy; parents.map { buildJsonObject { put("id", "s1"); put("label", "A") } } })),
        )
        val server = RayfoldServer(ir, resolvers)
        frames(server, """{"id":1,"op":"shelves"}""")
        val served = frames(server, """{"id":1,"op":"orders","shape":"{ id shelf { id } }"}""")
        assertEquals<Map<String, JsonObject?>>(mapOf("shelves" to null, "orders" to allowOf("Order"), "Order.shelf" to null), seen)
        assertEquals(listOf(obj("""{"id":1,"data":[{"${'$'}type":"Order","id":"o1","shelf":{"${'$'}type":"Shelf","id":"s1"}}],"meta":{"cost":2},"fin":true}""")), served)
    }

    @Test
    fun `mergePolicies reads every declared conflict policy from the schema`() {
        val policies = mergePolicies(
            SchemaText.load(
                """
                entity Doc { id: ID title: String @merge(serverWins) body: String @merge(crdtText) notes: String }
                query doc(id: ID): Doc?
                """.trimIndent(),
            ).ir,
        )
        assertEquals(mapOf("Doc.title" to "serverWins", "Doc.body" to "crdtText"), policies)
    }
}
