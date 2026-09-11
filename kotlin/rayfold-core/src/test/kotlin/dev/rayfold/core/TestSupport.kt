package dev.rayfold.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File

/**
 * Shared test inputs. Deliberately stateless: no object-level `var` or mutable collection lives in this file, so
 * nothing can leak between tests; every test builds its own store and server.
 */
object Fixtures {
    private val root = File(System.getProperty("rayfold.fixtures") ?: "../conformance/fixtures")
    fun load(name: String): JsonObject = Json.parseToJsonElement(File(root, name).readText()).jsonObject
    fun ir(fixture: JsonObject): RayfoldSchemaIR =
        RayfoldSchemaIR.json.decodeFromJsonElement(RayfoldSchemaIR.serializer(), fixture["ir"] ?: error("fixture has no ir"))
    fun data(fixture: JsonObject): JsonObject = (fixture["data"] ?: error("fixture has no data")).jsonObject
}

fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

/** Ops given as JSON text, wrapped in a request envelope. */
fun batch(vararg ops: String): JsonObject = obj("""{"ops":[${ops.joinToString(",")}]}""")

fun JsonObject.opId(): Int? = (this["id"] as? JsonPrimitive)?.content?.toIntOrNull()
fun JsonObject.errorCode(): String? = ((this["error"] as? JsonObject)?.get("code") as? JsonPrimitive)?.content
fun JsonObject.errorMessage(): String? = ((this["error"] as? JsonObject)?.get("message") as? JsonPrimitive)?.content

fun query(fn: RootResolver): RootResolver = fn
fun command(fn: suspend (JsonObject, RayfoldContext) -> Any?): suspend (JsonObject, RayfoldContext) -> Any? = fn
fun loader(fn: FieldLoader): FieldLoader = fn

class FixtureServer(val server: RayfoldServer, val store: FixtureStore)

/** A fresh server and store over a conformance fixture; [schema] can add policies or costs to its IR. */
fun fixtureServer(
    name: String = "core/03-pipelining.json",
    options: BatchOptions = BatchOptions(),
    schema: (RayfoldSchemaIR) -> RayfoldSchemaIR = { it },
): FixtureServer {
    val f = Fixtures.load(name)
    val store = FixtureStore(Fixtures.data(f))
    return FixtureServer(RayfoldServer(schema(Fixtures.ir(f)), FixtureResolvers.build(f, store), options), store)
}

fun RayfoldSchemaIR.withTypeAnnotations(type: String, vararg a: Annotation): RayfoldSchemaIR {
    val t = types[type] ?: error("schema has no type $type")
    return copy(types = types + (type to t.copy(annotations = t.annotations + a)))
}

fun RayfoldSchemaIR.withFieldAnnotations(type: String, field: String, vararg a: Annotation): RayfoldSchemaIR {
    val t = types[type] ?: error("schema has no type $type")
    check(t.fields.any { it.name == field }) { "$type has no field $field" }
    return copy(types = types + (type to t.copy(fields = t.fields.map { if (it.name == field) it.copy(annotations = it.annotations + a) else it })))
}

fun RayfoldSchemaIR.withOpAnnotations(op: String, vararg a: Annotation): RayfoldSchemaIR {
    val o = ops[op] ?: error("schema has no op $op")
    return copy(ops = ops + (op to o.copy(annotations = o.annotations + a)))
}

/** Expression AST builders for the IR's JSON form (spec/01 section 5). */
object E {
    fun lit(v: JsonElement): JsonObject = buildJsonObject { put("k", "lit"); put("v", v) }
    fun lit(v: String): JsonObject = lit(JsonPrimitive(v))
    fun lit(v: Number): JsonObject = lit(JsonPrimitive(v))
    fun lit(v: Boolean): JsonObject = lit(JsonPrimitive(v))
    val nul: JsonObject get() = lit(JsonNull)
    fun path(root: String, vararg p: String): JsonObject =
        buildJsonObject { put("k", "path"); put("root", root); put("path", JsonArray(p.map { JsonPrimitive(it) })) }
    fun bin(op: String, l: JsonObject, r: JsonObject): JsonObject = buildJsonObject { put("k", "bin"); put("op", op); put("l", l); put("r", r) }
    fun not(e: JsonObject): JsonObject = buildJsonObject { put("k", "not"); put("e", e) }
    fun call(fn: String, vararg args: JsonObject): JsonObject = buildJsonObject { put("k", "call"); put("fn", fn); put("args", JsonArray(args.toList())) }
    fun list(vararg items: JsonObject): JsonObject = buildJsonObject { put("k", "list"); put("items", JsonArray(items.toList())) }
    fun policy(name: String, mode: String, e: JsonObject): Annotation = Annotation(name, mapOf(mode to buildJsonObject { put("\$expr", e) }))
}
