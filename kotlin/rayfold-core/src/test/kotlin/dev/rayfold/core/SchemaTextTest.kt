package dev.rayfold.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * The Kotlin schema reader against `@rayfold/schema`. oracle/schema-cases.json (written by scripts/kotlin-oracle.ts)
 * holds every schema in the repository plus cases aimed at each lexer, parser and validator branch, with what the
 * TypeScript reader made of them: IR JSON, diagnostics, hash, or the error message. The Kotlin reader must match all.
 */
class SchemaTextTest {
    private val cases: List<JsonObject> by lazy {
        val text = javaClass.getResource("/oracle/schema-cases.json")?.readText() ?: error("oracle/schema-cases.json is missing; run npx tsx scripts/kotlin-oracle.ts")
        Json.parseToJsonElement(text).jsonArray.map { it.jsonObject }
    }

    private fun JsonObject.str(key: String): String = this[key]?.jsonPrimitive?.content ?: error("oracle case has no $key")

    private fun json(diagnostics: List<Diagnostic>) = JsonArray(diagnostics.map {
        buildJsonObject { put("severity", it.severity); put("code", it.code); put("message", it.message); put("at", it.at) }
    })

    @TestFactory
    fun `every oracle case reads as @rayfold-schema reads it`(): List<DynamicTest> = cases.map { c ->
        DynamicTest.dynamicTest(c.str("name")) {
            val text = c.str("text")
            val error = c["error"]?.jsonPrimitive?.content
            if (error != null) {
                assertEquals(error, assertFailsWith<RayfoldSyntaxException> { SchemaText.parse(text) }.message)
                assertEquals(error, assertFailsWith<RayfoldSyntaxException> { SchemaText.load(text) }.message)
                return@dynamicTest
            }
            val ir = SchemaText.parse(text)
            assertEquals(c["ir"], IrJson.of(ir), "IR")
            assertEquals(c["diagnostics"], json(SchemaText.validate(ir)), "diagnostics")
            assertEquals(c.str("hash"), SchemaText.hash(ir), "hash")
            val loadError = c["loadError"]?.jsonPrimitive?.content
            if (loadError != null) {
                assertEquals(loadError, assertFailsWith<RayfoldSchemaException> { SchemaText.load(text) }.message)
            } else {
                val loaded = SchemaText.load(text)
                assertEquals(c.str("hash"), loaded.hash)
                assertEquals(c["diagnostics"], json(loaded.warnings))
            }
        }
    }

    @Test
    fun `the oracle reaches every diagnostic code and a wide range of syntax errors`() {
        val codes = cases.flatMap { c -> (c["diagnostics"] as? JsonArray).orEmpty().map { it.jsonObject.str("code") } }.toSet()
        val every = setOf(
            "unknown-type", "generic-arity", "not-generic", "bad-type-position", "unknown-annotation", "annotation-position", "bad-policy-arg",
            "policy-this-on-op", "bad-cache-scope", "bad-cache-maxage", "bad-load", "reserved-name", "args-not-allowed", "bad-version-field",
            "page-on-non-page", "partial-non-null", "entity-id", "bad-interface", "missing-interface-field", "bad-union-member", "bad-throws",
            "bad-emits", "emits-on-non-command", "bad-http-method", "bad-http-path", "bad-http-param", "bad-http-body", "page-args",
            "view-on-non-object", "unknown-field", "shape-on-scalar", "unknown-view", "view-cycle", "spread-type-mismatch", "bad-type-condition",
            "shadowed-name", "unreachable", "duplicate-name",
        )
        assertEquals(emptySet(), every - codes, "codes no oracle case produces")
        assertTrue(cases.count { it["error"] != null } >= 30, "syntax-error cases: ${cases.count { it["error"] != null }}")
        assertTrue(cases.count { it["ir"] != null } >= 25, "readable cases: ${cases.count { it["ir"] != null }}")
    }

    /** IR no text parser produces (importers, the builder, lock files): oracle/schema-ir-cases.json, from scripts/kotlin-oracle.ts. */
    @TestFactory
    fun `IR from elsewhere is validated as @rayfold-schema validates it`(): List<DynamicTest> {
        val text = javaClass.getResource("/oracle/schema-ir-cases.json")?.readText() ?: error("oracle/schema-ir-cases.json is missing; run npx tsx scripts/kotlin-oracle.ts")
        val irCases = Json.parseToJsonElement(text).jsonArray.map { it.jsonObject }
        val codes = irCases.flatMap { c -> (c["diagnostics"] as? JsonArray).orEmpty().map { it.jsonObject.str("code") } }.toSet()
        assertEquals(emptySet(), setOf("bad-name", "duplicate-name", "bad-input", "unknown-type") - codes, "codes no IR case produces")
        return irCases.map { c ->
            DynamicTest.dynamicTest(c.str("name")) {
                val ir = RayfoldSchemaIR.json.decodeFromJsonElement(RayfoldSchemaIR.serializer(), c["ir"] ?: error("no ir"))
                assertEquals(c["diagnostics"], json(SchemaText.validate(ir)))
            }
        }
    }

    @Test
    fun `guard - a one-character change reads differently, so matching the oracle cannot pass by accident`() {
        val a = SchemaText.load("entity A { id: ID n: Int } query a: A")
        val b = SchemaText.load("entity A { id: ID n: Int? } query a: A")
        assertNotEquals(IrJson.of(a.ir), IrJson.of(b.ir))
        assertNotEquals(a.hash, b.hash)
    }

    @Test
    fun `IR decoded from the TypeScript JSON validates like the text and hashes the same`() {
        // fixtures and lock files carry the IR as JSON, which is how the runtime got its schema before it could read text
        var hashed = 0
        for (c in cases) {
            val irJson = c["ir"] ?: continue
            val decoded = RayfoldSchemaIR.json.decodeFromJsonElement(RayfoldSchemaIR.serializer(), irJson)
            assertEquals(c["diagnostics"], json(SchemaText.validate(decoded)), c.str("name"))
            assertEquals(c.str("hash"), SchemaText.hash(decoded), c.str("name"))
            hashed++
        }
        assertTrue(hashed >= 20, "hash compared for $hashed decoded schemas")
        assertTrue(cases.any { (it["ir"]?.toString() ?: "").contains("\"default\":null") }, "guard: some cases carry an explicit null default")
    }

    @Test
    fun `an explicit null default survives the IR JSON and keeps the TypeScript hash (guard - no default hashes differently)`() {
        val explicit = SchemaText.load("query q(a: Int? = null): Int")
        val absent = SchemaText.load("query q(a: Int?): Int")
        val decoded = RayfoldSchemaIR.parse(RayfoldSchemaIR.json.encodeToString(RayfoldSchemaIR.serializer(), explicit.ir))
        assertEquals(kotlinx.serialization.json.JsonNull, decoded.ops["q"]?.args?.single()?.default)
        assertEquals(explicit.hash, SchemaText.hash(decoded))
        assertEquals(null, RayfoldSchemaIR.parse(RayfoldSchemaIR.json.encodeToString(RayfoldSchemaIR.serializer(), absent.ir)).ops["q"]?.args?.single()?.default)
        assertNotEquals(explicit.hash, absent.hash)
    }

    @Test
    fun `the server's schema hash is the one TypeScript computes for the same schema`() {
        val bookstore = cases.first { it.str("name") == "bookstore" }
        val fromText = RayfoldServer(SchemaText.load(bookstore.str("text")).ir, Resolvers())
        assertEquals(bookstore.str("hash"), fromText.hash)
        val fromJson = RayfoldServer(RayfoldSchemaIR.json.decodeFromJsonElement(RayfoldSchemaIR.serializer(), bookstore["ir"] ?: error("no ir")), Resolvers())
        assertEquals(bookstore.str("hash"), fromJson.hash)
    }

    @Test
    fun `the repository's bookstore schema file reads without a Node step`() {
        val file = File("../../examples/bookstore-ts/bookstore.rayfold")
        val loaded = SchemaText.load(file.readText())
        assertEquals(cases.first { it.str("name") == "bookstore" }.str("hash"), loaded.hash)
        assertTrue("placeOrder" in loaded.ir.ops)
    }

    @Test
    fun `numbers are written the way JavaScript writes them`() {
        val cases = mapOf(
            0.0 to "0", -0.0 to "0", 100.0 to "100", 123.456 to "123.456", -1.5 to "-1.5", 1e21 to "1e+21", 1e20 to "100000000000000000000",
            0.000001 to "0.000001", 1e-7 to "1e-7", 12345678901234567890.0 to "12345678901234567000", 0.1 + 0.2 to "0.30000000000000004",
            5e-324 to "5e-324", 1.7976931348623157e308 to "1.7976931348623157e+308", 2.5e-7 to "2.5e-7",
        )
        for ((d, js) in cases) assertEquals(js, jsNumber(d), "jsNumber($d)")
    }
}
