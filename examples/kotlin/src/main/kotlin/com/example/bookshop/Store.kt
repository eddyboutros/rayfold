package com.example.bookshop

import java.math.BigDecimal
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

data class Author(val id: String, val name: String)

data class Book(val id: String, val title: String, val stock: Int, val authorId: String, val costPrice: BigDecimal)

/** The shop's shelves, in memory. Each server gets a fresh one. */
class Store {
    private val authors = listOf(
        Author("a1", "Ursula K. Le Guin"),
        Author("a2", "Frank Herbert"),
    ).associateBy { it.id }

    private val books = ConcurrentHashMap(
        listOf(
            Book("b1", "A Wizard of Earthsea", stock = 3, authorId = "a1", costPrice = BigDecimal("4.20")),
            Book("b2", "The Left Hand of Darkness", stock = 0, authorId = "a1", costPrice = BigDecimal("5.10")),
            Book("b3", "Dune", stock = 7, authorId = "a2", costPrice = BigDecimal("6.00")),
        ).associateBy { it.id },
    )

    /** How many times authors were looked up, to see batching at work. */
    val authorLookups = AtomicInteger()

    fun book(id: String): Book? = books[id]

    fun books(): List<Book> = books.values.sortedBy { it.id }

    /** Many authors in one lookup, the way one `WHERE id IN (...)` query would fetch them. */
    fun authors(ids: List<String>): List<Author?> {
        authorLookups.incrementAndGet()
        return ids.map { authors[it] }
    }

    /**
     * Replaces a book with what [change] makes of it, atomically, and returns the new copy; null when there is no such
     * book. An exception thrown by [change] leaves the book as it was.
     */
    fun update(id: String, change: (Book) -> Book): Book? = books.computeIfPresent(id) { _, book -> change(book) }
}
