package dev.rayfold.generated.edges

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

/**
 * Edges.kt is `rayfold gen kotlin` output for the names and defaults Kotlin reads differently (gen-ts-kotlin.test.ts
 * checks the file is exactly what the generator writes). That it compiles here is the proof; this uses it as a caller.
 */
class EdgesTest {
    private val json = Json { ignoreUnknownKeys = false }

    @Test
    fun `a field named type and one named for a keyword keep their JSON names beside the discriminator`() {
        val account = json.decodeFromString(Account.serializer(), """{"${'$'}type":"Account","id":"a1","type":"admin","when":"now"}""")
        assertEquals(Account(id = "a1", type = "admin", `when` = "now"), account)
        assertEquals("Account", account.type_)
        assertEquals("""{"id":"a1","type":"admin","when":"now","class":"c"}""", Json.encodeToString(Account.serializer(), account.copy(`class` = "c")))
    }

    @Test
    fun `defaults are values of the declared types, and a dollar sign is text`() {
        val f = Filter()
        assertEquals(Format.PAPER, f.format)
        assertEquals(listOf(Format.PAPER, Format.`in`), f.formats)
        assertEquals(1.0, f.min)
        assertEquals(1e21, f.big)
        assertEquals("\$5 and \${x} \u000c", f.price)
        assertEquals(buildJsonObject { put("a-b", JsonArray(listOf(JsonPrimitive(1), JsonPrimitive(true)))) }, f.meta)
        assertEquals(PageArgs(first = 5), f.page)
        assertEquals(Prefs(notify = true), f.prefs)
        assertEquals(Ops.AArgs(p = Prefs(notify = false), f = f, `in` = 3, `object` = Format.EBOOK), Ops.AArgs(p = Prefs(notify = false), f = f))
    }
}
