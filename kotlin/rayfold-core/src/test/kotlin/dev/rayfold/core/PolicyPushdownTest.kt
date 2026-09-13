package dev.rayfold.core

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
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
 * source can filter at the source instead of loading rows the viewer may not see.
 */
class PolicyPushdownTest {
    private val schema = """
        entity Order @allow(read: viewer.id == customerId) { id: ID customerId: ID }
        entity Note @allow(read: viewer.role == "admin" || this.owner.team == viewer.team) { id: ID owner: ID }
        entity Shelf { id: ID label: String }
        entity Desk { id: ID order: Order note: Note shelf: Shelf }
        query desk(id: ID): Desk?
    """.trimIndent()

    private val ir = SchemaText.load(schema).ir
    private val desk = buildJsonObject { put("id", "d1") }

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
        val server = RayfoldServer(ir, resolvers)
        val viewer = buildJsonObject { put("id", "u1"); put("role", "customer") }
        val envelope = Json.parseToJsonElement("""{"ops":[{"id":1,"op":"desk","args":{"id":"d1"},"shape":"{ id $field { id } }"}]}""").jsonObject
        runTest(timeout = 5.seconds) { server.execute(envelope, viewer).toList() }
        assertEquals(true, called, "the loader for $field must run")
        return seen
    }

    @Test
    fun `a policy a data source can apply arrives as ctx-policy`() {
        val pushed = assertNotNull(policyHandedTo("order"), "the policy of Order is pushable")
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
