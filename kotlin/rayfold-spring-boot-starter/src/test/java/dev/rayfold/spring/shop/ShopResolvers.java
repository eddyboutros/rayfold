package dev.rayfold.spring.shop;

import dev.rayfold.java.Context;
import dev.rayfold.java.Rayfold;
import dev.rayfold.java.Values;
import dev.rayfold.spring.Arg;
import dev.rayfold.spring.RayfoldCommand;
import dev.rayfold.spring.RayfoldField;
import dev.rayfold.spring.RayfoldQuery;
import dev.rayfold.spring.RayfoldStream;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

/** The shop's resolvers, written the way a Spring developer writes controllers. */
@Component
public final class ShopResolvers {
    public record Author(String id, String name) {}

    public record Book(String id, String title, int stock, String authorId) {}

    final Map<String, Book> books = new ConcurrentHashMap<>();
    final Map<String, Author> authors = Map.of("a1", new Author("a1", "Ursula K. Le Guin"), "a2", new Author("a2", "Frank Herbert"));
    final AtomicInteger authorLoads = new AtomicInteger();
    final List<String> sold = Collections.synchronizedList(new ArrayList<>());

    public ShopResolvers() {
        reset();
    }

    public void reset() {
        books.clear();
        books.put("b1", new Book("b1", "The Dispossessed", 3, "a1"));
        books.put("b2", new Book("b2", "Dune", 0, "a2"));
        authorLoads.set(0);
        sold.clear();
    }

    @RayfoldQuery("book")
    public Book book(@Arg String id) {
        return books.get(id);
    }

    @RayfoldQuery("books")
    public List<Book> books() {
        return books.values().stream().sorted(Comparator.comparing(Book::id)).toList();
    }

    @RayfoldField(type = "Book", field = "author")
    public List<Author> authors(List<Book> parents) {
        authorLoads.incrementAndGet();
        return parents.stream().map(b -> authors.get(b.authorId())).toList();
    }

    @RayfoldCommand("buy")
    public Book buy(@Arg String id, @Arg int qty, Context ctx) {
        Book b = books.get(id);
        if (qty > b.stock()) throw Rayfold.domainError("OutOfStock", Map.of("available", b.stock()), "Only " + b.stock() + " left");
        Book next = new Book(b.id(), b.title(), b.stock() - qty, b.authorId());
        books.put(id, next);
        sold.add(ctx.viewerId() + ":" + id);
        return next;
    }

    @RayfoldStream("countdown")
    public Stream<Integer> countdown(@Arg("from") int start) {
        return Stream.iterate(start, i -> i >= 0, i -> i - 1);
    }

    @RayfoldQuery("secret")
    public CompletableFuture<Map<String, Object>> secret(@Arg String id) {
        return CompletableFuture.completedFuture(Map.of("id", id, "note", "classified"));
    }

    @RayfoldQuery("me")
    public String me(Context ctx) {
        Values v = ctx.viewer();
        return v == null ? "anonymous" : v.getString("id") + "/" + v.getString("role");
    }
}
