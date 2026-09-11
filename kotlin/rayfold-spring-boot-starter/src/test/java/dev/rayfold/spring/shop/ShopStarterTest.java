package dev.rayfold.spring.shop;

import dev.rayfold.java.Rayfold;
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
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/** The starter inside a real Spring Boot application on a real port, called over HTTP as a browser or service would. */
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

    static final String BUY_B1 = """
        {"rayfold":"0.1","ops":[{"id":1,"op":"buy","args":{"id":"b1","qty":1},"key":"key-000000000000001","shape":"{ id stock }"}]}""";

    @Test
    void aNestedFieldIsServedByOneLoaderCallForEveryBook() throws Exception {
        var f = frames("""
            {"rayfold":"0.1","ops":[{"id":1,"op":"books","shape":"{ id title author { name } }"}]}""");
        List<Object> books = at(f.get(0), "data");
        assertThat(books).hasSize(2);
        assertThat((String) at(books, 0, "author", "name")).isEqualTo("Ursula K. Le Guin");
        assertThat((String) at(books, 1, "author", "name")).isEqualTo("Frank Herbert");
        assertThat(shop.authorLoads.get()).isEqualTo(1);
    }

    @Test
    void aSignedInUserBuysAndGetsThePatchedBook() throws Exception {
        var f = frames(BUY_B1, "X-User", "alice");
        assertThat((Long) at(f.get(0), "ok", "stock")).isEqualTo(2L);
        assertThat(shop.sold).containsExactly("alice:b1");
    }

    @Test
    void guardAnAnonymousPurchaseIsRefusedAndChangesNothing() throws Exception {
        var f = frames(BUY_B1);
        assertThat((String) at(f.get(0), "error", "code")).isEqualTo("unauthenticated");
        assertThat(shop.books.get("b1").stock()).isEqualTo(3);
        assertThat(shop.sold).isEmpty();
    }

    @Test
    void aDeclaredErrorReachesTheClientTyped() throws Exception {
        var f = frames("""
            {"rayfold":"0.1","ops":[{"id":1,"op":"buy","args":{"id":"b2","qty":1},"key":"key-000000000000002"}]}""", "X-User", "alice");
        assertThat((String) at(f.get(0), "error", "type")).isEqualTo("OutOfStock");
        assertThat((Long) at(f.get(0), "error", "data", "available")).isEqualTo(0L);
        assertThat((String) at(f.get(0), "error", "message")).isEqualTo("Only 0 left");
    }

    @Test
    void aWriteFromAnotherSiteIsRefusedWhileAnAllowedOriginAndCrossSiteReadsGoThrough() throws Exception {
        var evil = send("POST", "/rayfold", BUY_B1, "Content-Type", "application/rayfold+json", "X-User", "alice", "Origin", "https://evil.example");
        assertThat(evil.statusCode()).isEqualTo(403);
        assertThat(evil.body()).contains("\"code\":\"permission_denied\"");
        assertThat(shop.books.get("b1").stock()).isEqualTo(3);
        // guard: the origin in rayfold.allowed-origins may write
        var allowed = frames(BUY_B1, "X-User", "alice", "Origin", "https://app.example");
        assertThat((Long) at(allowed.get(0), "ok", "stock")).isEqualTo(2L);
        // guard: a safe read from any site is answered (the browser keeps the answer from the other site's page)
        var read = frames("""
            {"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title }"}]}""", "Origin", "https://evil.example", "Rayfold-Safe", "true");
        assertThat((String) at(read.get(0), "data", "title")).isEqualTo("The Dispossessed");
    }

    @Test
    void onlyJsonBodiesAreAccepted() throws Exception {
        var res = send("POST", "/rayfold", BUY_B1, "Content-Type", "text/plain", "X-User", "alice");
        assertThat(res.statusCode()).isEqualTo(415);
        assertThat(res.body()).contains("unsupported_media_type");
        assertThat(shop.sold).isEmpty();
    }

    @Test
    void theManifestShowsTheSchemaWithoutPolicyExpressions() throws Exception {
        var res = send("GET", "/rayfold/manifest", null);
        assertThat(res.statusCode()).isEqualTo(200);
        assertThat(res.body()).contains("\"Secret\"").contains("\"allow\"").doesNotContain("$expr");
    }

    @Test
    void theSchemaPolicyHidesASecretFromAnonymousReaders() throws Exception {
        String batch = """
            {"rayfold":"0.1","ops":[{"id":1,"op":"secret","args":{"id":"s1"},"shape":"{ id note }"}]}""";
        Object hidden = at(frames(batch).get(0), "data");
        assertThat(hidden).isNull();
        // guard: a signed-in reader gets it, through the asynchronous resolver
        assertThat((String) at(frames(batch, "X-User", "alice").get(0), "data", "note")).isEqualTo("classified");
    }

    @Test
    void aStreamSendsOneFramePerElement() throws Exception {
        var f = frames("""
            {"rayfold":"0.1","ops":[{"id":1,"op":"countdown","args":{"from":2}}]}""");
        assertThat(f.stream().filter(x -> x.containsKey("item")).map(x -> x.get("item")).toList()).containsExactly(2L, 1L, 0L);
    }

    @Test
    void aSingleQueryAnswersOverGet() throws Exception {
        String a = Base64.getUrlEncoder().withoutPadding().encodeToString("{\"id\":\"b1\"}".getBytes(StandardCharsets.UTF_8));
        String s = URLEncoder.encode("{ title }", StandardCharsets.UTF_8);
        var res = send("GET", "/rayfold/book?a=" + a + "&s=" + s, null, "Accept", "application/json");
        assertThat(res.statusCode()).as(res.body()).isEqualTo(200);
        assertThat((String) at(Rayfold.parseJson(res.body()), "data", "title")).isEqualTo("The Dispossessed");
    }

    @Test
    void theViewerComesFromTheApplicationsResolver() throws Exception {
        String me = """
            {"rayfold":"0.1","ops":[{"id":1,"op":"me"}]}""";
        assertThat((String) at(frames(me, "X-User", "bob").get(0), "data")).isEqualTo("bob/customer");
        assertThat((String) at(frames(me).get(0), "data")).isEqualTo("anonymous");
    }
}
