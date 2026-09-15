package com.example.bookshop;

import dev.rayfold.core.Code;
import dev.rayfold.core.RayfoldException;
import dev.rayfold.java.CommandOutcome;
import dev.rayfold.java.Rayfold;
import dev.rayfold.spring.Arg;
import dev.rayfold.spring.RayfoldCommand;
import dev.rayfold.spring.RayfoldField;
import dev.rayfold.spring.RayfoldQuery;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Objects;

@Component
public class BookResolvers {
    /** The schema's built-in {@code PageArgs}, with its defaults already filled in. */
    public record PageArgs(int first, String after, Integer offset) {}

    /** The schema's built-in {@code Page<Book>}. */
    public record BookPage(List<Book> items, String cursor, boolean hasMore, int total) {}

    private final Store store;

    public BookResolvers(Store store) {
        this.store = store;
    }

    // #region resolvers
    @RayfoldQuery("book")
    public Book book(@Arg String id) {
        return store.book(id).orElse(null);
    }

    @RayfoldQuery("books")
    public BookPage books(@Arg PageArgs page) {
        List<Book> books = store.books();
        // sorted by id, so a cursor is the id of the last book on the page before
        int start = page.after() != null
            ? (int) books.stream().filter(book -> book.id().compareTo(page.after()) <= 0).count()
            : Objects.requireNonNullElse(page.offset(), 0);
        List<Book> items = books.stream().skip(start).limit(page.first()).toList();
        String cursor = items.isEmpty() ? null : items.getLast().id();
        return new BookPage(items, cursor, start + items.size() < books.size(), books.size());
    }

    @RayfoldCommand("buy")
    public CommandOutcome buy(@Arg String bookId, @Arg int qty) {
        Book book = store.update(bookId, current -> {
            // #region errors
            if (qty > current.stock()) {
                throw Rayfold.domainError("OutOfStock",
                    Map.of("bookId", current.id(), "available", current.stock()),
                    "Only " + current.stock() + " left of " + current.title());
            }
            // #endregion errors
            return current.withStock(current.stock() - qty);
        }).orElseThrow(() -> notFound(bookId));
        return stockChanged(book);
    }

    @RayfoldCommand("restock")
    public CommandOutcome restock(@Arg String bookId, @Arg int qty) {
        Book book = store.update(bookId, current -> current.withStock(current.stock() + qty))
            .orElseThrow(() -> notFound(bookId));
        return stockChanged(book);
    }
    // #endregion resolvers

    // #region loader
    // called once per level with every book in the result, and answered with one lookup
    @RayfoldField(type = "Book", field = "author")
    public List<Author> author(List<Book> books) {
        return store.authors(books.stream().map(Book::authorId).toList());
    }
    // #endregion loader

    /** The changed book as the command's result, plus the event the schema says the command emits. */
    private static CommandOutcome stockChanged(Book book) {
        return Rayfold.result(book).emit("StockChanged", Map.of("bookId", book.id(), "stock", book.stock()));
    }

    private static RayfoldException notFound(String bookId) {
        return Rayfold.error(Code.NOT_FOUND, "No book " + bookId);
    }
}
