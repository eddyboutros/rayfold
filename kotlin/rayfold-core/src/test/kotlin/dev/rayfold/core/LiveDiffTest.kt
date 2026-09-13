package dev.rayfold.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * The structural half of [Live.diffResults] (spec 04 section 2b), case for case with
 * packages/server/src/live.test.ts: rows added to and removed from a list, fields of a plain object, and the
 * differences that cannot be described and so send the whole result.
 */
class LiveDiffTest {
    private fun row(id: String, state: String = "TODO"): JsonObject = buildJsonObject {
        put("\$type", "Issue")
        put("id", id)
        put("state", state)
    }

    private fun page(ids: List<String>, state: String = "TODO"): JsonObject = buildJsonObject {
        put("items", JsonArray(ids.map { row(it, state) }))
        put("total", ids.size)
    }

    private fun patchOf(prev: JsonElement, next: JsonElement): List<JsonObject> =
        (Live.diffResults(prev, next) as Live.Diff.Patch).patch

    private val five = listOf("i1", "i2", "i3", "i4", "i5")

    @Test
    fun `a row added to a list costs the row, not the page`() {
        val prev = page(five)
        val next = buildJsonObject {
            put("items", JsonArray(listOf(row("i9")) + five.map { row(it) }))
            put("total", 6)
        }
        assertEquals(
            listOf(
                buildJsonObject {
                    put("list", "items")
                    put("ins", buildJsonArray { add(buildJsonObject { put("at", 0); put("value", row("i9")) }) })
                },
                buildJsonObject { put("at", ""); put("value", buildJsonObject { put("total", 6) }) },
            ),
            patchOf(prev, next),
        )
    }

    @Test
    fun `a row removed costs its position`() {
        val prev = page(five)
        val next = page(five.filterIndexed { n, _ -> n != 2 })
        assertEquals(
            listOf(
                buildJsonObject {
                    put("list", "items")
                    put("del", buildJsonArray { add(JsonPrimitive(2)) })
                },
                buildJsonObject { put("at", ""); put("value", buildJsonObject { put("total", 4) }) },
            ),
            patchOf(prev, next),
        )
    }

    @Test
    fun `a field of an entity still travels as set`() {
        val prev = page(five)
        val next = buildJsonObject {
            put("items", JsonArray(listOf(row("i1", "DONE")) + five.drop(1).map { row(it) }))
            put("total", 5)
        }
        assertEquals(
            listOf(buildJsonObject { put("set", "Issue:i1"); put("value", buildJsonObject { put("state", "DONE") }) }),
            patchOf(prev, next),
        )
    }

    @Test
    fun `a board describes the row that moved and the two counts, not the six columns`() {
        fun column(state: String, ids: List<String>) = buildJsonObject {
            put("state", state)
            put("count", ids.size)
            put("issues", page(ids, state))
        }
        val todo = listOf("i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8")
        val doing = listOf("i9", "i10", "i11", "i12", "i13", "i14", "i15", "i16")
        val rest = listOf(column("REVIEW", listOf("i17", "i18")), column("DONE", listOf("i19", "i20")), column("TRIAGE", listOf("i21")), column("BACKLOG", listOf("i22")))
        val prev = buildJsonObject { put("columns", JsonArray(listOf(column("TODO", todo), column("DOING", doing)) + rest)) }
        val next = buildJsonObject { put("columns", JsonArray(listOf(column("TODO", todo.drop(1)), column("DOING", listOf("i1") + doing)) + rest)) }
        assertEquals(
            listOf(
                buildJsonObject { put("list", "columns.0.issues.items"); put("del", buildJsonArray { add(JsonPrimitive(0)) }) },
                buildJsonObject { put("at", "columns.0.issues"); put("value", buildJsonObject { put("total", 7) }) },
                buildJsonObject { put("at", "columns.0"); put("value", buildJsonObject { put("count", 7) }) },
                buildJsonObject {
                    put("list", "columns.1.issues.items")
                    put("ins", buildJsonArray { add(buildJsonObject { put("at", 0); put("value", row("i1", "DOING")) }) })
                },
                buildJsonObject { put("at", "columns.1.issues"); put("value", buildJsonObject { put("total", 9) }) },
                buildJsonObject { put("at", "columns.1"); put("value", buildJsonObject { put("count", 9) }) },
            ),
            patchOf(prev, next),
        )
    }

    @Test
    fun `a result that gained a field cannot be described, so the whole result is sent`() {
        val prev = page(five)
        val widened = buildJsonObject {
            put("items", JsonArray(five.map { row(it) }))
            put("total", 5)
            put("cursor", "c1")
        }
        assertEquals(widened, (Live.diffResults(prev, widened) as Live.Diff.Data).data)
    }
}
