package dev.rayfold.core

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

    fun error(d: Decision, what: String): RayfoldException = if (d == Decision.UNAUTHENTICATED)
        RayfoldException(Code.UNAUTHENTICATED, "Sign in to access $what")
    else RayfoldException(Code.PERMISSION_DENIED, "Not allowed to access $what")
}
