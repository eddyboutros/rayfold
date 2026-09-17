package dev.rayfold.core

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Uploads arrive on a route of their own and a command names what arrived (spec 04 section 9; mirrors
 * packages/server/src/uploads.test.ts). What is checked here is what a write is checked for anywhere else: who sent
 * it, where from, in what form, and how much of it (spec 12 sections 2 and 3). Every request carries a 5 s timeout, and
 * each test has its own server, store and listener.
 */
class UploadTest {
    private val ir = SchemaText.load("entity Avatar { id: ID bytes: Int } command setAvatar(userId: ID, upload: ID): Avatar").ir
    private val key = "0123456789abcdef"
    private val u1 = obj("""{"id":"u1"}""")
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val started = mutableListOf<HttpServer>()

    @AfterEach
    fun stop() {
        started.forEach { it.stop(0) }
        client.shutdownNow()
    }

    private fun bytes(n: Int) = ByteArray(n) { 65 }

    /** What a resolver did with an upload: whose it was and how many bytes it read. */
    private class Taken(val userId: String, val size: Int)

    private class Served(val base: String, val store: MemoryUploadStore, val taken: CopyOnWriteArrayList<Taken>)

    private fun serve(
        store: MemoryUploadStore = MemoryUploadStore(),
        maxBytes: Long = 25L * 1024 * 1024,
        viewerRequired: Boolean = true,
        viewer: JsonElement = u1,
        uploads: Boolean = true,
        server: RayfoldServer? = null,
    ): Served {
        val taken = CopyOnWriteArrayList<Taken>()
        // what a resolver does with an upload: read it, use it, drop it
        val setAvatar = command { args, _ ->
            val id = args.s("upload")
            val opened = store.open(id) ?: throw RayfoldException(Code.NOT_FOUND, "No upload $id")
            val (upload, body) = opened
            val read = body.readBytes().size
            store.delete(id)
            taken.add(Taken(args.s("userId"), read))
            CommandResult(obj("""{"id":"${args.s("userId")}","bytes":${upload.size}}"""))
        }
        val options = HttpOptions(uploads = if (uploads) UploadOptions(store, maxBytes, viewerRequired) else null)
        val http = RayfoldHttp(server ?: RayfoldServer(ir, Resolvers(commands = mapOf("setAvatar" to setAvatar))), options) { viewer }.start(0)
        started.add(http)
        return Served("http://127.0.0.1:${http.address.port}", store, taken)
    }

    private fun post(base: String, body: ByteArray?, vararg headers: String, chunked: Boolean = false): HttpResponse<String> {
        val publisher = when {
            body == null -> HttpRequest.BodyPublishers.noBody()
            // an unknown length is sent chunked: the request never declares how much is coming
            chunked -> HttpRequest.BodyPublishers.ofInputStream { ByteArrayInputStream(body) }
            else -> HttpRequest.BodyPublishers.ofByteArray(body)
        }
        val b = HttpRequest.newBuilder(URI("$base/rayfold/uploads")).timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/octet-stream").POST(publisher)
        headers.toList().chunked(2).forEach { (k, v) -> b.setHeader(k, v) }
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString())
    }

    private fun get(url: String): HttpResponse<String> =
        client.send(HttpRequest.newBuilder(URI(url)).timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofString())

    private fun setAvatar(base: String, upload: String, key: String = this.key): JsonObject {
        val body = """{"ops":[{"id":1,"op":"setAvatar","args":{"userId":"u1","upload":"$upload"},"key":"$key"}]}"""
        val res = client.send(
            HttpRequest.newBuilder(URI("$base/rayfold")).timeout(Duration.ofSeconds(5))
                .header("Content-Type", "application/rayfold+json").header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        return obj(res.body())
    }

    private fun detail(res: HttpResponse<String>): String? = (obj(res.body())["detail"] as? JsonPrimitive)?.content

    private fun header(res: HttpResponse<String>, name: String): String? = res.headers().firstValue(name).orElse(null)

    // ------------------------------------------------------------------ the route

    @Test
    fun `keeps the bytes and answers with the handle a command then names`() {
        val served = serve()
        val res = post(served.base, bytes(2_048), "Rayfold-Upload-Name", "avatar.png", "Rayfold-Upload-Type", "image/png")
        assertEquals(201, res.statusCode(), res.body())
        val kept = obj(res.body())
        assertEquals(JsonPrimitive(2_048L), kept["size"])
        assertEquals(JsonPrimitive("avatar.png"), kept["name"])
        assertEquals(JsonPrimitive("image/png"), kept["type"])
        val id = (kept["id"] as? JsonPrimitive)?.content ?: error("no id in $kept")
        assertTrue(Regex("^[0-9a-f-]{16,}$").matches(id), "an unguessable id: $id")
        assertEquals(1, served.store.size)
        assertEquals(2_048L, served.store.bytes)

        val answer = setAvatar(served.base, id)
        assertEquals(obj("""{"${'$'}type":"Avatar","id":"u1","bytes":2048}"""), answer["ok"], answer.toString())
        assertEquals(listOf("u1" to 2_048), served.taken.map { it.userId to it.size })
        assertEquals(0, served.store.size, "the resolver took what it needed and said so")
        assertEquals(0L, served.store.bytes)

        // a different key, so this is a second command and not a replay of the first
        val gone = setAvatar(served.base, id, key + "2")
        assertEquals(obj("""{"id":1,"error":{"code":"not_found","message":"No upload $id"},"fin":true}"""), gone, "the handle a resolver consumed is gone")
        assertEquals(1, served.taken.size)
        assertTrue(setAvatar(served.base, id).let { (it["meta"] as? JsonObject)?.get("replay") == JsonPrimitive(true) }, "guard: the first key still replays its answer")
        assertEquals(1, served.taken.size, "and replaying never reads the upload again")
    }

    @Test
    fun `refuses a content type a page could send cross-site without asking first`() {
        val served = serve()
        for (type in listOf("multipart/form-data; boundary=x", "text/plain", "application/x-www-form-urlencoded")) {
            val res = post(served.base, bytes(8), "Content-Type", type)
            assertEquals(415, res.statusCode(), "$type: ${res.body()}")
            assertEquals("Content-Type ${type.substringBefore(';')} is not accepted; send application/octet-stream", detail(res))
            assertEquals("application/octet-stream", header(res, "Accept-Post"))
            assertEquals("application/problem+json", header(res, "Content-Type"))
        }
        val none = post(served.base, bytes(8), "Content-Type", "")
        assertEquals(415, none.statusCode(), none.body())
        assertEquals(0, served.store.size, "nothing was stored by any of them")
    }

    @Test
    fun `applies the Origin rule, because an upload is a write`() {
        val served = serve()
        val foreign = post(served.base, bytes(8), "Origin", "https://evil.example")
        assertEquals(403, foreign.statusCode(), foreign.body())
        assertEquals("Origin https://evil.example is not allowed", detail(foreign))
        assertEquals(0, served.store.size)
        // guard: the server's own origin is allowed
        val own = post(served.base, bytes(8), "Origin", served.base)
        assertEquals(201, own.statusCode(), own.body())
        assertEquals(1, served.store.size)
    }

    @Test
    fun `needs an identified sender unless the server says otherwise`() {
        val anonymous = serve(viewer = JsonNull)
        val refused = post(anonymous.base, bytes(8))
        assertEquals(401, refused.statusCode(), refused.body())
        assertEquals("An upload needs an identified caller", detail(refused))
        assertEquals(0, anonymous.store.size)

        val open = serve(viewer = JsonNull, viewerRequired = false)
        assertEquals(201, post(open.base, bytes(8)).statusCode())
        assertEquals(1, open.store.size)
    }

    @Test
    fun `stops at the size bound while reading, whatever the request declared`() {
        val served = serve(maxBytes = 1_024)
        val declared = post(served.base, bytes(2_048))
        assertEquals(413, declared.statusCode(), declared.body())
        assertEquals("Upload exceeds 1024 bytes", detail(declared))

        // a body whose length the request never declared is still stopped, because the bytes are counted as they pass
        val undeclared = post(served.base, bytes(2_048), chunked = true)
        assertEquals(413, undeclared.statusCode(), undeclared.body())
        assertEquals("Upload exceeds 1024 bytes", detail(undeclared))
        assertEquals(0, served.store.size, "neither left anything behind")
        assertEquals(0L, served.store.bytes)

        // guard: one exactly at the bound is kept, declared or not
        assertEquals(201, post(served.base, bytes(1_024)).statusCode())
        assertEquals(201, post(served.base, bytes(1_024), chunked = true).statusCode())
        assertEquals(2, served.store.size)
        assertEquals(2_048L, served.store.bytes)
    }

    @Test
    fun `is not there at all unless a store was given`() {
        val bare = serve(uploads = false)
        val res = post(bare.base, bytes(8))
        assertEquals(404, res.statusCode(), res.body())
        assertEquals("No route for POST /rayfold/uploads", detail(res))
        assertEquals(0, bare.store.size)
    }

    @Test
    fun `says it serves the upload extension in its manifest, and does not when it has no store`() {
        val served = serve()
        val extensions = ((obj(get("${served.base}/rayfold/manifest").body())["extensions"] as? JsonArray) ?: JsonArray(emptyList())).map { (it as JsonPrimitive).content }
        assertContains(extensions, "upload")

        val bare = serve(uploads = false, server = RayfoldServer(ir, Resolvers()))
        val without = ((obj(get("${bare.base}/rayfold/manifest").body())["extensions"] as? JsonArray) ?: JsonArray(emptyList())).map { (it as JsonPrimitive).content }
        assertEquals(listOf("live", "rb"), without)
    }

    @Test
    fun `an upload is bounded by its own limit, not the envelope's, and the envelope's still holds`() {
        val store = MemoryUploadStore()
        // an envelope may be 1 KiB here; an upload may be 4 MiB, which is the point of a route of its own
        val http = RayfoldHttp(
            RayfoldServer(ir, Resolvers(commands = mapOf("setAvatar" to command { _, _ -> CommandResult(obj("""{"id":"u1","bytes":0}""")) }))),
            HttpOptions(maxBodyBytes = 1_024, uploads = UploadOptions(store, maxBytes = 4L * 1024 * 1024)),
        ) { u1 }.start(0)
        started.add(http)
        val base = "http://127.0.0.1:${http.address.port}"

        val big = post(base, bytes(2 * 1024 * 1024))
        assertEquals(201, big.statusCode(), big.body())
        assertEquals(JsonPrimitive(2L * 1024 * 1024), obj(big.body())["size"])
        assertEquals(2L * 1024 * 1024, store.bytes)

        // guard: the batch endpoint is unchanged, and still refuses a body over its own smaller limit
        val envelope = client.send(
            HttpRequest.newBuilder(URI("$base/rayfold")).timeout(Duration.ofSeconds(5)).header("Content-Type", "application/rayfold+json")
                .POST(HttpRequest.BodyPublishers.ofString("""{"ops":[{"id":1,"op":"setAvatar","args":{"userId":"u1","upload":"${"x".repeat(2_048)}"},"key":"$key"}]}""")).build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        assertEquals(413, envelope.statusCode())
        assertEquals("Body exceeds 1024 bytes", detail(envelope))
    }

    // ------------------------------------------------------------------ the store in memory

    @Test
    fun `forgets an upload nobody used, and says so rather than serving stale bytes`() = runBlocking {
        var clock = 1_000L
        val store = MemoryUploadStore(ttlMs = 60_000, now = { clock })
        val kept = store.put(ByteArrayInputStream(bytes(16)), "a.bin", null, u1)
        clock += 59_999
        val inside = store.open(kept.id) ?: error("one millisecond inside the lifetime it is still there")
        assertEquals(16L, inside.first.size)
        clock += 2
        assertNull(store.open(kept.id), "one millisecond past it, it is gone")
        assertEquals(0, store.size, "and reading it dropped it, rather than leaving it to be swept")
        assertEquals(0L, store.bytes)
    }

    @Test
    fun `keeps itself inside its bound, oldest first`() = runBlocking {
        var clock = 0L
        val store = MemoryUploadStore(maxBytes = 2_048, now = { clock })
        val first = store.put(ByteArrayInputStream(bytes(1_024)), null, null, u1)
        clock += 1
        val second = store.put(ByteArrayInputStream(bytes(1_024)), null, null, u1)
        assertEquals(2_048L, store.bytes)
        clock += 1
        val third = store.put(ByteArrayInputStream(bytes(1_024)), null, null, u1)

        assertNull(store.open(first.id), "the oldest made room")
        assertTrue(store.open(second.id) != null)
        assertTrue(store.open(third.id) != null)
        assertEquals(2, store.size)
        assertEquals(2_048L, store.bytes)
    }

    @Test
    fun `gives the bytes back as they arrived, and is gone once deleted`() = runBlocking {
        val store = MemoryUploadStore()
        val payload = byteArrayOf(1, 2, 3, -6, -5)
        val kept = store.put(ByteArrayInputStream(payload), null, "application/x-thing", u1)
        val opened = store.open(kept.id) ?: error("just stored")
        assertEquals(5L, opened.first.size)
        assertEquals("application/x-thing", opened.first.type)
        assertEquals(u1, opened.first.viewer, "a command can refuse an upload that was not its caller's")
        assertEquals(payload.toList(), opened.second.readBytes().toList())
        assertNotEquals(kept.id, store.put(ByteArrayInputStream(payload), null, null, u1).id, "two uploads never share an id")

        store.delete(kept.id)
        assertNull(store.open(kept.id))
        store.delete(kept.id) // deleting what is gone changes nothing
        assertEquals(1, store.size)
        assertEquals(5L, store.bytes)
    }
}
