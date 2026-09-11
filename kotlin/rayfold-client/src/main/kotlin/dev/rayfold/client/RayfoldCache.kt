package dev.rayfold.client

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.util.concurrent.CopyOnWriteArrayList

/** A stored result: its skeleton (entities replaced by refs), the op that produced it and the entity keys it holds. */
class CachedResult internal constructor(
    val data: JsonElement,
    val op: String,
    val keys: MutableSet<String>,
    val storedAt: Long,
    @Volatile var stale: Boolean = false,
)

/** What one cache update touched: entity keys ("Book:b1") and op names. */
class CacheChange(val keys: Set<String>, val ops: Set<String>)

/** A predicted change to one entity's fields (sub-profile `sync`, spec 08 section 5). */
@Serializable
data class OptimisticOp(val set: String, val value: JsonObject)

/**
 * Normalized entity cache (spec 07 section 3, spec 04 section 2; mirrors packages/client/src/cache.ts). Entities live
 * once, keyed "$type:id". A stored result is a skeleton in which entities are `{ "$ref": key, "$sel": selection }`,
 * where the selection records the fields that result asked for, so reading it back gives exactly the requested shape
 * while every value comes from the one shared entity. Safe to use from several threads.
 */
class RayfoldCache(private val now: () -> Long = System::currentTimeMillis) {
    private val lock = Any()
    private val entities = LinkedHashMap<String, JsonObject>()
    private val results = HashMap<String, CachedResult>()
    private val staleKeys = HashSet<String>()
    private val listeners = CopyOnWriteArrayList<(CacheChange) -> Unit>()

    /** Predictions, oldest first. [entities] shows the server's values with these applied on top. */
    private val layers = ArrayList<Pair<String, List<OptimisticOp>>>()

    /** The server's own values of the entities a prediction covers, for as long as one does. */
    private val shadow = HashMap<String, JsonObject?>()
    private var pending: Pair<MutableSet<String>, MutableSet<String>>? = null

    fun get(key: String): JsonObject? = synchronized(lock) { entities[key] }
    fun has(key: String): Boolean = synchronized(lock) { key in entities }
    fun isStale(key: String): Boolean = synchronized(lock) { key in staleKeys }
    val size: Int get() = synchronized(lock) { entities.size }

    /** Merges fields into an entity (creating it), normalizing nested entities. Returns the touched keys. */
    fun merge(key: String, fields: JsonObject, touched: MutableSet<String> = mutableSetOf()): Set<String> = synchronized(lock) {
        val next = LinkedHashMap(baseOf(key) ?: JsonObject(emptyMap()))
        for ((k, v) in fields) next[k] = normalizeValue(v, touched).first
        if ("\$type" !in next) next["\$type"] = JsonPrimitive(key.substringBefore(':'))
        if ("id" !in next) next["id"] = JsonPrimitive(key.substringAfter(':'))
        setBase(key, JsonObject(next))
        staleKeys.remove(key)
        touched.add(key)
        touched
    }

    /** Merges every entity found in [data] and tells watchers (used to repair after a version conflict). */
    fun mergeEntities(data: JsonElement) = synchronized(lock) {
        val keys = mutableSetOf<String>()
        normalizeValue(data, keys)
        emit(keys, emptySet())
    }

    /** Replaces entity objects with skeleton refs, storing the entities. */
    fun normalize(data: JsonElement, touched: MutableSet<String> = mutableSetOf()): JsonElement = synchronized(lock) { normalizeValue(data, touched).first }

    /** A value and its selection: [TRUE] for a leaf, an object of field selections otherwise. */
    private fun normalizeValue(v: JsonElement, touched: MutableSet<String>): Pair<JsonElement, JsonElement> = when (v) {
        is JsonArray -> {
            var sel: JsonElement = TRUE
            val value = JsonArray(v.map { x ->
                val (nx, s) = normalizeValue(x, touched)
                if (s != TRUE) sel = if (sel == TRUE) s else mergeSel(sel, s)
                nx
            })
            value to sel
        }
        is JsonObject -> {
            val ref = refKey(v)
            if (ref != null) {
                touched.add(ref)
                v to (v["\$sel"] ?: TRUE)
            } else {
                val key = entityKey(v)
                val sel = LinkedHashMap<String, JsonElement>()
                val out = LinkedHashMap<String, JsonElement>()
                for ((k, x) in v) {
                    val (nx, s) = normalizeValue(x, touched)
                    out[k] = nx
                    sel[k] = s
                }
                if (key != null) {
                    setBase(key, JsonObject(LinkedHashMap(baseOf(key) ?: JsonObject(emptyMap())).apply { putAll(out) }))
                    staleKeys.remove(key)
                    touched.add(key)
                    JsonObject(mapOf("\$ref" to JsonPrimitive(key), "\$sel" to JsonObject(sel))) to JsonObject(sel)
                } else JsonObject(out) to JsonObject(sel)
            }
        }
        else -> v to TRUE
    }

    /** Resolves refs back into plain objects, honouring each ref's selection. Cycles are cut at [maxDepth]. */
    fun denormalize(data: JsonElement, maxDepth: Int = 16): JsonElement = synchronized(lock) { walk(data, null, 0, maxDepth) }

    private fun walk(v: JsonElement, sel: JsonElement?, depth: Int, maxDepth: Int): JsonElement = when (v) {
        is JsonArray -> JsonArray(v.map { walk(it, sel, depth, maxDepth) })
        is JsonObject -> {
            val ref = refKey(v)
            if (ref != null) {
                val e = entities[ref]
                val s = v["\$sel"] ?: sel
                when {
                    e == null -> JsonObject(mapOf("\$ref" to JsonPrimitive(ref)))
                    depth >= maxDepth -> JsonObject(listOfNotNull(e["\$type"]?.let { "\$type" to it }, e["id"]?.let { "id" to it }).toMap())
                    s == null || s == TRUE -> walk(e, null, depth + 1, maxDepth)
                    else -> {
                        val out = LinkedHashMap<String, JsonElement>()
                        e["\$type"]?.let { out["\$type"] = it }
                        for ((k, sub) in s as JsonObject) e[k]?.let { out[k] = walk(it, sub, depth + 1, maxDepth) }
                        JsonObject(out)
                    }
                }
            } else {
                JsonObject(v.mapValues { (k, x) -> walk(x, (sel as? JsonObject)?.get(k), depth, maxDepth) })
            }
        }
        else -> v
    }

    // ------------------------------------------------------------ results

    fun putResult(key: String, op: String, data: JsonElement): CachedResult = synchronized(lock) {
        val keys = mutableSetOf<String>()
        val normalized = normalizeValue(data, keys).first
        val r = CachedResult(normalized, op, keys, now())
        results[key] = r
        emit(keys, setOf(op))
        r
    }

    fun getResult(key: String): CachedResult? = synchronized(lock) { results[key] }

    /** Applies a deferred delta at a path inside a stored result (spec 04 section 3). */
    fun mergeAt(key: String, path: String, delta: JsonElement) = synchronized(lock) {
        val r = results[key] ?: return@synchronized
        if (delta !is JsonObject) return@synchronized
        val touched = mutableSetOf<String>()
        val (norm, sel) = normalizeValue(delta, touched)
        val fields = norm as? JsonObject ?: return@synchronized
        val parts = if (path.isEmpty()) emptyList() else path.split(".")
        val data = updateAt(r.data, parts) { target ->
            val ref = (target as? JsonObject)?.let(::refKey)
            when {
                ref != null -> {
                    baseOf(ref)?.let { e -> setBase(ref, JsonObject(LinkedHashMap(e).apply { putAll(fields) })) }
                    JsonObject(mapOf("\$ref" to JsonPrimitive(ref), "\$sel" to mergeSel(target["\$sel"] ?: JsonObject(emptyMap()), sel)))
                }
                target is JsonObject -> JsonObject(LinkedHashMap(target).apply { putAll(fields) })
                else -> target
            }
        }
        r.keys.addAll(touched)
        // a new record for the result, so a watcher comparing records sees that this result changed
        results[key] = CachedResult(data, r.op, r.keys, r.storedAt, r.stale)
        emit(touched, setOf(r.op))
    }

    /** Rebuilds [v] with the value at [path] replaced by [fn]; a ref on the way leads into its stored entity. */
    private fun updateAt(v: JsonElement, path: List<String>, fn: (JsonElement) -> JsonElement): JsonElement {
        if (path.isEmpty()) return fn(v)
        if (v is JsonObject) {
            val ref = refKey(v)
            if (ref != null) {
                val e = baseOf(ref) ?: return v
                setBase(ref, updateAt(e, path, fn) as? JsonObject ?: e)
                return v
            }
            val child = v[path[0]] ?: return v
            return JsonObject(LinkedHashMap(v).apply { put(path[0], updateAt(child, path.drop(1), fn)) })
        }
        if (v is JsonArray) {
            val i = path[0].toIntOrNull()?.takeIf { it in v.indices } ?: return v
            return JsonArray(v.toMutableList().also { it[i] = updateAt(v[i], path.drop(1), fn) })
        }
        return v
    }

    // ------------------------------------------------------------ patches

    /** Applies patch operations from a command or a live query: set, del, inv (entities) and invOp (whole queries). */
    fun applyPatch(ops: List<JsonObject>) = synchronized(lock) {
        val keys = mutableSetOf<String>()
        val opNames = mutableSetOf<String>()
        for (p in ops) {
            val set = p.str("set")
            val del = p.str("del")
            when {
                set != null -> merge(set, p["value"] as? JsonObject ?: JsonObject(emptyMap()), keys)
                del != null -> {
                    setBase(del, null)
                    keys.add(del)
                    for ((k, r) in results) if (del in r.keys) results[k] = CachedResult(dropRef(r.data, del), r.op, r.keys, r.storedAt, r.stale)
                    // lists nested inside other entities (Book.reviews, Author.books) hold refs too
                    for (k in (entities.keys + shadow.keys).toSet()) {
                        val e = baseOf(k) ?: continue
                        if (!containsRef(e, del)) continue
                        setBase(k, dropRef(e, del) as JsonObject)
                        keys.add(k)
                    }
                }
                p["inv"] is JsonArray -> for (k in (p["inv"] as JsonArray)) (k as? JsonPrimitive)?.contentOrNull?.let { staleKeys.add(it); keys.add(it) }
                p["invOp"] is JsonArray -> for (o in (p["invOp"] as JsonArray)) (o as? JsonPrimitive)?.contentOrNull?.let { op ->
                    opNames.add(op)
                    for (r in results.values) if (r.op == op) r.stale = true
                }
            }
        }
        for (r in results.values) if (r.keys.any { it in keys }) opNames.add(r.op)
        emit(keys, opNames)
    }

    // ------------------------------------------------------------ predictions

    /**
     * Shows a prediction, tagged by the command's idempotency key, over the server's values until [removeLayer]. The
     * server's writes keep landing underneath, so removing it leaves exactly what the server said: the rebase after
     * success and the rollback after failure.
     */
    fun addLayer(id: String, ops: List<OptimisticOp>) = synchronized(lock) {
        val keys = ops.map { it.set }.toSet()
        for (k in keys) if (k !in shadow) shadow[k] = entities[k]
        layers.add(id to ops)
        keys.forEach(::rebuild)
        emit(keys, emptySet())
    }

    fun removeLayer(id: String) = synchronized(lock) {
        val i = layers.indexOfFirst { it.first == id }
        if (i < 0) return@synchronized
        val keys = layers.removeAt(i).second.map { it.set }.toSet()
        for (k in keys) {
            if (layers.any { (_, ops) -> ops.any { it.set == k } }) {
                rebuild(k)
                continue
            }
            val base = shadow.remove(k)
            if (base != null) entities[k] = base else entities.remove(k)
        }
        emit(keys, emptySet())
    }

    /** The command keys of the predictions not settled yet. */
    val predictions: List<String> get() = synchronized(lock) { layers.map { it.first } }

    /** The server's value of an entity, below any prediction. */
    private fun baseOf(key: String): JsonObject? = if (key in shadow) shadow[key] else entities[key]

    private fun setBase(key: String, value: JsonObject?) {
        when {
            key in shadow -> {
                shadow[key] = value
                rebuild(key)
            }
            value != null -> entities[key] = value
            else -> entities.remove(key)
        }
    }

    private fun rebuild(key: String) {
        var e: MutableMap<String, JsonElement>? = shadow[key]?.let { LinkedHashMap(it) }
        for ((_, ops) in layers) for (op in ops) {
            if (op.set != key) continue
            val m = e ?: linkedMapOf<String, JsonElement>("\$type" to JsonPrimitive(key.substringBefore(':')), "id" to JsonPrimitive(key.substringAfter(':')))
            m.putAll(op.value)
            e = m
        }
        val built = e
        if (built != null) entities[key] = JsonObject(built) else entities.remove(key)
    }

    // ------------------------------------------------------------ listeners

    /** Calls [listener] after every change. Returns the function that stops it. */
    fun subscribe(listener: (CacheChange) -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    /** Runs [fn] and reports everything it changed as one change. */
    fun transaction(fn: () -> Unit) = synchronized(lock) {
        if (pending != null) return@synchronized fn()
        val p = mutableSetOf<String>() to mutableSetOf<String>()
        pending = p
        try {
            fn()
        } finally {
            pending = null
            emit(p.first, p.second)
        }
    }

    private fun emit(keys: Set<String>, ops: Set<String>) {
        if (keys.isEmpty() && ops.isEmpty()) return
        val p = pending
        if (p != null) {
            p.first.addAll(keys)
            p.second.addAll(ops)
            return
        }
        val change = CacheChange(keys.toSet(), ops.toSet())
        for (l in listeners) l(change)
    }

    fun clear() = synchronized(lock) {
        entities.clear()
        results.clear()
        staleKeys.clear()
        layers.clear()
        shadow.clear()
    }

    companion object {
        private val TRUE = JsonPrimitive(true)

        /** The key under which a result is stored: the op, its arguments (canonical), the shape and the variables. */
        fun resultKey(op: String, args: JsonObject, shape: String?, vars: JsonObject?): String =
            JsonArray(listOf(JsonPrimitive(op), JsonPrimitive(canonical(args)), JsonPrimitive(shape ?: ""), JsonPrimitive(canonical(vars ?: JsonObject(emptyMap()))))).toString()

        /** "$type:id" of an entity object, or null. */
        fun entityKey(o: JsonObject): String? {
            val type = (o["\$type"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            val id = (o["id"] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content ?: return null
            return "$type:$id"
        }

        private fun refKey(o: JsonObject): String? {
            val ref = (o["\$ref"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
            return if (o.keys.all { it == "\$ref" || it == "\$sel" }) ref else null
        }

        private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun mergeSel(a: JsonElement, b: JsonElement): JsonElement {
            if (a == TRUE) return b
            if (b == TRUE) return a
            val out = LinkedHashMap(a as JsonObject)
            for ((k, v) in b as JsonObject) out[k] = out[k]?.let { mergeSel(it, v) } ?: v
            return JsonObject(out)
        }

        private fun containsRef(v: JsonElement, key: String): Boolean = when (v) {
            is JsonArray -> v.any { containsRef(it, key) }
            is JsonObject -> refKey(v)?.let { it == key } ?: v.values.any { containsRef(it, key) }
            else -> false
        }

        private fun dropRef(v: JsonElement, key: String): JsonElement = when (v) {
            is JsonArray -> JsonArray(v.filterNot { it is JsonObject && refKey(it) == key }.map { dropRef(it, key) })
            is JsonObject -> when (refKey(v)) {
                null -> JsonObject(v.mapValues { dropRef(it.value, key) })
                key -> JsonNull
                else -> v
            }
            else -> v
        }

        private fun canonical(v: JsonElement): String = when (v) {
            is JsonObject -> v.keys.sorted().joinToString(",", "{", "}") { JsonPrimitive(it).toString() + ":" + canonical(v.getValue(it)) }
            is JsonArray -> v.joinToString(",", "[", "]") { canonical(it) }
            else -> v.toString()
        }
    }
}
