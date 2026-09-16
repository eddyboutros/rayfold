package dev.rayfold.fleet

import dev.rayfold.core.Code
import dev.rayfold.core.CommandResult
import dev.rayfold.core.HttpOptions
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldHttp
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import dev.rayfold.core.shutdown
import dev.rayfold.jdbc.JdbcIdempotencyStore
import dev.rayfold.jdbc.PgNotifications
import dev.rayfold.jdbc.PgRelay
import java.sql.Connection
import java.sql.DriverManager
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * A JVM member of the fleet `e2e/fleet.test.ts` starts: the same schema, the same tables and the same shared stores as
 * the TypeScript member in `e2e/fleet/server.ts`, so the two run side by side over one Postgres. What the test proves
 * is that they behave as one fleet, not that either works alone.
 *
 * Environment: DATABASE_URL (JDBC or postgres:// form), PORT, NAME.
 */
private const val SCHEMA = """
  entity Book { id: ID stock: Int }
  event StockChanged { bookId: ID, stock: Int }
  query book(id: ID): Book?
  command restock(id: ID, qty: Int): Book emits StockChanged
  stream stockUpdates(bookIds: [ID]): StockChanged
"""

/** `postgres://user:password@host:port/db` as JDBC wants it, or a `jdbc:` URL unchanged. */
private fun jdbcUrl(url: String): Pair<String, Array<String>> {
    if (url.startsWith("jdbc:")) return url to emptyArray()
    val uri = java.net.URI(url)
    val credentials = uri.userInfo?.split(":", limit = 2) ?: emptyList()
    val port = if (uri.port == -1) 5432 else uri.port
    return "jdbc:postgresql://${uri.host}:$port${uri.path}" to arrayOf(credentials.getOrElse(0) { "postgres" }, credentials.getOrElse(1) { "" })
}

fun main() = runBlocking {
    val (url, credentials) = jdbcUrl(requireNotNull(System.getenv("DATABASE_URL")) { "DATABASE_URL is required" })
    val port = requireNotNull(System.getenv("PORT")) { "PORT is required" }.toInt()
    val name = System.getenv("NAME") ?: "jvm"
    val connect: () -> Connection = { DriverManager.getConnection(url, credentials[0], credentials[1]) }

    val idempotency = JdbcIdempotencyStore(connect)
    val relay = PgRelay(PgNotifications(connect(), connect), connect)
    idempotency.migrate()
    relay.migrate()

    val ir = SchemaText.load(SCHEMA).ir
    val resolvers = Resolvers(
        queries = mapOf(
            "book" to { args, _ ->
                val id = args["id"]?.jsonPrimitive?.content ?: ""
                connect().use { c ->
                    c.prepareStatement("SELECT id, stock FROM fleet_books WHERE id = ?").use { s ->
                        s.setString(1, id)
                        s.executeQuery().use { rows ->
                            if (!rows.next()) null
                            else buildJsonObject { put("id", rows.getString(1)); put("stock", rows.getInt(2)) }
                        }
                    }
                }
            },
        ),
        commands = mapOf(
            "restock" to { args, _ ->
                val id = args["id"]?.jsonPrimitive?.content ?: ""
                val qty = args["qty"]?.jsonPrimitive?.int ?: 0
                connect().use { c ->
                    // long enough for a retry to arrive while it runs, which is what a duplicate request looks like
                    c.createStatement().use { it.execute("SELECT pg_sleep(0.3)") }
                    c.prepareStatement("INSERT INTO fleet_runs (server, book) VALUES (?, ?)").use { s ->
                        s.setString(1, name)
                        s.setString(2, id)
                        s.executeUpdate()
                    }
                    c.prepareStatement("UPDATE fleet_books SET stock = stock + ? WHERE id = ? RETURNING id, stock").use { s ->
                        s.setInt(1, qty)
                        s.setString(2, id)
                        s.executeQuery().use { rows ->
                            if (!rows.next()) throw RayfoldException(Code.NOT_FOUND, "no book $id")
                            val book = buildJsonObject { put("id", rows.getString(1)); put("stock", rows.getInt(2)) }
                            CommandResult(
                                book,
                                emit = listOf("StockChanged" to buildJsonObject { put("bookId", book["id"]!!); put("stock", book["stock"]!!) }),
                            )
                        }
                    }
                }
            },
        ),
        streams = mapOf(
            "stockUpdates" to { args, ctx ->
                val wanted = (args["bookIds"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }?.toSet() ?: emptySet()
                callbackFlow<JsonElement> {
                    val off = ctx.events.on("StockChanged") { p -> if ((p["bookId"] as? JsonPrimitive)?.content in wanted) trySend(p) }
                    awaitClose { off() }
                }
            },
        ),
    )

    val server = RayfoldServer(ir, resolvers, idempotency = idempotency, relay = relay)
    val options = HttpOptions(readiness = mapOf("db" to { connect().use { it.isValid(1) }; Unit }))
    val http = RayfoldHttp(server, options) { buildJsonObject { put("id", "fleet") } }.start(port, host = "127.0.0.1")
    server.ready()

    Runtime.getRuntime().addShutdownHook(Thread { runBlocking { shutdown(server, http, timeoutMs = 5_000) } })
    println("$name listening on $port") // the test waits for this line
    Thread.currentThread().join()
}
