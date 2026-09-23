package dev.rayfold.spring.shop;

import dev.rayfold.core.RayfoldServer;
import dev.rayfold.core.RbCodec;
import dev.rayfold.java.Rayfold;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlinx.coroutines.BuildersKt;
import kotlinx.serialization.json.Json;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static dev.rayfold.spring.shop.ShopStarterTest.json;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

/**
 * The WebSocket transport on the application's own port, from spring-boot-starter-websocket, opened as a browser or
 * a JVM client would: batches and live queries, RB, the viewer from the handshake, and the Origin refusal with its
 * guard. Every wait is bounded at 5 s, and a wait on the server is for a signal ([OpEnds]), never a poll.
 */
@SpringBootTest(classes = {ShopApplication.class, OpEnds.class}, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class WebSocketStarterTest {
    @Value("${local.server.port}")
    int port;

    @Autowired
    ShopResolvers shop;

    @Autowired
    RayfoldServer server;

    @Autowired
    OpEnds opEnds;

    final HttpClient client = HttpClient.newHttpClient();
    final List<WebSocket> opened = new ArrayList<>();

    @BeforeEach
    void reset() {
        shop.reset();
        opEnds.getEnded().clear();
    }

    @AfterEach
    void close() {
        opened.forEach(WebSocket::abort);
        client.shutdownNow();
    }

    /** The close the server sent, as the last thing a [Messages] queue holds. */
    record Closed(int code, String reason) {}

    /** Whole messages as they arrive: text as parsed JSON, binary as the list of RB frames it holds, and the close. */
    final class Messages implements WebSocket.Listener {
        final BlockingQueue<Object> queue = new LinkedBlockingQueue<>();
        final RbCodec codec = new RbCodec(server.getIr());
        private StringBuilder text = new StringBuilder();
        private final ByteArrayOutputStream binary = new ByteArrayOutputStream();

        @Override
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            text.append(data);
            if (last) {
                queue.add(Rayfold.parseJson(text.toString()));
                text = new StringBuilder();
            }
            ws.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket ws, ByteBuffer data, boolean last) {
            byte[] b = new byte[data.remaining()];
            data.get(b);
            binary.writeBytes(b);
            if (last) {
                queue.add(codec.decodeFrames(binary.toByteArray()).stream().map(f -> Rayfold.parseJson(f.toString())).toList());
                binary.reset();
            }
            ws.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
            queue.add(new Closed(statusCode, reason));
            return null;
        }

        Object next() throws InterruptedException {
            Object m = queue.poll(5, TimeUnit.SECONDS);
            assertThat(m).as("a message within 5 s").isNotNull();
            return m;
        }
    }

    WebSocket open(Messages m, String... headers) throws Exception {
        WebSocket.Builder b = client.newWebSocketBuilder().subprotocols("rayfold.0.1").connectTimeout(Duration.ofSeconds(5));
        for (int i = 0; i < headers.length; i += 2) b.header(headers[i], headers[i + 1]);
        WebSocket ws = b.buildAsync(URI.create("ws://127.0.0.1:" + port + "/rayfold/ws"), m).get(5, TimeUnit.SECONDS);
        opened.add(ws);
        return ws;
    }

    /** Waits, at most 5 s in all, until the server reports that this op ("kind name") ended. */
    void ended(String op) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (true) {
            long left = deadline - System.nanoTime();
            String next = left > 0 ? opEnds.getEnded().poll(left, TimeUnit.NANOSECONDS) : null;
            if (next == null) fail("no " + op + " ended within 5 s");
            if (op.equals(next)) return;
        }
    }

    @Test
    void theSocketRunsOnTheApplicationsPortWithTheViewerFromTheHandshakeAndLiveQueriesGetPatches() throws Exception {
        Messages m = new Messages();
        WebSocket ws = open(m, "X-User", "alice");
        assertThat(ws.getSubprotocol()).isEqualTo("rayfold.0.1");
        ws.sendText("""
            {"ops":[{"id":1,"op":"me"}]}""", true).get(5, TimeUnit.SECONDS);
        assertThat(m.next()).isEqualTo(json("""
            {"id":1,"data":"alice/customer","meta":{"cost":1},"fin":true}"""));

        ws.sendText("""
            {"ops":[{"id":2,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}]}""", true).get(5, TimeUnit.SECONDS);
        assertThat(m.next()).isEqualTo(json("""
            {"id":2,"data":{"$type":"Book","id":"b1","stock":3},"meta":{"cost":1}}"""));
        assertThat(server.getChanges().getSize()).as("the live query holds a subscription").isEqualTo(1);

        // a purchase over HTTP on the same server reaches the socket as a patch; a fresh key, since the cached test
        // context keeps its idempotency records and a replay commits nothing
        String buy = """
            {"ops":[{"id":1,"op":"buy","args":{"id":"b1","qty":1},"key":"%s","shape":"{ id stock }"}]}""".formatted("ws-" + UUID.randomUUID());
        HttpResponse<String> bought = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/rayfold"))
            .timeout(Duration.ofSeconds(5)).header("Content-Type", "application/rayfold+json").header("X-User", "alice")
            .POST(HttpRequest.BodyPublishers.ofString(buy)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(bought.statusCode()).as(bought.body()).isEqualTo(200);
        assertThat(json(bought.body())).as("the purchase ran").isEqualTo(json(ShopStarterTest.BOUGHT_B1));
        assertThat(m.next()).isEqualTo(json("""
            {"id":2,"patch":[{"set":"Book:b1","value":{"stock":2}}]}"""));

        ws.sendText("""
            {"cancel":2}""", true).get(5, TimeUnit.SECONDS);
        assertThat(m.next()).isEqualTo(json("""
            {"id":2,"error":{"code":"canceled","message":"Canceled"},"fin":true}"""));
        // the canceled frame is sent only after the cancelled op let go of its subscription
        assertThat(server.getChanges().getSize()).isEqualTo(0);
    }

    @Test
    void anRbMessageIsAnsweredInRbAndAClientThatVanishesReleasesItsLiveQuery() throws Exception {
        Messages m = new Messages();
        WebSocket ws = open(m);
        RbCodec codec = new RbCodec(server.getIr());
        byte[] batch = codec.encode(Json.Default.parseToJsonElement("""
            {"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id title }","live":true}]}"""));
        ws.sendBinary(ByteBuffer.wrap(batch), true).get(5, TimeUnit.SECONDS);
        assertThat(m.next()).isEqualTo(List.of(json("""
            {"id":1,"data":{"$type":"Book","id":"b1","title":"The Dispossessed"},"meta":{"cost":1}}""")));
        assertThat(server.getChanges().getSize()).as("guard: while the socket is open, its live query stays subscribed").isEqualTo(1);
        ws.abort(); // no close frame: the connection just drops
        ended("query book");
        assertThat(server.getChanges().getSize()).as("the vanished client's live query is released").isEqualTo(0);
    }

    @Test
    void aForeignPageCannotOpenTheSocketButAnAllowedOriginCan() throws Exception {
        try {
            open(new Messages(), "Origin", "https://evil.example");
            fail("a foreign Origin was let in");
        } catch (ExecutionException e) {
            assertThat(e.getCause()).isInstanceOf(WebSocketHandshakeException.class);
            assertThat(((WebSocketHandshakeException) e.getCause()).getResponse().statusCode()).isEqualTo(403);
        }
        Messages m = new Messages();
        WebSocket ws = open(m, "Origin", "https://app.example");
        ws.sendText("""
            {"ops":[{"id":1,"op":"me"}]}""", true).get(5, TimeUnit.SECONDS);
        assertThat(m.next()).as("guard: rayfold.allowed-origins lets this page in").isEqualTo(json("""
            {"id":1,"data":"anonymous","meta":{"cost":1},"fin":true}"""));
    }

    /** A text message of [bytes] bytes: a batch the server can answer, padded with whitespace after it. */
    static String padded(int bytes) {
        String batch = """
            {"ops":[{"id":1,"op":"me"}]}""";
        return batch + " ".repeat(bytes - batch.length());
    }

    @Test
    void aMessageOverMaxBodyBytesClosesTheSocketWith1009AndOneOfExactlyTheLimitIsAnswered() throws Exception {
        int limit = 1024 * 1024; // rayfold.max-body-bytes, left at its default here
        Messages m = new Messages();
        WebSocket ws = open(m);
        ws.sendText(padded(limit), true).get(5, TimeUnit.SECONDS);
        assertThat(m.next()).as("guard: a message of exactly the limit").isEqualTo(json("""
            {"id":1,"data":"anonymous","meta":{"cost":1},"fin":true}"""));
        ws.sendText(padded(limit + 1), true).get(5, TimeUnit.SECONDS);
        // the reason text is the container's own, so only the code is the contract
        assertThat(m.next()).isInstanceOfSatisfying(Closed.class, c -> assertThat(c.code()).isEqualTo(1009));
    }

    /** Draining is for good: the context goes with this test, so the other tests on it get a server that is not. */
    @Test
    @DirtiesContext(methodMode = DirtiesContext.MethodMode.AFTER_METHOD)
    void drainEndsALiveQueryAndThenClosesTheSocketAsAServerGoingAway() throws Exception {
        Messages m = new Messages();
        WebSocket ws = open(m);
        ws.sendText("""
            {"ops":[{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ id stock }","live":true}]}""", true).get(5, TimeUnit.SECONDS);
        assertThat(m.next()).isEqualTo(json("""
            {"id":1,"data":{"$type":"Book","id":"b1","stock":3},"meta":{"cost":1}}"""));
        BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE, (scope, done) -> server.drain(5_000L, done));
        assertThat(m.next()).isEqualTo(json("""
            {"id":1,"error":{"code":"unavailable","message":"The server is shutting down"},"fin":true}"""));
        assertThat(m.next()).isEqualTo(new Closed(1001, "server shutting down"));
    }
}
