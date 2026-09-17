package dev.rayfold.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.UUID

/**
 * Uploads (extension `upload`, spec 04 section 9): bytes too large or too awkward for a JSON argument arrive on their
 * own route, and the command that uses them names the upload rather than carrying it.
 *
 *   POST {path}/uploads          Content-Type: application/octet-stream   -> 201 { "id": "...", "size": 1234 }
 *   POST /rayfold                { "ops": [{ "op": "setAvatar", "args": { "upload": "<id>" }, "key": "..." }] }
 *
 * Two reasons it is a route of its own rather than a multipart batch. A browser can send `multipart/form-data` to any
 * site without a preflight, so accepting it on the batch endpoint would give up half of what stops cross-site writes
 * (spec 12 section 2); `application/octet-stream` is not safelisted either, so this route keeps that protection. And
 * bytes that travel as bytes cost what they weigh, where a base64 argument costs a third more and must be held whole.
 *
 * The store is yours: [MemoryUploadStore] is for tests and small single servers, and anything that can keep bytes -
 * S3, a Postgres large object, a disk - is three methods. For files measured in hundreds of megabytes, hand the client
 * a URL from your own storage instead and let it upload there; a protocol should not pretend to be a file server.
 */
data class Upload(
    val id: String,
    /** Bytes stored. */
    val size: Long,
    /** When it arrived, in milliseconds since the epoch. */
    val at: Long,
    /** What the client called it, if it said. Never trusted as a path: treat it as a label. */
    val name: String? = null,
    /** What the client said it is. Never trusted: sniff or restrict it yourself where it matters. */
    val type: String? = null,
    /** The viewer that sent it, so a command can refuse an upload that was not theirs. */
    val viewer: JsonElement = JsonNull,
)

interface UploadStore {
    /** Keeps the bytes and answers with the handle a command will name. Reads the stream once. */
    suspend fun put(body: InputStream, name: String?, type: String?, viewer: JsonElement): Upload

    /** The upload a command named with its bytes, or null when it is gone: consumed, expired, or never there. */
    suspend fun open(id: String): Pair<Upload, InputStream>?

    /** Drops it. A command that has taken what it needs should say so, rather than wait for the lifetime to pass. */
    suspend fun delete(id: String)
}

/**
 * Uploads in memory, for tests and for one small server. Bytes are held whole, so [maxBytes] is what keeps a server
 * from being filled by uploads nobody uses: expired ones go first, then the oldest. Anything larger than that belongs
 * in a store that writes them down.
 */
class MemoryUploadStore(
    /** How long an upload waits to be used. */
    private val ttlMs: Long = 60 * 60 * 1000L,
    /** Most bytes held at once; past it the oldest go first. */
    private val maxBytes: Long = 256L * 1024 * 1024,
    private val now: () -> Long = System::currentTimeMillis,
    /** Ids. Must be unguessable: an id is what lets a command read those bytes. */
    private val id: () -> String = { UUID.randomUUID().toString() },
) : UploadStore {
    private class Kept(val upload: Upload, val bytes: ByteArray)

    // insertion order is arrival order, so expired and oldest entries sit at the head; guarded by itself
    private val held = LinkedHashMap<String, Kept>()

    private var total = 0L

    /** Uploads held right now, for tests and for a health check. */
    val size: Int get() = synchronized(held) { held.size }

    /** Bytes held right now. */
    val bytes: Long get() = synchronized(held) { total }

    override suspend fun put(body: InputStream, name: String?, type: String?, viewer: JsonElement): Upload {
        val bytes = body.readBytes() // read before anything is kept: a stream that fails leaves nothing behind
        val upload = Upload(id(), bytes.size.toLong(), now(), name, type, viewer)
        synchronized(held) {
            held[upload.id] = Kept(upload, bytes)
            total += bytes.size
            sweep(now())
        }
        return upload
    }

    override suspend fun open(id: String): Pair<Upload, InputStream>? = synchronized(held) {
        val kept = held[id] ?: return null
        if (now() - kept.upload.at >= ttlMs) {
            held.remove(id)
            total -= kept.upload.size
            return null
        }
        kept.upload to ByteArrayInputStream(kept.bytes)
    }

    override suspend fun delete(id: String) {
        synchronized(held) {
            held.remove(id)?.let { total -= it.upload.size }
        }
    }

    /** Expired uploads go first, then the oldest, until the store is inside its bound. Caller holds the lock. */
    private fun sweep(t: Long) {
        val expired = held.entries.iterator()
        while (expired.hasNext()) {
            val kept = expired.next().value
            if (t - kept.upload.at < ttlMs) break // arrival order, so the rest are younger
            expired.remove()
            total -= kept.upload.size
        }
        val oldest = held.entries.iterator()
        while (total > maxBytes && oldest.hasNext()) {
            val kept = oldest.next().value
            oldest.remove()
            total -= kept.upload.size
        }
    }
}

/** What the upload route reads and answers. */
data class UploadOptions(
    /** Where the bytes go. Without one, the route is not served at all. */
    val store: UploadStore,
    /** Most bytes one upload may carry. */
    val maxBytes: Long = 25L * 1024 * 1024,
    /**
     * Whether an upload needs an identified viewer. True by default: an open upload route is a way to fill a server's
     * storage with nothing to trace it to.
     */
    val viewerRequired: Boolean = true,
)
