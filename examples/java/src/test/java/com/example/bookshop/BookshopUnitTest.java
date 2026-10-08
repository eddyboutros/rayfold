package com.example.bookshop;

import dev.rayfold.core.Code;
import dev.rayfold.core.RayfoldException;
import dev.rayfold.core.RayfoldServer;
import dev.rayfold.java.Rayfold;
import dev.rayfold.test.LiveQuery;
import dev.rayfold.test.RayfoldTest;
import kotlin.Unit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/** The bookshop without a network: the real server, called in the test's own process. Every test gets its own store and server. */
class BookshopUnitTest {
    // #region test-setup
    Store store;
    RayfoldServer server;
    RayfoldTest anyone;
    RayfoldTest customer;
    RayfoldTest staff;

    @BeforeEach
    void start() {
        store = new Store();
        server = Bookshop.server(store);
        // one caller per viewer: the value the schema's policies see as `viewer`
        anyone = RayfoldTest.of(server);
        customer = anyone.signedInAs(Map.of("id", "u1", "role", "customer"));
        staff = anyone.signedInAs(Map.of("id", "s1", "role", "staff"));
    }
    // #endregion test-setup

    // #region test-resolver
    @Test
    void bookReturnsTheShapeItWasAskedForWithTheAuthorsName() {
        Map<String, Object> book = anyone.query("book", Map.of("id", "b1"), "{ title stock author { name } }");
        assertEquals(
            Map.of("$type", "Book", "title", "A Wizard of Earthsea", "stock", 3L,
                "author", Map.of("$type", "Author", "name", "Ursula K. Le Guin")),
            book);
        assertEquals(1, store.authorLookups());
    }
    // #endregion test-resolver

    // #region test-policy
    @Test
    void aCustomerMayNotRestockAndStaffMay() {
        var refused = assertThrows(RayfoldException.class,
            () -> customer.command("restock", Map.of("bookId", "b2", "qty", 5)));
        assertEquals(Code.PERMISSION_DENIED, refused.getCode());
        assertEquals(0, store.book("b2").orElseThrow().stock());

        Map<String, Object> restocked = staff.command("restock", Map.of("bookId", "b2", "qty", 5), "{ id stock }");
        assertEquals(Map.of("$type", "Book", "id", "b2", "stock", 5L), restocked);
        assertEquals(5, store.book("b2").orElseThrow().stock());
    }
    // #endregion test-policy

    @Test
    void buyingWithoutSigningInIsRefusedAndCostPriceIsForStaffAlone() {
        var anonymous = assertThrows(RayfoldException.class, () -> anyone.command("buy", Map.of("bookId", "b1")));
        assertEquals(Code.UNAUTHENTICATED, anonymous.getCode());
        // the schema's policy refused it, before the rule that a keyed command needs a caller could
        assertEquals("Sign in to access buy()", anonymous.getMessage());
        assertEquals(3, store.book("b1").orElseThrow().stock());

        var asked = assertThrows(RayfoldException.class, () -> customer.query("book", Map.of("id", "b1"), "{ title costPrice }"));
        assertEquals(Code.PERMISSION_DENIED, asked.getCode());
        assertEquals("costPrice", asked.getPath());
        // guard: the same question from staff is answered
        assertEquals(
            Map.of("$type", "Book", "title", "A Wizard of Earthsea", "costPrice", "4.20"),
            staff.query("book", Map.of("id", "b1"), "{ title costPrice }"));
    }

    @Test
    void aPurchaseOfABookTheShopDoesNotHaveIsNotFoundAndASaleSaysWhatItChanged() {
        var missing = assertThrows(RayfoldException.class, () -> customer.command("buy", Map.of("bookId", "b9")));
        assertEquals(Code.NOT_FOUND, missing.getCode());
        assertEquals("No book b9", missing.getMessage());

        // guard: a book the shop has is sold, and the StockChanged the schema declares is emitted with its new stock
        List<Object> emitted = new ArrayList<>();
        server.getEvents().on("StockChanged", event -> {
            emitted.add(Rayfold.fromJson(event));
            return Unit.INSTANCE;
        });
        customer.command("buy", Map.of("bookId", "b3", "qty", 2));
        assertEquals(List.of(Map.of("bookId", "b3", "stock", 5L, "seq", 1L)), emitted);
    }

    // #region test-error
    @Test
    void buyingMoreThanTheShelfHoldsFailsWithOutOfStockAndChangesNothing() {
        var error = assertThrows(RayfoldException.class,
            () -> customer.command("buy", Map.of("bookId", "b1", "qty", 5)));
        assertEquals(Code.DOMAIN, error.getCode());
        assertEquals("OutOfStock", error.getType());
        assertEquals(Map.of("bookId", "b1", "available", 3L), Rayfold.fromJson(error.getData()));
        assertEquals("Only 3 left of A Wizard of Earthsea", error.getMessage());
        assertEquals(3, store.book("b1").orElseThrow().stock());

        // guard: what the shelf holds can be bought
        customer.command("buy", Map.of("bookId", "b1", "qty", 3));
        assertEquals(0, store.book("b1").orElseThrow().stock());
    }
    // #endregion test-error

    // #region test-replay
    @Test
    void aPurchaseRetriedWithTheSameKeySellsOnce() {
        Map<String, Object> purchase = Map.of("bookId", "b3", "qty", 2);
        String key = "purchase-0001-first";
        Map<String, Object> first = customer.command("buy", purchase, "{ id stock }", key);
        assertEquals(Map.of("$type", "Book", "id", "b3", "stock", 5L), first);

        // frames() returns what the server sent as it sent it, where command() returns the result alone
        List<Map<String, Object>> retry = customer.frames("buy", purchase, "{ id stock }", key);
        assertEquals(1, retry.size(), "one frame, the replay");
        assertEquals(first, retry.getFirst().get("ok"));
        assertEquals(Map.of("cost", 1L, "replay", true), retry.getFirst().get("meta"));
        assertEquals(5, store.book("b3").orElseThrow().stock());

        // guard: without a key of its own each call gets a fresh one, so this is a new purchase
        customer.command("buy", purchase);
        assertEquals(3, store.book("b3").orElseThrow().stock());
    }
    // #endregion test-replay

    // #region test-live
    @Test
    void aLiveQueryGetsTheNewStockWhenSomeoneBuys() {
        try (LiveQuery<Object> book = anyone.live("book", Map.of("id", "b3"), "{ id stock }")) {
            assertEquals(Map.of("$type", "Book", "id", "b3", "stock", 7L), book.next());

            customer.command("buy", Map.of("bookId", "b3", "qty", 2));
            // next() waits 5 s at most, and fails the test when nothing came
            assertEquals(Map.of("$type", "Book", "id", "b3", "stock", 5L), book.next());
        }
        // closed, the query holds nothing on the server
        assertEquals(0, server.getChanges().getSize());
    }
    // #endregion test-live

    // #region test-clock
    @Test
    void aRetryIsAnsweredFromTheFirstPurchaseForADayAndIsANewPurchaseAfterIt() {
        long day = 24 * 60 * 60 * 1000L;
        AtomicLong now = new AtomicLong(0);
        // the server tells the time by the clock it is given, and the test moves it
        RayfoldServer timed = Bookshop.server(store, now::get);
        RayfoldTest customer = RayfoldTest.of(timed).signedInAs(Map.of("id", "u1", "role", "customer"));
        Map<String, Object> purchase = Map.of("bookId", "b3", "qty", 2);

        customer.command("buy", purchase, null, "purchase-0001-first");
        now.set(day - 1);
        customer.command("buy", purchase, null, "purchase-0001-first");
        assertEquals(5, store.book("b3").orElseThrow().stock());

        now.set(day);
        customer.command("buy", purchase, null, "purchase-0001-first");
        assertEquals(3, store.book("b3").orElseThrow().stock());
    }
    // #endregion test-clock
}
