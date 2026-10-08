package dev.rayfold.test

import dev.rayfold.client.Transport
import dev.rayfold.core.RayfoldServer
import dev.rayfold.java.Rayfold
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.util.function.Supplier

/**
 * A [Transport] over a [RayfoldServer] in the same process (mirrors `createLocalTransport` of packages/client): a real
 * [dev.rayfold.client.RayfoldClient] against the real server, with no network between them. Every frame the client
 * reads is one the server produced for the viewer, policies included. Cancelling the collection cancels the batch on
 * the server, so a live query gives its subscription back.
 *
 * ```kotlin
 * val client = RayfoldClient(LocalTransport(server) { buildJsonObject { put("id", "u1") } })
 * ```
 *
 * [viewer] runs once per batch, so a test can change who is signed in between two calls.
 */
class LocalTransport @JvmOverloads constructor(
    private val server: RayfoldServer,
    private val viewer: () -> JsonElement = { JsonNull },
) : Transport {
    /** For Java: the viewer as a map or a record, converted as a resolver's result is; null is an anonymous caller. */
    constructor(server: RayfoldServer, viewer: Supplier<*>) : this(server, { Rayfold.toJson(viewer.get()) })

    /** [safe] changes nothing here: it chooses between two kinds of HTTP request, and there is none. */
    override fun send(envelope: JsonObject, safe: Boolean): Flow<JsonObject> = flow { emitAll(server.execute(envelope, viewer())) }
}
