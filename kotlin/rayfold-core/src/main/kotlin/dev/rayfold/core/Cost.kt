package dev.rayfold.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class CostEstimate(val cost: Long, val depth: Int, val fields: Int)

/** Saturating Long arithmetic: a cost may grow without bound but never wraps around to a small or negative number. */
object Sat {
    fun add(a: Long, b: Long): Long {
        val r = a + b
        return if (((a xor r) and (b xor r)) < 0) (if (a < 0) Long.MIN_VALUE else Long.MAX_VALUE) else r
    }

    fun mul(a: Long, b: Long): Long = try {
        Math.multiplyExact(a, b)
    } catch (e: ArithmeticException) {
        if ((a < 0) != (b < 0)) Long.MIN_VALUE else Long.MAX_VALUE
    }
}

/**
 * Static cost (mirrors packages/server/src/cost.ts): op base + perItem*first + per-field costs multiplied by enclosing
 * page sizes. Bad input can only raise an estimate: a page size that is not a whole number in [0, 200] (negative,
 * huge, fractional, a string, a `$ref`, a missing variable) counts as 200, every op costs at least 1, and the
 * arithmetic saturates. Planning passes coerced op args when it has them, so a valid page size is already clamped.
 */
class Cost(private val ir: RayfoldSchemaIR, private val views: Views) {
    private class Acc(var fields: Int = 0, var depth: Int = 0)

    fun estimate(op: OpDef, args: JsonObject, shape: Shape, vars: JsonObject): CostEstimate {
        val c = op.annotations.find("cost")
        val base = weight(c?.args?.get("base"), 1)
        val perItem = weight(c?.args?.get("perItem"), if (op.returns.isPage) 1L else 0L)
        val first = if (op.returns.isPage) pageFirst(args, op.args) else 1L
        val acc = Acc()
        val shapeCost = walk(op.returns, shape, 1, first, 1, acc, vars)
        return CostEstimate(maxOf(1L, Sat.add(Sat.add(base, Sat.mul(perItem, first)), shapeCost)), acc.depth, acc.fields)
    }

    private fun walk(t: TypeRef, shape: Shape, mult: Long, itemsFirst: Long, depth: Int, acc: Acc, vars: JsonObject): Long {
        acc.depth = maxOf(acc.depth, depth)
        val isPage = t.isPage || (t.isList && t.of?.isPage == true)
        var total = 0L
        fun visit(items: List<ShapeItem>, ref: TypeRef) {
            val union = ir.types[ref.baseName()]
            if (union?.kind == "union") {
                // every member answers a union's bare fields, spreads and deferred items, so the dearest member counts;
                // looked up on the union itself they cost nothing (mirrors cost.ts)
                val bare = items.filter { it.kind != "on" }
                val total0 = total
                val fields0 = acc.fields
                var worst = 0L
                var worstFields = 0
                for (m in union.members) {
                    total = 0L
                    acc.fields = 0
                    visit(bare, TypeRef("named", m))
                    worst = maxOf(worst, total)
                    worstFields = maxOf(worstFields, acc.fields)
                }
                total = Sat.add(total0, worst)
                acc.fields = fields0 + worstFields
                for (it in items) if (it.kind == "on") it.shape?.let { s -> visit(s.items, TypeRef("named", it.type)) }
                return
            }
            val fields = ir.fieldsOf(ref) ?: emptyList()
            for (it in items) when (it.kind) {
                "field" -> {
                    acc.fields++
                    val f = fields.firstOrNull { x -> x.name == it.name }
                    val fc = f?.annotations?.find("cost")
                    val childFirst = if (f != null && f.type.isPage) {
                        pageFirst(substituteVars(JsonObject(it.args ?: emptyMap()), vars) as? JsonObject ?: JsonObject(emptyMap()), f.args)
                    } else 1L
                    // scalars and enums come with the row already loaded; a field that returns objects costs 1, and a page
                    // 1 more per row, unless @cost says otherwise
                    val defaultBase = if (f != null && ir.isScalarLike(f.type)) 0L else 1L
                    val defaultPerItem = if (f != null && f.type.isPage) 1L else 0L
                    val own = Sat.add(weight(fc?.args?.get("base"), defaultBase), Sat.mul(weight(fc?.args?.get("perItem"), defaultPerItem), childFirst))
                    total = Sat.add(total, Sat.mul(mult, own))
                    if (f != null && !ir.isScalarLike(f.type)) {
                        val sub = it.shape ?: views.defaultShape(f.type)
                        val childMult = if (isPage && it.name == "items") Sat.mul(mult, itemsFirst) else mult
                        total = Sat.add(total, walk(f.type, sub, childMult, childFirst, depth + 1, acc, vars))
                    }
                }
                "spread" -> ir.views["${it.type}.${it.view}"]?.let { v -> visit(v.shape.items, ref) }
                "on" -> it.shape?.let { s -> visit(s.items, TypeRef("named", it.type)) }
                "defer" -> it.shape?.let { s -> visit(s.items, ref) }
            }
        }
        visit(shape.items, t)
        return total
    }

    private fun pageFirst(args: JsonObject, defs: List<ArgDef>): Long {
        // the PageArgs argument by its type, whatever the schema calls it (mirrors cost.ts)
        val name = defs.firstOrNull { it.type.baseName() == "PageArgs" }?.name ?: "page"
        when (val page = args[name]) {
            null, JsonNull -> {}
            is JsonObject -> {
                if (Args.isRef(page)) return MAX_PAGE
                page["first"]?.let { return pageSize(it) }
            }
            else -> return MAX_PAGE
        }
        args["first"]?.let { return pageSize(it) }
        (defs.firstOrNull { it.name == name }?.default as? JsonObject)?.get("first")?.let { return pageSize(it) }
        defs.firstOrNull { it.name == "first" }?.default?.let { return pageSize(it) }
        return 20
    }

    private fun pageSize(v: JsonElement): Long = StrictJson.integerOrNull(v)?.toLongOrNull()?.takeIf { it in 0..MAX_PAGE } ?: MAX_PAGE

    /** A schema `@cost` weight; never negative, so an annotation cannot lower what the shape adds up to. */
    private fun weight(v: JsonElement?, default: Long): Long = v.numberOrNull()?.takeIf { it.isFinite() }?.let { maxOf(0.0, it).toLong() } ?: default

    companion object {
        private val MAX_PAGE = Args.MAX_PAGE_FIRST.toLong()

        fun substituteVars(v: JsonElement, vars: JsonObject): JsonElement = when (v) {
            is JsonArray -> JsonArray(v.map { substituteVars(it, vars) })
            is JsonObject -> {
                val name = (v["\$var"] as? JsonPrimitive)?.takeIf { it.isString }?.content
                // lenient: estimation runs before execution; the executor reports a missing variable
                if (name != null && v.size == 1) vars[name] ?: JsonNull
                else JsonObject(v.mapValues { (_, x) -> substituteVars(x, vars) })
            }
            else -> v
        }
    }
}
