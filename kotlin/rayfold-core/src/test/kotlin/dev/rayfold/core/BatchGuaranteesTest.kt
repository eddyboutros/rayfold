package dev.rayfold.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.seconds

/**
 * What the batch runner and the executor promise beyond the conformance corpus, each through RayfoldServer on virtual
 * time: references, op deadlines and cancels, the projection's own refusals, a command's declarations, key bounds,
 * the claim backoff, replays of failures and what a live query hears. Every refusal sits beside the request that is
 * answered.
 */
class BatchGuaranteesTest {
    private val t = "${'$'}type"
    private val u1 = obj("""{"id":"u1"}""")
    private val key = "0123456789abcdef"

    private val schema = SchemaText.load(
        """
        entity Book { id: ID title: String stock: Int x: Float? }
        entity Author { id: ID name: String }
        union Hit = Book | Author
        error OutOfStock { available: Int }
        event Sold { id: ID }
        query book(id: ID): Book
        query books: [Book]
        query hit(id: ID): Hit
        query quiet(id: ID): Book @live(false)
        query shelf(page: PageArgs): Page<Book>
        command buy(id: ID): Book throws OutOfStock emits Sold
        command buyAll: [Book] @idempotent(false)
        command pick: Hit @idempotent(false)
        command reprice(id: ID, amount: Float): Book
        stream sold: Sold
        """,
    ).ir

    private val books = java.util.concurrent.ConcurrentHashMap<String, JsonObject>(
        mapOf("b1" to obj("""{"id":"b1","title":"Dune","stock":3,"x":1.5}""")),
    )

    private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.content ?: error("no $k in $this")

    private fun server(
        queries: Map<String, RootResolver> = emptyMap(),
        commands: Map<String, suspend (JsonObject, RayfoldContext) -> Any?> = emptyMap(),
        streams: Map<String, StreamResolver> = emptyMap(),
        counters: Counters? = null,
        idempotency: IdempotencyStore? = null,
    ) = RayfoldServer(
        schema,
        Resolvers(
            queries = mapOf<String, RootResolver>(
                "book" to { a, _ -> books[a.str("id")] },
                "books" to { _, _ -> JsonArray(books.values.sortedBy { it.str("id") }) },
                "quiet" to { a, _ -> books[a.str("id")] },
                "shelf" to { _, _ -> buildJsonObject { put("items", JsonArray(books.values.sortedBy { it.str("id") })); put("hasMore", false) } },
            ) + queries,
            commands = commands,
            streams = streams,
        ),
        idempotency = idempotency,
        counters = counters,
    )

    // ---------------------------------------------------------------- references

    @Test
    fun `an op that refers to itself is refused before anything runs, rather than waiting for itself for ever`() = runTest(timeout = 5.seconds) {
        val s = server()
        assertEquals(
            listOf(obj("""{"error":{"code":"invalid_argument","message":"ops[0].args: ${'$'}ref to op 1 must point to an earlier op"},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"book","args":{"id":{"${'$'}ref":"1.id"}},"shape":"{ id }"}""")),
        )
        // guard: a reference to an earlier op is followed
        assertEquals(
            obj("""{"id":2,"data":{"$t":"Book","title":"Dune"},"meta":{"cost":1},"fin":true}"""),
            s.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}""", """{"id":2,"op":"book","args":{"id":{"${'$'}ref":"1.id"}},"shape":"{ title }"}""")).single { it.opId() == 2 },
        )
    }

    // ---------------------------------------------------------------- @live(false) and transports without live

    @Test
    fun `a query declared @live(false) cannot be opened live, and is answered when asked once (guard)`() = runTest(timeout = 5.seconds) {
        val s = server()
        assertEquals(
            listOf(obj("""{"error":{"code":"invalid_argument","message":"ops[0].live: quiet is declared @live(false)"},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"quiet","args":{"id":"b1"},"shape":"{ id }","live":true}""")),
        )
        assertEquals(listOf(obj("""{"id":1,"data":{"$t":"Book","id":"b1"},"meta":{"cost":1},"fin":true}""")), s.collect(batch("""{"id":1,"op":"quiet","args":{"id":"b1"},"shape":"{ id }"}""")))
        assertEquals(0, s.changes.size)
    }

    @Test
    fun `a transport that cannot notice a vanished client answers a live op unimplemented, and still answers plain queries (guard)`() = runTest(timeout = 5.seconds) {
        val s = server()
        val opts = ExecuteOptions(allowLive = false)
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"unimplemented","message":"Live queries are served over the WebSocket transport"},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }","live":true}"""), opts),
        )
        assertEquals(listOf(obj("""{"id":1,"data":{"$t":"Book","id":"b1"},"meta":{"cost":1},"fin":true}""")), s.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}"""), opts))
        assertEquals(0, s.changes.size)
    }

    // ---------------------------------------------------------------- deadlines and cancels

    @Test
    fun `a resolver sees isCancelled once its op's deadline has passed, and not before (guard)`() = runTest(timeout = 5.seconds) {
        val seen = CopyOnWriteArrayList<Boolean>()
        val s = server(queries = mapOf("book" to { _, ctx ->
            withContext(NonCancellable) { delay(100) } // work that does not stop by itself, as a blocking driver call
            seen.add(ctx.isCancelled())
            delay(1) // the next suspension is where the deadline ends the op
            books["b1"]
        }))
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"deadline_exceeded","message":"Op deadline exceeded"},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }","deadline":50}""")),
        )
        assertEquals(listOf(true), seen.toList())
        assertEquals(listOf(obj("""{"id":1,"data":{"$t":"Book","id":"b1"},"meta":{"cost":1},"fin":true}""")), s.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}""")))
        assertEquals(listOf(true, false), seen.toList())
    }

    @Test
    fun `an op whose own deadline passes ends deadline_exceeded even on a transport that can cancel it by id`() = runTest(timeout = 5.seconds) {
        val s = server(queries = mapOf("book" to { _, _ -> delay(1_000); books["b1"] }))
        val cancelOne = Job()
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"deadline_exceeded","message":"Op deadline exceeded"},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }","deadline":50}"""), ExecuteOptions(opCancel = mapOf(1 to cancelOne))),
        )
        assertEquals(50L, currentTime)
        // guard: completing the op's own cancel job is what ends it canceled
        val cancelTwo = Job()
        val run = async { s.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}"""), ExecuteOptions(opCancel = mapOf(1 to cancelTwo))) }
        runCurrent()
        cancelTwo.complete()
        assertEquals(listOf(obj("""{"id":1,"error":{"code":"canceled","message":"Canceled"},"fin":true}""")), run.await())
    }

    @Test
    fun `a command whose own deadline passes while it waits for an earlier one still holds the next command until the earlier one ends`() = runTest(timeout = 5.seconds) {
        val ran = CopyOnWriteArrayList<String>()
        val firstRunning = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        val s = RayfoldServer(
            SchemaText.load("entity A { id: ID } command one: A @idempotent(false) command two: A @idempotent(false) command three: A @idempotent(false)").ir,
            Resolvers(commands = mapOf(
                "one" to { _, _ -> ran.add("one"); firstRunning.complete(Unit); releaseFirst.await(); obj("""{"id":"1"}""") },
                "two" to { _, _ -> ran.add("two"); obj("""{"id":"2"}""") },
                "three" to { _, _ -> ran.add("three"); obj("""{"id":"3"}""") },
            )),
        )
        val frames = Channel<JsonObject>(Channel.UNLIMITED)
        val run = launch {
            try {
                s.execute(batch("""{"id":1,"op":"one","shape":"{ id }"}""", """{"id":2,"op":"two","shape":"{ id }","deadline":50}""", """{"id":3,"op":"three","shape":"{ id }"}"""), ExecuteOptions()).collect { frames.send(it) }
            } finally {
                frames.close()
            }
        }
        withTimeout(5_000) { firstRunning.await() }
        assertEquals(obj("""{"id":2,"error":{"code":"deadline_exceeded","message":"Op deadline exceeded"},"fin":true}"""), withTimeout(5_000) { frames.receive() })
        delay(1_000)
        assertEquals(listOf("one"), ran.toList(), "command 3 has not overtaken command 1, which is still running")
        releaseFirst.complete(Unit)
        withTimeout(5_000) { run.join() }
        assertEquals(listOf(1, 3), generateSequence { frames.tryReceive().getOrNull() }.map { it.opId() }.toList())
        assertEquals(listOf("one", "three"), ran.toList())
    }

    // ---------------------------------------------------------------- what the projection refuses

    @Test
    fun `a null result for a non-null return is an internal error, and a value is answered (guard)`() = runTest(timeout = 5.seconds) {
        val s = server()
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"internal","message":"Non-null result resolved to null","path":""},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"book","args":{"id":"b9"},"shape":"{ id }"}""")),
        )
        assertEquals(listOf(obj("""{"id":1,"data":{"$t":"Book","id":"b1"},"meta":{"cost":1},"fin":true}""")), s.collect(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }"}""")))
    }

    @Test
    fun `a null element in a list of non-null entities is an internal error at its index, and a full list is answered (guard)`() = runTest(timeout = 5.seconds) {
        val withHole = server(queries = mapOf("books" to { _, _ -> JsonArray(listOf(books.getValue("b1"), JsonNull)) }))
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"internal","message":"Non-null 1 resolved to null","path":"1"},"fin":true}""")),
            withHole.collect(batch("""{"id":1,"op":"books","shape":"{ id }"}""")),
        )
        assertEquals(listOf(obj("""{"id":1,"data":[{"$t":"Book","id":"b1"}],"meta":{"cost":1},"fin":true}""")), server().collect(batch("""{"id":1,"op":"books","shape":"{ id }"}""")))
    }

    @Test
    fun `a union value whose type is not a member is an internal error, and a member is answered (guard)`() = runTest(timeout = 5.seconds) {
        val s = server(queries = mapOf("hit" to { a, _ -> obj("""{"$t":"${a.str("id")}","id":"x1","name":"N","title":"T","stock":1}""") }))
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"internal","message":"Union Hit value at  lacks a valid $t","path":""},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"hit","args":{"id":"Sold"},"shape":"{ ...on Author { name } }"}""")),
        )
        assertEquals(
            listOf(obj("""{"id":1,"data":{"$t":"Author","name":"N"},"meta":{"cost":1},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"hit","args":{"id":"Author"},"shape":"{ ...on Author { name } }"}""")),
        )
    }

    @Test
    fun `a partial field whose loader fails reads null with an error at each parent, and the rest of the result stands`() = runTest(timeout = 5.seconds) {
        var failing = true
        val s = RayfoldServer(
            SchemaText.load("entity Book { id: ID bio: String? } query books: [Book]").ir,
            Resolvers(
                queries = mapOf("books" to { _, _ -> JsonArray(listOf(obj("""{"id":"b1"}"""), obj("""{"id":"b2"}"""))) }),
                fields = mapOf("Book" to mapOf("bio" to { ps, _, _ -> if (failing) throw RayfoldException(Code.UNAVAILABLE, "bios offline") else ps.map { JsonPrimitive("bio") } })),
            ),
        )
        val call = batch("""{"id":1,"op":"books","shape":"{ id bio @partial }"}""")
        assertEquals(
            listOf(obj("""{"id":1,"data":[{"$t":"Book","id":"b1","bio":null},{"$t":"Book","id":"b2","bio":null}],"errors":[{"code":"unavailable","message":"bios offline","path":"0.bio"},{"code":"unavailable","message":"bios offline","path":"1.bio"}],"meta":{"cost":1},"fin":true}""")),
            s.collect(call),
        )
        // guard: without @partial the same failure fails the op
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"unavailable","message":"bios offline","path":"0.bio"},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"books","shape":"{ id bio }"}""")),
        )
        failing = false
        assertEquals(listOf(obj("""{"id":1,"data":[{"$t":"Book","id":"b1","bio":"bio"},{"$t":"Book","id":"b2","bio":"bio"}],"meta":{"cost":1},"fin":true}""")), s.collect(call))
    }

    private val nested = SchemaText.load(
        """
        entity Secret @allow(read: false) { id: ID }
        entity Author { id: ID name: String bio: String @lazy }
        entity Shelf { id: ID secret: Secret? locked: Secret secrets: [Secret]? author: Author authors: [Author] }
        query shelf: Shelf
        """,
    ).ir

    private fun shelf(authors: JsonArray = JsonArray(listOf(obj("""{"id":"a1","name":"Ann"}""")))) = RayfoldServer(
        nested,
        Resolvers(
            queries = mapOf("shelf" to { _, _ -> obj("""{"id":"s1"}""") }),
            fields = mapOf(
                "Shelf" to mapOf(
                    "secret" to { ps, _, _ -> ps.map { obj("""{"id":"x1"}""") } },
                    "locked" to { ps, _, _ -> ps.map { obj("""{"id":"x2"}""") } },
                    "secrets" to { ps, _, _ -> ps.map { JsonArray(listOf(obj("""{"id":"x1"}"""))) } },
                    "author" to { ps, _, _ -> ps.map { obj("""{"id":"a1","name":"Ann"}""") } },
                    "authors" to { ps, _, _ -> ps.map { authors } },
                ),
                "Author" to mapOf("bio" to { ps, _, _ -> ps.map { JsonPrimitive("bio of Ann") } }),
            ),
        ),
    )

    @Test
    fun `a null inside a loaded list of non-null entities is an internal error at its index`() = runTest(timeout = 5.seconds) {
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"internal","message":"Non-null authors.1 resolved to null","path":"authors.1"},"fin":true}""")),
            shelf(JsonArray(listOf(obj("""{"id":"a1","name":"Ann"}"""), JsonNull))).collect(batch("""{"id":1,"op":"shelf","shape":"{ authors { name } }"}""")),
        )
        // guard: the same list without the hole is answered
        assertEquals(
            listOf(obj("""{"id":1,"data":{"$t":"Shelf","authors":[{"$t":"Author","name":"Ann"}]},"meta":{"cost":2},"fin":true}""")),
            shelf().collect(batch("""{"id":1,"op":"shelf","shape":"{ authors { name } }"}""")),
        )
    }

    @Test
    fun `a field asked for without a sub-shape gets its default view, which reads a denied entity as null rather than failing`() = runTest(timeout = 5.seconds) {
        assertEquals(
            listOf(obj("""{"id":1,"data":{"$t":"Shelf","id":"s1","secret":null},"meta":{"cost":2},"fin":true}""")),
            shelf().collect(batch("""{"id":1,"op":"shelf","shape":"{ id secret }"}""")),
        )
        // at a non-null position too: a default view never fails (spec 06 section 3)
        assertEquals(
            listOf(obj("""{"id":1,"data":{"$t":"Shelf","id":"s1","locked":null},"meta":{"cost":2},"fin":true}""")),
            shelf().collect(batch("""{"id":1,"op":"shelf","shape":"{ id locked }"}""")),
        )
        // guard: there an explicit sub-shape fails the op
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"permission_denied","message":"Not allowed to access Secret at locked","path":"locked"},"fin":true}""")),
            shelf().collect(batch("""{"id":1,"op":"shelf","shape":"{ id locked { id } }"}""")),
        )
        // guard: an explicit sub-shape on a nullable entity reads null too, and inside a list, where null would hide the
        // row's place, the denial fails the op
        assertEquals(
            listOf(obj("""{"id":1,"data":{"$t":"Shelf","id":"s1","secret":null},"meta":{"cost":2},"fin":true}""")),
            shelf().collect(batch("""{"id":1,"op":"shelf","shape":"{ id secret { id } }"}""")),
        )
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"permission_denied","message":"Not allowed to access Secret at secrets.0","path":"secrets.0"},"fin":true}""")),
            shelf().collect(batch("""{"id":1,"op":"shelf","shape":"{ id secrets { id } }"}""")),
        )
    }

    @Test
    fun `a lazy field in a default view under an explicit shape still arrives, in its own frame`() = runTest(timeout = 5.seconds) {
        assertEquals(
            listOf(
                obj("""{"id":1,"data":{"$t":"Shelf","id":"s1","author":{"$t":"Author","id":"a1","name":"Ann"}},"meta":{"cost":2}}"""),
                obj("""{"id":1,"at":"author","data":{"bio":"bio of Ann"}}"""),
                obj("""{"id":1,"fin":true}"""),
            ),
            shelf().collect(batch("""{"id":1,"op":"shelf","shape":"{ id author }"}""")),
        )
    }

    @Test
    fun `one field asked for twice with other arguments is loaded once for each, not answered from the first`() = runTest(timeout = 5.seconds) {
        val loads = CopyOnWriteArrayList<String>()
        val s = RayfoldServer(
            SchemaText.load("entity Author { id: ID titles(n: Int): [String] } query author: Author").ir,
            Resolvers(
                queries = mapOf("author" to { _, _ -> obj("""{"id":"a1"}""") }),
                fields = mapOf("Author" to mapOf("titles" to { ps, args, _ ->
                    val n = (args["n"] as JsonPrimitive).content.toInt()
                    loads.add("n=$n")
                    ps.map { JsonArray((1..n).map { JsonPrimitive("t$it") }) }
                })),
            ),
        )
        assertEquals(
            listOf(obj("""{"id":1,"data":{"$t":"Author","one":["t1"],"two":["t1","t2"]},"meta":{"cost":1},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"author","shape":"{ one: titles(n: 1) two: titles(n: 2) }"}""")),
        )
        assertEquals(listOf("n=1", "n=2"), loads.toList())
        // guard: the same arguments twice in one batch are loaded once
        loads.clear()
        s.collect(batch("""{"id":1,"op":"author","shape":"{ titles(n: 1) }"}""", """{"id":2,"op":"author","shape":"{ titles(n: 1) }"}"""))
        assertEquals(listOf("n=1"), loads.toList())
    }

    private val projection = SchemaText.load(
        """
        object Named @interface { name: String }
        entity Person implements Named { id: ID name: String nick: String? }
        object Box { id: ID n: Int label: String }
        entity Doc @allow(read: this.open == true) { id: ID open: Boolean body: String? }
        entity Mine @allow(read: viewer.id == "u1") { id: ID }
        entity Shelf2 { id: ID hit: Hit2 @lazy }
        union Hit2 = Person | Doc
        query people: [Person]
        query boxes: [Box]
        query docs: [Doc]
        query doc(id: ID): Doc?
        query mine: Mine?
        query shelf2: Shelf2
        """,
    ).ir

    private fun projector(parentsSeen: CopyOnWriteArrayList<List<String>> = CopyOnWriteArrayList()) = RayfoldServer(
        projection,
        Resolvers(
            queries = mapOf(
                "people" to { _, _ -> JsonArray(listOf(obj("""{"id":"p1","name":"Ada"}"""), obj("""{"id":"p1","name":"Ada"}"""), obj("""{"id":"p2","name":"Bo"}"""))) },
                "boxes" to { _, _ -> JsonArray(listOf(obj("""{"id":"x","n":1}"""), obj("""{"id":"x","n":2}"""))) },
                "docs" to { _, _ -> JsonArray(listOf(obj("""{"id":"d1","open":true}"""), obj("""{"id":"d2","open":false}"""))) },
                "doc" to { a, _ -> obj("""{"id":"${a.str("id")}","open":${a.str("id") == "d1"}}""") },
                "mine" to { _, _ -> obj("""{"id":"m1"}""") },
                "shelf2" to { _, _ -> obj("""{"id":"s1"}""") },
            ),
            fields = mapOf(
                "Person" to mapOf("nick" to { ps, _, _ -> parentsSeen.add(ps.map { it.str("id") }); ps.map { JsonPrimitive("nick of " + it.str("id")) } }),
                "Box" to mapOf("label" to { ps, _, _ -> ps.map { JsonPrimitive("box " + it.str("n")) } }),
                "Doc" to mapOf("body" to { ps, _, _ -> ps.map { JsonPrimitive("body of " + it.str("id")) } }),
                "Shelf2" to mapOf("hit" to { ps, _, _ -> ps.map { obj("""{"$t":"Person","id":"p9","name":"Cy"}""") } }),
            ),
        ),
    )

    @Test
    fun `an entity that appears twice at one level is loaded once, and an object is loaded for every place it appears`() = runTest(timeout = 5.seconds) {
        val seen = CopyOnWriteArrayList<List<String>>()
        assertEquals(
            listOf(obj("""{"id":1,"data":[{"$t":"Person","id":"p1","nick":"nick of p1"},{"$t":"Person","id":"p1","nick":"nick of p1"},{"$t":"Person","id":"p2","nick":"nick of p2"}],"meta":{"cost":1},"fin":true}""")),
            projector(seen).collect(batch("""{"id":1,"op":"people","shape":"{ id nick }"}""")),
        )
        assertEquals(listOf(listOf("p1", "p2")), seen.toList())
        // an object has no identity, so two with the same id are two values, each loaded
        assertEquals(
            listOf(obj("""{"id":1,"data":[{"label":"box 1"},{"label":"box 2"}],"meta":{"cost":1},"fin":true}""")),
            projector().collect(batch("""{"id":1,"op":"boxes","shape":"{ label }"}""")),
        )
    }

    @Test
    fun `one output name selected twice merges its sub-shapes and its modifiers, and with other arguments is refused`() = runTest(timeout = 5.seconds) {
        val s = projector()
        assertEquals(
            listOf(obj("""{"id":1,"data":[{"$t":"Person","id":"p1","name":"Ada"},{"$t":"Person","id":"p1","name":"Ada"},{"$t":"Person","id":"p2","name":"Bo"}],"meta":{"cost":1},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"people","shape":"{ id ...on Named { name } }"}""")),
            "a condition on an interface the entity implements selects its fields",
        )
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"invalid_argument","message":"Conflicting selections for t on Author"},"fin":true}""")),
            RayfoldServer(SchemaText.load("entity Author { id: ID titles(n: Int): [String] } query author: Author").ir, Resolvers(
                queries = mapOf("author" to { _, _ -> obj("""{"id":"a1"}""") }),
                fields = mapOf("Author" to mapOf("titles" to { ps, _, _ -> ps.map { JsonArray(emptyList()) } })),
            )).collect(batch("""{"id":1,"op":"author","shape":"{ t: titles(n: 1) t: titles(n: 2) }"}""")),
        )
        val nested = RayfoldServer(
            SchemaText.load("entity Author { id: ID name: String bio: String? } entity Book { id: ID author: Author } query book: Book").ir,
            Resolvers(
                queries = mapOf("book" to { _, _ -> obj("""{"id":"b1","author":{"id":"a1","name":"Ann"}}""") }),
                fields = mapOf("Author" to mapOf("bio" to { _, _, _ -> throw RayfoldException(Code.UNAVAILABLE, "bios offline") })),
            ),
        )
        assertEquals(
            listOf(obj("""{"id":1,"data":{"$t":"Book","author":{"$t":"Author","id":"a1","name":"Ann","bio":null}},"meta":{"cost":4},"errors":[{"code":"unavailable","message":"bios offline","path":"author.bio"}],"fin":true}""")),
            nested.collect(batch("""{"id":1,"op":"book","shape":"{ author { id } author { name bio } author { bio @partial } }"}""")),
            "the sub-shapes merge, and @partial on one of the selections makes the field partial",
        )
    }

    @Test
    fun `a read policy that needs a viewer reads an anonymous caller's entity as null, and a signed-in owner's as itself (guard)`() = runTest(timeout = 5.seconds) {
        val s = projector()
        assertEquals(listOf(obj("""{"id":1,"data":null,"meta":{"cost":1},"fin":true}""")), s.collect(batch("""{"id":1,"op":"mine","shape":"{ id }"}""")))
        assertEquals(listOf(obj("""{"id":1,"data":{"$t":"Mine","id":"m1"},"meta":{"cost":1},"fin":true}""")), s.collect(batch("""{"id":1,"op":"mine","shape":"{ id }"}"""), u1))
    }

    @Test
    fun `a deferred part is sent for an entity the viewer may see, and not for one the policy hid`() = runTest(timeout = 5.seconds) {
        assertEquals(
            listOf(obj("""{"id":1,"data":null,"meta":{"cost":1}}"""), obj("""{"id":1,"fin":true}""")),
            projector().collect(batch("""{"id":1,"op":"doc","args":{"id":"d2"},"shape":"{ id @defer { body } }"}""")),
        )
        // guard: the entity it may see gets its part
        assertEquals(
            listOf(
                obj("""{"id":1,"data":{"$t":"Doc","id":"d1"},"meta":{"cost":1}}"""),
                obj("""{"id":1,"at":"","data":{"body":"body of d1"}}"""),
                obj("""{"id":1,"fin":true}"""),
            ),
            projector().collect(batch("""{"id":1,"op":"doc","args":{"id":"d1"},"shape":"{ id @defer { body } }"}""")),
        )
    }

    @Test
    fun `a compact deferred part keeps the type of a union member inside it, which nothing else could tell`() = runTest(timeout = 5.seconds) {
        assertEquals(
            listOf(
                obj("""{"id":1,"data":{"id":"s1"}}"""),
                obj("""{"id":1,"at":"","data":{"hit":{"$t":"Person","name":"Cy"}}}"""),
                obj("""{"id":1,"fin":true}"""),
            ),
            projector().collect(batch("""{"id":1,"op":"shelf2","shape":"{ id hit { ...on Person { name } } }","compact":true}""")),
        )
    }

    @Test
    fun `a default view leaves out a scalar field that takes arguments, which only an explicit shape can supply`() = runTest(timeout = 5.seconds) {
        val s = RayfoldServer(
            SchemaText.load("entity P { id: ID price(currency: String): String } query p: P").ir,
            Resolvers(
                queries = mapOf("p" to { _, _ -> obj("""{"id":"p1"}""") }),
                fields = mapOf("P" to mapOf("price" to { ps, a, _ -> ps.map { JsonPrimitive("9 " + a.str("currency")) } })),
            ),
        )
        assertEquals(listOf(obj("""{"id":1,"data":{"$t":"P","id":"p1"},"meta":{"cost":1},"fin":true}""")), s.collect(batch("""{"id":1,"op":"p"}""")))
        // guard: asked for with its argument, it is answered
        assertEquals(
            listOf(obj("""{"id":1,"data":{"$t":"P","price":"9 EUR"},"meta":{"cost":1},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"p","shape":"{ price(currency: \"EUR\") }"}""")),
        )
    }

    // ---------------------------------------------------------------- what a command declares

    @Test
    fun `a domain error a command does not declare is internal, and one it declares reaches the client typed (guard)`() = runTest(timeout = 5.seconds) {
        var type = "Undeclared"
        val s = server(commands = mapOf("buy" to { _, _ -> throw RayfoldException.domain(type, buildJsonObject { put("available", 0) }, "none left") }))
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"internal","message":"buy raised undeclared error Undeclared"},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"buy","args":{"id":"b1"},"key":"$key"}"""), u1),
        )
        type = "OutOfStock"
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"domain","message":"none left","type":"OutOfStock","data":{"available":0}},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"buy","args":{"id":"b1"},"key":"${key}2"}"""), u1),
        )
    }

    @Test
    fun `an event a command does not declare fails it after the commit, and a declared one is published (guard)`() = runTest(timeout = 5.seconds) {
        var event = "Other"
        val heard = CopyOnWriteArrayList<JsonObject>()
        val s = server(commands = mapOf("buy" to { a, _ -> CommandResult(books[a.str("id")], emit = listOf(event to buildJsonObject { put("id", "b1") })) }))
        s.events.on("Other") { heard.add(it) }
        s.events.on("Sold") { heard.add(it) }
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"internal","message":"buy emitted undeclared event Other"},"fin":true}""")),
            s.collect(batch("""{"id":1,"op":"buy","args":{"id":"b1"},"key":"$key","shape":"{ id }"}"""), u1),
        )
        assertEquals(emptyList(), heard.toList())
        event = "Sold"
        assertEquals("b1", ((s.collect(batch("""{"id":1,"op":"buy","args":{"id":"b1"},"key":"${key}2","shape":"{ id }"}"""), u1).single()["ok"] as JsonObject).str("id")))
        assertEquals(listOf(obj("""{"id":"b1","seq":1}""")), heard.toList())
    }

    @Test
    fun `a command returning a list or a union that commits and then fails to answer still names its entities to live queries`() = runTest(timeout = 5.seconds) {
        // `title` is non-null and missing, so the answer fails after the write happened
        val s = server(commands = mapOf(
            "buyAll" to { _, _ -> JsonArray(listOf(obj("""{"id":"b1"}"""), obj("""{"id":"b2"}"""))) },
            "pick" to { _, _ -> obj("""{"$t":"Book","id":"b3"}""") },
        ))
        val changes = CopyOnWriteArrayList<Change>()
        val off = s.changes.subscribe { changes.add(it) }
        assertEquals("internal", s.collect(batch("""{"id":1,"op":"buyAll","shape":"{ id title }"}""")).single().errorCode())
        assertEquals("internal", s.collect(batch("""{"id":1,"op":"pick","shape":"{ ...on Book { id title } }"}""")).single().errorCode())
        assertEquals(listOf(Change(setOf("Book:b1", "Book:b2"), emptySet()), Change(setOf("Book:b3"), emptySet())), changes.toList())
        off()
    }

    // ---------------------------------------------------------------- idempotency keys

    @Test
    fun `an idempotency key is 16 to 128 characters, both ends included`() = runTest(timeout = 5.seconds) {
        val runs = AtomicInteger()
        val s = server(commands = mapOf("buy" to { a, _ -> runs.incrementAndGet(); books[a.str("id")] }))
        val refused = obj("""{"id":1,"error":{"code":"invalid_argument","message":"buy(): commands require an idempotency key of 16-128 characters"},"fin":true}""")
        for (n in listOf(15, 129)) assertEquals(listOf(refused), s.collect(batch("""{"id":1,"op":"buy","args":{"id":"b1"},"key":"${"k".repeat(n)}","shape":"{ id }"}"""), u1), "a key of $n")
        assertEquals(0, runs.get())
        for (n in listOf(16, 128)) {
            assertEquals(listOf(obj("""{"id":1,"ok":{"$t":"Book","id":"b1"},"patch":[{"set":"Book:b1","value":{"$t":"Book","id":"b1"}}],"meta":{"cost":1},"fin":true}""")),
                s.collect(batch("""{"id":1,"op":"buy","args":{"id":"b1"},"key":"${"k".repeat(n)}","shape":"{ id }"}"""), u1), "a key of $n")
        }
        assertEquals(2, runs.get())
    }

    /** A store behind a database: it cannot wake a waiter, so every wait runs to its end. Records how long each was. */
    private class Sleeping(private val inner: IdempotencyStore) : IdempotencyStore by inner {
        val waits = CopyOnWriteArrayList<Long>()

        override suspend fun awaitSettled(scope: String, key: String, timeoutMs: Long) {
            waits.add(timeoutMs)
            delay(timeoutMs)
        }
    }

    @Test
    fun `a retry waiting on a held key backs off 50, 100, 200, 400, then 500 ms between claims`() = runTest(timeout = 5.seconds) {
        val gate = CompletableDeferred<Unit>()
        val runs = AtomicInteger()
        val store = Sleeping(MemoryIdempotencyStore())
        val s = server(commands = mapOf("buy" to { a, _ -> runs.incrementAndGet(); gate.await(); books[a.str("id")] }), idempotency = store)
        val call = batch("""{"id":1,"op":"buy","args":{"id":"b1"},"key":"$key","shape":"{ id }"}""")
        val first = async { s.collect(call, u1) }
        runCurrent()
        val second = async { s.collect(call, u1) }
        launch { delay(1_300); gate.complete(Unit) }
        val answers = first.await() + second.await()
        assertEquals(listOf(50L, 100L, 200L, 400L, 500L, 500L), store.waits.toList())
        assertEquals(1_750L, currentTime, "the claim after the last wait found the answer")
        assertEquals(1, runs.get())
        assertEquals(listOf(null, JsonPrimitive(true)), answers.map { (it["meta"] as? JsonObject)?.get("replay") })
    }

    @Test
    fun `a replayed failure fails the ops that depend on it, as the first run's did`() = runTest(timeout = 5.seconds) {
        // the command commits, then its answer fails (`title` is missing): the failure is what a retry replays
        val s = server(commands = mapOf("buy" to { _, _ -> obj("""{"id":"b1"}""") }))
        val call = batch("""{"id":1,"op":"buy","args":{"id":"b1"},"key":"$key","shape":"{ id title }"}""", """{"id":2,"op":"book","args":{"id":{"${'$'}ref":"1.id"}},"shape":"{ id }"}""")
        val failed = obj("""{"id":1,"error":{"code":"internal","message":"Non-null field Book.title resolved to null","path":"title"},"fin":true}""")
        val dependent = obj("""{"id":2,"error":{"code":"failed_precondition","message":"Depends on op 1, which failed","type":"DependencyFailed","data":{"op":1}},"fin":true}""")
        assertEquals(listOf(failed, dependent), s.collect(call, u1).sortedBy { it.opId() })
        assertEquals(listOf(JsonObject(failed + ("meta" to obj("""{"replay":true}"""))), dependent), s.collect(call, u1).sortedBy { it.opId() })
    }

    @Test
    fun `a retry that writes a number or a viewer's number another way replays, as every runtime hashes them alike`() = runTest(timeout = 5.seconds) {
        val runs = AtomicInteger()
        val s = server(commands = mapOf("reprice" to { a, _ -> runs.incrementAndGet(); books[a.str("id")] }))
        fun call(amount: String) = batch("""{"id":1,"op":"reprice","args":{"id":"b1","amount":$amount},"key":"$key","shape":"{ id }"}""")
        val first = s.collect(call("2.50"), obj("""{"id":"u1","tier":2.0}""")).single()
        assertEquals(obj("""{"id":1,"ok":{"$t":"Book","id":"b1"},"patch":[{"set":"Book:b1","value":{"$t":"Book","id":"b1"}}],"meta":{"cost":1},"fin":true}"""), first)
        val retry = s.collect(call("2.5"), obj("""{"tier":2,"id":"u1"}""")).single()
        assertEquals(JsonObject(first + ("meta" to obj("""{"cost":1,"replay":true}"""))), retry)
        assertEquals(1, runs.get())
        // guard: another amount under the same key is another binding, refused rather than replayed
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"already_exists","message":"Idempotency key $key was used for another operation or other arguments"},"fin":true}""")),
            s.collect(call("2.51"), obj("""{"id":"u1","tier":2}""")),
        )
        assertEquals(1, runs.get())
    }

    // ---------------------------------------------------------------- counters

    @Test
    fun `a failed op is counted under its code and its error type`() = runTest(timeout = 5.seconds) {
        val counters = MemoryCounters()
        val s = server(commands = mapOf("buy" to { _, _ -> throw RayfoldException.domain("OutOfStock", buildJsonObject { put("available", 0) }, "none left") }), counters = counters)
        s.collect(batch("""{"id":1,"op":"buy","args":{"id":"b1"},"key":"$key"}"""), u1)
        s.collect(batch("""{"id":1,"op":"book","args":{"id":"b9"},"shape":"{ id }"}"""))
        assertEquals(
            listOf(
                CounterEntry("rayfold.errors", mapOf("op" to "buy", "code" to "domain", "type" to "OutOfStock"), 1),
                CounterEntry("rayfold.errors", mapOf("op" to "book", "code" to "internal", "type" to ""), 1),
            ),
            counters.snapshot().filter { it.name == "rayfold.errors" },
        )
    }

    // ---------------------------------------------------------------- live queries and streams

    @Test
    fun `a live re-run's NaN goes out as null in its patch, as the first frame's does`() = runTest(timeout = 5.seconds) {
        val s = server()
        val cancel = Job()
        val frames = Channel<JsonObject>(Channel.UNLIMITED)
        val job = launch {
            try { s.execute(batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id x }","live":true}"""), ExecuteOptions(cancel = cancel)).collect { frames.send(it) } } finally { frames.close() }
        }
        assertEquals(obj("""{"id":1,"data":{"$t":"Book","id":"b1","x":1.5},"meta":{"cost":1}}"""), withTimeout(5_000) { frames.receive() })
        books["b1"] = JsonObject(books.getValue("b1") + ("x" to JsonPrimitive(Double.NaN)))
        s.changes.publish(Change(setOf("Book:b1"), emptySet()))
        val patch = withTimeout(5_000) { frames.receive() }
        assertEquals(obj("""{"id":1,"patch":[{"set":"Book:b1","value":{"x":null}}]}"""), Json.parseToJsonElement(patch.toString()))
        cancel.complete()
        job.join()
        assertEquals(0, s.changes.size)
    }

    @Test
    fun `a live page re-runs when an entity of its item type appears, though its read set did not hold it`() = runTest(timeout = 5.seconds) {
        val s = server()
        val cancel = Job()
        val frames = Channel<JsonObject>(Channel.UNLIMITED)
        val job = launch {
            try { s.execute(batch("""{"id":1,"op":"shelf","args":{"page":{"first":10}},"shape":"{ items { id } }","live":true}"""), ExecuteOptions(cancel = cancel)).collect { frames.send(it) } } finally { frames.close() }
        }
        assertEquals(obj("""{"id":1,"data":{"items":[{"$t":"Book","id":"b1"}]},"meta":{"cost":12}}"""), withTimeout(5_000) { frames.receive() })
        books["b2"] = obj("""{"id":"b2","title":"Kindred","stock":5}""")
        s.changes.publish(Change(setOf("Book:b2"), emptySet()))
        assertEquals(obj("""{"id":1,"data":{"items":[{"$t":"Book","id":"b1"},{"$t":"Book","id":"b2"}]},"meta":{"cost":12}}"""), withTimeout(5_000) { frames.receive() })
        // guard: a change to a type the page cannot hold re-runs nothing
        s.changes.publish(Change(setOf("Author:a1"), emptySet()))
        advanceUntilIdle()
        assertEquals(true, frames.isEmpty)
        cancel.complete()
        job.join()
        assertEquals(0, s.changes.size)
    }

    @Test
    fun `a stream that stops stops hearing its events, and one that is open hears them (guard)`() = runTest(timeout = 5.seconds) {
        val handled = AtomicInteger()
        val subscribed = Channel<Unit>(Channel.UNLIMITED)
        val s = server(
            commands = mapOf("buy" to { a, _ -> CommandResult(books[a.str("id")], emit = listOf("Sold" to buildJsonObject { put("id", a.str("id")) })) }),
            streams = mapOf("sold" to { _, ctx ->
                callbackFlow<JsonElement> {
                    val off = ctx.events.on("Sold") { p -> handled.incrementAndGet(); trySend(p) }
                    subscribed.send(Unit)
                    awaitClose { off() }
                }
            }),
        )
        val cancel = Job()
        val frames = Channel<JsonObject>(Channel.UNLIMITED)
        val job = launch {
            try { s.execute(batch("""{"id":1,"op":"sold"}"""), ExecuteOptions(cancel = cancel)).collect { frames.send(it) } } finally { frames.close() }
        }
        withTimeout(5_000) { subscribed.receive() }
        s.collect(batch("""{"id":1,"op":"buy","args":{"id":"b1"},"key":"$key","shape":"{ id }"}"""), u1)
        assertEquals(obj("""{"id":1,"item":{"id":"b1"}}"""), withTimeout(5_000) { frames.receive() })
        cancel.complete()
        job.join()
        s.collect(batch("""{"id":1,"op":"buy","args":{"id":"b1"},"key":"${key}2","shape":"{ id }"}"""), u1)
        assertEquals(1, handled.get(), "the second sale reached no handler of the stopped stream")
    }

    @Test
    fun `a live query opened on a server already draining ends unavailable at once, without a first result`() = runTest(timeout = 5.seconds) {
        val s = server()
        val open = batch("""{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id }","live":true}""")
        // guard: before the drain the same op opens and answers
        val cancel = Job()
        val first = Channel<JsonObject>(Channel.UNLIMITED)
        val job = launch { s.execute(open, ExecuteOptions(cancel = cancel)).collect { first.send(it) } }
        assertEquals(obj("""{"id":1,"data":{"$t":"Book","id":"b1"},"meta":{"cost":1}}"""), withTimeout(5_000) { first.receive() })
        cancel.complete()
        job.join()
        s.drain(1_000)
        assertEquals(
            listOf(obj("""{"id":1,"error":{"code":"unavailable","message":"The server is shutting down"},"fin":true}""")),
            s.collect(open, ExecuteOptions(cancel = Job())),
        )
        assertEquals(0, s.changes.size)
    }

    @Test
    fun `a live query of a generic object hears a new entity of the type it is applied to`() = runTest(timeout = 5.seconds) {
        // a generic object other than Page reaches its type argument only through the arguments (an IR may declare one)
        val box = TypeDef(kind = "object", name = "Box", typeParams = listOf("T"), fields = listOf(FieldDef(name = "items", type = TypeRef(kind = "list", of = TypeRef(kind = "named", name = "T")), ordinal = 1)))
        val ir = schema.copy(
            types = schema.types + ("Box" to box),
            ops = schema.ops + ("boxed" to OpDef(kind = "query", name = "boxed", returns = TypeRef(kind = "named", name = "Box", args = listOf(TypeRef(kind = "named", name = "Book"))))),
        )
        val s = RayfoldServer(ir, Resolvers(queries = mapOf("boxed" to { _, _ -> buildJsonObject { put("items", JsonArray(books.values.sortedBy { it.str("id") })) } })))
        val cancel = Job()
        val frames = Channel<JsonObject>(Channel.UNLIMITED)
        val job = launch {
            try { s.execute(batch("""{"id":1,"op":"boxed","shape":"{ items { id } }","live":true}"""), ExecuteOptions(cancel = cancel)).collect { frames.send(it) } } finally { frames.close() }
        }
        assertEquals(obj("""{"id":1,"data":{"items":[{"$t":"Book","id":"b1"}]},"meta":{"cost":2}}"""), withTimeout(5_000) { frames.receive() })
        books["b2"] = obj("""{"id":"b2","title":"Kindred","stock":5}""")
        s.changes.publish(Change(setOf("Book:b2"), emptySet()))
        assertEquals(obj("""{"id":1,"data":{"items":[{"$t":"Book","id":"b1"},{"$t":"Book","id":"b2"}]},"meta":{"cost":2}}"""), withTimeout(5_000) { frames.receive() })
        cancel.complete()
        job.join()
        assertEquals(0, s.changes.size)
    }
}
