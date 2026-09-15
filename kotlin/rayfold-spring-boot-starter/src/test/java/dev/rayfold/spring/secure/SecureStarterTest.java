package dev.rayfold.spring.secure;

import dev.rayfold.java.Rayfold;
import dev.rayfold.spring.RayfoldViewerResolver;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContextHolder;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** The viewer from Spring Security, over real HTTP Basic sign-in, and the schema's role policy on a command. */
@SpringBootTest(classes = SecureApplication.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "rayfold.schema=classpath:secure.rayfold")
class SecureStarterTest {
    @Value("${local.server.port}")
    int port;

    @Autowired
    SecureApplication.Resolvers resolvers;

    @Autowired
    RayfoldViewerResolver viewerResolver;

    final HttpClient client = HttpClient.newHttpClient();

    @BeforeEach
    void reset() {
        resolvers.reset();
    }

    @AfterEach
    void close() {
        client.close();
        SecurityContextHolder.clearContext();
    }

    HttpResponse<String> post(String batch, String user, String password) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/rayfold"))
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString(batch));
        if (user != null) b.header("Authorization", "Basic " + Base64.getEncoder().encodeToString((user + ":" + password).getBytes(StandardCharsets.UTF_8)));
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    static List<Object> frames(HttpResponse<String> res) {
        assertThat(res.statusCode()).as(res.body()).isEqualTo(200);
        return res.body().lines().filter(l -> !l.isBlank()).map(Rayfold::parseJson).toList();
    }

    @SuppressWarnings("unchecked")
    static Object data(HttpResponse<String> res) {
        return ((Map<String, Object>) frames(res).get(0)).get("data");
    }

    static Object json(String text) {
        return Rayfold.parseJson(text);
    }

    static String retire(String key) {
        return """
            {"rayfold":"0.1","ops":[{"id":1,"op":"retire","args":{"id":"p1"},"key":"%s"}]}""".formatted(key);
    }

    static String key() {
        return "secure-" + UUID.randomUUID();
    }

    static final String ME = """
        {"rayfold":"0.1","ops":[{"id":1,"op":"me"}]}""";
    static final String SECRET = """
        {"rayfold":"0.1","ops":[{"id":1,"op":"secret","args":{"id":"s1"},"shape":"{ note }"}]}""";
    static final String RETIRED = """
        {"id":1,"ok":{"$type":"Post","id":"p1","title":"Launch notes","retired":true},\
        "patch":[{"set":"Post:p1","value":{"$type":"Post","id":"p1","title":"Launch notes","retired":true}}],"meta":{"cost":1},"fin":true}""";

    /** What the starter's viewer resolver makes of a principal granted these authorities, in this order. */
    String viewerOf(String name, String... authorities) {
        SecurityContextHolder.getContext().setAuthentication(UsernamePasswordAuthenticationToken.authenticated(name, null, AuthorityUtils.createAuthorityList(authorities)));
        try {
            return Rayfold.toJson(viewerResolver.viewer(new MockHttpServletRequest())).toString();
        } finally {
            SecurityContextHolder.clearContext();
        }
    }

    @Test
    void theSignedInUserIsTheViewerWithTheirRoles() throws Exception {
        assertThat(data(post(ME, "ada", "lovelace"))).isEqualTo("ada ADMIN [ADMIN, AUTHOR]");
        assertThat(data(post(SECRET, "ada", "lovelace"))).isEqualTo(Map.of("$type", "Secret", "note", "classified"));
    }

    @Test
    void guardAnAnonymousRequestHasNoViewerAndThePolicyHidesTheSecret() throws Exception {
        assertThat(data(post(ME, null, null))).isEqualTo("anonymous");
        assertThat(data(post(SECRET, null, null))).isNull();
    }

    @Test
    void aWrongPasswordIsRefusedBySpringSecurityBeforeRayfoldRuns() throws Exception {
        assertThat(post(ME, "ada", "wrong").statusCode()).isEqualTo(401);
        assertThat(resolvers.retirements).hasValue(0);
    }

    @Test
    void aUserWithoutTheRoleIsRefusedTheCommandAndNothingRuns() throws Exception {
        assertThat(frames(post(retire(key()), "bob", "builder"))).isEqualTo(List.of(json("""
            {"id":1,"error":{"code":"permission_denied","message":"Not allowed to access retire()"},"fin":true}""")));
        assertThat(resolvers.retirements).hasValue(0);
        assertThat(resolvers.posts.get("p1").retired()).isFalse();
        // and nobody signed in is asked to sign in
        assertThat(frames(post(retire(key()), null, null))).isEqualTo(List.of(json("""
            {"id":1,"error":{"code":"unauthenticated","message":"Sign in to access retire()"},"fin":true}""")));
        assertThat(resolvers.retirements).hasValue(0);
    }

    @Test
    void guardAnAdminRunsTheCommandWithTheExactResult() throws Exception {
        assertThat(frames(post(retire(key()), "ada", "lovelace"))).isEqualTo(List.of(json(RETIRED)));
        assertThat(resolvers.retirements).hasValue(1);
        assertThat(resolvers.posts.get("p1").retired()).isTrue();
    }

    @Test
    void theSamePrincipalIsTheSameViewerWhateverOrderSpringSecurityListsItsAuthoritiesIn() {
        String granted = viewerOf("ada", "ROLE_ADMIN", "ROLE_AUTHOR", "FACTOR_PASSWORD");
        assertThat(granted).isEqualTo("{\"id\":\"ada\",\"roles\":[\"ADMIN\",\"AUTHOR\"],\"role\":\"ADMIN\",\"authorities\":[\"FACTOR_PASSWORD\",\"ROLE_ADMIN\",\"ROLE_AUTHOR\"]}");
        assertThat(viewerOf("ada", "FACTOR_PASSWORD", "ROLE_AUTHOR", "ROLE_ADMIN")).isEqualTo(granted);
        assertThat(viewerOf("ada", "ROLE_AUTHOR", "FACTOR_PASSWORD", "ROLE_ADMIN")).isEqualTo(granted);
        // guard: another principal with the same authorities is another viewer
        assertThat(viewerOf("grace", "ROLE_ADMIN", "ROLE_AUTHOR", "FACTOR_PASSWORD")).isEqualTo(granted.replace("\"ada\"", "\"grace\""));
    }

    @Test
    void aRetryWithTheSameKeyReplaysForTheSamePrincipalAndTheCommandRunsOnce() throws Exception {
        String key = key();
        var first = frames(post(retire(key), "ada", "lovelace"));
        assertThat(first).isEqualTo(List.of(json(RETIRED)));
        assertThat(frames(post(retire(key), "ada", "lovelace"))).isEqualTo(List.of(json(RETIRED.replace("{\"cost\":1}", "{\"cost\":1,\"replay\":true}"))));
        assertThat(resolvers.retirements).hasValue(1);
        // guard: another principal sending the same key runs the command itself, and gets no replay marker
        assertThat(frames(post(retire(key), "grace", "hopper"))).isEqualTo(first);
        assertThat(resolvers.retirements).hasValue(2);
    }
}
