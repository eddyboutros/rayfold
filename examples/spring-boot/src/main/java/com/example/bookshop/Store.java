package com.example.bookshop;

import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.UnaryOperator;

/** The shop's shelves, in memory. */
@Component
public class Store {
    private final Map<String, Author> authors = Map.of(
        "a1", new Author("a1", "Ursula K. Le Guin"),
        "a2", new Author("a2", "Frank Herbert"));

    private final Map<String, Book> books = new ConcurrentHashMap<>(Map.of(
        "b1", new Book("b1", "A Wizard of Earthsea", 3, "a1", new BigDecimal("4.20")),
        "b2", new Book("b2", "The Left Hand of Darkness", 0, "a1", new BigDecimal("5.10")),
        "b3", new Book("b3", "Dune", 7, "a2", new BigDecimal("6.00"))));

    private final AtomicInteger authorLookups = new AtomicInteger();

    public Optional<Book> book(String id) {
        return Optional.ofNullable(books.get(id));
    }

    public List<Book> books() {
        return books.values().stream().sorted(Comparator.comparing(Book::id)).toList();
    }

    /** Many authors in one lookup, the way one {@code WHERE id IN (...)} query would fetch them. */
    public List<Author> authors(List<String> ids) {
        authorLookups.incrementAndGet();
        return ids.stream().map(authors::get).toList();
    }

    /** How many times authors were looked up, to see batching at work. */
    public int authorLookups() {
        return authorLookups.get();
    }

    /**
     * Replaces a book with what {@code change} makes of it, atomically, and returns the new copy. An exception thrown
     * by {@code change} leaves the book as it was.
     */
    public Optional<Book> update(String id, UnaryOperator<Book> change) {
        return Optional.ofNullable(books.computeIfPresent(id, (key, book) -> change.apply(book)));
    }
}
