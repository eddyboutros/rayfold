package dev.rayfold.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Policy evaluation (spec/06). Absent allow = allowed; deny after allow; viewer-dependent denial without a viewer =
 * unauthenticated. An expression that cannot be evaluated ([ExprError]) fails closed: a broken allow does not admit
 * and a broken deny denies.
 */
object Policy {
    enum class Decision { ALLOW, DENY, UNAUTHENTICATED }

    private fun expr(annotations: List<Annotation>, name: String, mode: String): JsonObject? =
        annotations.find(name)?.args?.get(mode).exprOrNull()

    fun hasPolicy(annotations: List<Annotation>, mode: String): Boolean =
        expr(annotations, "allow", mode) != null || expr(annotations, "deny", mode) != null

    fun decide(annotations: List<Annotation>, mode: String, env: ExprEnv): Decision {
        val allow = expr(annotations, "allow", mode)
        val deny = expr(annotations, "deny", mode)
        if (allow == null && deny == null) return Decision.ALLOW
        fun denied(e: JsonObject) = if (env.viewer is JsonNull && Expr.referencesViewer(e)) Decision.UNAUTHENTICATED else Decision.DENY
        fun holds(e: JsonObject, onError: Boolean) = try { Expr.eval(e, env) == JsonPrimitive(true) } catch (x: ExprError) { onError }
        if (allow != null && !holds(allow, onError = false)) return denied(allow)
        if (deny != null && holds(deny, onError = true)) return denied(deny)
        return Decision.ALLOW
    }

    /**
     * The part of a type's read policy a data source can apply itself (spec 06 section 4), or null when nothing can
     * be pushed. A `deny` needs the runtime's own check, so nothing is pushed when one is present.
     */
    fun pushableFilter(annotations: List<Annotation>): JsonObject? {
        if (expr(annotations, "deny", "read") != null) return null
        val allow = expr(annotations, "allow", "read") ?: return null
        return if (isPushable(allow)) allow else null
    }

    /** Mirrors isPushable in packages/schema/src/expr.ts: what a data source can evaluate without the row's shape. */
    fun isPushable(e: JsonObject): Boolean = when (e["k"]?.jsonPrimitive?.content) {
        "lit" -> true
        // a path into the row itself is pushable only when it names one of its own columns
        "path" -> (e["root"]?.jsonPrimitive?.content ?: "this") != "this" || (e["path"] as? JsonArray)?.size == 1
        "not" -> (e["e"] as? JsonObject)?.let { isPushable(it) } == true
        "bin" -> (e["l"] as? JsonObject)?.let { isPushable(it) } == true && (e["r"] as? JsonObject)?.let { isPushable(it) } == true
        "list" -> (e["items"] as? JsonArray)?.all { it is JsonObject && isPushable(it) } == true
        "call" -> e["fn"]?.jsonPrimitive?.content != "now" && (e["args"] as? JsonArray)?.all { a ->
            a is JsonObject && isPushable(a) && !((a["k"]?.jsonPrimitive?.content == "path") && (a["root"]?.jsonPrimitive?.content ?: "this") == "this")
        } == true
        else -> false
    }

    fun error(d: Decision, what: String): RayfoldException = if (d == Decision.UNAUTHENTICATED)
        RayfoldException(Code.UNAUTHENTICATED, "Sign in to access $what")
    else RayfoldException(Code.PERMISSION_DENIED, "Not allowed to access $what")
}
