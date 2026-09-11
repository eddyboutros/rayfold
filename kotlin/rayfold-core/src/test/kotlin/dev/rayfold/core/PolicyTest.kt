package dev.rayfold.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * Policy decisions. Production callers (grep `Policy\.decide`): Executor.checkOpPolicy (read for queries and
 * streams, write for commands, with the coerced op args), the entity check in projectMany (this = row) and the
 * field check in projectMany (args = the field's args). Each call shape has a pipeline test below.
 */
class PolicyTest {
    private val noClock: () -> Long = { error("this policy must not read the clock") }
    private fun env(viewer: JsonElement = JsonNull, self: JsonElement = JsonNull, args: JsonElement = JsonObject(emptyMap())) = ExprEnv(viewer, args, self, noClock)

    private val admin = obj("""{"id":"u9","role":"admin"}""")
    private val customer = obj("""{"id":"u1","role":"customer"}""")
    private val isAdmin = E.bin("==", E.path("viewer", "role"), E.lit("admin"))
    private val signedIn = E.bin("!=", E.path("viewer"), E.nul)
    private val outOfStock = E.bin("==", E.path("this", "stock"), E.lit(0))
    private fun allow(e: JsonObject, mode: String = "read") = E.policy("allow", mode, e)
    private fun deny(e: JsonObject, mode: String = "read") = E.policy("deny", mode, e)

    // ------------------------------------------------------------------ unit

    @Test
    fun `no policy allows everyone, signed in or not`() {
        assertEquals(Policy.Decision.ALLOW, Policy.decide(emptyList(), "read", env()))
        val cacheOnly = listOf(Annotation("cache", mapOf("maxAge" to obj("""{"${'$'}duration":60000}"""))))
        assertEquals(Policy.Decision.ALLOW, Policy.decide(cacheOnly, "write", env()))
        assertFalse(Policy.hasPolicy(cacheOnly, "read"))
        assertTrue(Policy.hasPolicy(listOf(allow(isAdmin)), "read"), "guard: a real policy is detected")
    }

    @Test
    fun `allow admits only a literal true`() {
        assertEquals(Policy.Decision.ALLOW, Policy.decide(listOf(allow(isAdmin)), "read", env(admin)))
        assertEquals(Policy.Decision.DENY, Policy.decide(listOf(allow(isAdmin)), "read", env(customer)))
        val flag = listOf(allow(E.path("this", "flag")))
        assertEquals(Policy.Decision.DENY, Policy.decide(flag, "read", env(customer, obj("""{"flag":"yes"}"""))), "truthy is not enough")
        assertEquals(Policy.Decision.ALLOW, Policy.decide(flag, "read", env(customer, obj("""{"flag":true}"""))))
    }

    @Test
    fun `a failed viewer-dependent allow without a viewer is unauthenticated, a viewer-independent one is a plain deny`() {
        assertEquals(Policy.Decision.UNAUTHENTICATED, Policy.decide(listOf(allow(isAdmin)), "read", env()))
        val public = listOf(allow(E.bin("==", E.path("this", "public"), E.lit(true))))
        assertEquals(Policy.Decision.DENY, Policy.decide(public, "read", env(self = obj("""{"public":false}"""))), "no viewer involved, so no sign-in prompt")
        assertEquals(Policy.Decision.ALLOW, Policy.decide(public, "read", env(self = obj("""{"public":true}"""))))
    }

    @Test
    fun `deny blocks on true and lets false or null through`() {
        val d = listOf(deny(outOfStock))
        assertEquals(Policy.Decision.DENY, Policy.decide(d, "read", env(customer, obj("""{"stock":0}"""))))
        assertEquals(Policy.Decision.ALLOW, Policy.decide(d, "read", env(customer, obj("""{"stock":2}"""))))
        assertEquals(Policy.Decision.ALLOW, Policy.decide(d, "read", env(customer, obj("{}"))), "a missing field compares as null, which is not 0")
    }

    @Test
    fun `deny is evaluated after allow`() {
        val both = listOf(allow(signedIn), deny(outOfStock))
        assertEquals(Policy.Decision.DENY, Policy.decide(both, "read", env(customer, obj("""{"stock":0}"""))))
        assertEquals(Policy.Decision.ALLOW, Policy.decide(both, "read", env(customer, obj("""{"stock":2}"""))))
        assertEquals(Policy.Decision.UNAUTHENTICATED, Policy.decide(both, "read", env(self = obj("""{"stock":2}"""))), "allow fails first")
    }

    @Test
    fun `a viewer-dependent deny that fires without a viewer is unauthenticated`() {
        val anonymousBlocked = listOf(deny(E.bin("==", E.path("viewer"), E.nul)))
        assertEquals(Policy.Decision.UNAUTHENTICATED, Policy.decide(anonymousBlocked, "read", env()))
        assertEquals(Policy.Decision.ALLOW, Policy.decide(anonymousBlocked, "read", env(customer)))
    }

    @Test
    fun `policies are per mode`() {
        val writeOnly = listOf(allow(isAdmin, "write"))
        assertEquals(Policy.Decision.ALLOW, Policy.decide(writeOnly, "read", env(customer)))
        assertEquals(Policy.Decision.DENY, Policy.decide(writeOnly, "write", env(customer)))
        assertFalse(Policy.hasPolicy(writeOnly, "read"))
        assertTrue(Policy.hasPolicy(writeOnly, "write"))
    }

    @Test
    fun `an expression that cannot be evaluated fails closed`() {
        val levelOver3 = E.bin(">", E.path("viewer", "level"), E.lit(3))
        val high = obj("""{"id":"u1","level":"high"}""")
        assertEquals(Policy.Decision.DENY, Policy.decide(listOf(allow(levelOver3)), "read", env(high)), "a broken allow does not admit")
        assertEquals(Policy.Decision.DENY, Policy.decide(listOf(deny(levelOver3)), "read", env(high)), "a broken deny denies")
        val selfOver3 = allow(E.bin(">", E.path("this", "level"), E.lit(3)))
        assertEquals(Policy.Decision.DENY, Policy.decide(listOf(selfOver3), "read", env(self = obj("""{"level":[4]}"""))))
        assertEquals(Policy.Decision.ALLOW, Policy.decide(listOf(allow(levelOver3)), "read", env(obj("""{"level":5}"""))), "guard")
        assertEquals(Policy.Decision.ALLOW, Policy.decide(listOf(deny(levelOver3)), "read", env(obj("""{"level":2}"""))), "guard")
        assertEquals(Policy.Decision.UNAUTHENTICATED, Policy.decide(listOf(allow(levelOver3)), "read", env()), "guard: a null comparison is false, not an error")
    }

    @Test
    fun `decisions map to protocol errors`() {
        val unauth = Policy.error(Policy.Decision.UNAUTHENTICATED, "order()")
        assertEquals(Code.UNAUTHENTICATED, unauth.code)
        assertEquals("Sign in to access order()", unauth.message)
        val denied = Policy.error(Policy.Decision.DENY, "order()")
        assertEquals(Code.PERMISSION_DENIED, denied.code)
        assertEquals("Not allowed to access order()", denied.message)
    }

    // ------------------------------------------------------------------ pipeline

    @Test
    fun `op read policy on a query gates the resolver`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        val req = batch("""{"id":1,"op":"order","args":{"id":"o0"}}""")
        val anon = fx.server.collect(req).single()
        assertEquals("unauthenticated", anon.errorCode())
        assertEquals("Sign in to access order()", anon.errorMessage())
        assertNull(fx.store.calls["Query.order"], "a denied op never reaches its resolver")
        val owner = fx.server.collect(req, customer).single()
        assertEquals(obj("""{"${'$'}type":"Order","id":"o0","customerId":"u1","bookId":"b1","qty":1}"""), owner["data"])
        assertEquals(1, fx.store.calls["Query.order"])
    }

    @Test
    fun `op read policy on a stream gates the stream`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer { it.withOpAnnotations("ticks", allow(isAdmin)) }
        val req = batch("""{"id":1,"op":"ticks","args":{"n":2}}""")
        val denied = fx.server.collect(req, customer).single()
        assertEquals("permission_denied", denied.errorCode())
        assertEquals("Not allowed to access ticks()", denied.errorMessage())
        assertNull(fx.store.calls["Stream.ticks"])
        assertEquals(
            listOf(obj("""{"id":1,"item":{"n":1}}"""), obj("""{"id":1,"item":{"n":2}}"""), obj("""{"id":1,"fin":true}""")),
            fx.server.collect(req, admin),
        )
    }

    @Test
    fun `commands are checked in write mode, so a read policy does not gate them`() = runTest(timeout = 5.seconds) {
        val restock = batch("""{"id":1,"op":"restock","args":{"bookId":"b1","qty":1},"key":"kkkkkkkkkkkkkkkk"}""")
        val readOnly = fixtureServer { it.withOpAnnotations("restock", allow(E.lit(false), "read")) }
        assertNull(readOnly.server.collect(restock, customer).single().errorCode(), "a read policy must not gate a command")
        assertEquals(1, readOnly.store.calls["Command.restock"])

        val writeDenied = fixtureServer { it.withOpAnnotations("restock", allow(E.lit(false), "write")) }
        val denied = writeDenied.server.collect(restock, customer).single()
        assertEquals("permission_denied", denied.errorCode())
        assertEquals("Not allowed to access restock()", denied.errorMessage())
        assertNull(writeDenied.store.calls["Command.restock"])
    }

    @Test
    fun `an op policy sees the coerced args, defaults included`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer { it.withOpAnnotations("books", allow(E.bin("<=", E.path("args", "page", "first"), E.lit(50)))) }
        val byDefault = fx.server.collect(batch("""{"id":1,"op":"books","shape":"{ total }"}""")).single()
        assertEquals(obj("""{"total":2}"""), byDefault["data"], "the default page of 20 passes")
        val big = fx.server.collect(batch("""{"id":1,"op":"books","args":{"page":{"first":100}},"shape":"{ total }"}""")).single()
        assertEquals("permission_denied", big.errorCode())
        assertEquals("Not allowed to access books()", big.errorMessage())
        assertEquals(1, fx.store.calls["Query.books"])
    }

    @Test
    fun `entity deny nulls a nullable position, explicit shape or not, and fails a list element with its path`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer { it.withTypeAnnotations("Book", deny(outOfStock)) }
        fun book(id: String, shape: String) = batch("""{"id":1,"op":"book","args":{"id":"$id"},"shape":"$shape"}""")
        assertEquals(
            obj("""{"id":1,"data":null,"meta":{"cost":1},"fin":true}"""),
            fx.server.collect(book("b2", "{ id }")).single(),
            "book() returns Book?, so a denied book reads like a missing one even with an explicit shape",
        )
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1"}"""), fx.server.collect(book("b1", "{ id }")).single()["data"], "guard: in stock passes")
        assertEquals(JsonNull, fx.server.collect(batch("""{"id":1,"op":"book","args":{"id":"b2"}}""")).single()["data"], "default views never fail")
        assertEquals(
            obj("""{"code":"permission_denied","message":"Not allowed to access Book at items.1","path":"items.1"}"""),
            fx.server.collect(batch("""{"id":1,"op":"books","shape":"{ items { id } }"}""")).single()["error"],
        )
    }

    @Test
    fun `a field policy sees the field's own args, and partial turns a denial into null plus an error`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer { it.withFieldAnnotations("Book", "reviews", allow(E.bin("<=", E.path("args", "page", "first"), E.lit(5)))) }
        fun req(shape: String) = batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"$shape"}""")
        assertEquals(
            obj("""{"${'$'}type":"Book","id":"b1","reviews":{"total":2}}"""),
            fx.server.collect(req("{ id reviews(page: {first: 5}) { total } }")).single()["data"],
        )
        assertEquals(1, fx.store.calls["Book.reviews"])
        val denial = obj("""{"code":"permission_denied","message":"Not allowed to access Book.reviews","path":"reviews"}""")
        assertEquals(denial, fx.server.collect(req("{ id reviews(page: {first: 6}) { total } }")).single()["error"])
        assertEquals(denial, fx.server.collect(req("{ id reviews { total } }")).single()["error"], "the field default of 10 is what the policy sees")
        val partial = fx.server.collect(req("{ id reviews(page: {first: 6}) { total } @partial }")).single()
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1","reviews":null}"""), partial["data"])
        assertEquals(JsonArray(listOf(denial)), partial["errors"])
        assertEquals(1, fx.store.calls["Book.reviews"], "denied fields never reach the loader")
    }

    @Test
    fun `a field policy sees the parent row as this and can read the clock`() = runTest(timeout = 5.seconds) {
        // RayfoldServer takes no clock (the TS server takes `now`), so these bounds hold for any clock value
        val fx = fixtureServer {
            it.withFieldAnnotations("Book", "stock", allow(E.bin(">", E.path("this", "stock"), E.lit(0))))
                .withFieldAnnotations("Book", "title", allow(E.bin(">", E.call("now"), E.lit(0))))
                .withFieldAnnotations("Book", "version", allow(E.bin("<", E.call("now"), E.lit(0))))
        }
        fun req(id: String, shape: String) = batch("""{"id":1,"op":"book","args":{"id":"$id"},"shape":"$shape"}""")
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1","stock":2,"title":"T1"}"""), fx.server.collect(req("b1", "{ id stock title }")).single()["data"])
        assertEquals(
            obj("""{"code":"permission_denied","message":"Not allowed to access Book.stock","path":"stock"}"""),
            fx.server.collect(req("b2", "{ id stock }")).single()["error"],
        )
        assertEquals(
            obj("""{"code":"permission_denied","message":"Not allowed to access Book.version","path":"version"}"""),
            fx.server.collect(req("b1", "{ id version }")).single()["error"],
        )
    }
}
