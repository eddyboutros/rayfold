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
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.test.annotation.DirtiesContext;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowableOfType;

/** The application without a network: the server Spring built, called in the test's own process. */
// #region test-setup
// no port is opened: the starter builds the server for any servlet application, and the default mock one is enough
@SpringBootTest
// a fresh application for every test, so no test sees another's purchases
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_EACH_TEST_METHOD)
class BookshopUnitTest {
    // the server the starter built from the schema and the annotated resolvers
    @Autowired
    RayfoldServer server;

    @Autowired
    Store store;

    RayfoldTest anyone;
    RayfoldTest customer;
    RayfoldTest staff;

    @BeforeEach
    void callers() {
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
        assertThat(book).isEqualTo(Map.of("$type", "Book", "title", "A Wizard of Earthsea", "stock", 3L,
            "author", Map.of("$type", "Author", "name", "Ursula K. Le Guin")));
        assertThat(store.authorLookups()).isEqualTo(1);
    }
    // #endregion test-resolver

    // #region test-policy
    @Test
    void aCustomerMayNotRestockAndStaffMay() {
        var refused = catchThrowableOfType(RayfoldException.class,
            () -> customer.command("restock", Map.of("bookId", "b2", "qty", 5)));
        assertThat(refused.getCode()).isEqualTo(Code.PERMISSION_DENIED);
        assertThat(store.book("b2").orElseThrow().stock()).isZero();

        Map<String, Object> restocked = staff.command("restock", Map.of("bookId", "b2", "qty", 5), "{ id stock }");
        assertThat(restocked).isEqualTo(Map.of("$type", "Book", "id", "b2", "stock", 5L));
        assertThat(store.book("b2").orElseThrow().stock()).isEqualTo(5);
    }
    // #endregion test-policy

    @Test
    void buyingWithoutSigningInIsRefusedAndCostPriceIsForStaffAlone() {
        var anonymous = catchThrowableOfType(RayfoldException.class, () -> anyone.command("buy", Map.of("bookId", "b1")));
        assertThat(anonymous.getCode()).isEqualTo(Code.UNAUTHENTICATED);
        // the schema's policy refused it, before the rule that a keyed command needs a caller could
        assertThat(anonymous.getMessage()).isEqualTo("Sign in to access buy()");
        assertThat(store.book("b1").orElseThrow().stock()).isEqualTo(3);

        var asked = catchThrowableOfType(RayfoldException.class, () -> customer.query("book", Map.of("id", "b1"), "{ title costPrice }"));
        assertThat(asked.getCode()).isEqualTo(Code.PERMISSION_DENIED);
        assertThat(asked.getPath()).isEqualTo("costPrice");
        // guard: the same question from staff is answered
        Map<String, Object> answered = staff.query("book", Map.of("id", "b1"), "{ title costPrice }");
        assertThat(answered).isEqualTo(Map.of("$type", "Book", "title", "A Wizard of Earthsea", "costPrice", "4.20"));
    }

    @Test
    void aPurchaseOfABookTheShopDoesNotHaveIsNotFoundAndASaleSaysWhatItChanged() {
        var missing = catchThrowableOfType(RayfoldException.class, () -> customer.command("buy", Map.of("bookId", "b9")));
        assertThat(missing.getCode()).isEqualTo(Code.NOT_FOUND);
        assertThat(missing.getMessage()).isEqualTo("No book b9");

        // guard: a book the shop has is sold, and the StockChanged the schema declares is emitted with its new stock
        List<Object> emitted = new ArrayList<>();
        server.getEvents().on("StockChanged", event -> {
            emitted.add(Rayfold.fromJson(event));
            return Unit.INSTANCE;
        });
        customer.command("buy", Map.of("bookId", "b3", "qty", 2));
        assertThat(emitted).isEqualTo(List.of(Map.of("bookId", "b3", "stock", 5L, "seq", 1L)));
    }

    // #region test-error
    @Test
    void buyingMoreThanTheShelfHoldsFailsWithOutOfStockAndChangesNothing() {
        var error = catchThrowableOfType(RayfoldException.class,
            () -> customer.command("buy", Map.of("bookId", "b1", "qty", 5)));
        assertThat(error.getCode()).isEqualTo(Code.DOMAIN);
        assertThat(error.getType()).isEqualTo("OutOfStock");
        assertThat(Rayfold.fromJson(error.getData())).isEqualTo(Map.of("bookId", "b1", "available", 3L));
        assertThat(error.getMessage()).isEqualTo("Only 3 left of A Wizard of Earthsea");
        assertThat(store.book("b1").orElseThrow().stock()).isEqualTo(3);

        // guard: what the shelf holds can be bought
        customer.command("buy", Map.of("bookId", "b1", "qty", 3));
        assertThat(store.book("b1").orElseThrow().stock()).isZero();
    }
    // #endregion test-error

    // #region test-replay
    @Test
    void aPurchaseRetriedWithTheSameKeySellsOnce() {
        Map<String, Object> purchase = Map.of("bookId", "b3", "qty", 2);
        String key = "purchase-0001-first";
        Map<String, Object> first = customer.command("buy", purchase, "{ id stock }", key);
        assertThat(first).isEqualTo(Map.of("$type", "Book", "id", "b3", "stock", 5L));

        // frames() returns what the server sent as it sent it, where command() returns the result alone
        List<Map<String, Object>> retry = customer.frames("buy", purchase, "{ id stock }", key);
        assertThat(retry).as("one frame, the replay").hasSize(1);
        assertThat(retry.getFirst().get("ok")).isEqualTo(first);
        assertThat(retry.getFirst().get("meta")).isEqualTo(Map.of("cost", 1L, "replay", true));
        assertThat(store.book("b3").orElseThrow().stock()).isEqualTo(5);

        // guard: without a key of its own each call gets a fresh one, so this is a new purchase
        customer.command("buy", purchase);
        assertThat(store.book("b3").orElseThrow().stock()).isEqualTo(3);
    }
    // #endregion test-replay

    // #region test-live
    @Test
    void aLiveQueryGetsTheNewStockWhenSomeoneBuys() {
        try (LiveQuery<Object> book = anyone.live("book", Map.of("id", "b3"), "{ id stock }")) {
            assertThat(book.next()).isEqualTo(Map.of("$type", "Book", "id", "b3", "stock", 7L));

            customer.command("buy", Map.of("bookId", "b3", "qty", 2));
            // next() waits 5 s at most, and fails the test when nothing came
            assertThat(book.next()).isEqualTo(Map.of("$type", "Book", "id", "b3", "stock", 5L));
        }
        // closed, the query holds nothing on the server
        assertThat(server.getChanges().getSize()).isZero();
    }
    // #endregion test-live

    // #region test-clock
    // the server tells the time by the application's Clock bean: here one that reads the time the test set
    @TestConfiguration
    static class TestClock {
        @Bean
        SetClock clock() { return new SetClock(); }
    }

    @Autowired
    SetClock clock;

    @Test
    void aRetryIsAnsweredFromTheFirstPurchaseForADayAndIsANewPurchaseAfterIt() {
        long day = Duration.ofDays(1).toMillis();
        Map<String, Object> purchase = Map.of("bookId", "b3", "qty", 2);
        customer.command("buy", purchase, null, "purchase-0001-first");

        clock.millis.set(day - 1);
        customer.command("buy", purchase, null, "purchase-0001-first");
        assertThat(store.book("b3").orElseThrow().stock()).isEqualTo(5);

        clock.millis.set(day);
        customer.command("buy", purchase, null, "purchase-0001-first");
        assertThat(store.book("b3").orElseThrow().stock()).isEqualTo(3);
    }
    // #endregion test-clock

    /** A real {@link Clock}, at epoch millisecond 0 until the test sets it, so {@code millis()} and {@code instant()} agree. */
    static final class SetClock extends Clock {
        final AtomicLong millis = new AtomicLong();

        @Override
        public Instant instant() {
            return Instant.ofEpochMilli(millis.get());
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }
    }
}
