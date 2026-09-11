package dev.rayfold.spring.secure;

import dev.rayfold.java.Rayfold;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** The viewer from Spring Security, over real HTTP Basic sign-in. */
@SpringBootTest(classes = SecureApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SecureStarterTest {
    @Value("${local.server.port}")
    int port;

    final HttpClient client = HttpClient.newHttpClient();

    HttpResponse<String> post(String batch, String password) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/rayfold"))
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString(batch));
        if (password != null) b.header("Authorization", "Basic " + Base64.getEncoder().encodeToString(("ada:" + password).getBytes(StandardCharsets.UTF_8)));
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    @SuppressWarnings("unchecked")
    static Object data(HttpResponse<String> res) {
        assertThat(res.statusCode()).as(res.body()).isEqualTo(200);
        List<String> lines = res.body().lines().filter(l -> !l.isBlank()).toList();
        return ((Map<String, Object>) Rayfold.parseJson(lines.get(0))).get("data");
    }

    static final String ME = """
        {"rayfold":"0.1","ops":[{"id":1,"op":"me"}]}""";
    static final String SECRET = """
        {"rayfold":"0.1","ops":[{"id":1,"op":"secret","args":{"id":"s1"},"shape":"{ note }"}]}""";

    @Test
    void theSignedInUserIsTheViewerWithTheirRoles() throws Exception {
        assertThat(data(post(ME, "lovelace"))).isEqualTo("ada ADMIN [ADMIN, AUTHOR]");
        assertThat(data(post(SECRET, "lovelace"))).isEqualTo(Map.of("$type", "Secret", "note", "classified"));
    }

    @Test
    void guardAnAnonymousRequestHasNoViewerAndThePolicyHidesTheSecret() throws Exception {
        assertThat(data(post(ME, null))).isEqualTo("anonymous");
        assertThat(data(post(SECRET, null))).isNull();
    }

    @Test
    void aWrongPasswordIsRefusedBySpringSecurityBeforeRayfoldRuns() throws Exception {
        assertThat(post(ME, "wrong").statusCode()).isEqualTo(401);
    }
}
