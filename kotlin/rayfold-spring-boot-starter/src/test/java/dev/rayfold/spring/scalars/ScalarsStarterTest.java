package dev.rayfold.spring.scalars;

import dev.rayfold.java.Rayfold;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import tools.jackson.databind.ObjectMapper;

import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Date;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Results through the starter's endpoint keep the schema's scalar encodings, whatever the application's Jackson writes. */
@SpringBootTest(
    classes = ScalarsApplication.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "rayfold.schema=classpath:scalars.rayfold")
class ScalarsStarterTest {
    @Value("${local.server.port}")
    int port;

    @Autowired
    ObjectMapper mapper;

    @Autowired
    ScalarsApplication.Echoes echoes;

    final HttpClient client = HttpClient.newHttpClient();

    @BeforeEach
    void forget() {
        echoes.received.clear();
    }

    @AfterEach
    void closeClient() {
        client.close();
    }

    /** The frames of one echo op sent these arguments over HTTP. */
    List<Object> echo(String args) throws Exception {
        String batch = "{\"ops\":[{\"id\":1,\"op\":\"echo\",\"args\":" + args + ",\"shape\":\"{ huge at legacy count }\"}]}";
        HttpResponse<String> res = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/rayfold"))
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString(batch))
            .build(), HttpResponse.BodyHandlers.ofString());
        assertThat(res.statusCode()).as(res.body()).isEqualTo(200);
        return res.body().lines().filter(l -> !l.isBlank()).map(Rayfold::parseJson).toList();
    }

    @Test
    void bigIntegerOffsetDateTimeDateAndABoxedLongRoundTripThroughTheBinding() throws Exception {
        assertThat(echo("""
            {"huge":"9007199254740993","at":"2026-09-15T10:30:00+02:00","legacy":"2026-09-15T08:30:00.123Z","count":null}"""))
            .isEqualTo(List.of(Rayfold.parseJson("""
                {"id":1,"data":{"huge":"9007199254740993","at":"2026-09-15T08:30:00Z","legacy":"2026-09-15T08:30:00.123Z","count":null},"meta":{"cost":1},"fin":true}""")));
        assertThat(echo("""
            {"huge":9007199254740991,"at":"1970-01-01T00:00:00Z","legacy":"1970-01-01T00:00:00Z","count":-9007199254740993}"""))
            .isEqualTo(List.of(Rayfold.parseJson("""
                {"id":1,"data":{"huge":"9007199254740991","at":"1970-01-01T00:00:00Z","legacy":"1970-01-01T00:00:00Z","count":"-9007199254740993"},"meta":{"cost":1},"fin":true}""")));
        assertThat(echo("""
            {"huge":"1","at":"1970-01-01T00:00:00Z","legacy":"1970-01-01T00:00:00Z","count":42}"""))
            .isEqualTo(List.of(Rayfold.parseJson("""
                {"id":1,"data":{"huge":"1","at":"1970-01-01T00:00:00Z","legacy":"1970-01-01T00:00:00Z","count":42},"meta":{"cost":1},"fin":true}""")));
        // what the resolver was handed, exactly: the application's Jackson reads the offset time in UTC
        assertThat(echoes.received).containsExactly(
            new ScalarsApplication.Echo(new BigInteger("9007199254740993"), OffsetDateTime.of(2026, 9, 15, 8, 30, 0, 0, ZoneOffset.UTC), new Date(1789461000123L), null),
            new ScalarsApplication.Echo(new BigInteger("9007199254740991"), OffsetDateTime.of(1970, 1, 1, 0, 0, 0, 0, ZoneOffset.UTC), new Date(0L), -9007199254740993L),
            new ScalarsApplication.Echo(BigInteger.ONE, OffsetDateTime.of(1970, 1, 1, 0, 0, 0, 0, ZoneOffset.UTC), new Date(0L), 42L));
    }

    /** The data of the reading query, asked for with this shape over HTTP. */
    @SuppressWarnings("unchecked")
    Map<String, Object> reading(String shape) throws Exception {
        String batch = "{\"ops\":[{\"id\":1,\"op\":\"reading\",\"shape\":\"" + shape + "\"}]}";
        HttpResponse<String> res = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/rayfold"))
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString(batch))
            .build(), HttpResponse.BodyHandlers.ofString());
        assertThat(res.statusCode()).as(res.body()).isEqualTo(200);
        Map<String, Object> frame = (Map<String, Object>) Rayfold.parseJson(res.body().lines().filter(l -> !l.isBlank()).findFirst().orElseThrow());
        assertThat(frame).as(res.body()).containsKey("data");
        return (Map<String, Object>) frame.get("data");
    }

    @Test
    void decimalLongInstantDateAndBytesTravelAsTheSchemaEncodesThem() throws Exception {
        assertThat(reading("{ amount big at zoned day raw }"))
            .containsEntry("amount", "4.20")
            .containsEntry("big", "9007199254740993")
            .containsEntry("at", "2026-09-15T08:30:00Z")
            .containsEntry("zoned", "2026-09-15T08:30:00Z")
            .containsEntry("day", "2026-09-15")
            .containsEntry("raw", "-_8");
    }

    @Test
    void guardNumbersWithinReachStayNumbersAndTheApplicationsJacksonAnnotationsStillApply() throws Exception {
        assertThat(reading("{ small ratio }"))
            .containsEntry("small", 9007199254740991L)
            .containsEntry("ratio", 0.5);
    }

    @Test
    void guardTheApplicationsOwnMapperWritesTheseValuesOtherwise() {
        @SuppressWarnings("unchecked")
        Map<String, Object> plain = (Map<String, Object>) Rayfold.parseJson(mapper.writeValueAsString(ScalarsApplication.READING));
        assertThat(plain.get("amount")).isInstanceOf(Number.class);
        assertThat(plain.get("big")).isInstanceOf(Number.class);
        assertThat(plain.get("at")).isInstanceOf(Number.class);
        assertThat(plain.get("zoned")).isInstanceOf(Number.class);
        assertThat(plain.get("day")).isInstanceOf(List.class);
        assertThat(plain.get("raw")).isEqualTo("+/8=");
    }
}
