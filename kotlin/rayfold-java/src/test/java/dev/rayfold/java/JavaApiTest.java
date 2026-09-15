package dev.rayfold.java;

import com.sun.net.httpserver.HttpServer;
import dev.rayfold.core.Code;
import dev.rayfold.core.RayfoldExplorer;
import dev.rayfold.core.RayfoldServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.BindException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The Java API end to end: resolvers written in Java, served by the real HTTP transport, called over the network
 * with java.net.http. Everything a request touches is real: schema text, builder, runtime, HTTP, JSON.
 */
class JavaApiTest {
    static final String SCHEMA = """
        entity Author { id: ID name: String born: Instant? }
        entity Book { id: ID title: String price: Decimal stock: Int author: Author format: Format tags: [String] }
        enum Format { HARDCOVER EBOOK }
        error OutOfStock { available: Int }
        event Sold { bookId: ID qty: Int }
        input Filter { minStock: Int? formats: [Format]? }
        query book(id: ID): Book?
        query books(filter: Filter?): [Book]
        query slowBook(id: ID): Book?
        query echo(i: Int, l: Long, f: Float, d: Decimal, b: Boolean, s: String, list: [Int], nested: Filter?): String
        object Reading { big: Long raw: Bytes at: Instant }
        query reading: Reading
        object Scalars { huge: Long at: Instant legacy: Instant count: Long? }
        query scalars(huge: Long, at: Instant, legacy: Instant, count: Long?): Scalars
        command buy(id: ID, qty: Int): Book throws OutOfStock emits Sold
        stream countdown(from: Int): Int
        """;

    record Author(String id, String name, Instant born) {}

    record Reading(long big, byte[] raw, ZonedDateTime at) {}

    record Scalars(BigInteger huge, OffsetDateTime at, Date legacy, Long count) {}

    record Book(String id, String title, BigDecimal price, int stock, String authorId, Format format, List<String> tags) {
        Book withStock(int s) { return new Book(id, title, price, s, authorId, format, tags); }
    }

    enum Format { HARDCOVER, EBOOK }

    /** A class with getters, the shape of most existing Java domain objects. */
    public static final class Profile {
        private final String name;
        public Profile(String name) { this.name = name; }
        public String getName() { return name; }
        public boolean isActive() { return true; }
        public Optional<String> getNickname() { return Optional.empty(); }
        public Duration getSession() { return Duration.ofSeconds(90); }
        public int[] getScores() { return new int[] {3, 5}; }
    }

    final Map<String, Book> books = new ConcurrentHashMap<>();
    final Map<String, Author> authors = Map.of(
        "a1", new Author("a1", "Ursula K. Le Guin", Instant.parse("1929-10-21T00:00:00Z")),
        "a2", new Author("a2", "Frank Herbert", null));
    final AtomicInteger authorLoads = new AtomicInteger();
    final List<String> sold = Collections.synchronizedList(new ArrayList<>());
    final List<Object> events = Collections.synchronizedList(new ArrayList<>());
    final List<Scalars> received = Collections.synchronizedList(new ArrayList<>());
    final HttpClient client = HttpClient.newHttpClient();
    RayfoldServer server;
    HttpServer http;
    String url;

    @BeforeEach
    void start() throws IOException {
        books.put("b1", new Book("b1", "The Dispossessed", new BigDecimal("12.50"), 3, "a1", Format.HARDCOVER, List.of("sf", "utopia")));
        books.put("b2", new Book("b2", "Dune", new BigDecimal("9.99"), 0, "a2", Format.EBOOK, List.of()));
        server = Rayfold.server(SCHEMA)
            .query("book", (args, ctx) -> {
                String id = args.getString("id");
                if ("crash".equals(id)) throw new IllegalStateException("secret detail that must not reach the client");
                return books.get(id);
            })
            .query("books", (args, ctx) -> {
                Values filter = args.getValues("filter");
                Integer min = filter == null ? null : filter.getInt("minStock");
                List<?> formats = filter == null ? null : filter.getList("formats");
                return books.values().stream()
                    .filter(b -> min == null || b.stock() >= min)
                    .filter(b -> formats == null || formats.contains(b.format().name()))
                    .sorted(Comparator.comparing(Book::id))
                    .toList();
            })
            .queryAsync("slowBook", (args, ctx) -> "boom".equals(args.getString("id"))
                ? CompletableFuture.failedFuture(Rayfold.error(Code.NOT_FOUND, "No book boom"))
                : CompletableFuture.supplyAsync(() -> books.get(args.getString("id"))))
            .query("echo", (args, ctx) -> String.join("|",
                String.valueOf(args.getInt("i") + 1), String.valueOf(args.getLong("l") + 1), String.valueOf(args.getDouble("f") * 2),
                args.getDecimal("d").add(BigDecimal.ONE).toPlainString(), String.valueOf(!args.getBoolean("b")), args.getString("s").toUpperCase(),
                String.valueOf(args.getList("list").size()), String.valueOf(args.getValues("nested").getList("formats")),
                String.valueOf(args.has("nested")), String.valueOf(args.getString("missing"))))
            .field("Book", "author", (parents, args, ctx) -> {
                authorLoads.incrementAndGet();
                return parents.stream().map(p -> authors.get(p.getString("authorId"))).toList();
            })
            .command("buy", (args, ctx) -> {
                Book b = books.get(args.getString("id"));
                int qty = args.getInt("qty");
                if (qty > b.stock()) throw Rayfold.domainError("OutOfStock", Map.of("available", b.stock()), "Only " + b.stock() + " left");
                Book next = b.withStock(b.stock() - qty);
                books.put(b.id(), next);
                sold.add(ctx.viewerId() + ":" + b.id());
                return Rayfold.result(next).emit("Sold", Map.of("bookId", b.id(), "qty", qty));
            })
            .stream("countdown", (args, ctx) -> Stream.iterate(args.getInt("from"), i -> i >= 0, i -> i - 1))
            .query("reading", (args, ctx) -> new Reading(9007199254740993L, new byte[] {(byte) 0xfb, (byte) 0xff},
                ZonedDateTime.of(2026, 9, 15, 10, 30, 0, 0, ZoneId.of("Europe/Paris"))))
            .query("scalars", (args, ctx) -> {
                Scalars s = new Scalars(new BigInteger(args.getString("huge")), OffsetDateTime.parse(args.getString("at")),
                    Date.from(Instant.parse(args.getString("legacy"))), args.getLong("count"));
                received.add(s);
                return s;
            })
            .build();
        server.getEvents().on("Sold", payload -> { events.add(Rayfold.fromJson(payload)); return kotlin.Unit.INSTANCE; });
        http = Rayfold.http(server)
            .viewer(exchange -> {
                String user = exchange.getRequestHeaders().getFirst("X-User");
                return user == null ? null : Map.of("id", user, "role", "customer");
            })
            .start(0);
        url = "http://127.0.0.1:" + http.getAddress().getPort() + "/rayfold";
    }

    @AfterEach
    void stop() {
        http.stop(0);
        client.close();
    }

    /** POSTs a batch and returns its frames as Java maps. */
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> post(String user, String batch) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(5))
            .header("Content-Type", "application/rayfold+json")
            .POST(HttpRequest.BodyPublishers.ofString(batch));
        if (user != null) request.header("X-User", user);
        HttpResponse<String> res = client.send(request.build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, res.statusCode(), res.body());
        return res.body().lines().filter(l -> !l.isBlank()).map(l -> (Map<String, Object>) Rayfold.parseJson(l)).toList();
    }

    @SuppressWarnings("unchecked")
    static <T> T at(Object json, Object... path) {
        Object cur = json;
        for (Object p : path) cur = p instanceof Integer i ? ((List<Object>) cur).get(i) : ((Map<String, Object>) cur).get((String) p);
        return (T) cur;
    }

    @Test
    void javaRecordsBecomeTheResponseAndOneLoaderCallServesEveryBook() throws Exception {
        var frames = post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"books","shape":"{ id title price stock format tags author { name born } }"}]}""");
        assertEquals(1, frames.size());
        List<Object> list = at(frames.get(0), "data");
        assertEquals(2, list.size());
        assertEquals("The Dispossessed", at(list, 0, "title"));
        assertEquals("12.50", at(list, 0, "price"));
        assertEquals(3L, (Long) at(list, 0, "stock"));
        assertEquals("HARDCOVER", at(list, 0, "format"));
        assertEquals(List.of("sf", "utopia"), at(list, 0, "tags"));
        assertEquals("Ursula K. Le Guin", at(list, 0, "author", "name"));
        assertEquals("1929-10-21T00:00:00Z", at(list, 0, "author", "born"));
        assertNull(at(list, 1, "author", "born"));
        assertEquals(1, authorLoads.get(), "one loader call for both books");
        // guard: the count follows the calls; one more request is one more load
        post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"b2"},"shape":"{ id author { name } }"}]}""");
        assertEquals(2, authorLoads.get());
    }

    @Test
    void argumentsReadTypedIncludingNestedInputsAndLists() throws Exception {
        var echo = post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"echo","args":{"i":41,"l":9007199254740993,"f":1.25,"d":"10.10","b":true,"s":"abc","list":[1,2,3],"nested":{"formats":["EBOOK"]}}}]}""");
        assertEquals("42|9007199254740994|2.5|11.10|false|ABC|3|[EBOOK]|true|null", at(echo.get(0), "data"));
        var filtered = post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"books","args":{"filter":{"minStock":1,"formats":["HARDCOVER"]}},"shape":"{ id }"}]}""");
        assertEquals(List.of(Map.of("$type", "Book", "id", "b1")), at(filtered.get(0), "data"));
    }

    @Test
    void aSignedInCommandReturnsThePatchedBookAndEmitsItsEvent() throws Exception {
        var frames = post("alice", """
            {"rayfold":"0.1","ops":[{"id":1,"op":"buy","args":{"id":"b1","qty":1},"key":"key-0000000000001","shape":"{ id stock }"}]}""");
        assertEquals(List.of(Rayfold.parseJson("""
            {"id":1,"ok":{"$type":"Book","id":"b1","stock":2},"patch":[{"set":"Book:b1","value":{"$type":"Book","id":"b1","stock":2}}],"meta":{"cost":1},"fin":true}""")), frames);
        assertEquals(List.of("alice:b1"), sold);
        assertEquals(List.of(Map.of("bookId", "b1", "qty", 1L, "seq", 1L)), events, "the event as declared, numbered by the bus");
        assertEquals(2, books.get("b1").stock());
    }

    @Test
    void guardAnAnonymousCommandIsRefusedAndChangesNothing() throws Exception {
        var frames = post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"buy","args":{"id":"b1","qty":1},"key":"key-0000000000002"}]}""");
        assertEquals("unauthenticated", at(frames.get(0), "error", "code"));
        assertEquals(3, books.get("b1").stock());
        assertEquals(List.of(), sold);
    }

    @Test
    void aDeclaredErrorThrownInJavaReachesTheClientTypedWithItsData() throws Exception {
        var frames = post("alice", """
            {"rayfold":"0.1","ops":[{"id":1,"op":"buy","args":{"id":"b2","qty":1},"key":"key-0000000000003"}]}""");
        assertEquals("domain", at(frames.get(0), "error", "code"));
        assertEquals("OutOfStock", at(frames.get(0), "error", "type"));
        assertEquals(0L, (Long) at(frames.get(0), "error", "data", "available"));
        assertEquals("Only 0 left", at(frames.get(0), "error", "message"));
        assertEquals(List.of(), sold);
    }

    @Test
    void asyncResolversAnswerAndAFailedFutureFailsWithItsCause() throws Exception {
        var ok = post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"slowBook","args":{"id":"b1"},"shape":"{ title }"}]}""");
        assertEquals("The Dispossessed", at(ok.get(0), "data", "title"));
        var failed = post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"slowBook","args":{"id":"boom"}}]}""");
        assertEquals("not_found", at(failed.get(0), "error", "code"));
        assertEquals("No book boom", at(failed.get(0), "error", "message"));
    }

    @Test
    void anUnexpectedJavaExceptionIsAnInternalErrorWithoutItsMessage() throws Exception {
        var frames = post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"book","args":{"id":"crash"}},{"id":2,"op":"book","args":{"id":"b1"},"shape":"{ title }"}]}""");
        Map<String, Object> crashed = frames.stream().filter(f -> Long.valueOf(1).equals(f.get("id"))).findFirst().orElseThrow();
        assertEquals("internal", at(crashed, "error", "code"));
        assertTrue(!String.valueOf(crashed).contains("secret detail"), String.valueOf(crashed));
        // guard: the other op in the batch still answers
        Map<String, Object> fine = frames.stream().filter(f -> Long.valueOf(2).equals(f.get("id"))).findFirst().orElseThrow();
        assertEquals("The Dispossessed", at(fine, "data", "title"));
    }

    @Test
    void aJavaStreamBecomesOneFramePerElement() throws Exception {
        var frames = post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"countdown","args":{"from":3}}]}""");
        List<Object> items = frames.stream().filter(f -> f.containsKey("item")).map(f -> f.get("item")).toList();
        assertEquals(List.of(3L, 2L, 1L, 0L), items);
        assertEquals(Boolean.TRUE, frames.get(frames.size() - 1).get("fin"));
    }

    @Test
    void theBuilderRefusesResolversTheSchemaDoesNotDeclare() {
        var e1 = assertThrows(IllegalArgumentException.class, () -> Rayfold.server(SCHEMA).query("nope", (a, c) -> null));
        assertEquals("The schema has no operation nope", e1.getMessage());
        var e2 = assertThrows(IllegalArgumentException.class, () -> Rayfold.server(SCHEMA).query("buy", (a, c) -> null));
        assertEquals("buy is a command in the schema, not a query", e2.getMessage());
        var e3 = assertThrows(IllegalArgumentException.class, () -> Rayfold.server(SCHEMA).field("Book", "publisher", (p, a, c) -> List.of()));
        assertEquals("The schema has no field Book.publisher", e3.getMessage());
    }

    @Test
    void javaValuesConvertToJsonByTheirShape() {
        UUID id = UUID.fromString("123e4567-e89b-12d3-a456-426614174000");
        Object json = Rayfold.fromJson(Rayfold.toJson(Map.of(
            "profile", new Profile("Ada"),
            "id", id,
            "money", new BigDecimal("1e3"),
            "list", List.of(1, "two", Optional.of(3.5)))));
        Map<String, Object> profile = new HashMap<>(Map.of("name", "Ada", "active", true, "session", 90000L, "scores", List.of(3L, 5L)));
        profile.put("nickname", null); // an empty Optional is a present null
        assertEquals(profile, at(json, "profile"));
        assertEquals(id.toString(), at(json, "id"));
        assertEquals("1000", at(json, "money"));
        assertEquals(List.of(1L, "two", 3.5), at(json, "list"));
    }

    @Test
    void aLongPast2To53BytesAndAZonedTimeTravelInTheSchemasEncodings() throws Exception {
        var frames = post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"reading","shape":"{ big raw at }"}]}""");
        assertEquals("9007199254740993", at(frames.get(0), "data", "big"));
        assertEquals("-_8", at(frames.get(0), "data", "raw"));
        assertEquals("2026-09-15T08:30:00Z", at(frames.get(0), "data", "at"));
    }

    @Test
    void scalarsTheSchemaCarriesAsTextConvertToThatText() {
        Object text = Rayfold.fromJson(Rayfold.toJson(Map.of(
            "big", 9007199254740993L,
            "negative", -9007199254740993L,
            "bytes", new byte[] {(byte) 0xfb, (byte) 0xff},
            "offset", OffsetDateTime.of(2026, 9, 15, 10, 30, 0, 0, ZoneOffset.ofHours(2)),
            "date", Date.from(Instant.parse("2026-09-15T08:30:00.123Z")))));
        assertEquals("9007199254740993", at(text, "big"));
        assertEquals("-9007199254740993", at(text, "negative"));
        assertEquals("-_8", at(text, "bytes"), "base64url without padding, not \"+/8=\"");
        assertEquals("2026-09-15T08:30:00Z", at(text, "offset"));
        assertEquals("2026-09-15T08:30:00.123Z", at(text, "date"));
        // guard: a Long within 2^53 stays a number, other arrays stay arrays, and Instant and LocalDate keep their text
        Object plain = Rayfold.fromJson(Rayfold.toJson(Map.of(
            "safe", 9007199254740991L,
            "ints", new int[] {1, 2},
            "instant", Instant.parse("2026-09-15T08:30:00Z"),
            "day", LocalDate.of(2026, 9, 15))));
        assertEquals(9007199254740991L, (Long) at(plain, "safe"));
        assertEquals(List.of(1L, 2L), at(plain, "ints"));
        assertEquals("2026-09-15T08:30:00Z", at(plain, "instant"));
        assertEquals("2026-09-15", at(plain, "day"));
    }

    HttpResponse<String> get(String uri) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create(uri)).timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void theBuilderServesTheExplorerWhenAskedTo() throws Exception {
        HttpServer withExplorer = Rayfold.http(server).explorer("Bookshop").start(0);
        try {
            var page = get("http://127.0.0.1:" + withExplorer.getAddress().getPort() + "/rayfold/explorer");
            assertEquals(200, page.statusCode(), page.body());
            assertEquals("text/html; charset=utf-8", page.headers().firstValue("Content-Type").orElse(null));
            assertEquals(new RayfoldExplorer("/rayfold", "Bookshop").getHtml(), page.body(), "the page for this endpoint, under its title");
        } finally {
            withExplorer.stop(0);
        }
        // guard: the server built without explorer() serves none
        assertEquals(404, get(url + "/explorer").statusCode());
    }

    @Test
    void theExplorerMountsFromJavaAtItsDefaultPath() throws Exception {
        new RayfoldExplorer("/rayfold", "Mounted by hand").mount(http);
        var page = get(url + "/explorer");
        assertEquals(200, page.statusCode(), page.body());
        assertEquals("text/html; charset=utf-8", page.headers().firstValue("Content-Type").orElse(null));
        assertEquals(new RayfoldExplorer("/rayfold", "Mounted by hand").getHtml(), page.body());
        assertTrue(page.body().contains("{\"endpoint\":\"/rayfold\",\"title\":\"Mounted by hand\"}"), "the page carries its own configuration");
    }

    @Test
    void bigIntegerOffsetDateTimeDateAndABoxedLongTravelAsTheSchemaEncodesThemBothWays() throws Exception {
        var text = post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"scalars","args":{"huge":"9007199254740993","at":"2026-09-15T10:30:00+02:00","legacy":"2026-09-15T08:30:00.123Z","count":null},"shape":"{ huge at legacy count }"}]}""");
        assertEquals(List.of(Rayfold.parseJson("""
            {"id":1,"data":{"huge":"9007199254740993","at":"2026-09-15T08:30:00Z","legacy":"2026-09-15T08:30:00.123Z","count":null},"meta":{"cost":1},"fin":true}""")), text);
        // numbers on the way in: a Long within 2^53 as a JSON number, and one past it, which comes back as text
        var numbers = post(null, """
            {"rayfold":"0.1","ops":[{"id":1,"op":"scalars","args":{"huge":9007199254740991,"at":"1970-01-01T00:00:00Z","legacy":"1970-01-01T00:00:00Z","count":-9007199254740993},"shape":"{ huge at legacy count }"}]}""");
        assertEquals(List.of(Rayfold.parseJson("""
            {"id":1,"data":{"huge":"9007199254740991","at":"1970-01-01T00:00:00Z","legacy":"1970-01-01T00:00:00Z","count":"-9007199254740993"},"meta":{"cost":1},"fin":true}""")), numbers);
        assertEquals(List.of(
            new Scalars(new BigInteger("9007199254740993"), OffsetDateTime.of(2026, 9, 15, 10, 30, 0, 0, ZoneOffset.ofHours(2)), new Date(1789461000123L), null),
            new Scalars(new BigInteger("9007199254740991"), OffsetDateTime.of(1970, 1, 1, 0, 0, 0, 0, ZoneOffset.UTC), new Date(0L), -9007199254740993L)), received);
    }

    @Test
    void startingOnATakenPortThrowsAnIOExceptionJavaCanCatch() throws Exception {
        int taken = http.getAddress().getPort();
        IOException failure = null;
        // this catch compiles only because start declares IOException
        try {
            Rayfold.http(server).start(taken).stop(0);
        } catch (IOException e) {
            failure = e;
        }
        assertInstanceOf(BindException.class, failure);
        // guard: a free port starts
        Rayfold.http(server).start(0).stop(0);
    }

    @Test
    void aValueThatContainsItselfFailsInsteadOfOverflowingTheStack() {
        List<Object> loop = new ArrayList<>();
        loop.add(loop);
        var e = assertThrows(IllegalArgumentException.class, () -> Rayfold.toJson(loop));
        assertTrue(e.getMessage().contains("nested deeper than 64"), e.getMessage());
    }
}
