package dev.rayfold.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.Duration.Companion.seconds

/**
 * Static cost, depth and field counts. The only production caller is BatchRunner's planning step (grep
 * `cost.estimate`), which uses one estimate three ways: frame meta.cost, the batch budget, and the depth/field
 * limits. Each use has a pipeline test at the bottom.
 */
class CostTest {
    private val ir = Fixtures.ir(Fixtures.load("core/03-pipelining.json"))

    private fun estimate(op: String, args: String = "{}", shape: String? = null, vars: String = "{}", schema: RayfoldSchemaIR = ir): CostEstimate {
        val o = schema.ops[op] ?: error("schema has no op $op")
        val views = Views(schema)
        return Cost(schema, views).estimate(o, obj(args), shape?.let { Shapes.parse(it) } ?: views.defaultShape(o.returns), obj(vars))
    }

    private fun withBooksArgs(vararg a: ArgDef): RayfoldSchemaIR =
        ir.copy(ops = ir.ops + ("books" to (ir.ops["books"] ?: error("fixture has no books op")).copy(args = a.toList())))

    @Test
    fun `an entity query costs its base, its scalar fields nothing and each object field 1`() {
        assertEquals(CostEstimate(cost = 1, depth = 1, fields = 3), estimate("book"), "declared default view: id title stock")
        assertEquals(CostEstimate(cost = 2, depth = 2, fields = 3), estimate("book", shape = "{ id author { name } }"), "guard: author is one more load")
    }

    @Test
    fun `a page op adds perItem times first and multiplies what sits under items`() {
        // books: @cost(base: 5, perItem: 1); 5 + 1*3, items 1; total, id and title come with their rows
        assertEquals(CostEstimate(cost = 9, depth = 2, fields = 4), estimate("books", """{"page":{"first":3}}""", "{ total items { id title } }"))
        // 5 + 1*3, items 1, author 3*1
        assertEquals(CostEstimate(cost = 12, depth = 3, fields = 6), estimate("books", """{"page":{"first":3}}""", "{ total items { id title author { name } } }"))
        // default view of Page<Book> at first 50: 5 + 50 + items 1; Book.default holds only scalars
        assertEquals(56L, estimate("books", """{"page":{"first":50}}""").cost, "matches core/09-limits")
    }

    @Test
    fun `page size comes from args, then the arg default, then 20`() {
        val shape = "{ items { id } }"
        // 5 + first + items 1
        assertEquals(8L, estimate("books", """{"page":{"first":2}}""", shape).cost)
        assertEquals(26L, estimate("books", shape = shape).cost, "the declared default page of 20")
        val pageArgs = TypeRef("named", "PageArgs")
        assertEquals(13L, estimate("books", shape = shape, schema = withBooksArgs(ArgDef("page", type = pageArgs, default = obj("""{"first":7}""")))).cost)
        assertEquals(26L, estimate("books", shape = shape, schema = withBooksArgs(ArgDef("page", type = pageArgs.copy(nullable = true)))).cost, "no default: 20")
        val firstArg = withBooksArgs(ArgDef("first", type = TypeRef("named", "Int"), default = JsonPrimitive(7)))
        assertEquals(13L, estimate("books", shape = shape, schema = firstArg).cost, "a top-level first default")
        assertEquals(10L, estimate("books", """{"first":4}""", shape, schema = firstArg).cost, "a top-level first arg")
    }

    @Test
    fun `nested pages multiply and a field page size can come from a shape variable or the field default`() {
        // 5 + 2 | items 1 | reviews 2*(1 + 3 rows) | reviews.items 2*1 | review.id free
        assertEquals(CostEstimate(cost = 18, depth = 4, fields = 4), estimate("books", """{"page":{"first":2}}""", "{ items { reviews(page: {first: 3}) { items { id } } } }"))
        val byVar = "{ items { reviews(page: {first: ${'$'}n}) { items { id } } } }"
        assertEquals(20L, estimate("books", """{"page":{"first":2}}""", byVar, """{"n":4}""").cost)
        assertEquals(412L, estimate("books", """{"page":{"first":2}}""", byVar).cost, "a missing variable is charged the largest page, 200, never less")
        assertEquals(32L, estimate("books", """{"page":{"first":2}}""", "{ items { reviews { items { id } } } }").cost)
    }

    @Test
    fun `a page size that is not a whole number from 0 to 200 is charged as 200 and never wraps`() {
        val shape = "{ items { id } }"
        val at200 = estimate("books", """{"page":{"first":200}}""", shape).cost
        assertEquals(206L, at200, "5 + 200 + items 1")
        for (v in listOf("-100000", "201", "2147483647", "3000000000", "1e300", "1e999", "1.5", "\"5000\"", "\"x\"", "null", "true", """{"${'$'}ref":"1.total"}""")) {
            assertEquals(at200, estimate("books", """{"page":{"first":$v}}""", shape).cost, "first = $v")
        }
        assertEquals(at200, estimate("books", """{"page":{"${'$'}ref":"1.page"}}""", shape).cost, "a page that is itself a ref")
        // book 1 + reviews 1 + 200 rows + items 1; before, Int arithmetic turned a huge page into -2147483646
        assertEquals(203L, estimate("book", shape = "{ reviews(page: {first: 1e300}) { items { id } } }").cost)
        // 1e999 is not a number JSON can carry: the shape itself is refused, as the TypeScript lexer refuses it
        assertEquals("Bad shape: bad number 1e999", kotlin.runCatching { estimate("book", shape = "{ reviews(page: {first: 1e999}) { items { id } } }") }.exceptionOrNull()?.message)
        for ((v, want) in listOf("0" to 6L, "3" to 9L)) assertEquals(want, estimate("books", """{"page":{"first":$v}}""", shape).cost, "guard: first = $v")
    }

    @Test
    fun `nested page multipliers saturate instead of wrapping, and every op costs at least 1`() {
        val book = ir.types["Book"] ?: error("fixture has no Book")
        val similar = FieldDef("similar", type = TypeRef("named", "Page", args = listOf(TypeRef("named", "Book"))), args = listOf(ArgDef("page", type = TypeRef("named", "PageArgs", nullable = true))))
        val schema = ir.copy(types = ir.types + ("Book" to book.copy(fields = book.fields + similar)))
        fun nested(levels: Int) = (1..levels).fold("{ id }") { inner, _ -> "{ similar(page: {first: 200}) { items $inner } }" }
        // book 1 | similar 1 + 200 rows | items 1 | similar (1 + 200 rows) * 200 | items 200 | id free
        assertEquals(40603L, estimate("book", shape = nested(2), schema = schema).cost, "guard: exact while it fits")
        assertEquals(Long.MAX_VALUE, estimate("book", shape = nested(9), schema = schema).cost, "200^9 does not fit a Long")
        val negative = ir.withOpAnnotations("book", Annotation("cost", mapOf("base" to JsonPrimitive(-5))))
        assertEquals(1L, estimate("book", shape = "{ }", schema = negative).cost, "a negative weight and an empty shape still cost 1")
    }

    @Test
    fun `an object field without a sub-shape is costed through the child's default view`() {
        // 5 + 1 | items 1 | author 1 | Author computed default: id name bio, all free; the walk still counts them
        assertEquals(CostEstimate(cost = 8, depth = 3, fields = 5), estimate("books", """{"page":{"first":1}}""", "{ items { author } }"))
    }

    @Test
    fun `field cost annotations replace the default base and perItem, on pages and on scalars`() {
        val shape = "{ reviews(page: {first: 3}) { total } }"
        assertEquals(CostEstimate(cost = 5, depth = 2, fields = 2), estimate("book", shape = shape), "guard: an unannotated page costs 1 plus 1 per row")
        val annotated = ir.withFieldAnnotations("Book", "reviews", Annotation("cost", mapOf("base" to JsonPrimitive(2), "perItem" to JsonPrimitive(2))))
        assertEquals(CostEstimate(cost = 9, depth = 2, fields = 2), estimate("book", shape = shape, schema = annotated), "book 1 + 2 + 2*3")
        assertEquals(1L, estimate("book", shape = "{ title }").cost, "guard: a scalar is free by default")
        val pricedTitle = ir.withFieldAnnotations("Book", "title", Annotation("cost", mapOf("base" to JsonPrimitive(3))))
        assertEquals(4L, estimate("book", shape = "{ title }", schema = pricedTitle).cost, "a scalar with its own @cost is charged it")
    }

    @Test
    fun `spreads, inline fragments and defers cost what they select`() {
        assertEquals(CostEstimate(1, 1, 3), estimate("book", shape = "{ ...Book.default }"))
        assertEquals(CostEstimate(2, 2, 3), estimate("book", shape = "{ @defer { id author { name } } }"))
        assertEquals(CostEstimate(2, 2, 2), estimate("book", shape = "{ ...on Book { author { id } } }"))
    }

    @Test
    fun `a plain list is not multiplied, only Page items are`() {
        val schema = ir.copy(ops = ir.ops + ("allBooks" to OpDef(kind = "query", name = "allBooks", returns = TypeRef("list", of = TypeRef("named", "Book")))))
        assertEquals(CostEstimate(1, 1, 1), estimate("allBooks", shape = "{ id }", schema = schema))
        assertEquals(CostEstimate(2, 2, 3), estimate("allBooks", shape = "{ id author { name } }", schema = schema), "author counts once, not once per element")
    }

    // ------------------------------------------------------------------ shapes that slipped past the model

    private val shop = SchemaText.load(
        """
        entity Book { id: ID title: String reviews(page: PageArgs = { first: 10 }): Page<Review> }
        entity Review { id: ID book: Book }
        entity Author { id: ID name: String }
        union Hit = Book | Author
        query hit: Hit
        query named(page: PageArgs = { first: 10 }): Page<Book>
        query picks(p: PageArgs = { first: 10 }): Page<Book>
        query list(first: Int = 20, after: String?): Page<Book>
        query top(first: Int): [Book]
        """.trimIndent(),
    ).ir

    private fun reviews(first: Int, inner: String) = "reviews(page: { first: $first }) { items { id book { $inner } } }"

    @Test
    fun `fields asked of a union are charged as each member would answer them, the dearest member counting`() {
        // the executor hands the bare fields to every member; looked up on the union they found nothing and cost 1
        val bare = estimate("hit", shape = "{ ${reviews(20, "id")} }", schema = shop)
        assertEquals(estimate("hit", shape = "{ ...on Book { ${reviews(20, "id")} } }", schema = shop), bare)
        // hit, the page and its 20 rows, items, a book on each row; summed over both members it would be one more
        assertEquals(CostEstimate(cost = 1 + 1 + 20 + 1 + 20, depth = 4, fields = 5), bare)
    }

    @Test
    fun `so a union can no longer nest pages past the depth limit`() = runTest(timeout = 5.seconds) {
        val book = obj("""{"${'$'}type":"Book","id":"b1","title":"Dune","reviews":{"items":[],"hasMore":false}}""")
        val server = RayfoldServer(shop, Resolvers(queries = mapOf("hit" to query { _, _ -> book })), BatchOptions(maxDepth = 8))
        val deep = "{ ${reviews(20, reviews(20, reviews(20, reviews(20, "id"))))} }"
        assertEquals("Shape depth 13 exceeds 8", server.collect(batch("""{"id":1,"op":"hit","shape":"$deep"}""")).single().errorMessage())
        // guard: a shallow one under the same limit runs
        assertNull(server.collect(batch("""{"id":1,"op":"hit","shape":"{ ${reviews(2, "id")} }"}""")).first().errorCode())
    }

    @Test
    fun `a PageArgs argument is read by its type, whatever it is called`() {
        val named = estimate("named", """{"page":{"first":200}}""", "{ items { id } }", schema = shop)
        assertEquals(named, estimate("picks", """{"p":{"first":200}}""", "{ items { id } }", schema = shop), "`p` was charged as a page of 20")
        assertEquals(1L + 200 + 1, named.cost)
        assertEquals(1L + 10 + 1, estimate("picks", shape = "{ items { id } }", schema = shop).cost, "guard: its own default still applies")
    }

    @Test
    fun `a page's own first argument is capped before the resolver sees it, and a negative one refused`() = runTest(timeout = 5.seconds) {
        val seen = mutableListOf<JsonElement?>()
        val page = obj("""{"items":[],"hasMore":false}""")
        val server = RayfoldServer(shop, Resolvers(queries = mapOf(
            "list" to query { args, _ -> seen.add(args["first"]); page },
            "top" to query { args, _ -> seen.add(args["first"]); JsonArray(emptyList()) },
        )))
        server.collect(batch("""{"id":1,"op":"list","args":{"first":1000000},"shape":"{ items { id } }"}"""))
        assertEquals(listOf<JsonElement?>(JsonPrimitive(200)), seen)
        assertEquals("list().first: must be >= 0", server.collect(batch("""{"id":1,"op":"list","args":{"first":-1},"shape":"{ items { id } }"}""")).single().errorMessage())
        // guard: a `first` on an op that returns no page means something else, and is left as sent
        seen.clear()
        server.collect(batch("""{"id":1,"op":"top","args":{"first":1000},"shape":"{ id }"}"""))
        assertEquals(listOf<JsonElement?>(JsonPrimitive(1000)), seen)
    }

    // ------------------------------------------------------------------ pipeline

    @Test
    fun `a frame's meta cost is the static estimate`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer()
        val frame = fx.server.collect(batch("""{"id":1,"op":"books","args":{"page":{"first":3}},"shape":"{ total items { id title } }"}""")).single()
        assertEquals(obj("""{"cost":9}"""), frame["meta"])
        assertEquals(9L, estimate("books", """{"page":{"first":3}}""", "{ total items { id title } }").cost, "the unit estimate agrees")
    }

    private val budgetBatch = batch(
        """{"id":1,"op":"book","args":{"id":"b1"}}""",
        """{"id":2,"op":"books","args":{"page":{"first":3}},"shape":"{ total items { id title } }"}""",
    )

    @Test
    fun `a batch one over budget is rejected before any resolver runs`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer(options = BatchOptions(budget = 9))
        assertEquals(
            listOf(obj("""{"error":{"code":"resource_exhausted","message":"Batch cost 10 exceeds budget 9","data":{"cost":10,"budget":9}},"fin":true}""")),
            fx.server.collect(budgetBatch),
        )
        assertEquals(emptyMap(), fx.store.calls.toMap())
    }

    @Test
    fun `the identical batch at exactly its budget runs`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer(options = BatchOptions(budget = 10))
        val frames = fx.server.collect(budgetBatch).associateBy { it.opId() }
        assertEquals(obj("""{"cost":1}"""), frames[1]?.get("meta"))
        assertEquals(obj("""{"cost":9}"""), frames[2]?.get("meta"))
        assertEquals(mapOf("Query.book" to 1, "Query.books" to 1), fx.store.calls.toMap())
    }

    @Test
    fun `depth at the limit passes and one over fails only that op`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer(options = BatchOptions(maxDepth = 2))
        val frames = fx.server.collect(batch(
            """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id author { name } }"}""",
            """{"id":2,"op":"book","args":{"id":"b1"},"shape":"{ reviews { items { id } } }"}""",
        )).associateBy { it.opId() }
        assertEquals(obj("""{"${'$'}type":"Book","id":"b1","author":{"${'$'}type":"Author","name":"Ann"}}"""), frames[1]?.get("data"))
        assertEquals(obj("""{"id":2,"error":{"code":"resource_exhausted","message":"Shape depth 3 exceeds 2"},"fin":true}"""), frames[2])
        assertEquals(1, fx.store.calls["Query.book"])
    }

    @Test
    fun `field count at the limit passes and one over fails`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer(options = BatchOptions(maxFields = 3))
        val frames = fx.server.collect(batch(
            """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id title stock }"}""",
            """{"id":2,"op":"book","args":{"id":"b1"},"shape":"{ id title stock version }"}""",
        )).associateBy { it.opId() }
        assertNull(frames[1]?.errorCode(), "${frames[1]}")
        assertEquals("Shape selects 4 fields, max 3", frames[2]?.errorMessage())
        assertEquals(1, fx.store.calls["Query.book"], "the op over the limit never ran")
    }

    private fun books(n: Int) = batch(*(1..n).map { """{"id":$it,"op":"book","args":{"id":"b1"},"shape":"{ id }"}""" }.toTypedArray())

    @Test
    fun `a batch with one op over maxOps is refused whole before any resolver runs`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer(options = BatchOptions(maxOps = 2))
        assertEquals(
            listOf(obj("""{"error":{"code":"resource_exhausted","message":"At most 2 ops per batch"},"fin":true}""")),
            fx.server.collect(books(3)),
        )
        assertEquals(emptyMap(), fx.store.calls.toMap())
    }

    @Test
    fun `a batch of exactly maxOps runs every op`() = runTest(timeout = 5.seconds) {
        val fx = fixtureServer(options = BatchOptions(maxOps = 2))
        val frames = fx.server.collect(books(2)).associateBy { it.opId() }
        assertEquals(setOf(1, 2), frames.keys)
        for (id in 1..2) assertEquals(obj("""{"${'$'}type":"Book","id":"b1"}"""), frames[id]?.get("data"), "op $id")
        assertEquals(mapOf("Query.book" to 2), fx.store.calls.toMap(), "each op ran its own resolver")
    }
}
