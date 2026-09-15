package dev.rayfold.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * Shape parsing, canonical form and ids. The expected canonical texts and ids were produced by the TypeScript
 * runtime (packages/schema/src/shape.ts: parseShapeText, canonicalShape, shapeIdOf) over the same IR views, so
 * these tests pin cross-runtime parity. Production callers (grep `Shapes\.|views.register`): RayfoldServer.registerShape
 * and Views.resolveRequestShape (auto-registration of inline text, lookup by id); both have pipeline tests below.
 */
class ShapesTest {
    private val ir = Fixtures.ir(Fixtures.load("core/03-pipelining.json"))

    private class V(val text: String, val canonical: String, val id: String)

    private val idTitle = "sha256:8a8a5652e83f7c956b9e4fc03e448cf08471167eecee40ea410460c7e17efa07"

    private val vectors = listOf(
        V("{ id title }", "{ id title }", idTitle),
        V("{ title, id }", "{ id title }", idTitle),
        V("{ items { id title author { name } } total }", "{ items { author { name } id title } total }",
            "sha256:4c746ad7974d5ca944b0bfb7d6d59994d5ebee52d77ee2ec22565326dc927c78"),
        V("{ id ...Book.default }", "{ id id stock title }", "sha256:d03867bbcddb3dcaed00e8851d8d043805eee02a33df193766cc7856d9412fc5"),
        V("""{ b: book(id: "b1") { id } a: author(id: ${'$'}aid) { name } }""", """{ a: author(id: ${'$'}aid) { name } b: book(id: "b1") { id } }""",
            "sha256:9a78d0658de0bbf81a2305e928d7eeb4b18d92f901b243cfb4c0ef8cc5188f76"),
        V("""{ reviews(page: {first: 2, after: "r1"}) { items { id rating } } }""", """{ reviews(page: {"after":"r1","first":2}) { items { id rating } } }""",
            "sha256:cab4c03192b29fa35569bdf0ef16cffdbc3d0d97fe3ad5d01b360cdb017d1b7e"),
        V("{ reviews(page: {first: 1.0}) { total } }", """{ reviews(page: {"first":1}) { total } }""",
            "sha256:a1ceb433b6967c5131fd878e4eb3b73ba4d9db121a2640eaece89ca1d0ed6c18"),
        V("{ x(v: 1e3) }", "{ x(v: 1000) }", "sha256:c447e98674c89149bdb332ba0890ecfe7a55e8f594a8aef1f5e8d022d730903e"),
        V("{ x(f: 1.5e2) }", "{ x(f: 150) }", "sha256:55e60a5e1cc5cb06bccbce0ca6f544b5861e7b5220e2907f8fb6ca062688ecde"),
        V("{ x(v: -2.50) }", "{ x(v: -2.5) }", "sha256:b79df03969e6e8adec548abffeedafb878ae43e17cff8afd4c482ca195bb2bbb"),
        V("{ x(v: 0.1) }", "{ x(v: 0.1) }", "sha256:4f96da26a18fdf930996ede5e6f8dbf466f25babb7c28ff55807a8cf51a167db"),
        V("{ x(v: 2.5e-3) }", "{ x(v: 0.0025) }", "sha256:e4323d0bf0d3fe24449521ece20a66e39f78b9b23ba4fdc2552195b2bd834a55"),
        V("""{ x(s: "a\"b\\c\nd\te") }""", """{ x(s: "a\"b\\c\nd\te") }""", "sha256:7c8a5e0c79db363fd580e6697426f3ea7408b57781c59a54fbb7ecf518391017"),
        V("""{ x(s: "\b\f\r") }""", """{ x(s: "\b\f\r") }""", "sha256:5d6b03bae2eb0d5b1732bfe3b35c58132c884e3e735b57cc9f1bba309ef520a1"),
        V("""{ x(s: "\u0041") }""", """{ x(s: "A") }""", "sha256:81e11e48533ce07a49a966836b339661e72191287d4d3b02b5ed768af78fa0a7"),
        V("""{ x(l: [1 "two" true null {b: 2 a: 1}]) }""", """{ x(l: [1,"two",true,null,{"a":1,"b":2}]) }""",
            "sha256:59f4e88250ab19fc504bc86445e8fffc8eb330f9aa809e764f7b1ec2e5d39f1e"),
        V("""{ id @defer(label: "slow") { reviews { total } } ...on Book { title } }""", """{ id ...on Book { title } @defer(label: "slow") { reviews { total } } }""",
            "sha256:bd706d5a22c42d3aea6992b861070790518a809de08c78588686352c4ec20b1a"),
        V("{ author { bio } @eager title @partial }", "{ author { bio } @eager title @partial }",
            "sha256:40906d681c1306b372e4f1058a1290f3b6f389405402a0bc833306bb13c0b740"),
        V("{ x(e: ASC) }", """{ x(e: "ASC") }""", "sha256:ee82ed7d95477b8365887d024aef72470d1502323ad3da0c0887fb6d51c4d2e5"),
        V("{ items(page: {first: ${'$'}n}) }", """{ items(page: {"first":${'$'}n}) }""", "sha256:76a980de8cdc6219198f24c4a16e056b1e0e34dedcc6afba636de26b0c5a8ef2"),
        V("{ x(s: \"\u00e9\") }", "{ x(s: \"\u00e9\") }", "sha256:b12d2aac589c3086d593970678378ab5d27877d605be799b562ff1a525116242"),
        V("{ x(z: 2, a: 1) }", "{ x(a: 1 z: 2) }", "sha256:ae1dd8b9a5ed65b5fba446e88b03dccb435d6eaef17673fa3dc50a2c84d12c22"),
    )

    private fun id(text: String) = Shapes.idOf(Shapes.canonical(Shapes.parse(text), ir))

    private fun fails(text: String, schema: RayfoldSchemaIR = ir): String =
        assertFailsWith<RayfoldException>("expected $text to be rejected") { Shapes.canonical(Shapes.parse(text), schema) }
            .also { assertEquals(Code.INVALID_ARGUMENT, it.code) }.message

    @TestFactory
    fun `canonical text and id match the TypeScript runtime`(): List<DynamicTest> = vectors.map { v ->
        DynamicTest.dynamicTest(v.text) {
            val canonical = Shapes.canonical(Shapes.parse(v.text), ir)
            assertEquals(v.canonical, canonical)
            assertEquals(v.id, Shapes.idOf(canonical))
        }
    }

    @Test
    fun `equivalent texts share an id, and a different arg or alias does not`() {
        assertEquals(id("{ id title }"), id("{\n  title,\n  id\n}"))
        assertEquals(id("""{ reviews(page: {first: 2, after: "r1"}) { total } }"""), id("""{ reviews(page: {after: "r1" first: 2}) { total } }"""))
        assertNotEquals(id("{ reviews(page: {first: 2}) { total } }"), id("{ reviews(page: {first: 3}) { total } }"))
        assertNotEquals(id("{ a: id }"), id("{ id }"), "an alias changes the output shape")
    }

    @Test
    fun `literals decode to the JSON values the TS parser yields`() {
        val args = Shapes.parse("""{ x(i: 12 f: 1.0 e: 1e3 d: 0.25 s: "\u0041\b\/" b: true n: null w: ASC) }""").items.single().args ?: error("no args parsed")
        assertEquals(JsonPrimitive(12), args["i"])
        assertEquals(JsonPrimitive(1), args["f"], "1.0 is the integer 1")
        assertEquals(JsonPrimitive(1000), args["e"])
        assertEquals(JsonPrimitive(0.25), args["d"])
        assertEquals(JsonPrimitive("A\b/"), args["s"])
        assertEquals(JsonPrimitive(true), args["b"])
        assertEquals(JsonNull, args["n"])
        assertEquals(JsonPrimitive("ASC"), args["w"], "enum identifiers become strings")
    }

    @Test
    fun `an unknown escape is rejected instead of being read as a different string`() {
        assertEquals("Bad shape: bad escape \\q", fails("""{ x(s: "\q") }"""))
        assertEquals("Bad shape: bad unicode escape", fails("""{ x(s: "\u00G1") }"""))
        assertEquals("Bad shape: bad unicode escape", fails("""{ x(s: "\u12") }"""))
    }

    @Test
    fun `malformed shapes are invalid_argument with a reason`() {
        assertEquals("Bad shape: unterminated shape", fails("{ id"))
        assertEquals("Bad shape: trailing input", fails("{ id } x"))
        assertEquals("Bad shape: unknown directive @foo", fails("{ @foo { id } }"))
        assertEquals("Bad shape: unterminated string", fails("""{ x(s: "abc) }"""))
        assertEquals("Bad shape: unknown modifier", fails("{ id @weird }"))
        assertEquals("Bad shape: unexpected '#'", fails("{ # }"))
    }

    @Test
    fun `shape text nests at most 64 levels, counting sub-shapes and argument values alike`() {
        fun nested(levels: Int) = "{" + "a{".repeat(levels - 1) + "}".repeat(levels)
        fun depth(s: Shape?): Int = generateSequence(s) { it.items.firstOrNull()?.shape }.count()
        assertEquals(64, depth(Shapes.parse(nested(64))), "guard: 64 levels parse")
        assertEquals("Bad shape: nested deeper than 64 levels", fails(nested(65)))
        assertEquals("Bad shape: nested deeper than 64 levels", fails(nested(100_000)), "refused before recursing, so no StackOverflowError")
        val lists = (1 until 63).fold(JsonArray(emptyList())) { inner, _ -> JsonArray(listOf(inner)) }
        assertEquals(
            Shape(listOf(ShapeItem(kind = "field", name = "x", args = mapOf("v" to lists)))),
            Shapes.parse("{ x(v: ${"[".repeat(63)}${"]".repeat(63)}) }"),
            "guard: one shape level and 63 list levels parse, every level kept",
        )
        assertEquals("Bad shape: nested deeper than 64 levels", fails("{ x(v: ${"[".repeat(64)}${"]".repeat(64)}) }"))
    }

    @Test
    fun `view spreads must name a known view and must not cycle`() {
        assertEquals("Unknown view Book.nope", fails("{ ...Book.nope }"))
        val looped = ir.copy(views = ir.views + ("Book.loop" to ViewDef("Book", "loop", Shapes.parse("{ id ...Book.loop }"))))
        assertEquals("View spread cycle at Book.loop", fails("{ ...Book.loop }", looped))
    }

    @Test
    fun `a shape id is sha256 plus 64 lowercase hex digits`() {
        assertTrue(Shapes.isShapeId("sha256:" + "0123456789abcdef".repeat(4)))
        assertFalse(Shapes.isShapeId("sha256:" + "0123456789ABCDEF".repeat(4)))
        assertFalse(Shapes.isShapeId("sha256:" + "0".repeat(63)))
        assertFalse(Shapes.isShapeId("sha256:" + "0".repeat(65)))
        assertFalse(Shapes.isShapeId("0".repeat(64)))
        assertFalse(Shapes.isShapeId("{ id }"))
    }

    @Test
    fun `canonical JSON quotes strings like JSON_stringify`() {
        assertEquals("\"\\b\\f\\n\\r\\t\\u0001\\\"\\\\\"", Canonical.json(JsonPrimitive("\b\u000c\n\r\t\u0001\"\\")))
        assertEquals("""{"a":[1,"x",null],"b":true}""", Canonical.json(obj("""{"b":true,"a":[1,"x",null]}""")))
    }

    // ------------------------------------------------------------------ pipeline

    @Test
    fun `registerShape yields the TS id and a trusted server executes by that id only`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer(options = BatchOptions(trustedShapes = true))
        assertEquals(idTitle, fx.server.registerShape("{ title, id }"))
        fun book(shape: String) = batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"$shape"}""")
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1","title":"T1"}"""), fx.server.collect(book(idTitle)).single()["data"])
        val raw = fx.server.collect(book("{ id title }")).single()
        assertEquals("permission_denied", raw.errorCode())
        assertEquals("Only registered shapes are accepted", raw.errorMessage())
        val unknown = "sha256:" + "0".repeat(64)
        val miss = fx.server.collect(book(unknown)).single()
        assertEquals("not_found", miss.errorCode())
        assertEquals("Unknown shape $unknown", miss.errorMessage())
        assertEquals(1, fx.store.calls["Query.book"], "only the registered shape reached the resolver")
    }

    @Test
    fun `an untrusted server registers inline text under its canonical id`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        val byId = batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"$idTitle"}""")
        assertEquals("not_found", fx.server.collect(byId).single().errorCode(), "nothing registered yet")
        fx.server.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title id }"}"""))
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1","title":"T1"}"""), fx.server.collect(byId).single()["data"])
    }

    @Test
    fun `shape literals reach the loader as the values the TS client meant`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        val oneDotZero = fx.server.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id reviews(page: {first: 1.0}) { total items { id } } }"}""")).single()
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1","reviews":{"total":2,"items":[{"${'$'}type":"Review","id":"r1"}]}}"""), oneDotZero["data"], "$oneDotZero")
        val escaped = fx.server.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id reviews(page: {after: \"r\\u0031\"}) { items { id } } }"}""")).single()
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1","reviews":{"items":[{"${'$'}type":"Review","id":"r2"}]}}"""), escaped["data"], "$escaped")
    }
}
