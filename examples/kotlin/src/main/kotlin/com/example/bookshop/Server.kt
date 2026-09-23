package com.example.bookshop

import com.sun.net.httpserver.HttpServer
import dev.rayfold.core.Code
import dev.rayfold.core.CommandResult
import dev.rayfold.core.HttpOptions
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldHttp
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Resolvers
import dev.rayfold.core.SchemaText
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

fun main() {
    startServer(port = 4000)
    println("Bookshop API at http://localhost:4000/rayfold, explorer at http://localhost:4000/rayfold/explorer")
}

// #region server
fun startServer(port: Int, store: Store = Store()): HttpServer {
    val schema = SchemaText.load(resourceText("/bookshop.rayfold")).ir
    val server = RayfoldServer(schema, resolvers(store))
    val options = HttpOptions(explorer = true, explorerTitle = "Bookshop")
    return RayfoldHttp(server, options, ::viewerOf).start(port)
}
// #endregion server

// #region resolvers
fun resolvers(store: Store) = Resolvers(
    queries = mapOf(
        "book" to { args, _ -> store.book(args.string("id"))?.toJson() },
        "books" to { args, _ -> page(store.books(), args.getValue("page").jsonObject) },
    ),
    commands = mapOf(
        "buy" to { args, _ ->
            val bookId = args.string("bookId")
            val qty = args.int("qty")
            val book = store.update(bookId) { book ->
                // #region errors
                if (qty > book.stock) {
                    throw RayfoldException.domain(
                        "OutOfStock",
                        buildJsonObject {
                            put("bookId", book.id)
                            put("available", book.stock)
                        },
                        "Only ${book.stock} left of ${book.title}",
                    )
                }
                // #endregion errors
                book.copy(stock = book.stock - qty)
            } ?: notFound(bookId)
            stockChanged(book)
        },
        "restock" to { args, _ ->
            val bookId = args.string("bookId")
            val qty = args.int("qty")
            val book = store.update(bookId) { it.copy(stock = it.stock + qty) } ?: notFound(bookId)
            stockChanged(book)
        },
    ),
    // #region loader
    fields = mapOf(
        "Book" to mapOf(
            // called once per level with every book in the result, and answered with one lookup
            "author" to { books, _, _ -> store.authors(books.map { it.string("authorId") }).map { it?.toJson() } },
        ),
    ),
    // #endregion loader
)
// #endregion resolvers

/** The changed book as the command's result, plus the event the schema says the command emits. */
private fun stockChanged(book: Book) = CommandResult(
    book.toJson(),
    emit = listOf("StockChanged" to buildJsonObject { put("bookId", book.id); put("stock", book.stock) }),
)

/** One page of books sorted by id, so a cursor is the id of the last book on the page before. */
private fun page(books: List<Book>, page: JsonObject): JsonObject {
    val first = page.int("first")
    val after = page["after"]?.jsonPrimitive?.contentOrNull
    val start = after?.let { cursor -> books.count { it.id <= cursor } }
        ?: page["offset"]?.jsonPrimitive?.intOrNull
        ?: 0
    val items = books.drop(start).take(first)
    return buildJsonObject {
        put("items", JsonArray(items.map { it.toJson() }))
        put("cursor", items.lastOrNull()?.id)
        put("hasMore", start + items.size < books.size)
        put("total", books.size)
    }
}

private fun Book.toJson() = buildJsonObject {
    put("id", id)
    put("title", title)
    put("stock", stock)
    put("authorId", authorId)
    // Decimal travels as text, so the amount stays exact
    put("costPrice", costPrice.toPlainString())
}

private fun Author.toJson() = buildJsonObject {
    put("id", id)
    put("name", name)
}

private fun notFound(bookId: String): Nothing = throw RayfoldException(Code.NOT_FOUND, "No book $bookId")

// the runtime has checked the arguments against the schema before a resolver sees them
private fun JsonObject.string(name: String): String = getValue(name).jsonPrimitive.content

private fun JsonObject.int(name: String): Int = getValue(name).jsonPrimitive.int

private fun resourceText(path: String): String =
    Store::class.java.getResource(path)?.readText() ?: error("$path is missing from the classpath")
