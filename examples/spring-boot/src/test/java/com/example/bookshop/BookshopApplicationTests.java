package com.example.bookshop;

import dev.rayfold.java.Rayfold;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** The application over real HTTP on a free port, signed in through Spring Security. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
// a fresh application for every test, so no test sees another's purchases; closing it stops the server
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_EACH_TEST_METHOD)
class BookshopApplicationTests {
    @Value("${local.server.port}")
    int port;

    @Autowired
    Store store;

    final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    @AfterEach
    void closeClient() {
        client.close();
    }

    /** Sends a batch of one op, as the viewer the token names or as nobody, and returns the op's one frame. */
    @SuppressWarnings("unchecked")
    Map<String, Object> send(Map<String, Object> op, String token) throws Exception {
        String body = Rayfold.toJson(Map.of("ops", List.of(op))).toString();
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/rayfold"))
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString(body));
        if (token != null) request.header("Authorization", "Bearer " + token);
        HttpResponse<String> response = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        List<String> frames = response.body().lines().filter(line -> !line.isBlank()).toList();
        assertThat(frames).as(response.body()).hasSize(1);
        return (Map<String, Object>) Rayfold.parseJson(frames.getFirst());
    }

    Map<String, Object> query(String name, Map<String, ?> args, String shape, String user) throws Exception {
        var op = new LinkedHashMap<String, Object>(Map.of("id", 1, "op", name, "args", args));
        if (shape != null) op.put("shape", shape);
        return send(op, user);
    }

    Map<String, Object> command(String name, Map<String, ?> args, String shape, String user) throws Exception {
        // every client sends an idempotency key with a command
        var op = new LinkedHashMap<String, Object>(Map.of("id", 1, "op", name, "args", args, "key", UUID.randomUUID().toString()));
        if (shape != null) op.put("shape", shape);
        return send(op, user);
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
        assertThat(frame.get("data")).isEqualTo(Map.of("$type", "Book", "title", "A Wizard of Earthsea", "stock", 3L,
            "author", Map.of("$type", "Author", "name", "Ursula K. Le Guin")));
    }

    @Test
    void buyTakesCopiesOffTheShelf() throws Exception {
        var frame = command("buy", Map.of("bookId", "b3", "qty", 2), "{ id stock }", "customer");
        assertThat(frame.get("ok")).isEqualTo(Map.of("$type", "Book", "id", "b3", "stock", 5L));
        assertThat(store.book("b3").orElseThrow().stock()).isEqualTo(5);
    }

    @Test
    void buyingMoreThanTheShelfHoldsFailsWithOutOfStockAndChangesNothing() throws Exception {
        var frame = command("buy", Map.of("bookId", "b1", "qty", 5), null, "customer");
        assertThat(BookshopApplicationTests.<String>at(frame, "error", "code")).isEqualTo("domain");
        assertThat(BookshopApplicationTests.<String>at(frame, "error", "type")).isEqualTo("OutOfStock");
        assertThat(BookshopApplicationTests.<Object>at(frame, "error", "data")).isEqualTo(Map.of("bookId", "b1", "available", 3L));
        assertThat(store.book("b1").orElseThrow().stock()).isEqualTo(3);
    }

    @Test
    void aCustomerMayNotRestock() throws Exception {
        var frame = command("restock", Map.of("bookId", "b2", "qty", 5), null, "customer");
        assertThat(BookshopApplicationTests.<String>at(frame, "error", "code")).isEqualTo("permission_denied");
        assertThat(store.book("b2").orElseThrow().stock()).isZero();
    }

    @Test
    void staffMayRestock() throws Exception {
        var frame = command("restock", Map.of("bookId", "b2", "qty", 5), "{ id stock }", "staff");
        assertThat(frame.get("ok")).isEqualTo(Map.of("$type", "Book", "id", "b2", "stock", 5L));
        assertThat(store.book("b2").orElseThrow().stock()).isEqualTo(5);
    }

    @Test
    void costPriceIsLeftOutForACustomerAndRefusedWhenACustomerNamesIt() throws Exception {
        var book = query("book", Map.of("id", "b1"), null, "customer");
        assertThat(book.get("data")).isEqualTo(Map.of("$type", "Book", "id", "b1", "title", "A Wizard of Earthsea", "stock", 3L));
        var asked = query("book", Map.of("id", "b1"), "{ title costPrice }", "customer");
        assertThat(BookshopApplicationTests.<String>at(asked, "error", "code")).isEqualTo("permission_denied");
    }

    @Test
    void staffSeeCostPrice() throws Exception {
        var book = query("book", Map.of("id", "b1"), null, "staff");
        assertThat(book.get("data")).isEqualTo(
            Map.of("$type", "Book", "id", "b1", "title", "A Wizard of Earthsea", "stock", 3L, "costPrice", "4.20"));
        var asked = query("book", Map.of("id", "b1"), "{ title costPrice }", "staff");
        assertThat(asked.get("data")).isEqualTo(Map.of("$type", "Book", "title", "A Wizard of Earthsea", "costPrice", "4.20"));
    }

    @Test
    void aPageOfBooksLoadsItsAuthorsInOneLookup() throws Exception {
        var frame = query("books", Map.of(), "{ items { title author { name } } total }", null);
        List<Map<String, Object>> items = at(frame, "data", "items");
        assertThat(items.stream().map(item -> BookshopApplicationTests.<String>at(item, "author", "name")).toList())
            .containsExactly("Ursula K. Le Guin", "Ursula K. Le Guin", "Frank Herbert");
        assertThat(store.authorLookups()).isEqualTo(1);
        // guard: the count follows the lookups, so one more request is one more
        query("book", Map.of("id", "b3"), "{ author { name } }", null);
        assertThat(store.authorLookups()).isEqualTo(2);
    }
}
