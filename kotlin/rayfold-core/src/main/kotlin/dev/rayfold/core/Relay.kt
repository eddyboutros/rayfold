package dev.rayfold.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import java.util.concurrent.CopyOnWriteArraySet

/**
 * What one server learned, carried to every other server it shares a relay with: the entities a command changed, so
 * their live queries re-run, and the events it emitted, so their streams deliver (mirrors packages/server/src/relay.ts).
 * Without a relay each server hears only itself, which is right for one server and silently wrong for two behind a
 * load balancer.
 */
sealed class RelayMessage {
    class Change(val keys: Set<String>, val ops: Set<String>) : RelayMessage()
    class Event(val name: String, val payload: JsonObject) : RelayMessage()
}

/** A relay never hands a server back what that server published: its own buses heard that already. */
interface Relay {
    /** Carries the message to every other server on the relay. Returns once handed over, not once delivered. */
    suspend fun publish(message: RelayMessage)

    /** Starts delivering the other servers' messages; returns once this server is listening. The function returned stops it. */
    suspend fun subscribe(onMessage: (RelayMessage) -> Unit): suspend () -> Unit
}

/** Joins servers that run in one process: [join] gives each server its own end of the relay. */
class MemoryRelay {
    private class End(val deliver: (RelayMessage) -> Unit)

    private val ends = CopyOnWriteArraySet<End>()

    fun join(): Relay = object : Relay {
        @Volatile
        private var mine: End? = null

        override suspend fun publish(message: RelayMessage) {
            // a copy per receiver, as a wire would give: no server sees another's later edits to the payload
            for (end in ends) if (end !== mine) end.deliver(copyOf(message))
        }

        override suspend fun subscribe(onMessage: (RelayMessage) -> Unit): suspend () -> Unit {
            mine?.let { ends.remove(it) }
            val end = End(onMessage)
            mine = end
            ends.add(end)
            return {
                ends.remove(end)
                if (mine === end) mine = null
            }
        }
    }

    /** Servers listening right now. */
    val size: Int get() = ends.size

    private companion object {
        fun copyOf(m: RelayMessage): RelayMessage = when (m) {
            is RelayMessage.Change -> RelayMessage.Change(LinkedHashSet(m.keys), LinkedHashSet(m.ops))
            is RelayMessage.Event -> RelayMessage.Event(m.name, Json.parseToJsonElement(m.payload.toString()).jsonObject)
        }
    }
}
