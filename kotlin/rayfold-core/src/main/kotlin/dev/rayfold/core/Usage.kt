package dev.rayfold.core

import java.util.concurrent.ConcurrentHashMap

/**
 * Field-usage telemetry (spec 11 "Field usage telemetry"), mirroring packages/server/src/usage.ts: which members each
 * client still asks for, so removing one is a fact rather than a guess. `rayfold check --unused` reads a snapshot.
 *
 * A server records nothing unless it is given a sink, and a sink keeps only the operation, the member's path
 * (`Book.author`, or empty for the operation itself), the client name from `Rayfold-Client`, when it was last seen
 * and how often. No arguments, no values, no viewer.
 */
data class UsageEvent(val op: String, val path: String, val client: String)

fun interface UsageSink {
    fun record(event: UsageEvent, at: Long)
}

data class UsageEntry(val op: String, val path: String, val client: String, val lastSeen: String, val count: Long)

/** Usage in memory for one process, safe to record into from several threads. */
class MemoryUsage(private val max: Int = 100_000) : UsageSink {
    private class Seen(@Volatile var at: Long, val count: java.util.concurrent.atomic.AtomicLong)

    private val seen = ConcurrentHashMap<String, Pair<UsageEvent, Seen>>()

    override fun record(event: UsageEvent, at: Long) {
        val key = event.client + "|" + event.op + "|" + event.path
        val existing = seen[key]
        if (existing != null) {
            if (at > existing.second.at) existing.second.at = at
            existing.second.count.incrementAndGet()
            return
        }
        // a full sink stops recording rather than growing without bound: telemetry must not exhaust memory
        if (seen.size >= max) return
        seen.putIfAbsent(key, event to Seen(at, java.util.concurrent.atomic.AtomicLong(1)))
    }

    /** Everything recorded, ordered as the TypeScript sink orders it, for the file `rayfold check --unused` reads. */
    fun snapshot(): List<UsageEntry> = seen.values
        .map { (event, s) -> UsageEntry(event.op, event.path, event.client, java.time.Instant.ofEpochMilli(s.at).toString(), s.count.get()) }
        .sortedWith(compareBy({ it.op }, { it.path }, { it.client }))

    val size: Int get() = seen.size
}
