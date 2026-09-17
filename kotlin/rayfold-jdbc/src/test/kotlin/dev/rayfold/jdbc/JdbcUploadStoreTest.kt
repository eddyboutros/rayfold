package dev.rayfold.jdbc

import com.sun.net.httpserver.HttpServer
import dev.rayfold.core.Code
import dev.rayfold.core.CommandResult
import dev.rayfold.core.HttpOptions
import dev.rayfold.core.MemoryUploadStore
import dev.rayfold.core.RayfoldContext
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldHttp
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import dev.rayfold.core.UploadOptions
import dev.rayfold.core.UploadStore
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.sql.Connection
import java.sql.DatabaseMetaData
import java.sql.DriverManager
import java.time.Duration
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Uploads in a shared database, with two servers over one H2: the point of the store is that a file sent to one
 * server is there for the command that runs on another. Everything else a store must do - forget what nobody used,
 * stay inside its bound, give the bytes back as they arrived - is checked against a real database rather than a map.
 * H2 stands in for Postgres; the one thing it cannot spell, `bytea`, is checked against a connection that reports
 * itself as Postgres.
 */
class JdbcUploadStoreTest {
    private val ir = SchemaText.load("entity Avatar { id: ID bytes: Int name: String? } command setAvatar(userId: ID, upload: ID): Avatar").ir
    private val u1 = Json.parseToJsonElement("""{"id":"u1"}""")
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private val started = mutableListOf<HttpServer>()

    private companion object {
        val databases = AtomicInteger()
    }

    private var clock = 1_000L
    private lateinit var url: String
    private lateinit var keepAlive: Connection

    @BeforeEach
    fun open() {
        clock = 1_000L
        url = "jdbc:h2:mem:rayfoldup${databases.incrementAndGet()}" // a database of its own, alive while this connection is
        keepAlive = DriverManager.getConnection(url)
    }

    @AfterEach
    fun close() {
        started.forEach { it.stop(0) }
        client.shutdownNow()
        keepAlive.close()
    }

    private fun store(ttlMs: Long = 60 * 60 * 1000L, maxBytes: Long = 1024L * 1024 * 1024) =
        JdbcUploadStore({ DriverManager.getConnection(url) }, JdbcUploadOptions(ttlMs = ttlMs, maxBytes = maxBytes, now = { clock })).also { it.migrate() }

    private fun bytes(n: Int, fill: Byte = 65) = ByteArray(n) { fill }

    /** One member of the fleet: its own HTTP server and command, over whichever store it was given. */
    private fun member(uploads: UploadStore): String {
        val setAvatar: suspend (JsonObject, RayfoldContext) -> Any? = { args, _ ->
            val id = (args["upload"] as? JsonPrimitive)?.content ?: throw RayfoldException(Code.INVALID_ARGUMENT, "no upload")
            val userId = (args["userId"] as? JsonPrimitive)?.content ?: throw RayfoldException(Code.INVALID_ARGUMENT, "no userId")
            val opened = uploads.open(id)
            if (opened == null) {
                CommandResult(buildJsonObject { put("id", userId); put("bytes", 0); put("name", JsonNull) })
            } else {
                val (upload, body) = opened
                val read = body.readBytes().size
                uploads.delete(id)
                CommandResult(buildJsonObject { put("id", userId); put("bytes", read); put("name", upload.name) })
            }
        }
        val http = RayfoldHttp(
            RayfoldServer(ir, Resolvers(commands = mapOf("setAvatar" to setAvatar))),
            HttpOptions(uploads = UploadOptions(uploads)),
        ) { u1 }.start(0)
        started.add(http)
        return "http://127.0.0.1:${http.address.port}"
    }

    private fun send(base: String, body: ByteArray, vararg headers: String): JsonObject {
        val b = HttpRequest.newBuilder(URI("$base/rayfold/uploads")).timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/octet-stream").POST(HttpRequest.BodyPublishers.ofByteArray(body))
        headers.toList().chunked(2).forEach { (k, v) -> b.setHeader(k, v) }
        val res = client.send(b.build(), HttpResponse.BodyHandlers.ofString())
        assertEquals(201, res.statusCode(), res.body())
        return Json.parseToJsonElement(res.body()).jsonObject
    }

    private fun consume(base: String, id: String, key: String): JsonObject {
        val body = """{"ops":[{"id":1,"op":"setAvatar","args":{"userId":"u1","upload":"$id"},"key":"$key"}]}"""
        val res = client.send(
            HttpRequest.newBuilder(URI("$base/rayfold")).timeout(Duration.ofSeconds(5))
                .header("Content-Type", "application/rayfold+json").header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
            HttpResponse.BodyHandlers.ofString(),
        )
        return Json.parseToJsonElement(res.body()).jsonObject
    }

    private fun idOf(kept: JsonObject): String = (kept["id"] as? JsonPrimitive)?.content ?: error("no id in $kept")

    // ------------------------------------------------------------------ the fleet

    @Test
    fun `a file sent to one server is used by a command on another`() {
        val shared = store()
        val a = member(shared)
        val b = member(shared)

        val kept = send(a, bytes(4_096), "Rayfold-Upload-Name", "avatar.png", "Rayfold-Upload-Type", "image/png")
        assertEquals(JsonPrimitive(4_096L), kept["size"])
        assertEquals(1, shared.count())

        val answer = consume(b, idOf(kept), "0123456789abcdef")
        assertEquals(
            Json.parseToJsonElement("""{"${'$'}type":"Avatar","id":"u1","bytes":4096,"name":"avatar.png"}"""),
            answer["ok"],
            "the other server read the bytes and what the client called them: $answer",
        )
        assertEquals(0, shared.count(), "the command took it and said so")
        assertEquals(0L, shared.bytes())

        // guard: a server that keeps uploads to itself never sees what another one was sent, which is the whole point
        val alone = MemoryUploadStore()
        val c = member(alone)
        val other = send(a, bytes(16))
        val unseen = consume(c, idOf(other), "0123456789abcdeg")
        assertEquals(Json.parseToJsonElement("""{"${'$'}type":"Avatar","id":"u1","bytes":0,"name":null}"""), unseen["ok"], "$unseen")
        assertEquals(1, shared.count(), "and the shared store still holds it, untouched")
        assertEquals(0, alone.size)
    }

    // ------------------------------------------------------------------ the store

    @Test
    fun `gives the bytes back exactly as they arrived, with what the client said about them`() = runBlocking {
        val s = store()
        val payload = byteArrayOf(0, 1, -6, -1, 13, 10) // 0x00, 0x01, 0xFA, 0xFF, CR, LF
        val kept = s.put(ByteArrayInputStream(payload), "raw.bin", "application/octet-stream", u1)
        assertEquals(6L, kept.size)
        val opened = s.open(kept.id) ?: error("just stored")
        assertEquals("raw.bin", opened.first.name)
        assertEquals("application/octet-stream", opened.first.type)
        assertEquals(6L, opened.first.size)
        assertEquals(u1, opened.first.viewer, "the viewer travelled as JSON and came back a value")
        assertEquals(payload.toList(), opened.second.readBytes().toList(), "high bytes and newlines survive the round trip")

        val anonymous = s.put(ByteArrayInputStream(bytes(4)), null, null, JsonNull)
        val read = s.open(anonymous.id) ?: error("just stored")
        assertEquals(JsonNull, read.first.viewer)
        assertNull(read.first.name)
        assertNull(read.first.type)
        assertNotEquals(kept.id, anonymous.id, "two uploads never share an id")
    }

    @Test
    fun `forgets an upload nobody used, at its lifetime and not before`() = runBlocking {
        val s = store(ttlMs = 60_000)
        val kept = s.put(ByteArrayInputStream(bytes(32)), null, null, u1)
        clock += 59_999
        assertTrue(s.open(kept.id) != null, "one millisecond inside its lifetime it is still there")
        clock += 2
        assertNull(s.open(kept.id), "one millisecond past it, it is gone")
        assertEquals(0, s.count(), "reading it away is what dropped it")
        assertEquals(0L, s.bytes())
    }

    @Test
    fun `keeps itself inside its bound, oldest first`() = runBlocking {
        val s = store(maxBytes = 2_048)
        val first = s.put(ByteArrayInputStream(bytes(1_024)), null, null, u1)
        clock += 1
        val second = s.put(ByteArrayInputStream(bytes(1_024)), null, null, u1)
        assertEquals(2_048L, s.bytes())
        clock += 1
        val third = s.put(ByteArrayInputStream(bytes(1_024)), null, null, u1)

        assertNull(s.open(first.id), "the oldest made room")
        assertTrue(s.open(second.id) != null)
        assertTrue(s.open(third.id) != null)
        assertEquals(2, s.count())
        assertEquals(2_048L, s.bytes())
    }

    @Test
    fun `delete makes it gone, and deleting what is gone is not an error`() = runBlocking {
        val s = store()
        val kept = s.put(ByteArrayInputStream(bytes(8)), null, null, u1)
        s.delete(kept.id)
        assertNull(s.open(kept.id))
        s.delete(kept.id)
        assertEquals(0, s.count())
        assertEquals(0L, s.bytes())
    }

    @Test
    fun `two servers may each create the table as they start`() = runBlocking {
        val stores = withTimeout(10_000) {
            (0 until 4).map { async { JdbcUploadStore({ DriverManager.getConnection(url) }, JdbcUploadOptions(now = { clock })).also { s -> s.migrate() } } }.awaitAll()
        }
        val kept = stores[0].put(ByteArrayInputStream(bytes(8)), "x", null, u1)
        for (s in stores.drop(1)) {
            assertTrue(s.open(kept.id) != null, "one table, whichever of them made it")
            assertEquals(1, s.count())
        }
    }

    @Test
    fun `names bytea on Postgres and varbinary elsewhere, with the columns both runtimes create`() {
        val h2 = store().schema()
        assertTrue(h2.contains("bytes varbinary NOT NULL"), "H2 has no bytea: $h2")

        // a connection that reports itself as Postgres, since H2 cannot
        val asPostgres = JdbcUploadStore({ pretending(DriverManager.getConnection(url), "PostgreSQL") }, JdbcUploadOptions(table = "app.rayfold_uploads"))
        val postgres = asPostgres.schema()
        assertEquals(
            "CREATE TABLE IF NOT EXISTS app.rayfold_uploads (\n" +
                "  id text NOT NULL,\n  name text,\n  type text,\n  viewer text,\n  size bigint NOT NULL,\n  at bigint NOT NULL,\n  bytes bytea NOT NULL,\n  PRIMARY KEY (id)\n);\n" +
                "CREATE INDEX IF NOT EXISTS app_rayfold_uploads_at ON app.rayfold_uploads (at);",
            postgres,
        )
    }

    /** [connection], answering [product] when asked what database it is, so the Postgres spelling can be checked on H2. */
    private fun pretending(connection: Connection, product: String): Connection =
        Proxy.newProxyInstance(javaClass.classLoader, arrayOf(Connection::class.java)) { _, method, args ->
            val result = try {
                method.invoke(connection, *(args ?: emptyArray()))
            } catch (e: InvocationTargetException) {
                throw e.targetException
            }
            if (method.name != "getMetaData") return@newProxyInstance result
            Proxy.newProxyInstance(javaClass.classLoader, arrayOf(DatabaseMetaData::class.java)) { _, m, a ->
                if (m.name == "getDatabaseProductName") product
                else try {
                    m.invoke(result as DatabaseMetaData, *(a ?: emptyArray()))
                } catch (e: InvocationTargetException) {
                    throw e.targetException
                }
            }
        } as Connection
}
