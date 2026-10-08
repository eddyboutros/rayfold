package dev.rayfold.test;

import dev.rayfold.client.Transport;
import dev.rayfold.core.Code;
import dev.rayfold.core.RayfoldException;
import dev.rayfold.core.RayfoldServer;
import dev.rayfold.java.Rayfold;
import kotlinx.serialization.json.JsonObject;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** The module as a Java developer uses it: a server from the Java builder, maps in, plain values out. */
class JavaApiTest {
    static final String SCHEMA = """
        entity Book {
          id: ID
          title: String
          stock: Int
          cost: Decimal? @allow(read: viewer.role == "staff")
        }
        error OutOfStock { bookId: ID, available: Int }
        query book(id: ID): Book?
        command buy(bookId: ID, qty: Int = 1): Book throws OutOfStock @allow(write: viewer != null)
        command restock(bookId: ID, qty: Int): Book @allow(write: viewer.role == "staff")
        """;

    record Book(String id, String title, int stock, String cost) {}

    record Viewer(String id, String role) {}

    Map<String, Integer> stock;
    AtomicInteger purchases;
    RayfoldServer server;
    RayfoldTest anyone;
    RayfoldTest customer;
    RayfoldTest staff;

    @BeforeEach
    void start() {
        stock = new ConcurrentHashMap<>(Map.of("b1", 3, "b2", 0));
        purchases = new AtomicInteger();
        server = Rayfold.server(SCHEMA)
            .query("book", (args, ctx) -> book(args.getString("id")))
            .command("buy", (args, ctx) -> {
                purchases.incrementAndGet();
                String id = args.getString("bookId");
                int left = stock.get(id);
                if (args.getInt("qty") > left) {
                    throw Rayfold.domainError("OutOfStock", Map.of("bookId", id, "available", left), "Only " + left + " left");
                }
                stock.put(id, left - args.getInt("qty"));
                return book(id);
            })
            .command("restock", (args, ctx) -> {
                stock.merge(args.getString("bookId"), args.getInt("qty"), Integer::sum);
                return book(args.getString("bookId"));
            })
            .build();
        anyone = RayfoldTest.of(server);
        customer = anyone.signedInAs(Map.of("id", "u1", "role", "customer"));
        staff = anyone.signedInAs(new Viewer("s1", "staff"));
    }

    Book book(String id) {
        Integer left = stock.get(id);
        return left == null ? null : new Book(id, "Book " + id, left, "4.20");
    }

    @Test
    void aQueryReturnsWhatTheResolverProducedAsPlainValues() {
        Map<String, Object> book = anyone.query("book", Map.of("id", "b1"), "{ title stock }");
        assertEquals(Map.of("$type", "Book", "title", "Book b1", "stock", 3L), book);
        // guard: without a shape the default one answers, and a book the shop does not have is null
        assertEquals(Map.of("$type", "Book", "id", "b2", "title", "Book b2", "stock", 0L), anyone.query("book", Map.of("id", "b2")));
        assertNull(anyone.query("book", Map.of("id", "b9")));
    }

    @Test
    void aPolicyRefusesACustomerAndNothingRuns() {
        var refused = assertThrows(RayfoldException.class, () -> customer.command("restock", Map.of("bookId", "b2", "qty", 5)));
        assertEquals(Code.PERMISSION_DENIED, refused.getCode());
        assertEquals("Not allowed to access restock()", refused.getMessage());
        assertEquals(0, stock.get("b2"));

        var anonymous = assertThrows(RayfoldException.class, () -> anyone.command("buy", Map.of("bookId", "b1")));
        assertEquals(Code.UNAUTHENTICATED, anonymous.getCode());
        assertEquals(0, purchases.get());
    }

    @Test
    void theSameCommandIsAllowedForStaffSignedInAsARecord() {
        Map<String, Object> book = staff.command("restock", Map.of("bookId", "b2", "qty", 5), "{ id stock }");
        assertEquals(Map.of("$type", "Book", "id", "b2", "stock", 5L), book);
        assertEquals(5, stock.get("b2"));
        assertEquals(Map.of("$type", "Book", "cost", "4.20"), staff.query("book", Map.of("id", "b1"), "{ cost }"));
    }

    @Test
    void aDeclaredErrorArrivesByNameWithItsPayload() {
        var error = assertThrows(RayfoldException.class, () -> customer.command("buy", Map.of("bookId", "b1", "qty", 5)));
        assertEquals(Code.DOMAIN, error.getCode());
        assertEquals("OutOfStock", error.getType());
        assertEquals(Map.of("bookId", "b1", "available", 3L), Rayfold.fromJson(error.getData()));
        assertEquals("Only 3 left", error.getMessage());
        assertEquals(3, stock.get("b1"));
    }

    @Test
    void aCommandRetriedUnderTheSameKeyRunsOnceAndIsAnsweredAsAReplay() {
        String key = "purchase-0001-first";
        Map<String, Object> first = customer.command("buy", Map.of("bookId", "b1"), "{ id stock }", key);
        Map<String, Object> retry = customer.command("buy", Map.of("bookId", "b1"), "{ id stock }", key);
        assertEquals(Map.of("$type", "Book", "id", "b1", "stock", 2L), first);
        assertEquals(first, retry);
        assertEquals(1, purchases.get());

        List<Map<String, Object>> frames = customer.frames("buy", Map.of("bookId", "b1"), "{ id stock }", key);
        assertEquals(1, frames.size());
        assertEquals(Map.of("cost", 1L, "replay", true), frames.getFirst().get("meta"));
        assertEquals(1, purchases.get());
    }

    @Test
    void anotherKeyOrNoKeyRunsTheCommandAgain() {
        customer.command("buy", Map.of("bookId", "b1"), null, "purchase-0001-first");
        List<Map<String, Object>> second = customer.frames("buy", Map.of("bookId", "b1"), "{ id stock }", "purchase-0002-second");
        assertEquals(Map.of("cost", 1L), second.getFirst().get("meta"));
        assertEquals(2, purchases.get());
        customer.command("buy", Map.of("bookId", "b1"));
        assertEquals(3, purchases.get());
        assertEquals(0, stock.get("b1"));
    }

    @Test
    void aLiveQueryGivesItsFirstResultThenTheResultAfterACommand() {
        try (LiveQuery<Object> book = anyone.live("book", Map.of("id", "b1"), "{ id stock }")) {
            assertEquals(Map.of("$type", "Book", "id", "b1", "stock", 3L), book.next());
            customer.command("buy", Map.of("bookId", "b1", "qty", 2));
            assertEquals(Map.of("$type", "Book", "id", "b1", "stock", 1L), book.next());
        }
    }

    @Test
    void nextFailsWithWhatItWaitedForWhenNothingArrives() {
        try (LiveQuery<Object> book = anyone.within(150).live("book", Map.of("id", "b1"))) {
            book.next();
            assertEquals("live book() sent nothing within 150 ms", assertThrows(AssertionError.class, book::next).getMessage());
            assertEquals("live book() sent nothing within 200 ms", assertThrows(AssertionError.class, () -> book.next(200)).getMessage());
            // guard: a change still arrives afterwards
            customer.command("buy", Map.of("bookId", "b1"));
            assertEquals(Map.of("$type", "Book", "id", "b1", "title", "Book b1", "stock", 2L), book.next(5_000));
        }
    }

    @Test
    void closeGivesTheServerItsSubscriptionBack() {
        LiveQuery<Object> book = anyone.live("book", Map.of("id", "b1"));
        assertEquals(1, server.getChanges().getSize());
        book.close();
        assertEquals(0, server.getChanges().getSize());
        // guard: leaving a try block closes it as well
        try (LiveQuery<Object> again = anyone.live("book", Map.of("id", "b1"))) {
            assertEquals(1, server.getChanges().getSize());
            again.next();
        }
        assertEquals(0, server.getChanges().getSize());
    }

    /** The frames of a batch of one op sent through a transport, as plain values. */
    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> send(Transport transport, Map<String, Object> op) {
        JsonObject envelope = (JsonObject) Rayfold.toJson(Map.of("ops", List.of(op)));
        return BatchesKt.framesOf(transport, envelope).stream().map(frame -> (Map<String, Object>) Rayfold.fromJson(frame)).toList();
    }

    @Test
    void aLocalTransportTakesItsViewerFromASupplierOfJavaValues() {
        Map<String, Object> restock = Map.of("id", 1, "op", "restock", "args", Map.of("bookId", "b2", "qty", 5), "key", "restock-0001-first", "shape", "{ id stock }");
        var refused = send(new LocalTransport(server, () -> Map.of("id", "u1", "role", "customer")), restock);
        assertEquals(List.of(Map.of("id", 1L, "error", Map.of("code", "permission_denied", "message", "Not allowed to access restock()"), "fin", true)), refused);
        assertEquals(0, stock.get("b2"));

        var allowed = send(new LocalTransport(server, () -> new Viewer("s1", "staff")), restock);
        assertEquals(Map.of("$type", "Book", "id", "b2", "stock", 5L), allowed.getFirst().get("ok"));
        assertEquals(5, stock.get("b2"));
    }

    @Test
    void aLocalTransportWithoutAViewerIsAnonymousAndOneWithJsonIsThatViewer() {
        Map<String, Object> buy = Map.of("id", 1, "op", "buy", "args", Map.of("bookId", "b1"), "key", "purchase-0001-first");
        var anonymous = send(new LocalTransport(server), buy);
        assertEquals(Map.of("code", "unauthenticated", "message", "Sign in to access buy()"), anonymous.getFirst().get("error"));
        assertEquals(0, purchases.get());

        var signedIn = send(new LocalTransport(server, () -> Rayfold.toJson(Map.of("id", "u1"))), buy);
        assertEquals(Map.of("$type", "Book", "id", "b1", "title", "Book b1", "stock", 2L), signedIn.getFirst().get("ok"));
        assertEquals(1, purchases.get());
    }
}
