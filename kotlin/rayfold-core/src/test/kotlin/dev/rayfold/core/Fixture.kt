package dev.rayfold.core

import kotlinx.coroutines.flow.asFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Declarative resolver interpreter for conformance fixtures (mirrors conformance/src/fixture.ts). */
class FixtureStore(data: JsonObject) {
    val tables: MutableMap<String, MutableList<MutableMap<String, JsonElement>>> =
        data.mapValues { (_, rows) -> rows.jsonArray.map { it.jsonObject.toMutableMap() }.toMutableList() }.toMutableMap()
    val calls = linkedMapOf<String, Int>()
    var nextId = 1
    fun table(name: String) = tables.getOrPut(name) { mutableListOf() }
    fun count(k: String) { calls[k] = (calls[k] ?: 0) + 1 }
}

object FixtureResolvers {
    private class Env(val args: JsonElement, val viewer: JsonElement, val row: JsonElement? = null)

    private fun JsonObject.req(key: String): JsonElement = this[key] ?: error("fixture resolver spec is missing \"$key\"")
    private fun JsonObject.str(key: String): String = req(key).jsonPrimitive.content

    private fun tmpl(v: JsonElement?, env: Env): JsonElement = when (v) {
        null -> JsonNull
        is JsonPrimitive -> {
            val s = v.takeIf { it.isString }?.content
            if (s != null && s.startsWith("$")) {
                val parts = s.substring(1).split(".")
                var cur: JsonElement? = when (parts[0]) { "args" -> env.args; "viewer" -> env.viewer; "row" -> env.row; else -> null }
                for (p in parts.drop(1)) cur = (cur as? JsonObject)?.get(p)
                cur ?: JsonNull
            } else v
        }
        is JsonArray -> JsonArray(v.map { tmpl(it, env) })
        is JsonObject -> JsonObject(v.mapValues { (_, x) -> tmpl(x, env) })
    }

    private fun matches(row: Map<String, JsonElement>, where: JsonObject?, env: Env): Boolean {
        if (where == null) return true
        return where.all { (k, v) ->
            val want = tmpl(v, env)
            want is JsonNull || (row[k] as? JsonPrimitive)?.content == (want as? JsonPrimitive)?.content
        }
    }

    private fun page(rows: List<Map<String, JsonElement>>, p: JsonObject?): JsonObject {
        val first = (p?.get("first") as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toInt() ?: 20
        val after = (p?.get("after") as? JsonPrimitive)?.takeIf { it.isString }?.content
        var start = 0
        if (after != null) { val i = rows.indexOfFirst { (it["id"] as? JsonPrimitive)?.content == after }; start = if (i < 0) rows.size else i + 1 }
        val items = rows.drop(start).take(first)
        return buildJsonObject {
            put("items", JsonArray(items.map { JsonObject(it) }))
            put("cursor", items.lastOrNull()?.get("id") ?: JsonNull)
            put("hasMore", JsonPrimitive(start + first < rows.size))
            put("total", JsonPrimitive(rows.size))
        }
    }

    fun build(fixture: JsonObject, store: FixtureStore): Resolvers {
        val res = fixture.req("resolvers").jsonObject
        val queries = (res["Query"]?.jsonObject ?: JsonObject(emptyMap())).mapValues { (name, specE) ->
            val spec = specE.jsonObject
            val fn: RootResolver = { args, ctx ->
                store.count("Query.$name")
                val env = Env(args, ctx.viewer)
                val rows = store.table(spec.str("from")).filter { matches(it, spec["where"] as? JsonObject, env) }
                when (spec.str("mode")) {
                    "one" -> rows.firstOrNull()?.let { JsonObject(it) } ?: JsonNull
                    "list" -> JsonArray(rows.map { JsonObject(it) })
                    else -> page(rows, args[(spec["pageArg"] as? JsonPrimitive)?.content ?: "page"] as? JsonObject)
                }
            }
            fn
        }
        val fields = (res["fields"]?.jsonObject ?: JsonObject(emptyMap())).mapValues { (type, fieldsE) ->
            fieldsE.jsonObject.mapValues { (field, specE) ->
                val spec = specE.jsonObject
                val loader: FieldLoader = { parents, args, _ ->
                    store.count("$type.$field")
                    val rows = store.table(spec.str("from"))
                    val key = spec.str("key")
                    val match = spec.str("match")
                    parents.map { p ->
                        val hits = rows.filter { (it[match] as? JsonPrimitive)?.content == (p[key] as? JsonPrimitive)?.content }
                        when (spec.str("mode")) {
                            "one" -> hits.firstOrNull()?.let { JsonObject(it) }
                            "list" -> JsonArray(hits.map { JsonObject(it) })
                            else -> page(hits, args[(spec["pageArg"] as? JsonPrimitive)?.content ?: "page"] as? JsonObject)
                        }
                    }
                }
                loader
            }
        }
        val commands = (res["Command"]?.jsonObject ?: JsonObject(emptyMap())).mapValues { (name, specE) ->
            val spec = specE.jsonObject
            val fn: suspend (JsonObject, RayfoldContext) -> Any? = { args, ctx ->
                store.count("Command.$name")
                val env = Env(args, ctx.viewer)
                for (failE in spec["fail"]?.jsonArray ?: JsonArray(emptyList())) {
                    val fail = failE.jsonObject
                    val w = fail.req("when").jsonObject
                    val from = (w["from"] as? JsonPrimitive)?.content
                    val subject = if (from != null) store.table(from).firstOrNull { matches(it, w["where"] as? JsonObject, env) } else null
                    val field = w.str("field")
                    val actual = if (subject != null) subject[field] else tmpl(JsonPrimitive("\$args.$field"), env)
                    val rowEnv = Env(args, ctx.viewer, subject?.let { JsonObject(it) })
                    val want = tmpl(w["value"], rowEnv)
                    val hit = when (w.str("op")) {
                        "missing" -> subject == null
                        "eq" -> (actual as? JsonPrimitive)?.content == (want as? JsonPrimitive)?.content
                        else -> ((actual as? JsonPrimitive)?.content?.toDoubleOrNull() ?: 0.0) < ((want as? JsonPrimitive)?.content?.toDoubleOrNull() ?: 0.0)
                    }
                    if (hit) {
                        val data = tmpl(fail["data"] ?: JsonObject(emptyMap()), rowEnv)
                        val type = (fail["type"] as? JsonPrimitive)?.content
                        val message = (fail["message"] as? JsonPrimitive)?.content
                        if (type != null) throw RayfoldException.domain(type, data, message ?: type)
                        val code = (fail["code"] as? JsonPrimitive)?.content ?: "failed_precondition"
                        throw RayfoldException(Code.entries.first { it.wire == code }, message ?: code)
                    }
                }
                var inserted: MutableMap<String, JsonElement>? = null
                var updated: MutableMap<String, JsonElement>? = null
                (spec["update"] as? JsonObject)?.let { u ->
                    val row = store.table(u.str("table")).firstOrNull { matches(it, u["where"] as? JsonObject, env) }
                        ?: throw RayfoldException(Code.NOT_FOUND, "row not found")
                    val versionField = (u["version"] as? JsonPrimitive)?.content
                    if (versionField != null) ctx.checkVersion("${u.str("table")}:${(row["id"] as JsonPrimitive).content}", row[versionField], JsonObject(row))
                    val target = if (ctx.simulate) row.toMutableMap() else row
                    (u["merge"])?.let { m -> (tmpl(m, env) as? JsonObject)?.forEach { (k, v) -> target[k] = v } }
                    if (versionField != null) target[versionField] = num(((target[versionField] as? JsonPrimitive)?.content?.toDoubleOrNull() ?: 0.0) + 1)
                    for ((k, v) in (u["set"] as? JsonObject ?: JsonObject(emptyMap()))) {
                        val add = (v as? JsonObject)?.get("\$add"); val sub = (v as? JsonObject)?.get("\$sub")
                        val cur = (target[k] as? JsonPrimitive)?.content?.toDoubleOrNull() ?: 0.0
                        target[k] = when {
                            add != null -> num(cur + (tmpl(add, env) as JsonPrimitive).content.toDouble())
                            sub != null -> num(cur - (tmpl(sub, env) as JsonPrimitive).content.toDouble())
                            else -> tmpl(v, env)
                        }
                    }
                    updated = target
                }
                (spec["insert"] as? JsonObject)?.let { ins ->
                    val prefix = (ins["idPrefix"] as? JsonPrimitive)?.content ?: "n"
                    val row = linkedMapOf<String, JsonElement>("id" to JsonPrimitive("$prefix${store.nextId++}"))
                    row.putAll(tmpl(ins["row"], env).jsonObject)
                    if (!ctx.simulate) store.table(ins.str("into")).add(row)
                    inserted = row
                }
                val result = if (spec.str("returns") == "inserted") inserted else updated
                val rowEnv = Env(args, ctx.viewer, result?.let { JsonObject(it) })
                val patch = (spec["patch"] as? JsonArray)?.map { tmpl(it, rowEnv).jsonObject } ?: emptyList()
                val emit = (spec["emit"] as? JsonArray)?.map { e -> e.jsonObject.str("event") to tmpl(e.jsonObject["payload"], rowEnv).jsonObject } ?: emptyList()
                CommandResult(result?.let { JsonObject(it) }, patch, emit)
            }
            fn
        }
        val streams = (res["Stream"]?.jsonObject ?: JsonObject(emptyMap())).mapValues { (name, specE) ->
            val items = specE.jsonObject.req("items").jsonArray.toList()
            val fn: StreamResolver = { _, _ -> store.count("Stream.$name"); items.asFlow() }
            fn
        }
        return Resolvers(queries, commands, streams, fields)
    }

    private fun num(d: Double): JsonPrimitive = if (d == Math.floor(d) && !d.isInfinite()) JsonPrimitive(d.toLong()) else JsonPrimitive(d)
}
