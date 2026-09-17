package dev.rayfold.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Protocol error codes (spec/05 section 2). */
enum class Code(val wire: String) {
    CANCELED("canceled"), UNKNOWN("unknown"), INVALID_ARGUMENT("invalid_argument"), DEADLINE_EXCEEDED("deadline_exceeded"),
    NOT_FOUND("not_found"), ALREADY_EXISTS("already_exists"), PERMISSION_DENIED("permission_denied"),
    RESOURCE_EXHAUSTED("resource_exhausted"), FAILED_PRECONDITION("failed_precondition"), ABORTED("aborted"),
    OUT_OF_RANGE("out_of_range"), UNIMPLEMENTED("unimplemented"), INTERNAL("internal"), UNAVAILABLE("unavailable"),
    DATA_LOSS("data_loss"), UNAUTHENTICATED("unauthenticated"), DOMAIN("domain");
}

/** Thrown by resolvers and the runtime; becomes an `error` frame member. */
class RayfoldException(
    val code: Code,
    override val message: String,
    val type: String? = null,
    val data: JsonElement? = null,
    val path: String? = null,
) : RuntimeException(message) {
    fun withPath(p: String) = RayfoldException(code, message, type, data, p)

    fun toWire(): JsonObject = buildJsonObject {
        put("code", code.wire)
        if (type != null) put("type", type)
        put("message", message)
        if (data != null) put("data", data)
        if (path != null) put("path", path)
    }

    companion object {
        fun domain(type: String, data: JsonElement, message: String = type) = RayfoldException(Code.DOMAIN, message, type, data)
        fun of(e: Throwable): RayfoldException = e as? RayfoldException ?: RayfoldException(Code.INTERNAL, "Internal error")
    }
}

/** Raised by [RayfoldContext.checkVersion]; the executor turns it into a VersionConflict carrying the current entity. */
class VersionConflictException(val key: String, val expected: JsonElement, val actual: JsonElement, val current: JsonObject) :
    RuntimeException("$key is at version ${(actual as? JsonPrimitive)?.content ?: actual}, not ${(expected as? JsonPrimitive)?.content ?: expected}")

/** One request op (spec/03 section 1). */
data class RequestOp(
    val id: Int,
    val op: String,
    val args: JsonObject = JsonObject(emptyMap()),
    val shape: String? = null,
    val vars: JsonObject = JsonObject(emptyMap()),
    val key: String? = null,
    val live: Boolean = false,
    val deadline: Long? = null,
    val simulate: Boolean = false,
    val compact: Boolean = false,
    val ifVersion: JsonElement? = null,
) {
    companion object {
        const val MAX_DEADLINE_MS = 600_000L

        fun from(o: JsonObject): RequestOp = RequestOp(
            id = StrictJson.integerOrNull(o["id"])?.toIntOrNull() ?: -1, // "2", 1.9 and 1e12 are not ids
            op = (o["op"] as? JsonPrimitive)?.content ?: "",
            args = o["args"] as? JsonObject ?: JsonObject(emptyMap()),
            shape = (o["shape"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            vars = o["vars"] as? JsonObject ?: JsonObject(emptyMap()),
            key = (o["key"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            live = (o["live"] as? JsonPrimitive)?.content == "true",
            deadline = StrictJson.integerOrNull(o["deadline"])?.toLongOrNull()?.takeIf { it in 0..MAX_DEADLINE_MS },
            simulate = (o["simulate"] as? JsonPrimitive)?.content == "true",
            compact = (o["compact"] as? JsonPrimitive)?.content == "true",
            ifVersion = o["ifVersion"]?.takeIf { it !is JsonNull },
        )
    }
}

data class RequestEnvelope(val ops: List<RequestOp>, val meta: JsonObject = JsonObject(emptyMap()), val raw: JsonObject) {
    companion object {
        fun from(o: JsonObject): RequestEnvelope {
            // a non-object entry becomes an empty placeholder; BatchRunner.validate reports it as `ops[i]: expected an object`
            val ops = (o["ops"] as? JsonArray)?.map { RequestOp.from(it as? JsonObject ?: JsonObject(emptyMap())) } ?: emptyList()
            return RequestEnvelope(ops, o["meta"] as? JsonObject ?: JsonObject(emptyMap()), o)
        }
    }
}

/** Frames are plain JSON objects so conformance can compare them structurally (spec/04 section 1). */
object Frames {
    fun data(id: Int, data: JsonElement, cost: Long, errors: List<JsonObject>, fin: Boolean, compact: Boolean = false): JsonObject = buildJsonObject {
        put("id", id); put("data", data)
        if (!compact) put("meta", buildJsonObject { put("cost", cost) })
        if (errors.isNotEmpty()) put("errors", JsonArray(errors))
        if (fin) put("fin", true)
    }
    fun ok(id: Int, ok: JsonElement, patch: List<JsonObject>, cost: Long, errors: List<JsonObject>, replay: Boolean = false, compact: Boolean = false): JsonObject = buildJsonObject {
        put("id", id); put("ok", ok); put("patch", JsonArray(patch))
        if (!compact) put("meta", buildJsonObject { put("cost", cost); if (replay) put("replay", true) })
        if (errors.isNotEmpty()) put("errors", JsonArray(errors))
        put("fin", true)
    }
    /** spec 04 section 2: an `item` frame carries `errors` of its own, as a `data` frame does. */
    fun item(id: Int, item: JsonElement, errors: List<JsonObject> = emptyList()): JsonObject = buildJsonObject {
        put("id", id); put("item", item)
        if (errors.isNotEmpty()) put("errors", JsonArray(errors))
    }
    fun patch(id: Int, patch: List<JsonObject>): JsonObject = buildJsonObject { put("id", id); put("patch", JsonArray(patch)) }
    fun at(id: Int, at: String, data: JsonElement, errors: List<JsonObject>): JsonObject = buildJsonObject {
        put("id", id); put("at", at); put("data", data)
        if (errors.isNotEmpty()) put("errors", JsonArray(errors))
    }
    fun error(id: Int, e: RayfoldException): JsonObject = buildJsonObject { put("id", id); put("error", e.toWire()); put("fin", true) }
    fun fin(id: Int): JsonObject = buildJsonObject { put("id", id); put("fin", true) }
    fun batchError(e: RayfoldException): JsonObject = buildJsonObject { put("error", e.toWire()); put("fin", true) }
}

val NULL: JsonElement = JsonNull
