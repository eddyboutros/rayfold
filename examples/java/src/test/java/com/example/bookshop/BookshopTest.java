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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

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

    URI uri(String path) {
        return URI.create("http://127.0.0.1:" + http.getAddress().getPort() + path);
    }

    /** Sends a batch of one op, as the viewer the token names or as nobody, and returns the op's one frame. */
    @SuppressWarnings("unchecked")
    Map<String, Object> send(Map<String, Object> op, String token) throws Exception {
        String body = Rayfold.toJson(Map.of("ops", List.of(op))).toString();
        HttpRequest.Builder request = HttpRequest.newBuilder(uri("/rayfold"))
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

    HttpResponse<String> get(String path) throws Exception {
        return client.send(HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(5)).build(), HttpResponse.BodyHandlers.ofString());
    }

    Map<String, Object> query(String name, Map<String, ?> args, String shape, String token) throws Exception {
        var op = new LinkedHashMap<String, Object>(Map.of("id", 1, "op", name, "args", args));
        if (shape != null) op.put("shape", shape);
        return send(op, token);
    }

    Map<String, Object> command(String name, Map<String, ?> args, String shape, String token) throws Exception {
        // every client sends an idempotency key with a command
        return command(name, args, shape, token, UUID.randomUUID().toString());
    }

    Map<String, Object> command(String name, Map<String, ?> args, String shape, String token, String key) throws Exception {
        var op = new LinkedHashMap<String, Object>(Map.of("id", 1, "op", name, "args", args, "key", key));
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
    void booksComeAPageAtATimeAndTheCursorPicksUpWhereTheLastPageEnded() throws Exception {
        var first = query("books", Map.of("page", Map.of("first", 2)), "{ items { id } cursor hasMore total }", null);
        assertEquals(
            Map.of("items", List.of(Map.of("$type", "Book", "id", "b1"), Map.of("$type", "Book", "id", "b2")),
                "cursor", "b2", "hasMore", true, "total", 3L),
            first.get("data"));
        String cursor = at(first, "data", "cursor");
        var second = query("books", Map.of("page", Map.of("first", 2, "after", cursor)), "{ items { id } cursor hasMore total }", null);
        assertEquals(
            Map.of("items", List.of(Map.of("$type", "Book", "id", "b3")), "cursor", "b3", "hasMore", false, "total", 3L),
            second.get("data"));
    }

    @Test
    void buyTakesCopiesOffTheShelf() throws Exception {
        var frame = command("buy", Map.of("bookId", "b3", "qty", 2), "{ id stock }", "customer");
        assertEquals(Map.of("$type", "Book", "id", "b3", "stock", 5L), frame.get("ok"));
        assertEquals(5, store.book("b3").orElseThrow().stock());
    }

    @Test
    void aPurchaseRetriedWithTheSameKeyGetsTheFirstAnswerAgainMarkedAsAReplayAndSellsOnce() throws Exception {
        String key = UUID.randomUUID().toString();
        var first = command("buy", Map.of("bookId", "b3", "qty", 2), "{ id stock }", "customer", key);
        assertEquals(Map.of("$type", "Book", "id", "b3", "stock", 5L), first.get("ok"));
        assertNull(at(first, "meta", "replay"));

        var retry = command("buy", Map.of("bookId", "b3", "qty", 2), "{ id stock }", "customer", key);
        var replayed = new LinkedHashMap<String, Object>(at(first, "meta"));
        replayed.put("replay", true);
        var expected = new LinkedHashMap<>(first);
        expected.put("meta", replayed);
        assertEquals(expected, retry);
        assertEquals(5, store.book("b3").orElseThrow().stock());

        // guard: a new key is a new purchase
        var next = command("buy", Map.of("bookId", "b3", "qty", 2), "{ id stock }", "customer");
        assertEquals(Map.of("$type", "Book", "id", "b3", "stock", 3L), next.get("ok"));
        assertEquals(3, store.book("b3").orElseThrow().stock());
    }

    @Test
    void aQtyOutsideOneToTenIsRefusedBeforeTheResolverSeesItAndNothingIsSold() throws Exception {
        var none = command("buy", Map.of("bookId", "b3", "qty", 0), null, "customer");
        assertEquals(Map.of("code", "invalid_argument", "message", "buy().qty: must be >= 1"), none.get("error"));
        var tooMany = command("buy", Map.of("bookId", "b3", "qty", 11), null, "customer");
        assertEquals(Map.of("code", "invalid_argument", "message", "buy().qty: must be <= 10"), tooMany.get("error"));
        assertEquals(7, store.book("b3").orElseThrow().stock());
    }

    @Test
    void aQtyAtEitherEndOfTheRangeSells() throws Exception {
        // Dune has 7 copies, so staff bring it up to the 10 one purchase may take
        command("restock", Map.of("bookId", "b3", "qty", 3), null, "staff");
        var most = command("buy", Map.of("bookId", "b3", "qty", 10), "{ id stock }", "customer");
        assertEquals(Map.of("$type", "Book", "id", "b3", "stock", 0L), most.get("ok"));
        var least = command("buy", Map.of("bookId", "b1", "qty", 1), "{ id stock }", "customer");
        assertEquals(Map.of("$type", "Book", "id", "b1", "stock", 2L), least.get("ok"));
    }

    @Test
    void buyingMoreThanTheShelfHoldsFailsWithOutOfStockAndChangesNothing() throws Exception {
        var frame = command("buy", Map.of("bookId", "b1", "qty", 5), null, "customer");
        assertEquals(
            Map.of("code", "domain", "type", "OutOfStock", "message", "Only 3 left of A Wizard of Earthsea",
                "data", Map.of("bookId", "b1", "available", 3L)),
            frame.get("error"));
        assertEquals(3, store.book("b1").orElseThrow().stock());
    }

    @Test
    void buyingWithoutSigningInIsRefusedAndSellsNothing() throws Exception {
        var frame = command("buy", Map.of("bookId", "b1"), null, null);
        assertEquals(Map.of("code", "unauthenticated", "message", "Sign in to access buy()"), frame.get("error"));
        assertEquals(3, store.book("b1").orElseThrow().stock());
        // guard: the same purchase from a signed-in customer goes through, one copy by default
        var signedIn = command("buy", Map.of("bookId", "b1"), "{ id stock }", "customer");
        assertEquals(Map.of("$type", "Book", "id", "b1", "stock", 2L), signedIn.get("ok"));
        assertEquals(2, store.book("b1").orElseThrow().stock());
    }

    @Test
    void aCustomerMayNotRestock() throws Exception {
        var frame = command("restock", Map.of("bookId", "b2", "qty", 5), null, "customer");
        assertEquals(Map.of("code", "permission_denied", "message", "Not allowed to access restock()"), frame.get("error"));
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
        assertEquals(
            Map.of("code", "permission_denied", "message", "Not allowed to access Book.costPrice", "path", "costPrice"),
            asked.get("error"));
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
        assertEquals(
            Map.of("items", List.of(
                    Map.of("$type", "Book", "title", "A Wizard of Earthsea", "author", Map.of("$type", "Author", "name", "Ursula K. Le Guin")),
                    Map.of("$type", "Book", "title", "The Left Hand of Darkness", "author", Map.of("$type", "Author", "name", "Ursula K. Le Guin")),
                    Map.of("$type", "Book", "title", "Dune", "author", Map.of("$type", "Author", "name", "Frank Herbert"))),
                "total", 3L),
            frame.get("data"));
        assertEquals(1, store.authorLookups());
        // guard: the count follows the lookups, so one more request is one more
        query("book", Map.of("id", "b3"), "{ author { name } }", null);
        assertEquals(2, store.authorLookups());
    }

    @Test
    void theExplorerIsServedBesideTheEndpointAndNothingElseIs() throws Exception {
        var page = get("/rayfold/explorer");
        assertEquals(200, page.statusCode());
        assertEquals("text/html; charset=utf-8", page.headers().firstValue("Content-Type").orElse(null));
        // the page carries the endpoint it talks to and the title Bookshop.start gave it
        assertTrue(page.body().contains("<script type=\"application/json\" id=\"config\">{\"endpoint\":\"/rayfold\",\"title\":\"Bookshop\"}</script>"));
        assertEquals(404, get("/elsewhere").statusCode());
    }
}
