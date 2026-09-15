package com.example.bookshop;

import com.sun.net.httpserver.HttpServer;
import dev.rayfold.java.Rayfold;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** The bookshop over real HTTP on a free port. Every test gets its own store and server, stopped afterwards. */
class BookshopTest {
    Store store;
    HttpServer http;
    HttpClient client;

    @BeforeEach
    void start() throws IOException {
        store = new Store();
        http = Bookshop.start(0, store);
        client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    }

    @AfterEach
    void stop() {
        http.stop(0);
        client.close();
    }

    /** Sends a batch of one op, as the viewer the token names or as nobody, and returns the op's one frame. */
    @SuppressWarnings("unchecked")
    Map<String, Object> send(Map<String, Object> op, String token) throws Exception {
        String body = Rayfold.toJson(Map.of("ops", List.of(op))).toString();
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + http.getAddress().getPort() + "/rayfold"))
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString(body));
        if (token != null) request.header("Authorization", "Bearer " + token);
        HttpResponse<String> response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, response.statusCode(), response.body());
        List<String> frames = response.body().lines().filter(line -> !line.isBlank()).toList();
        assertEquals(1, frames.size(), response.body());
        return (Map<String, Object>) Rayfold.parseJson(frames.getFirst());
    }

    Map<String, Object> query(String name, Map<String, ?> args, String shape, String token) throws Exception {
        var op = new LinkedHashMap<String, Object>(Map.of("id", 1, "op", name, "args", args));
        if (shape != null) op.put("shape", shape);
        return send(op, token);
    }

    Map<String, Object> command(String name, Map<String, ?> args, String shape, String token) throws Exception {
        // every client sends an idempotency key with a command
        var op = new LinkedHashMap<String, Object>(Map.of("id", 1, "op", name, "args", args, "key", UUID.randomUUID().toString()));
        if (shape != null) op.put("shape", shape);
        return send(op, token);
    }

    @SuppressWarnings("unchecked")
    static <T> T at(Object json, String... path) {
        Object current = json;
        for (String key : path) current = ((Map<String, Object>) current).get(key);
        return (T) current;
    }

    @Test
    void bookReturnsTheShapeItWasAskedForWithTheAuthorsName() throws Exception {
        var frame = query("book", Map.of("id", "b1"), "{ title stock author { name } }", null);
        assertEquals(
            Map.of("$type", "Book", "title", "A Wizard of Earthsea", "stock", 3L,
                "author", Map.of("$type", "Author", "name", "Ursula K. Le Guin")),
            frame.get("data"));
    }

    @Test
    void buyTakesCopiesOffTheShelf() throws Exception {
        var frame = command("buy", Map.of("bookId", "b3", "qty", 2), "{ id stock }", "customer");
        assertEquals(Map.of("$type", "Book", "id", "b3", "stock", 5L), frame.get("ok"));
        assertEquals(5, store.book("b3").orElseThrow().stock());
    }

    @Test
    void buyingMoreThanTheShelfHoldsFailsWithOutOfStockAndChangesNothing() throws Exception {
        var frame = command("buy", Map.of("bookId", "b1", "qty", 5), null, "customer");
        assertEquals("domain", at(frame, "error", "code"));
        assertEquals("OutOfStock", at(frame, "error", "type"));
        assertEquals(Map.of("bookId", "b1", "available", 3L), at(frame, "error", "data"));
        assertEquals(3, store.book("b1").orElseThrow().stock());
    }

    @Test
    void aCustomerMayNotRestock() throws Exception {
        var frame = command("restock", Map.of("bookId", "b2", "qty", 5), null, "customer");
        assertEquals("permission_denied", at(frame, "error", "code"));
        assertEquals(0, store.book("b2").orElseThrow().stock());
    }

    @Test
    void staffMayRestock() throws Exception {
        var frame = command("restock", Map.of("bookId", "b2", "qty", 5), "{ id stock }", "staff");
        assertEquals(Map.of("$type", "Book", "id", "b2", "stock", 5L), frame.get("ok"));
        assertEquals(5, store.book("b2").orElseThrow().stock());
    }

    @Test
    void costPriceIsLeftOutForACustomerAndRefusedWhenACustomerNamesIt() throws Exception {
        var book = query("book", Map.of("id", "b1"), null, "customer");
        assertEquals(Map.of("$type", "Book", "id", "b1", "title", "A Wizard of Earthsea", "stock", 3L), book.get("data"));
        var asked = query("book", Map.of("id", "b1"), "{ title costPrice }", "customer");
        assertEquals("permission_denied", at(asked, "error", "code"));
    }

    @Test
    void staffSeeCostPrice() throws Exception {
        var book = query("book", Map.of("id", "b1"), null, "staff");
        assertEquals(
            Map.of("$type", "Book", "id", "b1", "title", "A Wizard of Earthsea", "stock", 3L, "costPrice", "4.20"),
            book.get("data"));
        var asked = query("book", Map.of("id", "b1"), "{ title costPrice }", "staff");
        assertEquals(Map.of("$type", "Book", "title", "A Wizard of Earthsea", "costPrice", "4.20"), asked.get("data"));
    }

    @Test
    void aPageOfBooksLoadsItsAuthorsInOneLookup() throws Exception {
        var frame = query("books", Map.of(), "{ items { title author { name } } total }", null);
        List<Map<String, Object>> items = at(frame, "data", "items");
        assertEquals(
            List.of("Ursula K. Le Guin", "Ursula K. Le Guin", "Frank Herbert"),
            items.stream().map(item -> BookshopTest.<String>at(item, "author", "name")).toList());
        assertEquals(1, store.authorLookups());
        // guard: the count follows the lookups, so one more request is one more
        query("book", Map.of("id", "b3"), "{ author { name } }", null);
        assertEquals(2, store.authorLookups());
    }
}
