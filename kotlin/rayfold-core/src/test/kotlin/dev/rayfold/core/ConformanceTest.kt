package dev.rayfold.core

import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.seconds

/** Runs every fixture under conformance/fixtures against the Kotlin runtime, frame for frame. */
class ConformanceTest {
    private val root = File(System.getProperty("rayfold.fixtures") ?: "../conformance/fixtures")

    @TestFactory
    fun fixtures(): List<DynamicTest> = cases("") { fixture ->
        RayfoldSchemaIR.json.decodeFromJsonElement(RayfoldSchemaIR.serializer(), fixture["ir"] ?: error("fixture has no ir"))
    }

    /** The same cases with the schema read from each fixture's `.rayfold` text by [SchemaText] instead of its embedded IR. */
    @TestFactory
    fun fixturesFromSchemaText(): List<DynamicTest> = cases("from text: ") { fixture ->
        SchemaText.load(fixture["schema"]?.jsonPrimitive?.content ?: error("fixture has no schema text")).ir
    }

    private fun cases(prefix: String, irOf: (JsonObject) -> RayfoldSchemaIR): List<DynamicTest> {
        val out = mutableListOf<DynamicTest>()
        val profiles = root.listFiles()?.filter { it.isDirectory }?.sortedBy { it.name } ?: error("no fixture directory at ${root.absolutePath}")
        for (profile in profiles) {
            val files = profile.listFiles()?.filter { it.name.endsWith(".json") }?.sortedBy { it.name } ?: error("cannot list ${profile.absolutePath}")
            for (file in files) {
                val fixture = Json.parseToJsonElement(file.readText()).jsonObject
                known(file.name, fixture, FIXTURE_KEYS)
                val ir = irOf(fixture)
                val opts = fixture["options"] as? JsonObject
                opts?.let { known("${file.name} options", it, OPTION_KEYS) }
                for (case in fixture["cases"]?.jsonArray ?: error("${file.name} has no cases")) {
                    val c = case.jsonObject
                    val caseName = c["name"]?.jsonPrimitive?.content ?: error("${file.name} has a case without a name")
                    known("${file.name}: $caseName", c, CASE_KEYS)
                    out.add(DynamicTest.dynamicTest("$prefix${profile.name}/${file.name}: $caseName") { runCase(ir, fixture, opts, c) })
                }
            }
        }
        check(out.isNotEmpty()) { "no conformance cases under ${root.absolutePath}" }
        return out
    }

    private fun runCase(ir: RayfoldSchemaIR, fixture: JsonObject, opts: JsonObject?, c: JsonObject) = runTest(timeout = 5.seconds) {
        val store = FixtureStore(fixture["data"]?.jsonObject ?: error("fixture has no data"))
        val options = BatchOptions(
            trustedShapes = (opts?.get("trustedShapes") as? JsonPrimitive)?.content == "true",
            budget = (opts?.get("budget") as? JsonPrimitive)?.content?.toIntOrNull() ?: 1000,
            maxDepth = (opts?.get("maxDepth") as? JsonPrimitive)?.content?.toIntOrNull() ?: 8,
        )
        val server = RayfoldServer(ir, FixtureResolvers.build(fixture, store), options)
        for (s in (opts?.get("registerShapes") as? JsonArray) ?: JsonArray(emptyList())) server.registerShape(s.jsonPrimitive.content)
        val repeat = (c["repeat"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 1
        val viewer = c["viewer"] ?: JsonNull
        val request = c["request"]?.jsonObject ?: error("case has no request")
        var frames: List<JsonObject> = emptyList()
        val take = (c["take"] as? JsonPrimitive)?.content?.toInt()
        // taking fewer frames than a batch would produce cancels it: the way to read a batch that does not end, such as a live query
        repeat(repeat) { frames = if (take == null) server.collect(request, viewer) else server.execute(request, viewer).take(take).toList() }
        val expected = c["frames"]?.jsonArray ?: error("case has no frames")
        assertEquals(group(expected.map { it.jsonObject }), group(frames), "frames")
        (c["calls"] as? JsonObject)?.let { calls ->
            assertEquals(calls.mapValues { (_, v) -> v.jsonPrimitive.content.toInt() }, store.calls.toMap(), "loader calls")
        }
    }

    /** A member this runner does not know is an expectation it would silently skip, so it fails instead. */
    private fun known(where: String, o: JsonObject, keys: Set<String>) {
        for (k in o.keys) check(k in keys) { "$where: no runner support for \"$k\"" }
    }

    private companion object {
        // the same lists as FIXTURE_KEYS, OPTION_KEYS and CASE_KEYS in conformance/src/fixture.ts
        val FIXTURE_KEYS = setOf("name", "schema", "ir", "data", "resolvers", "options", "cases")
        val OPTION_KEYS = setOf("budget", "maxDepth", "trustedShapes", "registerShapes")
        val CASE_KEYS = setOf("name", "viewer", "request", "frames", "calls", "repeat", "take")
    }

    /** Group by op id (batch-level frames under "batch"); per-op order must match, ops may interleave. */
    private fun group(frames: List<JsonObject>): Map<String, List<JsonElement>> {
        val out = linkedMapOf<String, MutableList<JsonElement>>()
        for (f in frames) out.getOrPut((f["id"] as? JsonPrimitive)?.content ?: "batch") { mutableListOf() }.add(f)
        return out.toSortedMap()
    }
}
