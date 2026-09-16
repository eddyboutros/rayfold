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
class ChangeBus(
    private val relay: Relay? = null,
    /** Where a relay's refusal to carry a change goes; the change itself was already made. */
    onRelayError: (Throwable) -> Unit = {},
) {
    /** A wrapper per subscription, so the same function subscribed twice is two subscriptions. */
    private class Sub(val fn: (Change) -> Unit)

    private val subs = CopyOnWriteArraySet<Sub>()
    private val forwarding = RelayForwarding(relay, onRelayError)

    /** A change this server made: its own live queries hear it now, and every other server's through the relay. */
    fun publish(c: Change) {
        if (c.keys.isEmpty() && c.ops.isEmpty()) return
        deliver(c)
        forwarding.send(RelayMessage.Change(c.keys, c.ops))
    }

    /** A change reaching this server, made here or elsewhere: only the live queries here hear it. */
    fun deliver(c: Change) {
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
            // result-scoped operations (spec 04 section 2b) name no entity and no operation
            "list" in p || "at" in p -> Unit
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
        /** The change described as operations: `set` per entity, plus result-scoped `at` and `list` (spec 04 section 2b). */
        class Patch(val patch: List<JsonObject>) : Diff()

        /** The change cannot be described (a different set of fields, or a patch dearer than the result): send it whole. */
        class Data(val data: JsonElement) : Diff()
    }

    /** What a value is known by inside a list: its entity key, or its own content. */
    private fun identityOf(v: JsonElement): String {
        if (v is JsonObject) {
            val tn = (v["\$type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val id = (v["id"] as? JsonPrimitive)?.takeIf { it !is JsonNull && (it.isString || StrictJson.isNumber(it.content)) }?.content
            if (tn != null && id != null) return "$tn:$id"
        }
        return "#" + v.toString()
    }

    private fun entityAt(v: JsonElement): String? = identityOf(v).takeIf { !it.startsWith("#") }
    private fun joinPath(path: String, part: Any): String = if (path.isEmpty()) part.toString() else path + "." + part
    private fun isLeaf(v: JsonElement): Boolean = v !is JsonObject && v !is JsonArray

    /** Operations collected while walking, and the entity keys whose values travel inside an insertion. */
    private class Ops {
        val out = mutableListOf<JsonObject>()
        val carried = mutableSetOf<String>()
    }

    /**
     * Describes how [b] differs from [a] as operations the client can apply to its stored result, or returns false
     * when the difference cannot be expressed. Entities are not descended into: their fields travel as `set`.
     */
    private fun structuralDiff(a: JsonElement, b: JsonElement, path: String, ops: Ops): Boolean {
        if (a.toString() == b.toString()) return true
        val ea = entityAt(a)
        val eb = entityAt(b)
        if (ea != null || eb != null) return ea != null && ea == eb
        if (a is JsonArray && b is JsonArray) return listDiff(a, b, path, ops)
        if (a is JsonObject && b is JsonObject) {
            if (a.keys != b.keys) return false
            val merge = linkedMapOf<String, JsonElement>()
            for (k in b.keys) {
                val av = a.getValue(k)
                val bv = b.getValue(k)
                if (av.toString() == bv.toString()) continue
                if (isLeaf(av) && isLeaf(bv)) {
                    merge[k] = bv
                    continue
                }
                if (!structuralDiff(av, bv, joinPath(path, k), ops)) return false
            }
            if (merge.isNotEmpty()) ops.out.add(buildJsonObject { put("at", path); put("value", JsonObject(merge)) })
            return true
        }
        return false
    }

    /** Positions removed and elements inserted, verified by replaying them; anything else is refused. */
    private fun listDiff(a: JsonArray, b: JsonArray, path: String, ops: Ops): Boolean {
        val identified = { xs: JsonArray -> xs.isNotEmpty() && xs.all { entityAt(it) != null } }
        val objects = { xs: JsonArray -> xs.all { it is JsonObject } }
        // Rows with an identity of their own are matched by it. Elements without one (plain objects, such as a
        // board's columns) are matched by position, so a change inside one of them is described in place.
        if (!(identified(a) && identified(b)) && a.size == b.size && objects(a) && objects(b)) {
            for (n in b.indices) if (!structuralDiff(a[n], b[n], joinPath(path, n), ops)) return false
            return true
        }
        val oldKeys = a.map { identityOf(it) }
        val newKeys = b.map { identityOf(it) }
        val del = mutableListOf<Int>()
        val ins = mutableListOf<Pair<Int, JsonElement>>()
        val pairs = mutableListOf<Pair<Int, Int>>()
        var i = 0
        var j = 0
        while (i < a.size && j < b.size) {
            when {
                oldKeys[i] == newKeys[j] -> {
                    pairs.add(i to j)
                    i++
                    j++
                }
                newKeys.subList(j, newKeys.size).none { it == oldKeys[i] } -> {
                    del.add(i)
                    i++
                }
                else -> {
                    ins.add(j to b[j])
                    j++
                }
            }
        }
        while (i < a.size) {
            del.add(i)
            i++
        }
        while (j < b.size) {
            ins.add(j to b[j])
            j++
        }
        val replay = a.filterIndexed { n, _ -> n !in del }.toMutableList()
        for ((at, v) in ins) replay.add(at, v)
        if (replay.map { identityOf(it) } != newKeys) return false
        for ((x, y) in pairs) if (!structuralDiff(a[x], b[y], joinPath(path, y), ops)) return false
        if (del.isNotEmpty() || ins.isNotEmpty()) {
            for ((_, v) in ins) ops.carried.addAll(normalize(v).entities.keys)
            ops.out.add(
                buildJsonObject {
                    put("list", path)
                    if (del.isNotEmpty()) put("del", JsonArray(del.map { JsonPrimitive(it) }))
                    if (ins.isNotEmpty()) put("ins", JsonArray(ins.map { (at, v) -> buildJsonObject { put("at", at); put("value", v) } }))
                },
            )
        }
        return true
    }

    /**
     * Null when nothing changed. Values compare by their serialized text, key order included, as the TS runtime does.
     */
    fun diffResults(prev: JsonElement?, next: JsonElement?): Diff? {
        val a = normalize(prev)
        val b = normalize(next)
        val ops = Ops()
        if (a.skeleton.toString() != b.skeleton.toString() &&
            !structuralDiff(prev ?: JsonNull, next ?: JsonNull, "", ops)
        ) {
            return Diff.Data(next ?: JsonNull)
        }
        val patch = mutableListOf<JsonObject>()
        for ((key, fields) in b.entities) {
            if (key in ops.carried) continue // its fields travel inside an insertion
            val before = a.entities[key]
            val changed = fields.filter { (k, v) -> before?.get(k)?.toString() != v.toString() }
            if (changed.isNotEmpty()) patch.add(buildJsonObject { put("set", key); put("value", JsonObject(changed)) })
        }
        // Describing the structure costs more than resending it only when nearly every row changed; then send the result.
        if (ops.out.isNotEmpty() && JsonArray(ops.out).toString().length >= (next ?: JsonNull).toString().length) {
            return Diff.Data(next ?: JsonNull)
        }
        patch.addAll(ops.out)
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
