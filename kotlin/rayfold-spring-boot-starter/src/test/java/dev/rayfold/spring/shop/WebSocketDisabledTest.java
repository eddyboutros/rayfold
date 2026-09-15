package dev.rayfold.spring.shop;

import dev.rayfold.java.Rayfold;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.net.http.WebSocketHandshakeException;
import java.time.Duration;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import static dev.rayfold.spring.shop.ShopStarterTest.json;
import static dev.rayfold.spring.shop.ShopStarterTest.problem;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

/** `rayfold.websocket=false` leaves the socket path unserved, and the HTTP endpoint keeps working (guard). */
@SpringBootTest(classes = ShopApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "rayfold.websocket=false")
class WebSocketDisabledTest {
    @Value("${local.server.port}")
    int port;

    @Test
    void noSocketWhenTurnedOff() throws Exception {
        HttpClient client = HttpClient.newHttpClient();
        try {
            try {
                client.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(5))
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/rayfold/ws"), new WebSocket.Listener() {}).get(5, TimeUnit.SECONDS).abort();
                fail("the socket opened although rayfold.websocket=false");
            } catch (ExecutionException e) {
                assertThat(e.getCause()).isInstanceOf(WebSocketHandshakeException.class);
                assertThat(((WebSocketHandshakeException) e.getCause()).getResponse().statusCode()).isEqualTo(400);
            }
            // no upgrade: the HTTP endpoint answers that path, as a GET of an operation named ws, and refuses it
            HttpResponse<String> plain = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/rayfold/ws"))
                .timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofString());
            assertThat(plain.statusCode()).isEqualTo(400);
            assertThat(json(plain.body())).isEqualTo(json(problem(400, "invalid_argument", "Safe requests (GET/QUERY) may only contain queries", "invalid_argument")));

            HttpResponse<String> res = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/rayfold"))
                .timeout(Duration.ofSeconds(5)).header("Content-Type", "application/rayfold+json")
                .POST(HttpRequest.BodyPublishers.ofString("""
                    {"ops":[{"id":1,"op":"me"}]}""")).build(), HttpResponse.BodyHandlers.ofString());
            assertThat(res.statusCode()).isEqualTo(200);
            assertThat(Rayfold.parseJson(res.body())).isEqualTo(json("""
                {"id":1,"data":"anonymous","meta":{"cost":1},"fin":true}"""));
        } finally {
            client.close();
        }
    }
}
