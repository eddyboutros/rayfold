package dev.rayfold.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import org.junit.jupiter.api.assertThrows
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The published vectors under `conformance/vectors`, run against this runtime.
 *
 * A vector is not a fixture: a fixture is a request and the frames it must produce, a vector is a pure function and
 * the answer the specification says it has. They are written from the specification rather than captured from a
 * runtime, because a vector taken from an implementation proves only that the implementations agree - and two
 * implementations can agree on the same wrong answer.
 *
 * `packages/schema/src/vectors.test.ts` runs the identical files on the TypeScript side.
 */
class VectorsTest {
    private val root = File(System.getProperty("rayfold.vectors") ?: "../conformance/vectors")

    private fun area(name: String): List<Pair<String, JsonObject>> {
        val dir = File(root, name)
        val files = dir.listFiles()?.filter { it.name.endsWith(".json") }?.sortedBy { it.name }
            ?: error("no vector directory at ${dir.absolutePath}")
        return files.map { it.name to Json.parseToJsonElement(it.readText()).jsonObject }
    }

    @TestFactory
    fun numbers(): List<DynamicTest> {
        val out = mutableListOf<DynamicTest>()
        for ((file, doc) in area("numbers")) {
            for (case in doc["cases"]?.jsonArray ?: error("$file has no cases")) {
                val c = case.jsonObject
                val name = c["name"]?.jsonPrimitive?.content ?: error("$file has a case without a name")
                val literal = c["literal"]?.jsonPrimitive?.content ?: error("$name has no literal")
                val expected = c["canonical"]?.jsonPrimitive?.content ?: error("$name has no canonical form")
                out.add(
                    DynamicTest.dynamicTest("numbers/$file: $name") {
                        // the literal is text so the vector keeps it exactly as a client would send it; parsing is
                        // part of what is under test, since it is where 2.50 and 2.5 become one number
                        val parsed = Json.parseToJsonElement(literal).jsonPrimitive.content
                        assertEquals(expected, Canonical.number(parsed), c["why"]?.jsonPrimitive?.content ?: name)
                    },
                )
            }
        }
        assertTrue(out.size > 10, "no number vectors were found under ${root.absolutePath}")
        return out
    }

    /**
     * The manifest contract (spec 04 section 4a), against a real server. The document is not a pure function, so the
     * vector pins which members exist and the rules relating them; the values depend on the schema.
     */
    @Test
    fun manifest() {
        val contract = Json.parseToJsonElement(File(File(root, "manifest"), "document.json").readText()).jsonObject
        val named = (contract["members"] ?: error("no members")).jsonArray.map { it.jsonObject.str("name") }

        val schema = """
            entity Book { id: ID title: String costPrice: Decimal? @allow(read: viewer.role == "admin") }
            query book(id: ID): Book?
        """.trimIndent()
        val server = RayfoldServer(SchemaText.load(schema).ir, Resolvers(queries = mapOf("book" to { _, _ -> null })))
        val http = RayfoldHttp(server) { JsonNull }.start(0)
        try {
            val port = http.address.port
            val text = java.net.URI("http://127.0.0.1:$port/rayfold/manifest").toURL().readText()
            val body = Json.parseToJsonElement(text).jsonObject

            assertEquals(named.sorted(), body.keys.sorted(), "the manifest must serve exactly the members spec 04 section 4a names")
            val hash = body["schemaHash"]?.jsonPrimitive?.content
            assertTrue(hash != null && Regex("^[0-9a-f]{64}$").matches(hash), "schemaHash is bare lower-case hex, not a prefixed shape id: was $hash")
            val limits = body["limits"]?.jsonObject ?: error("no limits")
            val keys = (contract.req("members").jsonArray.first { it.jsonObject.str("name") == "limits" }).jsonObject.req("keys").jsonArray
            for (k in keys) assertTrue(limits.containsKey(k.jsonPrimitive.content), "limits.${k.jsonPrimitive.content} is missing")
        } finally {
            http.stop(0)
        }
    }

    @TestFactory
    fun hashing(): List<DynamicTest> {
        val out = mutableListOf<DynamicTest>()
        for ((file, doc) in area("hashing")) {
            // hashing/ holds more than one kind of file: schema.json carries cases, not bindings and scopes
            for (case in doc["bindings"]?.jsonArray ?: emptyList()) {
                val c = case.jsonObject
                val name = c["name"]?.jsonPrimitive?.content ?: error("$file has a binding without a name")
                val why = c["why"]?.jsonPrimitive?.content ?: name
                out.add(
                    DynamicTest.dynamicTest("hashing/$file: binding: $name") {
                        val bound = buildJsonObject {
                            put("op", c.str("op"))
                            put("args", c.req("args"))
                        }
                        // Canonical.hashed is the number-normalising form spec 12 section 4.2 requires here, and
                        // only here; the canonical text is asserted too, so a mismatch says which half is wrong
                        assertEquals(c["canonical"]?.jsonPrimitive?.content, Canonical.hashed(bound), why)
                        assertEquals(c["hash"]?.jsonPrimitive?.content, sha256(Canonical.hashed(bound)), why)
                    },
                )
            }
            for (case in doc["scopes"]?.jsonArray ?: emptyList()) {
                val c = case.jsonObject
                val name = c["name"]?.jsonPrimitive?.content ?: error("$file has a scope without a name")
                val why = c["why"]?.jsonPrimitive?.content ?: name
                out.add(
                    DynamicTest.dynamicTest("hashing/$file: scope: $name") {
                        val viewer = c["viewer"] ?: JsonNull
                        assertEquals(c["canonical"]?.jsonPrimitive?.content, Canonical.hashed(viewer), why)
                        assertEquals(c["hash"]?.jsonPrimitive?.content, sha256(Canonical.hashed(viewer)), why)
                    },
                )
            }
        }
        assertTrue(out.size > 5, "no hashing vectors were found under ${root.absolutePath}")
        return out
    }

    /**
     * `hashing/schema.json`: the schema hash, which is the protocol's identity - what the manifest publishes and
     * what the `Rayfold-Schema` header carries. The hashes in that file were built by hand from spec 01 sections 9
     * and 9.1a, so this is the JVM checked against the document rather than against the other runtime.
     *
     * `documentCases` are stated over the IR document instead of over schema text, because no schema text produces
     * an `extensions` member. A runtime whose IR cannot hold the member passes the hash half by accident, so the
     * case asserts the member survives a load as well.
     */
    @TestFactory
    fun schemaHash(): List<DynamicTest> {
        val doc = Json.parseToJsonElement(File(File(root, "hashing"), "schema.json").readText()).jsonObject
        val cases = doc.req("cases").jsonArray.map { it.jsonObject }
        fun schemaOf(name: String) = cases.first { it.str("name") == name }.str("schema")
        fun hashOf(schema: String) = SchemaText.load(schema).hash

        val out = mutableListOf<DynamicTest>()
        for (c in cases) {
            val name = c.str("name")
            val why = c["why"]?.jsonPrimitive?.content ?: name
            out.add(
                DynamicTest.dynamicTest("hashing/schema: $name") {
                    val schema = c.str("schema")
                    c["hash"]?.jsonPrimitive?.content?.let { assertEquals(it, hashOf(schema), why) }
                    c["canonicalBytes"]?.jsonPrimitive?.content?.toInt()?.let {
                        assertEquals(it, Canonical.json(IrJson.of(SchemaText.load(schema).ir)).length, "the canonical IR is this many bytes")
                    }
                    c["differsFrom"]?.jsonPrimitive?.content?.let {
                        assertTrue(hashOf(schema) != hashOf(schemaOf(it)), why)
                    }
                },
            )
        }
        for (case in doc.req("documentCases").jsonArray) {
            val c = case.jsonObject
            val name = c.str("name")
            out.add(
                DynamicTest.dynamicTest("hashing/schema: $name") {
                    val loaded = SchemaText.load(c.str("schema"))
                    val vendor = c.req("extensions").jsonObject
                    val withVendor = loaded.ir.copy(extensions = vendor)
                    assertEquals(vendor, withVendor.extensions, "the member survives on the document")
                    // and survives a round trip through the document form, which is where it used to be dropped
                    assertEquals(vendor, RayfoldSchemaIR.parse(irWithExtensions(withVendor)).extensions, "the member survives a load")
                    assertEquals(hashOf(schemaOf(c.str("sameAs"))), SchemaText.hash(withVendor), c["why"]?.jsonPrimitive?.content ?: name)
                },
            )
        }
        assertTrue(out.size > 3, "no schema-hash vectors were found under ${root.absolutePath}")
        return out
    }

    /** The document form of [ir] including `extensions`, which the hashed form of [IrJson.of] leaves out by rule. */
    private fun irWithExtensions(ir: RayfoldSchemaIR): String =
        JsonObject(IrJson.of(ir) + ("extensions" to (ir.extensions ?: JsonObject(emptyMap())))).toString()

    /**
     * The denial table of spec 06 section 3, run against a real server. The expectation is the table, not either
     * runtime: the two disagreed on the list-element row, and the table is what decided which was right.
     */
    @TestFactory
    fun authorization(): List<DynamicTest> {
        val doc = Json.parseToJsonElement(File(File(root, "authorization"), "denial-outcomes.json").readText()).jsonObject
        val ir = SchemaText.load(doc.str("schema")).ir
        val secret = buildJsonObject { put("id", "s1"); put("code", "hunter2") }
        val note = buildJsonObject { put("id", "n1"); put("title", "A note"); put("owner", "u9"); put("sometimes", "s") }

        fun server() = RayfoldServer(
            ir,
            Resolvers(
                queries = mapOf(
                    "note" to { _, _ -> note },
                    "adminOnly" to { _, _ -> note },
                    "box" to { _, _ -> buildJsonObject { put("id", "b1") } },
                    "boxWithGap" to { _, _ -> buildJsonObject { put("id", "b1") } },
                ),
                fields = mapOf(
                    "Note" to mapOf(
                        "secret" to { parents: List<JsonObject>, _: JsonObject, _: RayfoldContext -> parents.map { secret } },
                        "mustHave" to { parents: List<JsonObject>, _: JsonObject, _: RayfoldContext -> parents.map { secret } },
                    ),
                    "Box" to mapOf(
                        "items" to { parents: List<JsonObject>, _: JsonObject, _: RayfoldContext -> parents.map { JsonArray(listOf(secret)) } },
                        // one list holds a denied entity, the other a real gap, so the denial rule can be told apart
                        "maybe" to { parents: List<JsonObject>, _: JsonObject, _: RayfoldContext -> parents.map { JsonArray(listOf(secret)) } },
                    ),
                ),
            ),
        )

        val out = mutableListOf<DynamicTest>()
        for (case in doc.req("cases").jsonArray) {
            val c = case.jsonObject
            val name = c.str("name")
            // the gap case needs a resolver that returns a null element; it is covered on the TypeScript side, and
            // the JVM's own LiveDiffTest covers null elements, so it is skipped rather than given a second server
            if (c.str("expect") == "nullElement") continue
            out.add(
                DynamicTest.dynamicTest("authorization/$name") {
                    val viewer = if (c.containsKey("viewer")) c.req("viewer") else doc.req("viewer")
                    val shape = c["shape"]?.jsonPrimitive?.content
                    val op = buildJsonObject {
                        put("id", 1); put("op", c.str("op"))
                        put("args", buildJsonObject { put("id", if (c.str("op").startsWith("box")) "b1" else "n1") })
                        shape?.let { put("shape", it) }
                    }
                    val frames = runBlocking { server().collect(buildJsonObject { put("ops", JsonArray(listOf(op))) }, viewer) }
                    val error = frames.firstOrNull { (it as? JsonObject)?.containsKey("error") == true } as? JsonObject
                    val why = c["why"]?.jsonPrimitive?.content ?: name
                    val expect = c.str("expect")
                    if (expect == "error") {
                        assertEquals(c.str("code"), (error?.get("error") as? JsonObject)?.get("code")?.jsonPrimitive?.content, why)
                        return@dynamicTest
                    }
                    assertTrue(error == null, "$why: expected no error, got $error")
                    val frame = frames.single { it.containsKey("data") }
                    val data = frame.req("data").jsonObject
                    val errors = (frame["errors"] as? JsonArray)?.map { it.jsonObject } ?: emptyList()
                    when (expect) {
                        "null" -> {
                            assertEquals(JsonNull, data[c.str("at")], "$why: a denied entity at a nullable position reads as null")
                            // absence carries no error, or the error itself would say the entity exists
                            assertEquals(emptyList(), errors, why)
                        }
                        "omitted" -> {
                            assertTrue(c.str("field") !in data, "$why: ${c.str("field")} was served: $data")
                            assertEquals(emptyList(), errors, why)
                        }
                        "partial" -> {
                            val field = c.str("field")
                            assertEquals(buildJsonObject { put("\$type", "Note"); put("id", "n1"); put(field, JsonNull) }, data, why)
                            assertEquals(1, errors.size, "$why: $errors")
                            assertEquals(field, errors[0].str("path"), why)
                            assertEquals("permission_denied", errors[0].str("code"), why)
                        }
                        "ok" -> {
                            assertEquals(buildJsonObject { put("\$type", "Note"); put("id", "n1"); put("title", "A note") }, data, why)
                            assertEquals(emptyList(), errors, why)
                        }
                        else -> error("$name: no assertion for expect=$expect")
                    }
                },
            )
        }
        assertTrue(out.size > 5, "no authorization vectors were found under ${root.absolutePath}")
        return out
    }

    /**
     * The status each error code derives (spec 05 section 3). A proxy routes on this and a client branches on it, so
     * two runtimes that map a code differently are not interchangeable. The problem-document-or-frame half of the
     * area needs a server and is covered by the TypeScript runner and by HttpTest here.
     */
    @TestFactory
    fun errors(): List<DynamicTest> {
        val doc = Json.parseToJsonElement(File(File(root, "errors"), "statuses-and-problems.json").readText()).jsonObject
        val out = mutableListOf<DynamicTest>()
        for (case in doc.req("statuses").jsonArray) {
            val c = case.jsonObject
            val name = c.str("code")
            val expected = c.str("status").toInt()
            out.add(
                DynamicTest.dynamicTest("errors/$name is $expected") {
                    val code = Code.entries.first { it.wire == name }
                    assertEquals(expected, Guard.status(code), c["why"]?.jsonPrimitive?.content ?: name)
                },
            )
        }
        assertTrue(out.size > 10, "no error vectors were found under ${root.absolutePath}")
        return out
    }

    /**
     * The published idempotency vectors, against a real server. Each operation is a separate batch, because a retry
     * is a second request; `runs` is what separates a replay from a command that ran twice and answered the same.
     */
    @TestFactory
    fun idempotency(): List<DynamicTest> {
        val doc = Json.parseToJsonElement(File(File(root, "idempotency"), "keys-and-replays.json").readText()).jsonObject
        val ir = SchemaText.load(doc.str("schema")).ir
        val defaultViewer = buildJsonObject { put("id", "u1") }

        val out = mutableListOf<DynamicTest>()
        for (case in doc.req("cases").jsonArray) {
            val c = case.jsonObject
            val name = c.str("name")
            val why = c["why"]?.jsonPrimitive?.content ?: name
            out.add(
                DynamicTest.dynamicTest("idempotency/$name") {
                    var runs = 0
                    val stock = java.util.concurrent.atomic.AtomicInteger(3)
                    val bump = command { args: JsonObject, _: RayfoldContext ->
                        runs++
                        val qty = args["qty"]?.jsonPrimitive?.content?.toIntOrNull() ?: 1
                        CommandResult(buildJsonObject { put("id", "b1"); put("stock", stock.addAndGet(qty)) })
                    }
                    val server = RayfoldServer(ir, Resolvers(commands = mapOf("restock" to bump, "other" to bump, "free" to bump)))

                    val answers = mutableListOf<List<JsonObject>>()
                    for (o in c.req("ops").jsonArray) {
                        val op = o.jsonObject
                        val viewer = if (op.containsKey("viewer")) op.req("viewer") else defaultViewer
                        val env = buildJsonObject {
                            put(
                                "ops",
                                JsonArray(listOf(buildJsonObject {
                                    put("id", 1); put("op", op.str("op")); put("args", op.req("args"))
                                    op["key"]?.let { put("key", it.jsonPrimitive.content) }
                                })),
                            )
                        }
                        answers.add(runBlocking { server.collect(env, viewer) })
                    }
                    val last = answers.last()
                    val error = last.firstOrNull { it.containsKey("error") }?.get("error") as? JsonObject
                    val okFrame = last.firstOrNull { it.containsKey("ok") }
                    val replayed = ((okFrame?.get("meta") as? JsonObject)?.get("replay") as? JsonPrimitive)?.content == "true"

                    when (c.str("expect")) {
                        "error" -> assertEquals(c.str("code"), error?.get("code")?.jsonPrimitive?.content, why)
                        "replay" -> {
                            assertTrue(error == null, "$why: $error")
                            assertEquals(answers.first().firstOrNull { it.containsKey("ok") }?.get("ok"), okFrame?.get("ok"), why)
                            assertEquals(stocked(4), okFrame?.get("ok"), why)
                        }
                        "replayMeta" -> {
                            assertTrue(error == null, "$why: $error")
                            assertTrue(replayed, "$why: meta.replay was not set on the retry")
                            // replayed and not re-run: the first answer is the stock after one restock
                            assertEquals(stocked(4), okFrame?.get("ok"), why)
                        }
                        "bothRan" -> {
                            assertTrue(error == null, "$why: $error")
                            assertTrue(!replayed, "$why: the second caller got a replay of the first caller's answer")
                            assertEquals(stocked(5), okFrame?.get("ok"), why)
                        }
                        "ok" -> {
                            assertTrue(error == null, "$why: $error")
                            assertTrue(!replayed, "$why: a first call is not a replay")
                            assertEquals(stocked(4), okFrame?.get("ok"), why)
                        }
                        else -> error("$name: no assertion for expect=${c.str("expect")}")
                    }
                    c["runs"]?.let { assertEquals(it.jsonPrimitive.content.toInt(), runs, "$why: the resolver ran $runs times") }
                },
            )
        }
        assertTrue(out.size > 5, "no idempotency vectors were found under ${root.absolutePath}")
        return out
    }

    @TestFactory
    fun canonicalization(): List<DynamicTest> {
        val out = mutableListOf<DynamicTest>()
        for ((file, doc) in area("canonicalization")) {
            for (case in doc["cases"]?.jsonArray ?: error("$file has no cases")) {
                val c = case.jsonObject
                val name = c["name"]?.jsonPrimitive?.content ?: error("$file has a case without a name")
                val json = c["json"]?.jsonPrimitive?.content ?: error("$name has no json")
                val expected = c["canonical"]?.jsonPrimitive?.content ?: error("$name has no canonical form")
                out.add(
                    DynamicTest.dynamicTest("canonicalization/$file: $name") {
                        // Canonical.json is the form the schema hash is taken over (spec 01 section 9); the number
                        // normalisation of spec 12 section 4.2 is Canonical.hashed, and numbers/ covers that
                        assertEquals(expected, Canonical.json(Json.parseToJsonElement(json)), c["why"]?.jsonPrimitive?.content ?: name)
                    },
                )
            }
        }
        assertTrue(out.size > 10, "no canonicalization vectors were found under ${root.absolutePath}")
        return out
    }

    @TestFactory
    fun shapes(): List<DynamicTest> {
        // no vector uses a named-view spread, so an empty schema is enough to expand against
        val empty = RayfoldSchemaIR(rayfold = "0.1", types = emptyMap(), ops = emptyMap())
        val out = mutableListOf<DynamicTest>()
        for ((file, doc) in area("shapes")) {
            for (case in doc["cases"]?.jsonArray ?: error("$file has no cases")) {
                val c = case.jsonObject
                val name = c["name"]?.jsonPrimitive?.content ?: error("$file has a case without a name")
                val text = c["shape"]?.jsonPrimitive?.content ?: error("$name has no shape")
                val why = c["why"]?.jsonPrimitive?.content ?: name
                val rejected = c["rejected"]?.jsonPrimitive?.content == "true"
                out.add(
                    DynamicTest.dynamicTest("shapes/$file: $name") {
                        if (rejected) {
                            val failed = runCatching { Shapes.canonical(Shapes.parse(text), empty) }.isFailure
                            assertTrue(failed, "the shape was accepted but the grammar does not admit it: $why")
                            return@dynamicTest
                        }
                        val canonical = Shapes.canonical(Shapes.parse(text), empty)
                        assertEquals(c["canonical"]?.jsonPrimitive?.content, canonical, why)
                        // the id in the vector is the SHA-256 of the canonical text above, taken independently
                        assertEquals(c["id"]?.jsonPrimitive?.content, Shapes.idOf(canonical), why)
                    },
                )
            }
        }
        assertTrue(out.size > 5, "no shape vectors were found under ${root.absolutePath}")
        return out
    }

    @TestFactory
    fun binary(): List<DynamicTest> {
        val out = mutableListOf<DynamicTest>()
        for ((file, doc) in area("binary")) {
            // no schema, so the dictionary is exactly the protocol keys the vector lists
            val codec = RbCodec()
            val dictionary = doc["dictionary"]?.jsonArray ?: error("$file has no dictionary")

            out.add(
                DynamicTest.dynamicTest("binary/$file: the protocol keys are those, in that order") {
                    assertEquals(40, dictionary.size, "the count is load-bearing: every schema name is offset by it")
                    dictionary.forEachIndexed { i, key ->
                        val name = key.jsonPrimitive.content
                        // encoding { key: 1 } puts the key's id on the wire as the varint 2*i, which is the id's only
                        // observable effect and the thing an independent codec has to agree about
                        val bytes = codec.encode(buildJsonObject { put(name, JsonPrimitive(1)) })
                        assertEquals("0801%02x81".format(2 * i), hex(bytes), "$name should be dictionary id $i")
                    }
                },
            )

            for (case in doc["values"]?.jsonArray ?: error("$file has no values")) {
                val c = case.jsonObject
                val name = c["name"]?.jsonPrimitive?.content ?: error("$file has a case without a name")
                val json = c["json"]?.jsonPrimitive?.content ?: error("$name has no json")
                val expected = c["bytes"]?.jsonPrimitive?.content ?: error("$name has no bytes")
                val why = c["why"]?.jsonPrimitive?.content ?: name
                out.add(
                    DynamicTest.dynamicTest("binary/$file: $name") {
                        val value = Json.parseToJsonElement(json)
                        assertEquals(expected, hex(codec.encode(value)), why)
                        assertEquals(value, codec.decode(codec.encode(value)), "reads back as what went in")
                        assertEquals(value, codec.decode(unhex(expected)), "and the bytes as written read as the value")
                    },
                )
            }
            for (case in doc["refused"]?.jsonArray ?: JsonArray(emptyList())) {
                val c = case.jsonObject
                val name = c.str("name")
                out.add(
                    DynamicTest.dynamicTest("binary/$file: refuses: $name") {
                        assertThrows<RbException>(c.str("why")) { codec.decode(unhex(c.str("bytes"))) }
                    },
                )
            }
        }
        assertTrue(out.size > 5, "no binary vectors were found under ${root.absolutePath}")
        return out
    }

    private fun JsonObject.req(key: String): JsonElement = this[key] ?: error("vector is missing \"$key\"")
    private fun JsonObject.str(key: String): String = req(key).jsonPrimitive.content

    /** What restock answers: every case starts from a stock of 3. */
    private fun stocked(stock: Int) = buildJsonObject { put("\$type", "Book"); put("id", "b1"); put("stock", stock) }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
    private fun unhex(h: String): ByteArray = h.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    /** A general-purpose digest, so the vector checks the runtime rather than the runtime checking itself. */
    private fun sha256(s: String): String = hex(java.security.MessageDigest.getInstance("SHA-256").digest(s.toByteArray()))
}
