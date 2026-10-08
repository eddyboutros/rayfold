package dev.rayfold.test

import dev.rayfold.client.Transport
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject

/** Every frame of one batch sent through [transport], bounded to 5 s: for the Java tests, which cannot collect a flow. */
fun framesOf(transport: Transport, envelope: JsonObject): List<JsonObject> =
    runBlocking { withTimeout(5_000) { transport.send(envelope, false).toList() } }
