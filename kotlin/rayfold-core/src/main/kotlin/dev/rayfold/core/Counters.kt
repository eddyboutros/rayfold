package dev.rayfold.core

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Counts of what a server did, for an operator or a metrics system to read. Mirrors packages/server/src/counters.ts,
 * name for name, because a fleet console reads the same counters from either runtime.
 *
 * This is the other half of [UsageSink]. Usage answers "does anyone still ask for this field"; counters answer "what
 * is this server doing right now" - how many requests arrived, how many were refused before anything ran, how many
 * commands replayed rather than executed, how many live queries are being re-run.
 *
 * Most of it cannot be had any other way. A request refused for its `Origin`, its media type or its size is answered
 * and gone before a batch is built, so no [Instrumentation] hook ever sees it.
 *
 * A server records nothing unless it is given a sink.
 */
fun interface Counters {
    /** Adds [n] to the count of [name] with these labels. Must not throw: a sink that fails must not fail a request. */
    fun add(name: String, n: Long, labels: Map<String, String>)
}

/** Adds one, the common case. */
fun Counters.add(name: String, labels: Map<String, String> = emptyMap()): Unit = add(name, 1, labels)

data class CounterEntry(val name: String, val labels: Map<String, String>, val count: Long)

/**
 * Counters in memory for one process, safe to count into from several threads - what `GET {base}/stats`, the tests
 * and a small server use.
 *
 * Bounded, because a label taken from a request is a way to exhaust memory. Past the bound it keeps counting what it
 * already knows and counts what it had to drop, rather than going quiet: a sink that silently stops recording is
 * worse than one that says it is full, because the graph keeps drawing and stops being true.
 */
class MemoryCounters(private val max: Int = 10_000) : Counters {
    private val counts = ConcurrentHashMap<String, Pair<CounterEntry, AtomicLong>>()
    private val droppedCount = AtomicLong()

    override fun add(name: String, n: Long, labels: Map<String, String>) {
        // sorted, so the same labels in another order are the same series
        val key = name + "|" + labels.entries.sortedBy { it.key }.joinToString(",") { "${it.key}=${it.value}" }
        val existing = counts[key]
        if (existing != null) {
            existing.second.addAndGet(n)
            return
        }
        if (counts.size >= max) {
            droppedCount.incrementAndGet()
            return
        }
        counts.putIfAbsent(key, CounterEntry(name, labels, 0) to AtomicLong(n))?.second?.addAndGet(n)
    }

    /** Everything counted, ordered as the TypeScript sink orders it, so two snapshots of one fleet read the same way. */
    fun snapshot(): List<CounterEntry> = counts.values
        .map { (entry, count) -> entry.copy(count = count.get()) }
        .sortedWith(compareBy({ it.name }, { it.labels.entries.sortedBy { e -> e.key }.joinToString(",") { e -> "${e.key}=${e.value}" } }))

    /** Series this sink refused because it was full. Anything above zero means the counts are incomplete. */
    val dropped: Long get() = droppedCount.get()

    val size: Int get() = counts.size
}
