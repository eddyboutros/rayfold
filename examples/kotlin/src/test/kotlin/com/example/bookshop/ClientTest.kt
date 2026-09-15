package com.example.bookshop

import dev.rayfold.client.HttpTransport
import dev.rayfold.client.RayfoldClient
import dev.rayfold.client.Transport
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** The client app against a server on a free port, bounded to 5 s. */
class ClientTest {
    private val store = Store()
    private val http = startServer(port = 0, store)

    @AfterTest
    fun stop() {
        http.stop(0)
    }

    @Test
    fun `the client app sees its purchase through the watch without reading the book again`(): Unit = runBlocking {
        val requests = AtomicInteger()
        val transport = HttpTransport(
            "http://127.0.0.1:${http.address.port}/rayfold",
            headers = { mapOf("Authorization" to "Bearer customer") },
        )
        val counted = Transport { envelope, safe ->
            requests.incrementAndGet()
            transport.send(envelope, safe)
        }
        val lines = mutableListOf<String>()
        withTimeout(5_000) { buyOneCopy(RayfoldClient(counted), lines::add) }
        assertEquals(
            listOf("A Wizard of Earthsea by Ursula K. Le Guin: 3 in stock", "watching: 3 in stock", "after buying one: 2 in stock"),
            lines,
        )
        assertEquals(3, requests.get(), "the read, the watch's first read and the purchase, and nothing after it")
        assertEquals(2, store.book("b1")?.stock)
    }
}
