package dev.rayfold.core

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** What a resolver receives. */
class RayfoldContext(
    val viewer: JsonElement,
    val simulate: Boolean,
    val opId: Int,
    val opName: String,
    val vars: JsonObject,
    val events: EventBus,
    val isCancelled: () -> Boolean = { false },
    val compact: Boolean = false,
    val ifVersion: JsonElement? = null,
) {
    /** Conditional write (spec 03 section 4a): fails when the request's ifVersion differs from the stored version. */
    fun checkVersion(key: String, actual: JsonElement?, current: JsonObject) {
        val want = ifVersion ?: return
        val a = actual ?: JsonNull
        if ((a as? JsonPrimitive)?.content != (want as? JsonPrimitive)?.content) throw VersionConflictException(key, want, a, current)
    }
}

typealias RootResolver = suspend (args: JsonObject, ctx: RayfoldContext) -> JsonElement?
typealias StreamResolver = suspend (args: JsonObject, ctx: RayfoldContext) -> Flow<JsonElement>
/** Batch loader: one call per level, results aligned with parents. */
typealias FieldLoader = suspend (parents: List<JsonObject>, args: JsonObject, ctx: RayfoldContext) -> List<JsonElement?>

/** Command return value with extra patches/events. */
class CommandResult(val result: JsonElement?, val patch: List<JsonObject> = emptyList(), val emit: List<Pair<String, JsonObject>> = emptyList())

class Resolvers(
    val queries: Map<String, RootResolver> = emptyMap(),
    val commands: Map<String, suspend (JsonObject, RayfoldContext) -> Any?> = emptyMap(),
    val streams: Map<String, StreamResolver> = emptyMap(),
    val fields: Map<String, Map<String, FieldLoader>> = emptyMap(),
)

class EventBus {
    private val subs = mutableMapOf<String, MutableList<(JsonObject) -> Unit>>()
    private var seq = 0L
    @Synchronized
    fun publish(name: String, payload: JsonObject) {
        seq++
        val enriched = JsonObject(payload + ("seq" to JsonPrimitive(seq)))
        subs[name]?.toList()?.forEach { it(enriched) }
    }
    @Synchronized
    fun on(name: String, fn: (JsonObject) -> Unit): () -> Unit {
        subs.getOrPut(name) { mutableListOf() }.add(fn)
        return { synchronized(this) { subs[name]?.remove(fn) } }
    }
}

/**
 * Shape projection with level-wise batching (mirrors packages/server/src/executor.ts).
 * Every field of every object at one nesting level is resolved with one loader call.
 */
class Executor(
    private val ir: RayfoldSchemaIR,
    private val resolvers: Resolvers,
    private val views: Views,
    private val instrumentation: Instrumentation = Instrumentation.NONE,
) {

    /** Output cells hold JsonElement, a child Slot, or a list of cells; materialised once children are projected. */
    private class Slot(val value: JsonObject, val path: String) {
        val out = linkedMapOf<String, Any?>()
        var override: JsonElement? = null
        /** true when `$type` is the only way to know this object's type (union member) */
        var unionMember = false
        fun outJson(): JsonElement = override ?: JsonObject(out.mapValues { materialize(it.value) })
        /** compact form: `$type` dropped unless this is a union member (spec 03 `compact`) */
        fun outCompact(): JsonElement = override ?: JsonObject(out.filterKeys { it != "\$type" || unionMember }.mapValues { materializeCompact(it.value) })
    }

    private class Deferred(val slots: List<Slot>, val type: TypeRef, val shape: Shape, val explicit: Boolean, val nullable: Boolean)

    private class State(val ctx: RayfoldContext, val explicit: Boolean) {
        val errors = mutableListOf<JsonObject>()
        val deferred = ArrayDeque<Deferred>()
        /** result paths of union members (their `$type` survives compact mode) */
        val unionPaths = mutableSetOf<String>()
        fun compact(v: JsonElement): JsonElement = if (ctx.compact) stripTypes(v, unionPaths) else v
    }

    private class Group(val field: FieldDef, val alias: String, val args: JsonObject, val item: ShapeItem, var shape: Shape?, var eager: Boolean, var partial: Boolean)

    // ---------------------------------------------------------------- ops

    /** [unionPaths], when given, receives the result paths of union members (their `$type` survives compaction). */
    suspend fun runQuery(op: OpDef, args: JsonObject, shape: Shape, explicit: Boolean, cost: Long, ctx: RayfoldContext, emit: (JsonObject) -> Unit, unionPaths: MutableSet<String>? = null): JsonElement {
        checkOpPolicy(op, "read", args, ctx)
        val fn = resolvers.queries[op.name] ?: throw RayfoldException(Code.UNIMPLEMENTED, "No resolver for query ${op.name}")
        val raw = fn(args, ctx)
        val st = State(ctx, explicit)
        val data = projectValue(raw, op.returns, shape, "", st)
        emit(Frames.data(ctx.opId, st.compact(data), cost, st.errors.toList(), st.deferred.isEmpty(), ctx.compact))
        flushDeferred(st, emit)
        unionPaths?.addAll(st.unionPaths)
        return data
    }

    /**
     * Returns the result with both the full and the compact `ok` frame: an idempotent replay answers in the retry's own
     * form. A failure after the resolver ran is a [CommittedCommandException], because its side effect stands.
     */
    suspend fun runCommand(op: OpDef, args: JsonObject, shape: Shape, explicit: Boolean, cost: Long, ctx: RayfoldContext, emit: (JsonObject) -> Unit, policyChecked: Boolean = false): Triple<JsonElement, JsonObject, JsonObject> {
        if (!policyChecked) checkOpPolicy(op, "write", args, ctx)
        val fn = resolvers.commands[op.name] ?: throw RayfoldException(Code.UNIMPLEMENTED, "No resolver for command ${op.name}")
        val raw = try {
            fn(args, ctx)
        } catch (e: VersionConflictException) {
            throw conflictWithCurrent(op, shape, ctx, e)
        } catch (e: RayfoldException) {
            if (e.code == Code.DOMAIN && (e.type == null || e.type !in op.throws)) throw RayfoldException(Code.INTERNAL, "${op.name} raised undeclared error ${e.type ?: "?"}")
            throw e
        }
        try {
            val cr = raw as? CommandResult ?: CommandResult(raw as JsonElement?)
            val st = State(ctx, explicit)
            val data = projectValue(cr.result, op.returns, shape, "", st)
            while (st.deferred.isNotEmpty()) { val job = st.deferred.removeFirst(); projectMany(job.slots, job.type, job.shape, st, job.nullable) }
            val patch = derivePatches(data) + cr.patch
            if (!ctx.simulate) for ((ev, payload) in cr.emit) {
                if (ev !in op.emits) throw RayfoldException(Code.INTERNAL, "${op.name} emitted undeclared event $ev")
                ctx.events.publish(ev, payload)
            }
            val full = Frames.ok(ctx.opId, data, patch, cost, st.errors.toList())
            // compact frames omit `set` patches that restate entities already in `ok`
            val compactFrame = Frames.ok(ctx.opId, stripTypes(data, st.unionPaths), cr.patch, cost, st.errors.toList(), compact = true)
            emit(if (ctx.compact) compactFrame else full)
            return Triple(data, full, compactFrame)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Throwable) {
            throw CommittedCommandException(RayfoldException.of(e))
        }
    }

    private suspend fun conflictWithCurrent(op: OpDef, shape: Shape, ctx: RayfoldContext, e: VersionConflictException): RayfoldException {
        val st = State(RayfoldContext(ctx.viewer, ctx.simulate, ctx.opId, ctx.opName, ctx.vars, ctx.events), false)
        val current = projectValue(e.current, op.returns.copy(nullable = true), shape, "", st)
        while (st.deferred.isNotEmpty()) { val job = st.deferred.removeFirst(); projectMany(job.slots, job.type, job.shape, st, job.nullable) }
        return RayfoldException(Code.FAILED_PRECONDITION, e.message ?: "VersionConflict", "VersionConflict", buildJsonObject {
            put("key", e.key); put("expected", e.expected); put("actual", e.actual); put("current", current)
        })
    }

    suspend fun runStream(op: OpDef, args: JsonObject, shape: Shape, explicit: Boolean, ctx: RayfoldContext, emit: (JsonObject) -> Unit, maxItems: Int = Int.MAX_VALUE) {
        checkOpPolicy(op, "read", args, ctx)
        val fn = resolvers.streams[op.name] ?: throw RayfoldException(Code.UNIMPLEMENTED, "No resolver for stream ${op.name}")
        var items = 0
        fn(args, ctx).collect { v ->
            if (ctx.isCancelled()) throw RayfoldException(Code.CANCELED, "Canceled")
            if (++items > maxItems) throw RayfoldException(Code.RESOURCE_EXHAUSTED, "${op.name}() yielded more than $maxItems items")
            val st = State(ctx, explicit)
            val item = projectValue(v, op.returns, shape, "", st)
            while (st.deferred.isNotEmpty()) { val job = st.deferred.removeFirst(); projectMany(job.slots, job.type, job.shape, st, job.nullable) }
            emit(Frames.item(ctx.opId, st.compact(item)))
        }
        if (ctx.isCancelled()) throw RayfoldException(Code.CANCELED, "Canceled")
        emit(Frames.fin(ctx.opId))
    }

    internal fun checkOpPolicy(op: OpDef, mode: String, args: JsonObject, ctx: RayfoldContext) {
        val d = Policy.decide(op.annotations, mode, ExprEnv(ctx.viewer, args, JsonNull))
        if (d != Policy.Decision.ALLOW) throw Policy.error(d, "${op.name}()")
    }

    private suspend fun flushDeferred(st: State, emit: (JsonObject) -> Unit) {
        if (st.deferred.isEmpty()) return
        while (st.deferred.isNotEmpty()) {
            val job = st.deferred.removeFirst()
            val fresh = job.slots.map { s -> Slot(s.value, s.path) }
            val sub = State(st.ctx, job.explicit)
            sub.deferred.addAll(st.deferred); st.deferred.clear()
            projectMany(fresh, job.type, job.shape, sub, job.nullable)
            st.deferred.addAll(sub.deferred)
            st.unionPaths.addAll(sub.unionPaths)
            for (s in fresh) {
                s.out.remove("\$type")
                val errs = sub.errors.filter { (it["path"] as? JsonPrimitive)?.content?.startsWith(s.path) == true }
                emit(Frames.at(st.ctx.opId, s.path, if (st.ctx.compact) s.outCompact() else s.outJson(), errs))
            }
        }
        emit(Frames.fin(st.ctx.opId))
    }

    // ---------------------------------------------------------- projection

    private suspend fun projectValue(value: JsonElement?, t: TypeRef, shape: Shape, path: String, st: State): JsonElement {
        if (value == null || value is JsonNull) {
            if (!t.nullable) throw RayfoldException(Code.INTERNAL, "Non-null ${path.ifEmpty { "result" }} resolved to null", path = path)
            return JsonNull
        }
        if (t.isList) {
            val arr = value as? JsonArray ?: throw RayfoldException(Code.INTERNAL, "${path.ifEmpty { "result" }} should be a list", path = path)
            val cells = arrayOfNulls<Any>(arr.size)
            val slots = mutableListOf<Slot>()
            val elem = t.element
            arr.forEachIndexed { i, v ->
                val p = if (path.isEmpty()) "$i" else "$path.$i"
                if (v is JsonNull) {
                    if (!elem.nullable) throw RayfoldException(Code.INTERNAL, "Non-null $p resolved to null", path = p)
                    cells[i] = JsonNull
                } else if (elem.isList || ir.isScalarLike(elem)) {
                    cells[i] = projectValue(v, elem, shape, p, st)
                } else {
                    val s = Slot(v as JsonObject, p)
                    slots.add(s); cells[i] = s
                }
            }
            if (slots.isNotEmpty()) projectMany(slots, elem, shape, st, nullable = false) // list elements keep their errors
            return JsonArray(cells.map { materialize(it) })
        }
        if (ir.isScalarLike(t)) return value
        val obj = value as? JsonObject ?: throw RayfoldException(Code.INTERNAL, "${path.ifEmpty { "result" }} should be an object", path = path)
        val slot = Slot(obj, path)
        projectMany(listOf(slot), t, shape, st, t.nullable)
        return slot.outJson()
    }

    /** [nullable]: the slots sit at a nullable position that is not a list element, where a denied entity reads as null. */
    private suspend fun projectMany(slots: List<Slot>, t: TypeRef, shape: Shape, st: State, nullable: Boolean) {
        if (slots.isEmpty()) return
        val def = ir.types[t.listBase().name] ?: throw RayfoldException(Code.INTERNAL, "Unknown type ${t.baseName()}")

        if (def.kind == "union") {
            val groups = linkedMapOf<String, MutableList<Slot>>()
            for (s in slots) {
                val tn = (s.value["\$type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                if (tn == null || tn !in def.members) throw RayfoldException(Code.INTERNAL, "Union ${def.name} value at ${s.path} lacks a valid \$type", path = s.path)
                s.out["\$type"] = JsonPrimitive(tn)
                s.unionMember = true
                st.unionPaths.add(s.path)
                groups.getOrPut(tn) { mutableListOf() }.add(s)
            }
            for ((tn, group) in groups) {
                val items = shape.items.flatMap { it -> when { it.kind == "on" && it.type == tn -> it.subShape.items; it.kind == "spread" || it.kind == "field" -> listOf(it); else -> emptyList() } }
                val ref = TypeRef("named", tn)
                projectMany(group, ref, if (items.isNotEmpty()) Shape(items) else views.defaultShape(ref), st, nullable)
            }
            return
        }
        if (!def.hasFields) throw RayfoldException(Code.INTERNAL, "Cannot project ${def.kind} ${def.name}")

        var allowed = slots
        if (def.annotations.isNotEmpty()) {
            allowed = mutableListOf()
            for (s in slots) {
                val d = Policy.decide(def.annotations, "read", ExprEnv(st.ctx.viewer, JsonObject(emptyMap()), s.value))
                if (d == Policy.Decision.ALLOW) allowed.add(s)
                // an explicit shape fails, except at a nullable position: there a denied entity reads exactly like a missing one
                else if (st.explicit && !nullable) throw Policy.error(d, "${def.name} at ${s.path.ifEmpty { "result" }}").withPath(s.path)
                else { s.out.clear(); s.override = JsonNull } // default views never fail (spec 06 section 3)
            }
        }
        if (def.kind == "entity") for (s in allowed) s.out["\$type"] = JsonPrimitive(def.name)

        val fields = ir.fieldsOf(t) ?: def.fields
        val (groups, defers) = flatten(shape, def, fields, st)

        class Child(val slots: List<Slot>, val type: TypeRef, val shape: Shape, val explicit: Boolean, val nullable: Boolean)
        val children = mutableListOf<Child>()

        for (g in groups) {
            val field = g.field
            val lazy = field.annotations.find("lazy") != null && !g.eager
            if (lazy) { st.deferred.add(Deferred(allowed, t, Shape(listOf(g.item.copy(eager = true))), st.explicit, nullable)); continue }
            var targets = allowed
            if (field.annotations.isNotEmpty()) {
                targets = mutableListOf()
                for (s in allowed) {
                    val d = Policy.decide(field.annotations, "read", ExprEnv(st.ctx.viewer, g.args, s.value))
                    if (d == Policy.Decision.ALLOW) targets.add(s)
                    else if (st.explicit && !g.partial) throw Policy.error(d, "${def.name}.${field.name}").withPath(join(s.path, g.alias))
                    else if (st.explicit) { st.errors.add(Policy.error(d, "${def.name}.${field.name}").withPath(join(s.path, g.alias)).toWire()); s.out[g.alias] = JsonNull }
                }
            }
            if (targets.isEmpty()) continue
            val values: List<JsonElement?> = try {
                loadField(def, field, targets, g.args, st.ctx)
            } catch (e: Throwable) {
                if (g.partial) {
                    val w = RayfoldException.of(e)
                    for (s in targets) { st.errors.add(w.withPath(join(s.path, g.alias)).toWire()); s.out[g.alias] = JsonNull }
                    continue
                }
                throw if (e is RayfoldException) e.withPath(join(targets[0].path, g.alias)) else e
            }
            if (values.size != targets.size) throw RayfoldException(Code.INTERNAL, "Loader for ${def.name}.${field.name} returned ${values.size} for ${targets.size} parents")
            val scalar = ir.isScalarLike(field.type)
            val childSlots = mutableListOf<Slot>()
            targets.forEachIndexed { i, s ->
                val v = values[i]
                val p = join(s.path, g.alias)
                if (v == null || v is JsonNull) {
                    if (!field.type.nullable) {
                        val err = RayfoldException(Code.INTERNAL, "Non-null field ${def.name}.${field.name} resolved to null", path = p)
                        if (!g.partial) throw err
                        st.errors.add(err.toWire())
                    }
                    s.out[g.alias] = JsonNull
                    return@forEachIndexed
                }
                if (scalar) { s.out[g.alias] = v; return@forEachIndexed }
                if (field.type.isList) {
                    val arr = v as? JsonArray ?: throw RayfoldException(Code.INTERNAL, "$p should be a list", path = p)
                    val cells = ArrayList<Any?>(arr.size)
                    arr.forEachIndexed { j, el ->
                        if (el is JsonNull) {
                            if (!field.type.element.nullable) throw RayfoldException(Code.INTERNAL, "Non-null $p.$j resolved to null", path = "$p.$j")
                            cells.add(JsonNull)
                        } else {
                            val cs = Slot(el as JsonObject, "$p.$j")
                            childSlots.add(cs); cells.add(cs)
                        }
                    }
                    s.out[g.alias] = cells
                } else {
                    val cs = Slot(v as JsonObject, p)
                    childSlots.add(cs)
                    s.out[g.alias] = cs
                }
            }
            if (childSlots.isNotEmpty()) {
                val childType = if (field.type.isList) field.type.element else field.type
                val sub = g.shape ?: views.defaultShape(childType)
                children.add(Child(childSlots, childType, sub, if (g.shape != null) st.explicit else false, !field.type.isList && field.type.nullable))
            }
        }
        for (c in children) {
            if (c.explicit == st.explicit) projectMany(c.slots, c.type, c.shape, st, c.nullable)
            else {
                val sub = State(st.ctx, c.explicit)
                projectMany(c.slots, c.type, c.shape, sub, c.nullable)
                st.errors.addAll(sub.errors); st.deferred.addAll(sub.deferred)
            }
        }
        for (d in defers) st.deferred.add(Deferred(allowed, t, d, st.explicit, nullable))
    }

    private suspend fun loadField(def: TypeDef, field: FieldDef, targets: List<Slot>, args: JsonObject, ctx: RayfoldContext): List<JsonElement?> {
        val loader = resolvers.fields[def.name]?.get(field.name)
        if (loader == null) {
            if (field.args.isNotEmpty()) throw RayfoldException(Code.UNIMPLEMENTED, "No loader for ${def.name}.${field.name}")
            return targets.map { it.value[field.name] }
        }
        return instrumentation.loader(LoaderInfo(def.name, field.name, targets.size)) { loader(targets.map { it.value }, args, ctx) }
    }

    private fun flatten(shape: Shape, def: TypeDef, fields: List<FieldDef>, st: State): Pair<List<Group>, List<Shape>> {
        val groups = mutableListOf<Group>()
        val defers = mutableListOf<Shape>()
        val byAlias = linkedMapOf<String, Group>()
        fun visit(items: List<ShapeItem>, seen: Set<String>) {
            for (it in items) when (it.kind) {
                "field" -> {
                    val f = fields.firstOrNull { x -> x.name == it.name } ?: throw RayfoldException(Code.INVALID_ARGUMENT, "${def.name} has no field ${it.name}")
                    val alias = it.alias ?: it.fieldName
                    val args = if (f.args.isNotEmpty()) Args.coerce(ir, f.args, substituteVarsStrict(JsonObject(it.args ?: emptyMap()), st.ctx.vars), "${def.name}.${it.name}") else JsonObject(emptyMap())
                    val existing = byAlias[alias]
                    if (existing != null) {
                        if (existing.field !== f || existing.args != args) throw RayfoldException(Code.INVALID_ARGUMENT, "Conflicting selections for $alias on ${def.name}")
                        if (it.shape != null) existing.shape = existing.shape?.let { s -> Shape(s.items + it.shape.items) } ?: it.shape
                        if (it.eager) existing.eager = true
                        if (it.partial) existing.partial = true
                        continue
                    }
                    val g = Group(f, alias, args, it, it.shape, it.eager, it.partial || f.annotations.find("partial") != null)
                    byAlias[alias] = g; groups.add(g)
                }
                "spread" -> {
                    val key = "${it.type}.${it.view}"
                    val v = ir.views[key] ?: throw RayfoldException(Code.INVALID_ARGUMENT, "Unknown view $key")
                    if (key in seen) throw RayfoldException(Code.INVALID_ARGUMENT, "View cycle at $key")
                    visit(v.shape.items, seen + key)
                }
                "on" -> if (it.type == def.name || (def.kind == "entity" && it.type in def.implements)) visit(it.subShape.items, seen)
                "defer" -> defers.add(it.subShape)
            }
        }
        visit(shape.items, emptySet())
        return groups to defers
    }

    private fun substituteVarsStrict(v: JsonElement, vars: JsonObject): JsonElement = when (v) {
        is JsonArray -> JsonArray(v.map { substituteVarsStrict(it, vars) })
        is JsonObject -> {
            val name = (v["\$var"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (name != null && v.size == 1) vars[name] ?: throw RayfoldException(Code.INVALID_ARGUMENT, "Missing shape variable \$$name")
            else JsonObject(v.mapValues { (_, x) -> substituteVarsStrict(x, vars) })
        }
        else -> v
    }

    private fun join(path: String, name: String) = if (path.isEmpty()) name else "$path.$name"

    companion object {
        private fun materialize(cell: Any?): JsonElement = when (cell) {
            null -> JsonNull
            is JsonElement -> cell
            is Slot -> cell.outJson()
            is List<*> -> JsonArray(cell.map { materialize(it) })
            else -> JsonNull
        }
        private fun materializeCompact(cell: Any?): JsonElement = when (cell) {
            null -> JsonNull
            is JsonElement -> cell
            is Slot -> cell.outCompact()
            is List<*> -> JsonArray(cell.map { materializeCompact(it) })
            else -> JsonNull
        }

        /** Post-projection compact stripping for values that were already materialised (lists at the root). */
        fun stripTypes(v: JsonElement, unionPaths: Set<String> = emptySet(), path: String = ""): JsonElement = when (v) {
            is JsonArray -> JsonArray(v.mapIndexed { i, x -> stripTypes(x, unionPaths, if (path.isEmpty()) "$i" else "$path.$i") })
            is JsonObject -> JsonObject(v.filterKeys { it != "\$type" || path in unionPaths }.mapValues { (k, x) -> stripTypes(x, unionPaths, if (path.isEmpty()) k else "$path.$k") })
            else -> v
        }

        /** Every entity object in a projected result becomes a `set` patch (spec/04 section 2). */
        fun derivePatches(data: JsonElement): List<JsonObject> {
            val out = linkedMapOf<String, MutableMap<String, JsonElement>>()
            fun walk(v: JsonElement) {
                when (v) {
                    is JsonArray -> v.forEach { walk(it) }
                    is JsonObject -> {
                        val tn = (v["\$type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                        val id = (v["id"] as? JsonPrimitive)?.content
                        if (tn != null && id != null) {
                            val shallow = out.getOrPut("$tn:$id") { linkedMapOf() }
                            for ((k, x) in v) shallow[k] = toRef(x)
                        }
                        v.values.forEach { walk(it) }
                    }
                    else -> {}
                }
            }
            walk(data)
            return out.map { (key, value) -> buildJsonObject { put("set", key); put("value", JsonObject(value)) } }
        }

        private fun toRef(v: JsonElement): JsonElement = when (v) {
            is JsonArray -> JsonArray(v.map { toRef(it) })
            is JsonObject -> {
                val tn = (v["\$type"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                if (tn != null && v["id"] != null) buildJsonObject { put("\$ref", "$tn:${(v["id"] as JsonPrimitive).content}") }
                else JsonObject(v.mapValues { (_, x) -> toRef(x) })
            }
            else -> v
        }
    }
}
