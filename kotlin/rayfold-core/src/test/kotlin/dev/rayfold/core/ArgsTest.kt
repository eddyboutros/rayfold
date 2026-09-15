package dev.rayfold.core

import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.time.Duration.Companion.seconds

/**
 * Argument coercion at the system boundary. Production callers (grep `Args\.`): Batch.kt coerces op args,
 * resolves `$ref`s and collects ref ids twice (dependency waits and validation); Executor.kt coerces field args
 * inside a shape. Each of those call shapes has a pipeline test at the bottom of this class.
 */
class ArgsTest {
    private val ir = Fixtures.ir(Fixtures.load("core/03-pipelining.json"))
    private val u1 = obj("""{"id":"u1","role":"customer"}""")
    private val bookRow = obj("""{"id":"b1","title":"T1","stock":2,"authorId":"a1","version":1}""")
    private val orderRow = obj("""{"id":"o1","customerId":"u1","bookId":"b1","qty":1}""")

    private fun named(name: String, nullable: Boolean = false) = TypeRef("named", name, nullable)
    private fun listType(of: TypeRef) = TypeRef("list", of = of)
    private fun arg(name: String, type: TypeRef, default: JsonElement? = null, vararg annotations: Annotation) =
        ArgDef(name, type = type, default = default, annotations = annotations.toList())
    private fun range(min: Int? = null, max: Int? = null) = Annotation("range", buildMap<String, JsonElement> {
        if (min != null) put("min", JsonPrimitive(min))
        if (max != null) put("max", JsonPrimitive(max))
    })
    private fun format(pattern: String) = Annotation("format", mapOf("pattern" to JsonPrimitive(pattern)))
    private fun opArgs(name: String) = (ir.ops[name] ?: error("fixture has no op $name")).args

    private fun coerce(defs: List<ArgDef>, raw: String, schema: RayfoldSchemaIR = ir, path: String = "f()") = Args.coerce(schema, defs, obj(raw), path)
    private fun rejected(defs: List<ArgDef>, raw: String, schema: RayfoldSchemaIR = ir, path: String = "f()"): String {
        val e = assertFailsWith<RayfoldException>("expected $raw to be rejected") { coerce(defs, raw, schema, path) }
        assertEquals(Code.INVALID_ARGUMENT, e.code)
        return e.message
    }

    // ------------------------------------------------------------------ absent, null and defaults

    @Test
    fun `absent stays absent and explicit null stays null on a nullable arg without a default`() {
        val defs = listOf(arg("note", named("String", nullable = true)))
        assertFalse("note" in coerce(defs, "{}"), "absent must not be materialised as null")
        assertEquals(obj("""{"note":null}"""), coerce(defs, """{"note":null}"""))
        assertEquals(obj("""{"note":"x"}"""), coerce(defs, """{"note":"x"}"""))
    }

    @Test
    fun `a default fills an absent value and a supplied value wins`() {
        val defs = listOf(arg("qty", named("Int"), JsonPrimitive(1)))
        assertEquals(obj("""{"qty":1}"""), coerce(defs, "{}"))
        assertEquals(obj("""{"qty":3}"""), coerce(defs, """{"qty":3}"""))
    }

    @Test
    fun `explicit null on a nullable arg with a default stays null`() {
        val defs = listOf(arg("limit", named("Int", nullable = true), JsonPrimitive(5)))
        assertEquals(obj("""{"limit":null}"""), coerce(defs, """{"limit":null}"""))
        // guard: the default is still applied when the value is absent
        assertEquals(obj("""{"limit":5}"""), coerce(defs, "{}"))
    }

    @Test
    fun `explicit null on a non-null arg with a default is rejected instead of defaulted`() {
        val defs = listOf(arg("qty", named("Int"), JsonPrimitive(1)))
        assertEquals("f().qty: must not be null", rejected(defs, """{"qty":null}"""))
        assertEquals(obj("""{"qty":1}"""), coerce(defs, "{}"), "guard: absent still takes the default")
    }

    @Test
    fun `a required arg without a default rejects both absent and null`() {
        val defs = listOf(arg("id", named("ID")))
        assertEquals("f().id: required", rejected(defs, "{}"))
        assertEquals("f().id: required", rejected(defs, """{"id":null}"""))
    }

    @Test
    fun `input fields follow the same absent, null and default rules`() {
        val schema = ir.copy(types = ir.types + ("Opts" to TypeDef(kind = "input", name = "Opts", fields = listOf(
            FieldDef("note", type = named("String", nullable = true), default = JsonPrimitive("n")),
            FieldDef("size", type = named("Int"), default = JsonPrimitive(2)),
            FieldDef("tag", type = named("String", nullable = true)),
        ))))
        val defs = listOf(arg("o", named("Opts")))
        assertEquals(obj("""{"o":{"note":"n","size":2}}"""), coerce(defs, """{"o":{}}""", schema), "defaults fill, tag stays absent")
        assertEquals(obj("""{"o":{"note":null,"size":2,"tag":null}}"""), coerce(defs, """{"o":{"note":null,"tag":null}}""", schema))
        assertEquals("f().o.size: must not be null", rejected(defs, """{"o":{"size":null}}""", schema))
    }

    @Test
    fun `unknown arguments and non-object input are rejected with the path`() {
        assertEquals("f().zzz: unknown argument", rejected(listOf(arg("id", named("ID"))), """{"id":"1","zzz":1}"""))
        val notObject = assertFailsWith<RayfoldException> { Args.coerce(ir, emptyList(), JsonArray(emptyList()), "f()") }
        assertEquals("f(): expected an object", notObject.message)
        assertEquals(JsonObject(emptyMap()), Args.coerce(ir, emptyList(), JsonNull, "f()"), "a null args object reads as no args")
        assertEquals(JsonObject(emptyMap()), Args.coerce(ir, emptyList(), null, "f()"))
    }

    // ------------------------------------------------------------------ type coercion

    private fun accepts(type: String, json: String, expected: String = json) =
        assertEquals(Json.parseToJsonElement(expected), coerce(listOf(arg("x", named(type))), """{"x":$json}""")["x"], "$type accepts $json")

    private fun refuses(type: String, json: String, want: String) =
        assertEquals("f().x: expected $want", rejected(listOf(arg("x", named(type))), """{"x":$json}"""), "$type refuses $json")

    @Test
    fun `built-in scalars accept their wire forms and normalise ids and decimals to strings`() {
        accepts("ID", "\"b1\""); accepts("ID", "7", "\"7\"")
        accepts("String", "\"s\"")
        accepts("Int", "2147483647"); accepts("Int", "-2147483647")
        accepts("Long", "9007199254740993"); accepts("Long", "\"-12\"")
        accepts("Float", "1.5")
        accepts("Boolean", "true")
        accepts("Decimal", "\"12.50\""); accepts("Decimal", "1.25", "\"1.25\"")
        accepts("Instant", "\"2026-09-10T12:00:00Z\""); accepts("Instant", "\"2026-09-10T12:00:00.123+02:00\"")
        accepts("Date", "\"2026-09-10\"")
        accepts("Duration", "1500"); accepts("Duration", "\"5s\"")
        accepts("Bytes", "\"aGk_-\"")
        accepts("JSON", """{"a":[1]}""")
    }

    @Test
    fun `built-in scalars reject other shapes with the expected type in the message`() {
        refuses("ID", "\"\"", "ID"); refuses("ID", "1.5", "ID"); refuses("ID", "true", "ID")
        refuses("String", "1", "String"); refuses("String", """{"a":1}""", "scalar String")
        refuses("Int", "2147483648", "Int"); refuses("Int", "1.5", "Int"); refuses("Int", "\"3\"", "Int")
        refuses("Long", "\"1.5\"", "Long")
        refuses("Float", "\"1.5\"", "Float")
        refuses("Boolean", "\"true\"", "Boolean"); refuses("Boolean", "1", "Boolean")
        refuses("Decimal", "\"1e3\"", "Decimal")
        refuses("Instant", "\"2026-09-10\"", "Instant (RFC 3339)")
        refuses("Date", "\"10/09/2026\"", "Date (YYYY-MM-DD)")
        refuses("Duration", "-1", "Duration"); refuses("Duration", "\"5 s\"", "Duration")
        refuses("Bytes", "\"aGk=\"", "Bytes (base64url)")
    }

    @Test
    fun `numbers must be strict JSON and fit their type`() {
        accepts("Int", "-2147483648"); refuses("Int", "-2147483649", "Int")
        accepts("Long", "9223372036854775807"); accepts("Long", "\"-9223372036854775808\"")
        refuses("Long", "9223372036854775808", "Long"); refuses("Long", "\"9223372036854775808\"", "Long")
        refuses("Float", "1e309", "Float"); accepts("Float", "1e308")
        // what kotlinx's lenient parser lets through as unquoted literals is no number for any scalar
        for (lit in listOf("NaN", "Infinity", "1d", "01")) {
            refuses("Int", lit, "Int"); refuses("Long", lit, "Long"); refuses("Float", lit, "Float")
            refuses("Decimal", lit, "Decimal"); refuses("Duration", lit, "Duration")
        }
        refuses("ID", "1d", "ID")
        accepts("Decimal", "-0.5", "\"-0.5\"")
    }

    @Test
    fun `enums, lists and non-input types are checked with element paths`() {
        val schema = ir.copy(types = ir.types + ("Format" to TypeDef(kind = "enum", name = "Format", values = listOf(EnumValueDef("PAPER"), EnumValueDef("EBOOK")))))
        val fmt = listOf(arg("fmt", named("Format")))
        assertEquals(obj("""{"fmt":"PAPER"}"""), coerce(fmt, """{"fmt":"PAPER"}""", schema))
        assertEquals("f().fmt: expected one of PAPER, EBOOK", rejected(fmt, """{"fmt":"VINYL"}""", schema))
        assertEquals("f().fmt: expected one of PAPER, EBOOK", rejected(fmt, """{"fmt":1}""", schema))

        val tags = listOf(arg("tags", listType(named("String"))))
        assertEquals(obj("""{"tags":["a","b"]}"""), coerce(tags, """{"tags":["a","b"]}"""))
        assertEquals("f().tags.1: expected String", rejected(tags, """{"tags":["a",3]}"""))
        assertEquals("f().tags.0: must not be null", rejected(tags, """{"tags":[null]}"""))
        assertEquals("f().tags: expected a list", rejected(tags, """{"tags":"a"}"""))

        assertEquals("f().b: Book is not an input type", rejected(listOf(arg("b", named("Book"))), """{"b":{}}"""))
        assertEquals("f().p: expected BookPatch", rejected(listOf(arg("p", named("BookPatch"))), """{"p":"x"}"""))
    }

    // ------------------------------------------------------------------ constraints

    @Test
    fun `range bounds are inclusive and reported with the full path into nested inputs`() {
        val buy = opArgs("buy")
        assertEquals("buy().qty: must be >= 1", rejected(buy, """{"bookId":"b1","qty":0}""", path = "buy()"))
        assertEquals(obj("""{"bookId":"b1","qty":1}"""), coerce(buy, """{"bookId":"b1","qty":1}""", path = "buy()"))
        assertEquals(obj("""{"bookId":"b1","qty":10}"""), coerce(buy, """{"bookId":"b1","qty":10}""", path = "buy()"))
        assertEquals("buy().qty: must be <= 10", rejected(buy, """{"bookId":"b1","qty":11}""", path = "buy()"))

        val patch = opArgs("patchBook")
        assertEquals("patchBook().patch.stock: must be >= 0", rejected(patch, """{"id":"b1","patch":{"stock":-1}}""", path = "patchBook()"))
        assertEquals(obj("""{"id":"b1","patch":{"stock":0}}"""), coerce(patch, """{"id":"b1","patch":{"stock":0}}""", path = "patchBook()"))
    }

    @Test
    fun `range applies to string and list lengths but not to an explicit null`() {
        val s = listOf(arg("s", named("String", nullable = true), null, range(min = 2, max = 3)))
        assertEquals("f().s: must be >= 2", rejected(s, """{"s":"a"}"""))
        assertEquals(obj("""{"s":"abc"}"""), coerce(s, """{"s":"abc"}"""))
        assertEquals("f().s: must be <= 3", rejected(s, """{"s":"abcd"}"""))
        assertEquals(obj("""{"s":null}"""), coerce(s, """{"s":null}"""), "null is not a zero-length value")

        val l = listOf(arg("l", listType(named("String")), null, range(max = 2)))
        assertEquals(obj("""{"l":["a","b"]}"""), coerce(l, """{"l":["a","b"]}"""))
        assertEquals("f().l: must be <= 2", rejected(l, """{"l":["a","b","c"]}"""))
    }

    @Test
    fun `range reads the declared type, so a String that looks like a number is measured by length`() {
        val title = listOf(arg("title", named("String"), null, range(min = 1, max = 200)))
        assertEquals(obj("""{"title":"1984"}"""), coerce(title, """{"title":"1984"}"""), "4 characters, not the number 1984")
        assertEquals(obj("""{"title":"${"x".repeat(200)}"}"""), coerce(title, """{"title":"${"x".repeat(200)}"}"""))
        assertEquals("f().title: must be <= 200", rejected(title, """{"title":"${"x".repeat(201)}"}"""))
        assertEquals("f().title: must be >= 1", rejected(title, """{"title":""}"""))
    }

    @Test
    fun `range compares Decimal, Long and Int by value even when the wire form is a string`() {
        val price = listOf(arg("price", named("Decimal"), null, range(min = 0)))
        assertEquals("f().price: must be >= 0", rejected(price, """{"price":"-1"}"""))
        assertEquals(obj("""{"price":"0"}"""), coerce(price, """{"price":"0"}"""))
        // guard for the String rule above: the same text as a Decimal is a number
        assertEquals("f().d: must be <= 200", rejected(listOf(arg("d", named("Decimal"), null, range(max = 200))), """{"d":"1984"}"""))
        assertEquals("f().n: must be <= 200", rejected(listOf(arg("n", named("Long"), null, range(max = 200))), """{"n":"1984"}"""), "a Long sent as a string")
        assertEquals("f().n: must be <= 200", rejected(listOf(arg("n", named("Int"), null, range(max = 200))), """{"n":1984}"""))
    }

    @Test
    fun `format matches the whole string and ignores non-strings`() {
        val slug = listOf(arg("slug", named("String"), null, format("^[a-z]+$")))
        assertEquals(obj("""{"slug":"abc"}"""), coerce(slug, """{"slug":"abc"}"""))
        assertEquals("f().slug: must match ^[a-z]+$", rejected(slug, """{"slug":"abC"}"""))

        val digit = listOf(arg("s", named("String"), null, format("[0-9]")))
        assertEquals("f().s: must match [0-9]", rejected(digit, """{"s":"a1b"}"""), "the whole value must match, anchored or not")
        assertEquals(obj("""{"s":"7"}"""), coerce(digit, """{"s":"7"}"""))
        assertEquals("f().slug: must match ^[a-z]+$", rejected(slug, """{"slug":"abc\n"}"""), "a trailing line break does not satisfy the end anchor")

        val n = listOf(arg("n", named("Int"), null, format("^[a-z]+$")))
        assertEquals(obj("""{"n":5}"""), coerce(n, """{"n":5}"""))
    }

    @Test
    fun `page size is clamped to 200, and a negative size or offset is rejected`() {
        val books = opArgs("books")
        fun page(raw: String) = (coerce(books, raw, path = "books()")["page"] as? JsonObject) ?: error("no page arg")
        fun first(raw: String) = page(raw)["first"]
        assertEquals(JsonPrimitive(200), first("""{"page":{"first":500}}"""))
        assertEquals(JsonPrimitive(200), first("""{"page":{"first":200}}"""))
        assertEquals(JsonPrimitive(0), first("""{"page":{"first":0}}"""))
        assertEquals(JsonPrimitive(20), first("{}"), "the op's declared default page")
        assertEquals("books().page.first: must be >= 0", rejected(books, """{"page":{"first":-1}}""", path = "books()"))
        assertEquals("books().page.offset: must be >= 0", rejected(books, """{"page":{"first":2,"offset":-1}}""", path = "books()"))
        // guard: an offset of 0 or more, or none, reaches the resolver as sent
        assertEquals(JsonPrimitive(0), page("""{"page":{"first":2,"offset":0}}""")["offset"])
        assertEquals(JsonPrimitive(3), page("""{"page":{"first":2,"offset":3}}""")["offset"])
        assertNull(page("""{"page":{"first":2}}""")["offset"])
    }

    // ------------------------------------------------------------------ $ref

    private val results = mapOf(1 to obj("""{"id":"o1","bio":null,"items":[{"sku":"x"}]}"""))
    private fun lookup(id: Int, path: List<String>): JsonElement? = Args.getPath(results[id], path)

    @Test
    fun `resolveRefs swaps refs at any depth and leaves look-alikes alone`() {
        val out = Args.resolveRefs(obj("""{
            "a":{"${'$'}ref":"1.id"},
            "b":[{"${'$'}ref":"1.items.0.sku"}],
            "c":{"${'$'}ref":"1.id","x":1},
            "d":{"${'$'}ref":"1.bio"},
            "e":{"${'$'}ref":"1"}}"""), ::lookup, "ops.2.args")
        assertEquals(obj("""{
            "a":"o1",
            "b":["x"],
            "c":{"${'$'}ref":"1.id","x":1},
            "d":null,
            "e":{"id":"o1","bio":null,"items":[{"sku":"x"}]}}"""), out, "an explicit null is a value, not a dangling ref")
    }

    @Test
    fun `resolveRefs reports malformed and dangling refs with the arg path`() {
        fun fails(ref: String) = assertFailsWith<RayfoldException> {
            Args.resolveRefs(obj("""{"a":{"${'$'}ref":"$ref"}}"""), ::lookup, "ops.2.args")
        }.also { assertEquals(Code.INVALID_ARGUMENT, it.code) }.message
        assertEquals("ops.2.args.a: bad \$ref \"x.id\"", fails("x.id"))
        assertEquals("ops.2.args.a: bad \$ref \"0.id\"", fails("0.id"))
        assertEquals("ops.2.args.a: bad \$ref \"-1.id\"", fails("-1.id"))
        assertEquals("ops.2.args.a: \$ref 1.nope resolved to nothing", fails("1.nope"))
        assertEquals("ops.2.args.a: \$ref 3.id resolved to nothing", fails("3.id"))
        assertEquals("ops.2.args.a: \$ref 1.items.5.sku resolved to nothing", fails("1.items.5.sku"))
    }

    @Test
    fun `collectRefs finds every referenced op and marks a malformed id as -1`() {
        val refs = Args.collectRefs(obj("""{
            "a":{"${'$'}ref":"2.id"},
            "b":[{"${'$'}ref":"1"}],
            "c":{"${'$'}ref":"x.y"},
            "d":{"${'$'}ref":"3.id","other":1}}"""))
        assertEquals(setOf(2, 1, -1), refs, "d has a second key, so it is data, not a ref")
        assertEquals(emptySet(), Args.collectRefs(obj("""{"a":"1.id","b":[1,2]}""")))
    }

    // ------------------------------------------------------------------ pipeline: Batch.kt op args

    @Test
    fun `op args reach the resolver with defaults applied, explicit nulls kept and absent fields absent`() = runTest(timeout = 5.seconds) {
        val seen = mutableListOf<JsonObject>()
        val server = RayfoldServer(ir, Resolvers(commands = mapOf(
            "patchBook" to command { args, _ -> seen.add(args); CommandResult(bookRow) },
            "buy" to command { args, _ -> seen.add(args); CommandResult(orderRow) },
        )))
        val frames = server.collect(batch(
            """{"id":1,"op":"patchBook","args":{"id":"b1","patch":{"title":"New","secret":null}},"key":"k-patch-000000001"}""",
            """{"id":2,"op":"buy","args":{"bookId":"b1"},"key":"k-buy-00000000001"}""",
        ), u1)
        assertEquals(listOf(null, null), frames.map { it.errorCode() }, "$frames")
        assertEquals(obj("""{"title":"New","secret":null}"""), seen[0]["patch"], "stock was absent and must stay absent")
        assertEquals(JsonPrimitive(1), seen[1]["qty"], "buy.qty defaults to 1")
    }

    @Test
    fun `an op arg constraint fails the op before its resolver runs`() = runTest(timeout = 5.seconds) {
        var runs = 0
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("buy" to command { _, _ -> runs++; CommandResult(orderRow) })))
        val over = server.collect(batch("""{"id":1,"op":"buy","args":{"bookId":"b1","qty":11},"key":"k-buy-00000000011"}"""), u1).single()
        assertEquals("invalid_argument", over.errorCode())
        assertEquals("buy().qty: must be <= 10", over.errorMessage())
        assertEquals(0, runs)
        val atMax = server.collect(batch("""{"id":1,"op":"buy","args":{"bookId":"b1","qty":10},"key":"k-buy-00000000010"}"""), u1).single()
        assertNull(atMax.errorCode(), "guard: the bound itself is accepted: $atMax")
        assertEquals(1, runs)
    }

    @Test
    fun `explicit null for a non-null arg with a default is rejected end to end while absent takes the default`() = runTest(timeout = 5.seconds) {
        val seen = mutableListOf<JsonObject>()
        val server = RayfoldServer(ir, Resolvers(commands = mapOf("buy" to command { args, _ -> seen.add(args); CommandResult(orderRow) })))
        val nulled = server.collect(batch("""{"id":1,"op":"buy","args":{"bookId":"b1","qty":null},"key":"k-buy-null0000001"}"""), u1).single()
        assertEquals("invalid_argument", nulled.errorCode())
        assertEquals("buy().qty: must not be null", nulled.errorMessage())
        assertEquals(emptyList(), seen)
        val absent = server.collect(batch("""{"id":1,"op":"buy","args":{"bookId":"b1"},"key":"k-buy-absent00001"}"""), u1).single()
        assertNull(absent.errorCode(), "$absent")
        assertEquals(JsonPrimitive(1), seen.single()["qty"])
    }

    @Test
    fun `a String range on an input field is checked by length end to end`() = runTest(timeout = 5.seconds) {
        val schema = ir.withFieldAnnotations("BookPatch", "title", range(min = 1, max = 200))
        val seen = mutableListOf<JsonObject>()
        val server = RayfoldServer(schema, Resolvers(commands = mapOf("patchBook" to command { args, _ -> seen.add(args); CommandResult(bookRow) })))
        val ok = server.collect(batch("""{"id":1,"op":"patchBook","args":{"id":"b1","patch":{"title":"1984"}},"key":"k-title-000000001"}"""), u1).single()
        assertNull(ok.errorCode(), "$ok")
        assertEquals(obj("""{"title":"1984"}"""), seen.single()["patch"])
        val tooLong = server.collect(batch("""{"id":1,"op":"patchBook","args":{"id":"b1","patch":{"title":"${"x".repeat(201)}"}},"key":"k-title-000000002"}"""), u1).single()
        assertEquals("invalid_argument", tooLong.errorCode())
        assertEquals("patchBook().patch.title: must be <= 200", tooLong.errorMessage())
        assertEquals(1, seen.size, "the over-long title never reached the resolver")
    }

    // ------------------------------------------------------------------ pipeline: Executor.kt field args

    @Test
    fun `field args in a shape are coerced with the field path, its default and page clamping`() = runTest(timeout = 5.seconds) {
        val seen = mutableListOf<JsonObject>()
        val server = RayfoldServer(ir, Resolvers(
            queries = mapOf("book" to query { _, _ -> bookRow }),
            fields = mapOf("Book" to mapOf("reviews" to loader { parents, args, _ ->
                seen.add(args)
                parents.map { obj("""{"items":[],"hasMore":false,"total":0}""") }
            })),
        ))
        suspend fun pageFirstSeen(shape: String): JsonElement? {
            val frame = server.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"$shape"}""")).single()
            assertNull(frame.errorCode(), "$shape failed: $frame")
            return (seen.last()["page"] as? JsonObject)?.get("first")
        }
        assertEquals(JsonPrimitive(10), pageFirstSeen("{ id reviews { total } }"), "the field's declared default")
        assertEquals(JsonPrimitive(3), pageFirstSeen("{ id reviews(page: {first: 3}) { total } }"))
        assertEquals(JsonPrimitive(200), pageFirstSeen("{ id reviews(page: {first: 500}) { total } }"), "clamped to the page maximum")
        pageFirstSeen("{ id reviews(page: {first: 2, offset: 1}) { total } }")
        assertEquals(JsonPrimitive(1), (seen.last()["page"] as? JsonObject)?.get("offset"), "guard: an offset of 0 or more reaches the loader")
        val loads = seen.size
        val bad = server.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id reviews(page: {first: -1}) { total } }"}""")).single()
        assertEquals("invalid_argument", bad.errorCode())
        assertEquals("Book.reviews.page.first: must be >= 0", bad.errorMessage())
        val badOffset = server.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id reviews(page: {first: 2, offset: -1}) { total } }"}""")).single()
        assertEquals("invalid_argument", badOffset.errorCode())
        assertEquals("Book.reviews.page.offset: must be >= 0", badOffset.errorMessage())
        assertEquals(loads, seen.size, "a rejected field arg never reaches the loader")
    }

    @Test
    fun `shape variables feed field args and a missing one fails the op`() = runTest(timeout = 5.seconds) {
        val seen = mutableListOf<JsonObject>()
        val server = RayfoldServer(ir, Resolvers(
            queries = mapOf("book" to query { _, _ -> bookRow }),
            fields = mapOf("Book" to mapOf("reviews" to loader { parents, args, _ ->
                seen.add(args)
                parents.map { obj("""{"items":[],"hasMore":false,"total":0}""") }
            })),
        ))
        val shape = "{ id reviews(page: {first: ${'$'}n}) { total } }"
        val withVar = server.collect(obj("""{"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"$shape","vars":{"n":2}}]}""")).single()
        assertNull(withVar.errorCode(), "$withVar")
        assertEquals(JsonPrimitive(2), (seen.single()["page"] as? JsonObject)?.get("first"))
        val missing = server.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"$shape"}""")).single()
        assertEquals("invalid_argument", missing.errorCode())
        assertEquals("Missing shape variable \$n", missing.errorMessage())
        assertEquals(1, seen.size)
    }

    // ------------------------------------------------------------------ pipeline: Batch.kt refs

    @Test
    fun `a ref waits for the op it names and a dangling path fails only the dependent op`() = runTest(timeout = 5.seconds) {
        val authorCalls = mutableListOf<JsonElement?>()
        val server = RayfoldServer(ir, Resolvers(
            // the delay makes a dropped dependency wait visible: op 2 would read an empty result
            queries = mapOf(
                "book" to query { _, _ -> delay(10); bookRow },
                "author" to query { args, _ -> authorCalls.add(args["id"]); obj("""{"id":"a1","name":"Ann","bio":null}""") },
            ),
            fields = mapOf("Book" to mapOf("author" to loader { parents, _, _ -> parents.map { obj("""{"id":"a1","name":"Ann","bio":null}""") } })),
        ))
        val frames = server.collect(batch(
            """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id author { id } }"}""",
            """{"id":2,"op":"author","args":{"id":{"${'$'}ref":"1.author.id"}},"shape":"{ name }"}""",
            """{"id":3,"op":"author","args":{"id":{"${'$'}ref":"1.nope"}}}""",
        )).associateBy { it.opId() }
        assertEquals(obj("""{"${'$'}type":"Author","name":"Ann"}"""), frames[2]?.get("data"))
        assertEquals("ops.3.args.id: \$ref 1.nope resolved to nothing", frames[3]?.errorMessage())
        assertNull(frames[1]?.errorCode())
        assertEquals(listOf<JsonElement?>(JsonPrimitive("a1")), authorCalls, "only the op with a live ref reached the resolver")
    }

    @Test
    fun `a malformed ref id is a batch-level error and nothing runs`() = runTest(timeout = 5.seconds) {
        var runs = 0
        val server = RayfoldServer(ir, Resolvers(queries = mapOf("book" to query { _, _ -> runs++; bookRow })))
        val frames = server.collect(batch(
            """{"id":1,"op":"book","args":{"id":"b1"}}""",
            """{"id":2,"op":"book","args":{"id":{"${'$'}ref":"x.id"}}}""",
        ))
        assertEquals(listOf(obj("""{"error":{"code":"invalid_argument","message":"ops[1].args: bad ${'$'}ref"},"fin":true}""")), frames)
        assertEquals(0, runs)
    }
}
