package com.example.bookshop;

import com.sun.net.httpserver.HttpServer;
import dev.rayfold.core.Code;
import dev.rayfold.core.RayfoldException;
import dev.rayfold.core.RayfoldServer;
import dev.rayfold.java.CommandOutcome;
import dev.rayfold.java.Rayfold;
import dev.rayfold.java.Values;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class Bookshop {
    private Bookshop() {}

    public static void main(String[] args) throws IOException {
        start(4000, new Store());
        System.out.println("Bookshop API at http://localhost:4000/rayfold, explorer at http://localhost:4000/rayfold/explorer");
    }

    // #region server
    public static HttpServer start(int port, Store store) throws IOException {
        return Rayfold.http(server(store))
            .viewer(Auth::viewerOf)
            .explorer("Bookshop")
            .start(port);
    }
    // #endregion server

    // #region resolvers
    public static RayfoldServer server(Store store) {
        return Rayfold.server(schema())
            .query("book", (args, ctx) -> store.book(args.getString("id")).orElse(null))
            .query("books", (args, ctx) -> page(store.books(), args.getValues("page")))
            .command("buy", (args, ctx) -> {
                String bookId = args.getString("bookId");
                int qty = args.getInt("qty");
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
            })
            .command("restock", (args, ctx) -> {
                String bookId = args.getString("bookId");
                int qty = args.getInt("qty");
                Book book = store.update(bookId, current -> current.withStock(current.stock() + qty))
                    .orElseThrow(() -> notFound(bookId));
                return stockChanged(book);
            })
            // #region loader
            // called once per level with every book in the result, and answered with one lookup
            .field("Book", "author", (books, args, ctx) ->
                store.authors(books.stream().map(book -> book.getString("authorId")).toList()))
            // #endregion loader
            .build();
    }
    // #endregion resolvers

    /** The schema's built-in {@code Page<Book>}. */
    private record BookPage(List<Book> items, String cursor, boolean hasMore, int total) {}

    /** One page of books sorted by id, so a cursor is the id of the last book on the page before. */
    private static BookPage page(List<Book> books, Values page) {
        int first = page.getInt("first");
        String after = page.getString("after");
        int start = after != null
            ? (int) books.stream().filter(book -> book.id().compareTo(after) <= 0).count()
            : Objects.requireNonNullElse(page.getInt("offset"), 0);
        List<Book> items = books.stream().skip(start).limit(first).toList();
        String cursor = items.isEmpty() ? null : items.getLast().id();
        return new BookPage(items, cursor, start + items.size() < books.size(), books.size());
    }

    /** The changed book as the command's result, plus the event the schema says the command emits. */
    private static CommandOutcome stockChanged(Book book) {
        return Rayfold.result(book).emit("StockChanged", Map.of("bookId", book.id(), "stock", book.stock()));
    }

    private static RayfoldException notFound(String bookId) {
        return Rayfold.error(Code.NOT_FOUND, "No book " + bookId);
    }

    private static String schema() {
        try (InputStream in = Bookshop.class.getResourceAsStream("/bookshop.rayfold")) {
            Objects.requireNonNull(in, "bookshop.rayfold is missing from the classpath");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
