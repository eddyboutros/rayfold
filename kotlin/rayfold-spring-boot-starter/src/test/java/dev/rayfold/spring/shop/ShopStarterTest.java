package dev.rayfold.spring.shop;

import dev.rayfold.java.Rayfold;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The starter inside a real Spring Boot application on a real port, called over HTTP as a browser or service would.
 * The context is cached across test classes and keeps its idempotency records, so every purchase carries a key of its
 * own; only the replay test sends one key twice.
 */
@SpringBootTest(classes = ShopApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ShopStarterTest {
    @Value("${local.server.port}")
    int port;

    @Autowired
    ShopResolvers shop;

    final HttpClient client = HttpClient.newHttpClient();

    @BeforeEach
    void reset() {
        shop.reset();
    }

    @AfterEach
    void closeClient() {
        client.close();
    }

    HttpResponse<String> send(String method, String path, String body, String... headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
            .timeout(Duration.ofSeconds(5))
            .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        for (int i = 0; i < headers.length; i += 2) b.header(headers[i], headers[i + 1]);
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    /** POSTs a JSON batch and returns its frames. */
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> frames(String batch, String... headers) throws Exception {
        String[] all = Stream.concat(Stream.of("Content-Type", "application/rayfold+json"), Stream.of(headers)).toArray(String[]::new);
        HttpResponse<String> res = send("POST", "/rayfold", batch, all);
        assertThat(res.statusCode()).as(res.body()).isEqualTo(200);
        return res.body().lines().filter(l -> !l.isBlank()).map(l -> (Map<String, Object>) Rayfold.parseJson(l)).toList();
    }

    @SuppressWarnings("unchecked")
    static <T> T at(Object json, Object... path) {
        Object cur = json;
        for (Object p : path) cur = p instanceof Integer i ? ((List<Object>) cur).get(i) : ((Map<String, Object>) cur).get((String) p);
        return (T) cur;
    }

    static Object json(String text) {
        return Rayfold.parseJson(text);
    }

    static String freshKey() {
        return "shop-" + UUID.randomUUID();
    }

    static String buy(String id, int qty, String key) {
        return """
            {"rayfold":"0.1","ops":[{"id":1,"op":"buy","args":{"id":"%s","qty":%d},"key":"%s","shape":"{ id stock }"}]}""".formatted(id, qty, key);
    }

    static String problem(int status, String type, String detail, String code) {
        return """
            {"type":"https://eddyboutros.github.io/rayfold/errors/%s","title":"%s","status":%d,"detail":"%s","code":"%s"}""".formatted(type, type.replace('_', ' '), status, detail, code);
    }

    static final String BOUGHT_B1 = """
        {"id":1,"ok":{"$type":"Book","id":"b1","stock":2},"patch":[{"set":"Book:b1","value":{"$type":"Book","id":"b1","stock":2}}],"meta":{"cost":1},"fin":true}""";

    @Test
    void aNestedFieldIsServedByOneLoaderCallForEveryBook() throws Exception {
        var f = frames("""
            {"rayfold":"0.1","ops":[{"id":1,"op":"books","shape":"{ id title author { name } }"}]}""");
        assertThat(f).isEqualTo(List.of(json("""
            {"id":1,"data":[{"$type":"Book","id":"b1","title":"The Dispossessed","author":{"$type":"Author","name":"Ursula K. Le Guin"}},\
            {"$type":"Book","id":"b2","title":"Dune","author":{"$type":"Author","name":"Frank Herbert"}}],"meta":{"cost":2},"fin":true}""")));
        assertThat(shop.authorLoads.get()).isEqualTo(1);
    }

    @Test
    void aSignedInUserBuysAndGetsThePatchedBook() throws Exception {
        assertThat(frames(buy("b1", 1, freshKey()), "X-User", "alice")).isEqualTo(List.of(json(BOUGHT_B1)));
        assertThat(shop.sold).containsExactly("alice:b1");
        assertThat(shop.books.get("b1").stock()).isEqualTo(2);
    }

    @Test
    void aRetryWithTheSameKeyIsAnsweredFromTheRecordAndSellsOnce() throws Exception {
        String key = freshKey();
        assertThat(frames(buy("b1", 1, key), "X-User", "alice")).isEqualTo(List.of(json(BOUGHT_B1)));
        assertThat(frames(buy("b1", 1, key), "X-User", "alice")).isEqualTo(List.of(json(BOUGHT_B1.replace("{\"cost\":1}", "{\"cost\":1,\"replay\":true}"))));
        assertThat(shop.sold).containsExactly("alice:b1");
        assertThat(shop.books.get("b1").stock()).isEqualTo(2);
        // guard: a new key is a new purchase
        assertThat(frames(buy("b1", 1, freshKey()), "X-User", "alice")).isEqualTo(List.of(json(BOUGHT_B1.replace("\"stock\":2", "\"stock\":1"))));
        assertThat(shop.sold).containsExactly("alice:b1", "alice:b1");
    }

    @Test
    void guardAnAnonymousPurchaseIsRefusedAndChangesNothing() throws Exception {
        assertThat(frames(buy("b1", 1, freshKey()))).isEqualTo(List.of(json("""
            {"id":1,"error":{"code":"unauthenticated","message":"buy(): idempotency keys need an identified caller"},"fin":true}""")));
        assertThat(shop.books.get("b1").stock()).isEqualTo(3);
        assertThat(shop.sold).isEmpty();
    }

    @Test
    void aDeclaredErrorReachesTheClientTyped() throws Exception {
        assertThat(frames(buy("b2", 1, freshKey()), "X-User", "alice")).isEqualTo(List.of(json("""
            {"id":1,"error":{"code":"domain","type":"OutOfStock","message":"Only 0 left","data":{"available":0}},"fin":true}""")));
        assertThat(shop.sold).isEmpty();
    }

    @Test
    void aWriteFromAnotherSiteIsRefusedWhileAnAllowedOriginAndCrossSiteReadsGoThrough() throws Exception {
        var evil = send("POST", "/rayfold", buy("b1", 1, freshKey()), "Content-Type", "application/rayfold+json", "X-User", "alice", "Origin", "https://evil.example");
        assertThat(evil.statusCode()).isEqualTo(403);
        assertThat(evil.headers().firstValue("Content-Type")).contains("application/problem+json");
        assertThat(json(evil.body())).isEqualTo(json(problem(403, "permission_denied", "Origin https://evil.example is not allowed", "permission_denied")));
        assertThat(shop.books.get("b1").stock()).isEqualTo(3);
        assertThat(shop.sold).isEmpty();
        // guard: the origin in rayfold.allowed-origins may write
        assertThat(frames(buy("b1", 1, freshKey()), "X-User", "alice", "Origin", "https://app.example")).isEqualTo(List.of(json(BOUGHT_B1)));
        // guard: a safe read from any site is answered (the browser keeps the answer from the other site's page)
        var read = frames("""
            {"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title }"}]}""", "Origin", "https://evil.example", "Rayfold-Safe", "true");
        assertThat(read).isEqualTo(List.of(json("""
            {"id":1,"data":{"$type":"Book","title":"The Dispossessed"},"meta":{"cost":1},"fin":true}""")));
    }

    @Test
    void onlyJsonBodiesAreAccepted() throws Exception {
        var res = send("POST", "/rayfold", buy("b1", 1, freshKey()), "Content-Type", "text/plain", "X-User", "alice");
        assertThat(res.statusCode()).isEqualTo(415);
        assertThat(json(res.body())).isEqualTo(json(problem(415, "unsupported_media_type", "Content-Type text/plain is not accepted; send application/rayfold+json", "invalid_argument")));
        assertThat(shop.sold).isEmpty();
    }

    @Test
    void theManifestNamesThePolicyButNotItsExpression() throws Exception {
        var res = send("GET", "/rayfold/manifest", null);
        assertThat(res.statusCode()).isEqualTo(200);
        Object manifest = json(res.body());
        assertThat(ShopStarterTest.<Object>at(manifest, "rayfold")).isEqualTo("0.1");
        assertThat(ShopStarterTest.<Object>at(manifest, "extensions")).isEqualTo(List.of("live", "rb"));
        assertThat(ShopStarterTest.<Object>at(manifest, "schema", "types", "Secret", "annotations")).isEqualTo(List.of(Map.of("name", "allow")));
        assertThat(res.body()).doesNotContain("$expr");
    }

    @Test
    void theSchemaPolicyHidesASecretFromAnonymousReaders() throws Exception {
        String batch = """
            {"rayfold":"0.1","ops":[{"id":1,"op":"secret","args":{"id":"s1"},"shape":"{ id note }"}]}""";
        assertThat(frames(batch)).isEqualTo(List.of(json("""
            {"id":1,"data":null,"meta":{"cost":1},"fin":true}""")));
        // guard: a signed-in reader gets it, through the asynchronous resolver
        assertThat(frames(batch, "X-User", "alice")).isEqualTo(List.of(json("""
            {"id":1,"data":{"$type":"Secret","id":"s1","note":"classified"},"meta":{"cost":1},"fin":true}""")));
    }

    @Test
    void aStreamSendsOneFramePerElement() throws Exception {
        var f = frames("""
            {"rayfold":"0.1","ops":[{"id":1,"op":"countdown","args":{"from":2}}]}""");
        assertThat(f).isEqualTo(List.of(json("{\"id\":1,\"item\":2}"), json("{\"id\":1,\"item\":1}"), json("{\"id\":1,\"item\":0}"), json("{\"id\":1,\"fin\":true}")));
    }

    @Test
    void aSingleQueryAnswersOverGet() throws Exception {
        String a = Base64.getUrlEncoder().withoutPadding().encodeToString("{\"id\":\"b1\"}".getBytes(StandardCharsets.UTF_8));
        String s = URLEncoder.encode("{ title }", StandardCharsets.UTF_8);
        var res = send("GET", "/rayfold/book?a=" + a + "&s=" + s, null, "Accept", "application/json");
        assertThat(res.statusCode()).as(res.body()).isEqualTo(200);
        assertThat(json(res.body())).isEqualTo(json("""
            {"id":1,"data":{"$type":"Book","title":"The Dispossessed"},"meta":{"cost":1},"fin":true}"""));
    }

    @Test
    void theViewerComesFromTheApplicationsResolver() throws Exception {
        String me = """
            {"rayfold":"0.1","ops":[{"id":1,"op":"me"}]}""";
        assertThat((String) at(frames(me, "X-User", "bob").get(0), "data")).isEqualTo("bob/customer");
        assertThat((String) at(frames(me).get(0), "data")).isEqualTo("anonymous");
    }
}
