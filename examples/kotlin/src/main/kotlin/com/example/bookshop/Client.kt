package com.example.bookshop

import dev.rayfold.client.HttpTransport
import dev.rayfold.client.RayfoldClient
import dev.rayfold.client.args
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// #region client
fun main() = runBlocking {
    // the access token the user's sign-in produced; a local run signs a customer's with the development key
    val accessToken = System.getenv("TOKEN") ?: devToken("u1", "customer")
    val client = RayfoldClient(
        HttpTransport("http://localhost:4000/rayfold", headers = { mapOf("Authorization" to "Bearer $accessToken") }),
    )
    buyOneCopy(client, ::println)
}

suspend fun buyOneCopy(client: RayfoldClient, say: (String) -> Unit) = coroutineScope {
    val book = client.query("book", args("id" to "b1"), shape = "{ title stock author { name } }").jsonObject
    say("${book.text("title")} by ${book.getValue("author").jsonObject.text("name")}: ${book.text("stock")} in stock")

    // the book as the client's cache holds it: now, and again whenever the cache changes it
    val stock = Channel<String>(Channel.UNLIMITED)
    val watch = launch {
        client.watch("book", args("id" to "b1"), shape = "{ id stock }").collect { stock.send(it.jsonObject.text("stock")) }
    }
    say("watching: ${stock.receive()} in stock")

    client.command("buy", args("bookId" to "b1", "qty" to 1), shape = "{ id stock }")
    // no second read: the purchase came back with a patch for Book:b1, and the watch saw the cache apply it
    say("after buying one: ${stock.receive()} in stock")
    watch.cancel()
}
// #endregion client

private fun JsonObject.text(name: String): String = getValue(name).jsonPrimitive.content
