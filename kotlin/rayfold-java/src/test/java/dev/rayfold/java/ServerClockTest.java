package dev.rayfold.java;

import com.sun.net.httpserver.HttpServer;
import dev.rayfold.core.RayfoldServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.UnaryOperator;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * {@code ServerBuilder.clock}: the server a Java application builds tells the time by the clock it was given. Served
 * by the real HTTP transport, as JavaApiTest is; every test owns its clock, its server and its port.
 */
class ServerClockTest {
    static final String SCHEMA = """
        entity Post @allow(read: this.publishedAt <= now()) { id: ID title: String publishedAt: Long }
        object Tick { at: Long }
        query post(id: ID): Post
        query time: Tick
        command publish(id: ID): Post
        """;

    static final String READ = """
        {"rayfold":"0.1","ops":[{"id":1,"op":"post","args":{"id":"p1"},"shape":"{ id title }"}]}""";
    static final String TIME = """
        {"rayfold":"0.1","ops":[{"id":1,"op":"time","shape":"{ at }"}]}""";
    static final String PUBLISH = """
        {"rayfold":"0.1","ops":[{"id":1,"op":"publish","args":{"id":"p1"},"key":"publish-key-0000001","shape":"{ id }"}]}""";

    /** A clock an application would inject, which java.time has only fixed ones of: this one reads what the test set. */
    static final class SetClock extends Clock {
        final AtomicLong millis = new AtomicLong();

        @Override public Instant instant() { return Instant.ofEpochMilli(millis.get()); }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
    }

    final HttpClient client = HttpClient.newHttpClient();
    final List<HttpServer> started = new ArrayList<>();
    final List<String> published = Collections.synchronizedList(new ArrayList<>());
    RayfoldServer server;

    @AfterEach
    void stop() {
        started.forEach(h -> h.stop(0));
        client.close();
    }

    /** The shop over one post published at {@code publishedAt}, on the clock {@code clocked} gives its builder, if any. */
    String serve(long publishedAt, UnaryOperator<ServerBuilder> clocked) throws Exception {
        Map<String, Object> post = Map.of("id", "p1", "title", "Hello", "publishedAt", publishedAt);
        server = clocked.apply(Rayfold.server(SCHEMA))
            .query("post", (args, ctx) -> post)
            .query("time", (args, ctx) -> Map.of("at", ctx.now()))
            .command("publish", (args, ctx) -> {
                published.add(args.getString("id"));
                return post;
            })
            .build();
        HttpServer http = Rayfold.http(server).viewer(exchange -> Map.of("id", "u1")).start(0);
        started.add(http);
        return "http://127.0.0.1:" + http.getAddress().getPort() + "/rayfold";
    }

    @SuppressWarnings("unchecked")
    Map<String, Object> post(String url, String batch) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString(batch))
            .build();
        HttpResponse<String> res = client.send(request, HttpResponse.BodyHandlers.ofString());
        assertEquals(200, res.statusCode(), res.body());
        List<String> frames = res.body().lines().filter(l -> !l.isBlank()).toList();
        assertEquals(1, frames.size(), res.body());
        return (Map<String, Object>) Rayfold.parseJson(frames.getFirst());
    }

    @SuppressWarnings("unchecked")
    static <T> T at(Object json, String... path) {
        Object cur = json;
        for (String p : path) cur = cur == null ? null : ((Map<String, Object>) cur).get(p);
        return (T) cur;
    }

    @Test
    void aPolicyIsDecidedByTheClockTheBuilderWasGivenInMilliseconds() throws Exception {
        AtomicLong now = new AtomicLong(999);
        String url = serve(1_000, builder -> builder.clock(now::get));
        assertEquals("permission_denied", at(post(url, READ), "error", "code"));

        now.set(1_000);
        assertEquals(Map.of("$type", "Post", "id", "p1", "title", "Hello"), at(post(url, READ), "data"));
    }

    @Test
    void aPolicyIsDecidedByTheJavaTimeClockTheBuilderWasGiven() throws Exception {
        // half a second into a second, so a clock read to the second rather than the millisecond refuses both
        SetClock clock = new SetClock();
        clock.millis.set(1_499);
        String url = serve(1_500, builder -> builder.clock(clock));
        assertEquals("permission_denied", at(post(url, READ), "error", "code"));

        clock.millis.set(1_500);
        assertEquals(Map.of("$type", "Post", "id", "p1", "title", "Hello"), at(post(url, READ), "data"));
    }

    @Test
    void guardAServerBuiltWithoutAClockDecidesByTheSystems() throws Exception {
        // a millisecond into 1970 is behind any machine's clock, and the last one a long holds is ahead of it
        assertEquals(Map.of("$type", "Post", "id", "p1", "title", "Hello"), at(post(serve(1, builder -> builder), READ), "data"));
        assertEquals("permission_denied", at(post(serve(Long.MAX_VALUE, builder -> builder), READ), "error", "code"));
    }

    @Test
    void aResolverReadsTheClockFromItsContext() throws Exception {
        AtomicLong now = new AtomicLong(1_234);
        String url = serve(0, builder -> builder.clock(now::get));
        assertEquals(1_234L, (Long) at(post(url, TIME), "data", "at"));
        now.set(5_678);
        assertEquals(5_678L, (Long) at(post(url, TIME), "data", "at"));
    }

    @Test
    void theDefaultStoreOfAnsweredCommandsExpiresByTheBuildersClock() throws Exception {
        long day = Duration.ofDays(1).toMillis();
        AtomicLong now = new AtomicLong(0);
        String url = serve(0, builder -> builder.clock(now::get));

        assertEquals(Map.of("cost", 1L), at(post(url, PUBLISH), "meta"));
        now.set(day - 1);
        assertEquals(Map.of("cost", 1L, "replay", true), at(post(url, PUBLISH), "meta"));
        assertEquals(List.of("p1"), published);

        now.set(day);
        assertEquals(Map.of("cost", 1L), at(post(url, PUBLISH), "meta"));
        assertEquals(List.of("p1", "p1"), published);
    }

    @Test
    void theServerStartedAndHasBeenUpByTheBuildersClock() throws Exception {
        AtomicLong now = new AtomicLong(1_000);
        serve(0, builder -> builder.clock(now::get));
        now.set(3_500);
        assertEquals(1_000, server.getIdentity().getStartedAt());
        assertEquals(2_500, server.getUptimeMs());
    }
}
