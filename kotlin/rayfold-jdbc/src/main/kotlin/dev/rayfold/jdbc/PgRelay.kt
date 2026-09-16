package dev.rayfold.jdbc

import dev.rayfold.core.Relay
import dev.rayfold.core.RelayMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.postgresql.PGConnection
import java.sql.Connection
import java.sql.Statement
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/** What the relay needs from Postgres: [PgNotifications] provides it over pgjdbc; a test can provide it in memory. */
interface Notifications {
    /** Delivers every payload sent on [channel], by this process or any other, until the function returned is called. */
    suspend fun listen(channel: String, onPayload: (String) -> Unit): suspend () -> Unit

    suspend fun notify(channel: String, payload: String)
}

data class PgRelayOptions(
    /** The NOTIFY channel. */
    val channel: String = "rayfold",
    /** The table for messages too large for a payload. */
    val table: String = "rayfold_relay",
    /** Largest payload sent inline, in bytes: under Postgres's limit of 8000. */
    val maxInline: Int = 7900,
    /** How long a row in the table is kept: long enough for every server to have read it. */
    val ttlMs: Long = 5 * 60_000L,
    /** Identifies this relay in what it publishes. */
    val origin: String = UUID.randomUUID().toString(),
    /** Where a message this relay could not read or fetch goes. */
    val onError: (Throwable) -> Unit = {},
    /** Wall clock, injectable for tests. */
    val now: () -> Long = System::currentTimeMillis,
)

/**
 * A relay over Postgres `LISTEN`/`NOTIFY` (mirrors packages/postgres/src/relay.ts), so servers in different processes
 * hear each other's changes and events through the database they already share.
 *
 * One NOTIFY payload carries one message, as JSON:
 *
 *   {"from":"<relay id>","change":{"keys":["Book:b1"],"ops":["books"]}}
 *   {"from":"<relay id>","event":{"name":"StockChanged","payload":{"bookId":"b1","stock":4}}}
 *   {"from":"<relay id>","ref":12}
 *
 * `from` is the publishing relay's id, so a server drops what it published itself. Postgres limits a payload to 8000
 * bytes; a message that would not fit is written to the relay table and `ref` names its row, which the receivers
 * read. Those rows are swept as new ones are written. Any Rayfold server that speaks this format can share the relay,
 * in either runtime.
 */
class PgRelay(
    private val notifications: Notifications,
    private val connections: () -> Connection,
    private val opts: PgRelayOptions = PgRelayOptions(),
) : Relay {
    val origin: String get() = opts.origin

    /** The DDL for the relay table. */
    fun schema(): String = "CREATE TABLE IF NOT EXISTS ${opts.table} (id bigserial PRIMARY KEY, message jsonb NOT NULL, at bigint NOT NULL)"

    /** Creates the table for oversized messages if it is not there yet. Safe to call from every server as it starts, at the same instant included. */
    fun migrate() {
        connections().use { ensure(it, schema()) }
    }

    override suspend fun publish(message: RelayMessage) {
        val body = when (message) {
            is RelayMessage.Change -> buildJsonObject {
                put("change", buildJsonObject { put("keys", JsonArray(message.keys.map { JsonPrimitive(it) })); put("ops", JsonArray(message.ops.map { JsonPrimitive(it) })) })
            }
            is RelayMessage.Event -> buildJsonObject { put("event", buildJsonObject { put("name", message.name); put("payload", message.payload) }) }
        }
        val inline = JsonObject(mapOf("from" to JsonPrimitive(opts.origin)) + body).toString()
        if (inline.toByteArray(Charsets.UTF_8).size <= opts.maxInline) return notifications.notify(opts.channel, inline)
        val t = opts.now()
        val id = withContext(Dispatchers.IO) {
            connections().use { c ->
                val id = c.prepareStatement("INSERT INTO ${opts.table} (message, at) VALUES (CAST(? AS jsonb), ?)", Statement.RETURN_GENERATED_KEYS).use { s ->
                    s.setString(1, body.toString())
                    s.setLong(2, t)
                    s.executeUpdate()
                    s.generatedKeys.use { keys -> if (keys.next()) keys.getLong(1) else error("rayfold relay: ${opts.table} returned no id") }
                }
                c.prepareStatement("DELETE FROM ${opts.table} WHERE at < ?").use { s -> s.setLong(1, t - opts.ttlMs); s.executeUpdate() }
                id
            }
        }
        notifications.notify(opts.channel, buildJsonObject { put("from", opts.origin); put("ref", id) }.toString())
    }

    override suspend fun subscribe(onMessage: (RelayMessage) -> Unit): suspend () -> Unit =
        notifications.listen(opts.channel) { payload ->
            try {
                receive(payload, onMessage)
            } catch (e: Throwable) {
                opts.onError(e)
            }
        }

    private fun receive(payload: String, onMessage: (RelayMessage) -> Unit) {
        val wire = Json.parseToJsonElement(payload).jsonObject
        if ((wire["from"] as? JsonPrimitive)?.content == opts.origin) return
        val ref = (wire["ref"] as? JsonPrimitive)?.content?.toLongOrNull()
        if (ref == null) return deliver(wire, onMessage)
        val stored = connections().use { c ->
            c.prepareStatement("SELECT message FROM ${opts.table} WHERE id = ?").use { s ->
                s.setLong(1, ref)
                s.executeQuery().use { rows -> if (rows.next()) rows.getString(1) else null }
            }
        } ?: error("rayfold relay: message $ref is gone from ${opts.table}")
        // a driver may hand the row back as JSON text inside a JSON string; read it the way the TypeScript relay does
        val parsed = Json.parseToJsonElement(stored)
        val body = (parsed as? JsonPrimitive)?.takeIf { it.isString }?.let { Json.parseToJsonElement(it.content) } ?: parsed
        deliver(body.jsonObject, onMessage)
    }

    private fun deliver(body: JsonObject, onMessage: (RelayMessage) -> Unit) {
        fun strings(v: JsonObject?, key: String): Set<String> = (v?.get(key) as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }?.toCollection(LinkedHashSet()) ?: linkedSetOf()
        (body["change"] as? JsonObject)?.let { return onMessage(RelayMessage.Change(strings(it, "keys"), strings(it, "ops"))) }
        (body["event"] as? JsonObject)?.let { e ->
            onMessage(RelayMessage.Event((e["name"] as? JsonPrimitive)?.content ?: "", e["payload"] as? JsonObject ?: JsonObject(emptyMap())))
        }
    }
}

/**
 * `LISTEN`/`NOTIFY` through pgjdbc. `LISTEN` belongs to the connection that issued it, so [listener] must be a
 * dedicated connection, never one from a pool, and it is polled for notifications every [pollMs] from a coroutine.
 * [notifier] opens the connection `pg_notify` runs on; by default the listening one, which then waits out a poll.
 */
class PgNotifications(
    private val listener: Connection,
    private val notifier: () -> Connection = { listener },
    private val pollMs: Int = 250,
) : Notifications {
    private class Listener(val channel: String, val onPayload: (String) -> Unit)

    private val listeners = CopyOnWriteArrayList<Listener>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var poller: Job? = null

    override suspend fun listen(channel: String, onPayload: (String) -> Unit): suspend () -> Unit {
        val l = Listener(channel, onPayload)
        withContext(Dispatchers.IO) {
            synchronized(listener) {
                if (listeners.none { it.channel == channel }) listener.createStatement().use { it.execute("LISTEN ${quote(channel)}") }
                listeners.add(l)
                if (poller == null) poller = scope.launch { poll() }
            }
        }
        return {
            withContext(Dispatchers.IO) {
                synchronized(listener) {
                    listeners.remove(l)
                    if (listeners.none { it.channel == channel }) listener.createStatement().use { it.execute("UNLISTEN ${quote(channel)}") }
                    if (listeners.isEmpty()) { poller?.cancel(); poller = null }
                }
            }
        }
    }

    override suspend fun notify(channel: String, payload: String) {
        withContext(Dispatchers.IO) {
            val c = notifier()
            try {
                synchronized(c) {
                    c.prepareStatement("SELECT pg_notify(?, ?)").use { s -> s.setString(1, channel); s.setString(2, payload); s.executeQuery().close() }
                }
            } finally {
                if (c !== listener) c.close()
            }
        }
    }

    private fun CoroutineScope.poll() {
        while (isActive) {
            val batch = synchronized(listener) { listener.unwrap(PGConnection::class.java).getNotifications(pollMs) } ?: continue
            for (n in batch) for (l in listeners) if (l.channel == n.name) l.onPayload(n.parameter ?: "")
        }
    }

    private companion object {
        fun quote(name: String): String = "\"" + name.replace("\"", "\"\"") + "\""
    }
}
