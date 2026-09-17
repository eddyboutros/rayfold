package dev.rayfold.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The two hashes a shared idempotency store makes cross-runtime (spec 12 section 4): the scope a record is kept under
 * and the binding it carries. Every value here is pinned to the string ECMAScript writes and to a hash the TypeScript
 * runtime produces for the same input, so that neither runtime can drift from the other without a test saying so.
 * `packages/server/src/binding-hash.test.ts` asserts the same vectors from the other side.
 */
class CanonicalHashTest {
    private fun obj(text: String) = Json.parseToJsonElement(text) as JsonObject

    @Test
    fun `a number is written as ECMAScript writes it, whatever the sender wrote`() {
        // left: what a client may send; right: the one form both runtimes hash
        val forms = listOf(
            "2.5" to "2.5",
            "2.50" to "2.5", // the same number, two literals: the reason this exists
            "1.0" to "1",
            "5" to "5",
            "0" to "0",
            "-0" to "0",
            "-3.75" to "-3.75",
            "0.1" to "0.1",
            "0.0001" to "0.0001", // java would write 1.0E-4 here, ECMAScript does not
            "1e-6" to "0.000001",
            "1e-7" to "1e-7",
            "1.5e-9" to "1.5e-9",
            "1e20" to "100000000000000000000",
            "1e21" to "1e+21",
            "123456789012345678901234567890" to "1.2345678901234568e+29",
        )
        for ((sent, written) in forms) assertEquals(written, Canonical.number(sent), "the number $sent")
    }

    @Test
    fun `two spellings of one argument hash alike, and the hash is the one the other runtime produces`() {
        val plain = Canonical.hashed(obj("""{"args":{"id":"b1","qty":2.5},"op":"restock"}"""))
        val spelled = Canonical.hashed(obj("""{"args":{"qty":2.50,"id":"b1"},"op":"restock"}"""))
        assertEquals("""{"args":{"id":"b1","qty":2.5},"op":"restock"}""", plain, "keys sorted, numbers normalised")
        assertEquals(plain, spelled, "the same arguments written differently are one binding")
        // the value the TypeScript runtime produces for the same binding; packages/server/src/binding-hash.test.ts
        // asserts it from that side, so a change to either canonicaliser breaks a test rather than a fleet
        assertEquals("c3a798f6ee29dd08612660fc7b227a6cdc93efc9df9fb30638e91718931c01d2", sha256(plain))
        assertEquals("c3a798f6ee29dd08612660fc7b227a6cdc93efc9df9fb30638e91718931c01d2", sha256(spelled))
    }

    private fun sha256(s: String): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    @Test
    fun `the wire form is left alone, so schema hashes and ETags do not move`() {
        // Canonical.json writes bytes that are already settled: it keeps a number as the sender wrote it
        assertEquals("""{"qty":2.50}""", Canonical.json(obj("""{"qty":2.50}""")))
        assertEquals("""{"qty":2.5}""", Canonical.hashed(obj("""{"qty":2.50}""")))
    }

    @Test
    fun `strings, booleans, nulls, arrays and nesting are unchanged by the number rule`() {
        val value = obj("""{"a":[1.0,"1.0",true,null,{"b":2.50}],"z":"x"}""")
        assertEquals("""{"a":[1,"1.0",true,null,{"b":2.5}],"z":"x"}""", Canonical.hashed(value))
    }

    @Test
    fun `a viewer is scoped by the same rule, so one viewer is one scope however its numbers were written`() {
        val a = Canonical.hashed(buildJsonObject { put("id", JsonPrimitive("u1")); put("tier", JsonPrimitive(2.0)) })
        val b = Canonical.hashed(obj("""{"tier":2,"id":"u1"}"""))
        assertEquals(a, b)
        assertEquals("e779509076f090fa2c72f7c489668c5723811a96cdfeacc9ea1e8c3f949e3d5e", sha256(a), "the scope the TypeScript runtime keeps records under")
    }
}
