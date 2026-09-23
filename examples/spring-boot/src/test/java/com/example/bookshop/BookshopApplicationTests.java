package com.example.bookshop;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
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
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Date;
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

    URI uri(String path) {
        return URI.create("http://127.0.0.1:" + port + path);
    }

    /** A request for one op with the given bearer token, or none. */
    HttpRequest request(Map<String, Object> op, String bearer) {
        String body = Rayfold.toJson(Map.of("ops", List.of(op))).toString();
        HttpRequest.Builder request = HttpRequest.newBuilder(uri("/rayfold"))
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString(body));
        if (bearer != null) request.header("Authorization", "Bearer " + bearer);
        return request.build();
    }

    /**
     * Sends a batch of one op, signed in as {@code role} ("customer" or "staff", with a token as the identity provider
     * issues one) or as nobody, and returns the op's one frame.
     */
    @SuppressWarnings("unchecked")
    Map<String, Object> send(Map<String, Object> op, String role) throws Exception {
        String bearer = role == null ? null : DevTokens.token(role.equals("staff") ? "s1" : "u1", role);
        HttpResponse<String> response = client.send(request(op, bearer), HttpResponse.BodyHandlers.ofString());
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        List<String> frames = response.body().lines().filter(line -> !line.isBlank()).toList();
        assertThat(frames).as(response.body()).hasSize(1);
        return (Map<String, Object>) Rayfold.parseJson(frames.getFirst());
    }

    HttpResponse<String> get(String path) throws Exception {
        return client.send(HttpRequest.newBuilder(uri(path)).timeout(Duration.ofSeconds(5)).build(), HttpResponse.BodyHandlers.ofString());
    }

    Map<String, Object> query(String name, Map<String, ?> args, String shape, String user) throws Exception {
        var op = new LinkedHashMap<String, Object>(Map.of("id", 1, "op", name, "args", args));
        if (shape != null) op.put("shape", shape);
        return send(op, user);
    }

    Map<String, Object> command(String name, Map<String, ?> args, String shape, String user) throws Exception {
        // every client sends an idempotency key with a command
        return command(name, args, shape, user, UUID.randomUUID().toString());
    }

    Map<String, Object> command(String name, Map<String, ?> args, String shape, String user, String key) throws Exception {
        var op = new LinkedHashMap<String, Object>(Map.of("id", 1, "op", name, "args", args, "key", key));
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
    void booksComeAPageAtATimeAndTheCursorPicksUpWhereTheLastPageEnded() throws Exception {
        var first = query("books", Map.of("page", Map.of("first", 2)), "{ items { id } cursor hasMore total }", null);
        assertThat(first.get("data")).isEqualTo(Map.of(
            "items", List.of(Map.of("$type", "Book", "id", "b1"), Map.of("$type", "Book", "id", "b2")),
            "cursor", "b2", "hasMore", true, "total", 3L));
        String cursor = at(first, "data", "cursor");
        var second = query("books", Map.of("page", Map.of("first", 2, "after", cursor)), "{ items { id } cursor hasMore total }", null);
        assertThat(second.get("data")).isEqualTo(Map.of(
            "items", List.of(Map.of("$type", "Book", "id", "b3")), "cursor", "b3", "hasMore", false, "total", 3L));
    }

    @Test
    void buyTakesCopiesOffTheShelf() throws Exception {
        var frame = command("buy", Map.of("bookId", "b3", "qty", 2), "{ id stock }", "customer");
        assertThat(frame.get("ok")).isEqualTo(Map.of("$type", "Book", "id", "b3", "stock", 5L));
        assertThat(store.book("b3").orElseThrow().stock()).isEqualTo(5);
    }

    @Test
    void aPurchaseRetriedWithTheSameKeyGetsTheFirstAnswerAgainMarkedAsAReplayAndSellsOnce() throws Exception {
        String key = UUID.randomUUID().toString();
        var first = command("buy", Map.of("bookId", "b3", "qty", 2), "{ id stock }", "customer", key);
        assertThat(first.get("ok")).isEqualTo(Map.of("$type", "Book", "id", "b3", "stock", 5L));
        assertThat(BookshopApplicationTests.<Map<String, Object>>at(first, "meta")).doesNotContainKey("replay");

        var retry = command("buy", Map.of("bookId", "b3", "qty", 2), "{ id stock }", "customer", key);
        var replayed = new LinkedHashMap<String, Object>(at(first, "meta"));
        replayed.put("replay", true);
        var expected = new LinkedHashMap<>(first);
        expected.put("meta", replayed);
        assertThat(retry).isEqualTo(expected);
        assertThat(store.book("b3").orElseThrow().stock()).isEqualTo(5);

        // guard: a new key is a new purchase
        var next = command("buy", Map.of("bookId", "b3", "qty", 2), "{ id stock }", "customer");
        assertThat(next.get("ok")).isEqualTo(Map.of("$type", "Book", "id", "b3", "stock", 3L));
        assertThat(store.book("b3").orElseThrow().stock()).isEqualTo(3);
    }

    @Test
    void aQtyOutsideOneToTenIsRefusedBeforeTheResolverSeesItAndNothingIsSold() throws Exception {
        var none = command("buy", Map.of("bookId", "b3", "qty", 0), null, "customer");
        assertThat(none.get("error")).isEqualTo(Map.of("code", "invalid_argument", "message", "buy().qty: must be >= 1"));
        var tooMany = command("buy", Map.of("bookId", "b3", "qty", 11), null, "customer");
        assertThat(tooMany.get("error")).isEqualTo(Map.of("code", "invalid_argument", "message", "buy().qty: must be <= 10"));
        assertThat(store.book("b3").orElseThrow().stock()).isEqualTo(7);
    }

    @Test
    void aQtyAtEitherEndOfTheRangeSells() throws Exception {
        // Dune has 7 copies, so staff bring it up to the 10 one purchase may take
        command("restock", Map.of("bookId", "b3", "qty", 3), null, "staff");
        var most = command("buy", Map.of("bookId", "b3", "qty", 10), "{ id stock }", "customer");
        assertThat(most.get("ok")).isEqualTo(Map.of("$type", "Book", "id", "b3", "stock", 0L));
        var least = command("buy", Map.of("bookId", "b1", "qty", 1), "{ id stock }", "customer");
        assertThat(least.get("ok")).isEqualTo(Map.of("$type", "Book", "id", "b1", "stock", 2L));
    }

    @Test
    void buyingMoreThanTheShelfHoldsFailsWithOutOfStockAndChangesNothing() throws Exception {
        var frame = command("buy", Map.of("bookId", "b1", "qty", 5), null, "customer");
        assertThat(frame.get("error")).isEqualTo(Map.of("code", "domain", "type", "OutOfStock",
            "message", "Only 3 left of A Wizard of Earthsea", "data", Map.of("bookId", "b1", "available", 3L)));
        assertThat(store.book("b1").orElseThrow().stock()).isEqualTo(3);
    }

    @Test
    void buyingWithoutSigningInIsRefusedAndSellsNothing() throws Exception {
        var frame = command("buy", Map.of("bookId", "b1"), null, null);
        assertThat(frame.get("error")).isEqualTo(Map.of("code", "unauthenticated", "message", "Sign in to access buy()"));
        assertThat(store.book("b1").orElseThrow().stock()).isEqualTo(3);
        // guard: the same purchase from a signed-in customer goes through, one copy by default
        var signedIn = command("buy", Map.of("bookId", "b1"), "{ id stock }", "customer");
        assertThat(signedIn.get("ok")).isEqualTo(Map.of("$type", "Book", "id", "b1", "stock", 2L));
        assertThat(store.book("b1").orElseThrow().stock()).isEqualTo(2);
    }

    @Test
    void aCustomerMayNotRestock() throws Exception {
        var frame = command("restock", Map.of("bookId", "b2", "qty", 5), null, "customer");
        assertThat(frame.get("error")).isEqualTo(Map.of("code", "permission_denied", "message", "Not allowed to access restock()"));
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
        assertThat(asked.get("error")).isEqualTo(
            Map.of("code", "permission_denied", "message", "Not allowed to access Book.costPrice", "path", "costPrice"));
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
        assertThat(frame.get("data")).isEqualTo(Map.of(
            "items", List.of(
                Map.of("$type", "Book", "title", "A Wizard of Earthsea", "author", Map.of("$type", "Author", "name", "Ursula K. Le Guin")),
                Map.of("$type", "Book", "title", "The Left Hand of Darkness", "author", Map.of("$type", "Author", "name", "Ursula K. Le Guin")),
                Map.of("$type", "Book", "title", "Dune", "author", Map.of("$type", "Author", "name", "Frank Herbert"))),
            "total", 3L));
        assertThat(store.authorLookups()).isEqualTo(1);
        // guard: the count follows the lookups, so one more request is one more
        query("book", Map.of("id", "b3"), "{ author { name } }", null);
        assertThat(store.authorLookups()).isEqualTo(2);
    }

    @Test
    void theExplorerIsServedBesideTheEndpointAndNothingElseIs() throws Exception {
        var page = get("/rayfold/explorer");
        assertThat(page.statusCode()).isEqualTo(200);
        assertThat(page.headers().firstValue("Content-Type")).hasValue("text/html;charset=utf-8");
        // the page carries the endpoint it talks to and the title application.properties gave it
        assertThat(page.body()).contains("<script type=\"application/json\" id=\"config\">{\"endpoint\":\"/rayfold\",\"title\":\"Bookshop\"}</script>");
        assertThat(get("/elsewhere").statusCode()).isEqualTo(404);
    }

    @Test
    void aRoleIsBelievedOnlyFromATokenThatVerifies() throws Exception {
        String devKey = "bookshop development key, not a secret";
        var restock = new LinkedHashMap<String, Object>(Map.of("id", 1, "op", "restock", "args", Map.of("bookId", "b2", "qty", 4), "key", UUID.randomUUID().toString()));
        var refused = new ArrayList<Integer>();
        for (String bearer : List.of(
            "staff", // the role's name is not a credential
            signed("a key this server does not hold, at least 32 bytes", DevTokens.ISSUER, "bookshop", 3_600_000),
            signed(devKey, DevTokens.ISSUER, "bookshop", -3_600_000), // expired an hour ago
            signed(devKey, "https://someone-else.example", "bookshop", 3_600_000),
            signed(devKey, DevTokens.ISSUER, "another-app", 3_600_000))) {
            refused.add(client.send(request(restock, bearer), HttpResponse.BodyHandlers.ofString()).statusCode());
        }
        // Spring Security refuses them before Rayfold is reached
        assertThat(refused).containsExactly(401, 401, 401, 401, 401);
        assertThat(store.book("b2").orElseThrow().stock()).isZero();
        // guard: the same claims, signed with the key and for this issuer and audience, are believed
        var ok = client.send(request(restock, signed(devKey, DevTokens.ISSUER, "bookshop", 3_600_000)), HttpResponse.BodyHandlers.ofString());
        assertThat(ok.statusCode()).as(ok.body()).isEqualTo(200);
        assertThat(store.book("b2").orElseThrow().stock()).isEqualTo(4);
    }

    private static String signed(String key, String issuer, String audience, long expiresInMs) throws Exception {
        var claims = new JWTClaimsSet.Builder().subject("s1").issuer(issuer).audience(audience).claim("role", "staff")
            .expirationTime(new Date(System.currentTimeMillis() + expiresInMs)).build();
        var jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
        jwt.sign(new MACSigner(key.getBytes(StandardCharsets.UTF_8)));
        return jwt.serialize();
    }
}
