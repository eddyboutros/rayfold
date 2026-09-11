package dev.rayfold.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.CopyOnWriteArraySet

/** Entity keys (`Type:id`) and operation names a change touches (spec 08 section 3). */
data class Change(val keys: Set<String>, val ops: Set<String>)

/**
 * The server's change bus (mirrors packages/server/src/live.ts). Every committed command publishes its patch here;
 * adapters may publish their own changes. Live queries subscribe for as long as they are open.
 */
class ChangeBus {
    /** A wrapper per subscription, so the same function subscribed twice is two subscriptions. */
    private class Sub(val fn: (Change) -> Unit)

    private val subs = CopyOnWriteArraySet<Sub>()

    fun publish(c: Change) {
        if (c.keys.isEmpty() && c.ops.isEmpty()) return
        for (s in subs) s.fn(c)
    }

    /** Returns the unsubscribe function. */
    fun subscribe(fn: (Change) -> Unit): () -> Unit {
        val s = Sub(fn)
        subs.add(s)
        return { subs.remove(s) }
    }

    /** Subscriptions currently held. */
    val size: Int get() = subs.size
}

/** Read sets, result diffs and frame folding for live queries and single-document transports. */
object Live {
    fun changeFromPatch(patch: List<JsonObject>): Change {
        val keys = linkedSetOf<String>()
        val ops = linkedSetOf<String>()
        fun strings(v: JsonElement?) = (v as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: emptyList()
        for (p in patch) when {
            "set" in p -> (p["set"] as? JsonPrimitive)?.content?.let { keys.add(it) }
            "del" in p -> (p["del"] as? JsonPrimitive)?.content?.let { keys.add(it) }
            "inv" in p -> keys.addAll(strings(p["inv"]))
            "invOp" in p -> ops.addAll(strings(p["invOp"]))
        }
        return Change(keys, ops)
    }

    /** Entities keyed by `Type:id` with nested entities replaced by `{ $ref }`, plus that skeleton. */
    class Normalized(val entities: Map<String, JsonObject>, val skeleton: JsonElement)

    fun normalize(data: JsonElement?): Normalized {
        val entities = linkedMapOf<String, JsonObject>()
        fun walk(v: JsonElement): JsonElement = when (v) {
            is JsonArray -> JsonArray(v.map { walk(it) })
            is JsonObject -> {
                val out = JsonObject(v.mapValues { (_, x) -> walk(x) })
                val tn = (v["\$type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                // an id is text or a number, as in the TS runtime; true or null is not an identity
                val id = (v["id"] as? JsonPrimitive)?.takeIf { it !is JsonNull && (it.isString || StrictJson.isNumber(it.content)) }?.content
                if (tn != null && id != null) {
                    val key = "$tn:$id"
                    entities[key] = JsonObject((entities[key] ?: JsonObject(emptyMap())) + out)
                    buildJsonObject { put("\$ref", key) }
                } else out
            }
            else -> v
        }
        return Normalized(entities, walk(data ?: JsonNull))
    }

    fun readSetOf(data: JsonElement?): Set<String> = normalize(data).entities.keys

    sealed class Diff {
        /** Only entity fields changed: one `set` per entity with the fields that changed. */
        class Patch(val patch: List<JsonObject>) : Diff()

        /** The structure changed (membership, order, an entity appearing or disappearing): the whole new result. */
        class Data(val data: JsonElement) : Diff()
    }

    /** Null when nothing changed. Values compare by their serialized text, key order included, as the TS runtime does. */
    fun diffResults(prev: JsonElement?, next: JsonElement?): Diff? {
        val a = normalize(prev)
        val b = normalize(next)
        if (a.skeleton.toString() != b.skeleton.toString()) return Diff.Data(next ?: JsonNull)
        val patch = mutableListOf<JsonObject>()
        for ((key, fields) in b.entities) {
            val before = a.entities[key]
            val changed = fields.filter { (k, v) -> before?.get(k)?.toString() != v.toString() }
            if (changed.isNotEmpty()) patch.add(buildJsonObject { put("set", key); put("value", JsonObject(changed)) })
        }
        return if (patch.isEmpty()) null else Diff.Patch(patch)
    }

    /** The query result with deferred `at` frames folded in, so deferred parts take part in read sets and diffs. */
    fun foldFrames(frames: List<JsonObject>): JsonElement {
        var data: JsonElement = JsonNull
        for (f in frames) {
            val at = (f["at"] as? JsonPrimitive)?.content
            val d = f["data"] ?: continue
            data = if (at != null) mergeAt(data, at, d) else d
        }
        return data
    }

    /** [root] with [data]'s members assigned into the object at the dotted path [at] ("" is the root); unchanged when the path misses. */
    fun mergeAt(root: JsonElement, at: String, data: JsonElement): JsonElement {
        val parts = if (at.isEmpty()) emptyList() else at.split(".")
        fun merge(v: JsonElement, i: Int): JsonElement {
            if (i == parts.size) return if (v is JsonObject && data is JsonObject) JsonObject(v + data) else v
            return when (v) {
                is JsonObject -> v[parts[i]]?.let { child -> JsonObject(v + (parts[i] to merge(child, i + 1))) } ?: v
                is JsonArray -> {
                    val idx = parts[i].toIntOrNull()
                    val child = idx?.let { v.getOrNull(it) } ?: return v
                    JsonArray(v.toMutableList().also { it[idx] = merge(child, i + 1) })
                }
                else -> v
            }
        }
        return merge(root, 0)
    }
}
