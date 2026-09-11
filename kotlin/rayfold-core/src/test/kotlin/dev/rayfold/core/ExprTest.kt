package dev.rayfold.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Test
import kotlinx.serialization.json.Json
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Policy expressions. `Expr.eval`'s only production caller is `Policy.decide` (grep `Expr\.eval`), so the pipeline
 * tests that drive expressions through RayfoldServer live in [PolicyTest]. Every env here injects a clock that fails
 * when read, unless the test is about `now()`.
 */
class ExprTest {
    private val noClock: () -> Long = { error("this expression must not read the clock") }
    private val viewer = obj("""{"id":"u1","role":"admin","org":{"id":"x"}}""")
    private val env = ExprEnv(viewer, obj("""{"id":"b1","n":7}"""), obj("""{"ownerId":"u1","tags":["a","b"],"stock":2,"name":"abc"}"""), noClock)
    private val yes = JsonPrimitive(true)
    private val no = JsonPrimitive(false)
    private fun eval(e: JsonObject, en: ExprEnv = env): JsonElement = Expr.eval(e, en)

    @Test
    fun `paths read viewer, args and this, and anything missing is null`() {
        assertEquals(JsonPrimitive("admin"), eval(E.path("viewer", "role")))
        assertEquals(JsonPrimitive("b1"), eval(E.path("args", "id")))
        assertEquals(JsonPrimitive("u1"), eval(E.path("this", "ownerId")))
        assertEquals(JsonPrimitive("x"), eval(E.path("viewer", "org", "id")))
        assertEquals(viewer, eval(E.path("viewer")))
        assertEquals(JsonNull, eval(E.path("viewer", "missing")))
        assertEquals(JsonNull, eval(E.path("viewer", "role", "deeper")), "a path through a scalar is null, not an error")
        assertEquals(JsonNull, eval(E.path("args", "id"), ExprEnv(JsonNull, JsonNull, JsonNull, noClock)))
        assertEquals(JsonNull, eval(obj("""{"k":"lit"}""")), "a literal without v is null")
        assertEquals(JsonNull, eval(obj("""{"k":"mystery"}""")))
    }

    @Test
    fun `equality is loose across scalar types and null equals only null`() {
        assertEquals(yes, eval(E.bin("==", E.lit(1), E.lit("1"))), "ids given as numbers equal their string form")
        assertEquals(yes, eval(E.bin("==", E.path("this", "ownerId"), E.path("viewer", "id"))))
        assertEquals(no, eval(E.bin("!=", E.path("this", "ownerId"), E.path("viewer", "id"))))
        assertEquals(yes, eval(E.bin("==", E.nul, E.path("viewer", "missing"))))
        assertEquals(no, eval(E.bin("==", E.nul, E.lit("x"))))
        assertEquals(no, eval(E.bin("==", E.lit("x"), E.nul)))
        assertEquals(yes, eval(E.bin("!=", E.lit("x"), E.nul)))
        assertEquals(no, eval(E.bin("==", E.path("viewer", "org"), E.path("viewer", "org"))), "objects never compare equal")
    }

    @Test
    fun `ordering compares numbers and numeric strings by value, other strings lexically, and never with null`() {
        assertEquals(yes, eval(E.bin("<", E.lit(2), E.lit(10))), "numerically, not as text")
        assertEquals(yes, eval(E.bin(">", E.lit("b"), E.lit("a"))))
        assertEquals(yes, eval(E.bin("<=", E.lit(1), E.lit(1))))
        assertEquals(yes, eval(E.bin(">=", E.lit(1), E.lit(1))))
        assertEquals(no, eval(E.bin("<", E.lit(1), E.lit(1))))
        assertEquals(no, eval(E.bin("<", E.lit("10"), E.lit(9))), "a numeric string orders by value against a number")
        assertEquals(yes, eval(E.bin(">=", E.lit("10"), E.lit(9))))
        assertEquals(no, eval(E.bin("<", E.lit("10"), E.lit("9"))), "two numeric strings order by value: Decimal and Long travel as text")
        assertEquals(no, eval(E.bin("<", E.nul, E.lit(1))))
        assertEquals(no, eval(E.bin(">", E.lit(1), E.nul)))
        assertEquals(no, eval(E.bin("<", E.path("viewer", "missing"), E.lit(1))), "a missing path is null: false, not an error")
    }

    @Test
    fun `numbers compare exactly, past 2^53 and across the number and numeric-string forms`() {
        val over = E.lit(JsonPrimitive(9007199254740993L))
        val at = E.lit(JsonPrimitive(9007199254740992L))
        assertEquals(yes, eval(E.bin(">", over, at)), "as doubles both are 2^53")
        assertEquals(yes, eval(E.bin(">", E.lit("9007199254740993"), at)))
        assertEquals(yes, eval(E.bin(">", E.lit("1000.01"), E.lit(1000))))
        assertEquals(no, eval(E.bin(">", E.lit("999.99"), E.lit(1000))))
        assertEquals(yes, eval(E.bin("==", E.lit(Json.parseToJsonElement("1.0")), E.lit(1))))
        assertEquals(yes, eval(E.bin("==", E.lit("1.0"), E.lit(1))))
        assertEquals(no, eval(E.bin("==", E.lit("1.0"), E.lit("1"))), "two strings compare as text")
        assertEquals(yes, eval(E.bin("in", E.lit("5000"), E.list(E.lit(5000)))), "in and has use the same equality")
    }

    @Test
    fun `ordering values that do not order is an evaluation error, not false`() {
        val pairs = listOf(E.lit("high") to E.lit(3), E.lit(true) to E.lit(false), E.lit(1) to E.lit(true), E.list(E.lit(1)) to E.lit(2), E.path("viewer", "org") to E.lit(1))
        for ((l, r) in pairs) assertFailsWith<ExprError>("$l > $r") { eval(E.bin(">", l, r)) }
        assertEquals(yes, eval(E.bin("<", E.lit("abc"), E.lit("abd"))), "guard: strings order")
        assertEquals(no, eval(E.bin("==", E.lit("high"), E.lit(3))), "guard: equality never errors")
    }

    @Test
    fun `and-or short-circuit (the right side is not evaluated) and always yield booleans`() {
        var reads = 0
        val counting = ExprEnv(viewer, JsonNull, JsonNull) { reads++; 1000L }
        val readsClock = E.bin(">", E.call("now"), E.lit(0))
        assertEquals(no, eval(E.bin("&&", E.lit(false), readsClock), counting))
        assertEquals(yes, eval(E.bin("||", E.lit(true), readsClock), counting))
        assertEquals(0, reads, "the right side must not run once the left decides")
        assertEquals(yes, eval(E.bin("&&", E.lit(true), readsClock), counting))
        assertEquals(yes, eval(E.bin("||", E.lit(false), readsClock), counting))
        assertEquals(2, reads, "guard: an undecided left side does evaluate the right")
        assertEquals(yes, eval(E.bin("&&", E.lit("a"), E.lit(5))), "truthy operands still give a boolean")
    }

    @Test
    fun `only null and false are falsy`() {
        assertEquals(yes, eval(E.not(E.nul)))
        assertEquals(yes, eval(E.not(E.lit(false))))
        assertEquals(yes, eval(E.not(E.path("viewer", "missing"))))
        assertEquals(no, eval(E.not(E.lit(0))), "0 is truthy")
        assertEquals(no, eval(E.not(E.lit(""))), "empty string is truthy")
        assertEquals(no, eval(E.not(E.lit("false"))), "the string \"false\" is truthy")
        assertEquals(no, eval(E.not(E.path("viewer", "org"))))
    }

    @Test
    fun `in, has, len and list literals`() {
        assertEquals(yes, eval(E.bin("in", E.lit("b"), E.path("this", "tags"))))
        assertEquals(no, eval(E.bin("in", E.lit("c"), E.path("this", "tags"))))
        assertEquals(no, eval(E.bin("in", E.lit("a"), E.lit("abc"))), "in needs a list on the right")
        assertEquals(yes, eval(E.bin("in", E.path("viewer", "role"), E.list(E.lit("admin"), E.lit("owner")))))
        assertEquals(yes, eval(E.call("has", E.path("this", "tags"), E.lit("a"))))
        assertEquals(no, eval(E.call("has", E.path("this", "missing"), E.lit("a"))))
        assertEquals(JsonPrimitive(2), eval(E.call("len", E.path("this", "tags"))))
        assertEquals(JsonPrimitive(3), eval(E.call("len", E.path("this", "name"))))
        assertEquals(JsonNull, eval(E.call("len", E.path("this", "stock"))), "len of a number is null")
        assertEquals(JsonNull, eval(E.call("nope")), "unknown functions are null")
        assertEquals(JsonArray(listOf(JsonPrimitive(1), JsonPrimitive("admin"))), eval(E.list(E.lit(1), E.path("viewer", "role"))))
    }

    @Test
    fun `now() reads the injected clock once, and a strict comparison flips exactly at the boundary`() {
        val t = 1_700_000_000_000L
        var reads = 0
        fun at(expiresAt: Long) = ExprEnv(JsonNull, JsonNull, obj("""{"expiresAt":$expiresAt}""")) { reads++; t }
        val live = E.bin(">", E.path("this", "expiresAt"), E.call("now"))
        assertEquals(yes, Expr.eval(live, at(t + 1)), "1 ms before expiry")
        assertEquals(no, Expr.eval(live, at(t)), "at the instant of expiry")
        assertEquals(no, Expr.eval(live, at(t - 1)), "1 ms after expiry")
        assertEquals(3, reads, "one clock read per evaluation")
        val started = E.bin(">=", E.call("now"), E.path("this", "expiresAt"))
        assertEquals(yes, Expr.eval(started, at(t)), "an inclusive comparison holds at the boundary")
        assertEquals(no, Expr.eval(started, at(t + 1)))
        assertEquals(JsonPrimitive(t), Expr.eval(E.call("now"), at(0)))
    }

    @Test
    fun `referencesViewer finds viewer paths nested anywhere and nothing else`() {
        assertTrue(Expr.referencesViewer(E.bin("&&", E.lit(true), E.not(E.call("has", E.list(E.path("viewer", "roles")), E.lit("x"))))))
        assertFalse(Expr.referencesViewer(E.bin("==", E.path("this", "ownerId"), E.path("args", "id"))), "guard: this and args are not the viewer")
        assertFalse(Expr.referencesViewer(E.call("now")))
    }
}
