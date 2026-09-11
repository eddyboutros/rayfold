package dev.rayfold.client

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.coroutines.cancellation.CancellationException

/** A command waiting for the server (sub-profile `sync`, spec 08 section 5): all it takes to send it again, and its prediction. */
@Serializable
data class QueuedCommand(
    val key: String,
    val op: String,
    val args: JsonObject,
    val shape: String? = null,
    val ifVersion: JsonElement? = null,
    val optimistic: List<OptimisticOp>? = null,
    val queuedAt: Long,
    /** Order of creation: a command queued late because its attempt failed late still goes out in its place. */
    val seq: Long,
)

/** Where the queue is kept, so waiting commands survive the app being stopped. */
interface QueueStorage {
    fun load(): List<QueuedCommand>
    fun save(queue: List<QueuedCommand>)
}

/** Keeps the queue in memory only: waiting commands are lost with the process. */
class MemoryQueueStorage : QueueStorage {
    @Volatile
    private var saved: List<QueuedCommand> = emptyList()
    override fun load(): List<QueuedCommand> = saved
    override fun save(queue: List<QueuedCommand>) {
        saved = queue.toList()
    }
}

/**
 * Keeps the queue in a JSON file, replaced atomically on every change. On Android:
 * `FileQueueStorage(File(context.filesDir, "rayfold-queue.json"))`.
 */
class FileQueueStorage(private val file: File) : QueueStorage {
    private val serializer = ListSerializer(QueuedCommand.serializer())

    override fun load(): List<QueuedCommand> {
        if (!file.exists()) return emptyList()
        return try {
            RayfoldJson.decodeFromString(serializer, file.readText())
        } catch (e: Exception) {
            emptyList() // a damaged file is dropped rather than blocking every later command
        }
    }

    override fun save(queue: List<QueuedCommand>) {
        if (queue.isEmpty()) {
            file.delete()
            return
        }
        val tmp = File(file.absoluteFile.parentFile, file.name + ".tmp")
        tmp.writeText(RayfoldJson.encodeToString(serializer, queue))
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }
}

/** A command queued, sent, or refused when it finally went out; [pending] counts the commands still waiting. */
data class QueueEvent(val type: Type, val command: QueuedCommand, val error: Throwable? = null, val pending: Int) {
    enum class Type { QUEUED, SENT, FAILED }
}

/** Whether a failure means the server could not be reached, so the command may go out again later with its key. */
fun isUnreachable(e: Throwable): Boolean = e is IOException || (e is RayfoldClientException && e.code == "unavailable")

/** The queue a [RayfoldClient] created with `offline` keeps. */
internal class OfflineQueue(
    private val storage: QueueStorage,
    private val send: suspend (QueuedCommand) -> JsonElement,
    /** Called once a command left the queue, sent or refused: its prediction goes. */
    private val settle: (QueuedCommand) -> Unit,
    /** Called for each command a restart brought back: its prediction is shown again. */
    restore: (QueuedCommand) -> Unit,
) {
    private class Entry(val command: QueuedCommand, val waiter: CompletableDeferred<JsonElement>?)

    private val lock = Any()
    private val entries = ArrayList<Entry>()
    private val listeners = CopyOnWriteArrayList<(QueueEvent) -> Unit>()
    private val draining = Mutex()

    init {
        for (c in storage.load().sortedBy { it.seq }) {
            entries.add(Entry(c, null))
            restore(c)
        }
    }

    val size: Int get() = synchronized(lock) { entries.size }

    val commands: List<QueuedCommand> get() = synchronized(lock) { entries.map { it.command } }

    /** Queues [command] in its place and suspends until it has gone out, with its result or the server's refusal. */
    suspend fun add(command: QueuedCommand): JsonElement {
        val waiter = CompletableDeferred<JsonElement>()
        val pending = synchronized(lock) {
            val at = entries.indexOfFirst { it.command.seq > command.seq }
            entries.add(if (at < 0) entries.size else at, Entry(command, waiter))
            storage.save(entries.map { it.command })
            entries.size
        }
        emit(QueueEvent(QueueEvent.Type.QUEUED, command, pending = pending))
        return waiter.await()
    }

    /** Sends waiting commands in order; returns how many still wait because the server is still unreachable. */
    suspend fun drain(): Int = draining.withLock { drainInOrder() }

    private suspend fun drainInOrder(): Int {
        while (true) {
            val e = synchronized(lock) { entries.firstOrNull() } ?: break
            val result = try {
                send(e.command)
            } catch (err: CancellationException) {
                throw err
            } catch (err: Throwable) {
                if (isUnreachable(err)) break // still offline: it and everything behind it keep waiting
                val pending = remove(e)
                settle(e.command)
                e.waiter?.completeExceptionally(err)
                emit(QueueEvent(QueueEvent.Type.FAILED, e.command, err, pending))
                continue
            }
            val pending = remove(e)
            settle(e.command)
            e.waiter?.complete(result)
            emit(QueueEvent(QueueEvent.Type.SENT, e.command, pending = pending))
        }
        return size
    }

    private fun remove(e: Entry): Int = synchronized(lock) {
        entries.remove(e)
        storage.save(entries.map { it.command })
        entries.size
    }

    fun subscribe(listener: (QueueEvent) -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    private fun emit(e: QueueEvent) {
        for (l in listeners) l(e)
    }
}
