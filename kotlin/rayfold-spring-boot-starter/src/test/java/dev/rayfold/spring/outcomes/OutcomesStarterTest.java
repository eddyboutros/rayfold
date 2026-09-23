package dev.rayfold.spring.outcomes;

import dev.rayfold.core.RayfoldServer;
import dev.rayfold.java.Rayfold;
import kotlin.Unit;
import kotlin.jvm.functions.Function0;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** The annotated binding shapes of [OutcomesApplication], each driven over HTTP through the running application. */
@SpringBootTest(
    classes = OutcomesApplication.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "rayfold.schema=classpath:outcomes.rayfold")
class OutcomesStarterTest {
    @Value("${local.server.port}")
    int port;

    @Autowired
    OutcomesApplication.Resolvers resolvers;

    @Autowired
    RayfoldServer server;

    final HttpClient client = HttpClient.newHttpClient();
    final List<Object> restocked = Collections.synchronizedList(new ArrayList<>());
    Function0<Unit> off;

    @BeforeEach
    void reset() {
        resolvers.reset();
        off = server.getEvents().on("Restocked", payload -> {
            restocked.add(Rayfold.fromJson(payload));
            return Unit.INSTANCE;
        });
    }

    @AfterEach
    void close() {
        off.invoke();
        client.close();
    }

    HttpResponse<String> post(String path, String contentType, String body) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", contentType)
            .header("X-User", "alice")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build(), HttpResponse.BodyHandlers.ofString());
    }

    List<Object> frames(String batch) throws Exception {
        HttpResponse<String> res = post("/rayfold", "application/rayfold+json", batch);
        assertThat(res.statusCode()).as(res.body()).isEqualTo(200);
        return res.body().lines().filter(l -> !l.isBlank()).map(Rayfold::parseJson).toList();
    }

    static List<Object> json(String... frames) {
        return java.util.Arrays.stream(frames).map(Rayfold::parseJson).toList();
    }

    static String command(String op, String id, int qty) {
        return """
            {"ops":[{"id":1,"op":"%s","args":{"id":"%s","qty":%d},"key":"%s","shape":"{ id stock }"}]}""".formatted(op, id, qty, "k-" + UUID.randomUUID());
    }

    @Test
    void anAnnotatedCommandReturningAnOutcomeSendsItsPatchesAndEmitsItsEvent() throws Exception {
        assertThat(frames(command("restock", "b1", 1))).isEqualTo(json("""
            {"id":1,"ok":{"$type":"Book","id":"b1","stock":4},"patch":[{"set":"Book:b1","value":{"$type":"Book","id":"b1","stock":4}},{"set":"Book:b2","value":{"stock":9}},{"invOp":["book"]}],"meta":{"cost":1},"fin":true}"""));
        assertThat(restocked).isEqualTo(List.of(Map.of("bookId", "b1", "qty", 1L, "seq", 1L)));
    }

    @Test
    void anAsyncAnnotatedCommandAnswersWithItsOutcomeAndAFailedStageFailsWithItsCause() throws Exception {
        assertThat(frames(command("reserve", "b1", 1))).isEqualTo(json("""
            {"id":1,"ok":{"$type":"Book","id":"b1","stock":2},"patch":[{"set":"Book:b1","value":{"$type":"Book","id":"b1","stock":2}},{"invOp":["book"]}],"meta":{"cost":1},"fin":true}"""));
        assertThat(frames(command("reserve", "b1", -1))).isEqualTo(json("""
            {"id":1,"error":{"code":"failed_precondition","message":"qty must not be negative"},"fin":true}"""));
        assertThat(resolvers.books.get("b1").stock()).isEqualTo(2);
    }

    @Test
    void anAsyncAnnotatedFieldLoaderAnswersAndAFailedStageFailsTheOpAtTheField() throws Exception {
        String batch = """
            {"ops":[{"id":1,"op":"book","args":{"id":"%s"},"shape":"{ id author { id name } }"}]}""";
        assertThat(frames(batch.formatted("b1"))).isEqualTo(json("""
            {"id":1,"data":{"$type":"Book","id":"b1","author":{"$type":"Author","id":"a1","name":"Author a1"}},"meta":{"cost":2},"fin":true}"""));
        assertThat(frames(batch.formatted("b9"))).isEqualTo(json("""
            {"id":1,"error":{"code":"unavailable","message":"authors offline","path":"author"},"fin":true}"""));
        assertThat(resolvers.authorLoads.get()).isEqualTo(2);
    }

    @Test
    void aStreamMethodReturningAListSendsOneFramePerElement() throws Exception {
        assertThat(frames("""
            {"ops":[{"id":1,"op":"ticks","args":{"n":3}}]}""")).isEqualTo(json(
            "{\"id\":1,\"item\":1}", "{\"id\":1,\"item\":2}", "{\"id\":1,\"item\":3}", "{\"id\":1,\"fin\":true}"));
    }

    @Test
    void anUploadStoreBeanServesTheUploadsRouteAndTheManifestSaysSo() throws Exception {
        HttpResponse<String> res = post("/rayfold/uploads", "application/octet-stream", "hello");
        assertThat(res.statusCode()).as(res.body()).isEqualTo(201);
        assertThat(Rayfold.parseJson(res.body())).isEqualTo(Rayfold.parseJson("{\"id\":\"upload-1\",\"size\":5}"));
        HttpResponse<String> manifest = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/rayfold/manifest"))
            .timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofString());
        assertThat(((Map<?, ?>) Rayfold.parseJson(manifest.body())).get("extensions")).isEqualTo(List.of("live", "rb", "upload"));
    }
}
