package dev.rayfold.spring.outcomes;

import dev.rayfold.core.Code;
import dev.rayfold.core.MemoryUploadStore;
import dev.rayfold.core.UploadStore;
import dev.rayfold.java.CommandOutcome;
import dev.rayfold.java.Rayfold;
import dev.rayfold.spring.Arg;
import dev.rayfold.spring.RayfoldCommand;
import dev.rayfold.spring.RayfoldField;
import dev.rayfold.spring.RayfoldQuery;
import dev.rayfold.spring.RayfoldStream;
import dev.rayfold.spring.RayfoldViewerResolver;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.IntStream;

/**
 * The binding shapes the shop does not use: resolvers that answer later, commands that answer with patches and
 * events, a stream returned as a list, and an upload store.
 */
@SpringBootApplication
public class OutcomesApplication {
    @Bean
    SecurityFilterChain security(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(a -> a.anyRequest().permitAll()).csrf(c -> c.ignoringRequestMatchers("/rayfold/**")).build();
    }

    @Bean
    RayfoldViewerResolver viewer() {
        return request -> {
            String user = request.getHeader("X-User");
            return user == null ? null : Map.of("id", user);
        };
    }

    /** A fixed id, so the test can name the upload it made; a real store's ids must be unguessable. */
    @Bean
    UploadStore uploads() {
        return new MemoryUploadStore(3_600_000L, 1024L, System::currentTimeMillis, () -> "upload-1");
    }

    @Component
    public static final class Resolvers {
        public record Author(String id, String name) {}

        public record Book(String id, int stock, String authorId) {}

        final Map<String, Book> books = new ConcurrentHashMap<>();
        final AtomicInteger authorLoads = new AtomicInteger();

        public void reset() {
            books.clear();
            books.put("b1", new Book("b1", 3, "a1"));
            books.put("b9", new Book("b9", 1, "boom"));
            authorLoads.set(0);
        }

        public Resolvers() {
            reset();
        }

        @RayfoldQuery("book")
        public Book book(@Arg String id) {
            return books.get(id);
        }

        @RayfoldField(type = "Book", field = "author")
        public CompletableFuture<List<Author>> authors(List<Book> parents) {
            authorLoads.incrementAndGet();
            if (parents.stream().anyMatch(b -> "boom".equals(b.authorId()))) {
                return CompletableFuture.failedFuture(Rayfold.error(Code.UNAVAILABLE, "authors offline"));
            }
            return CompletableFuture.supplyAsync(() -> parents.stream().map(b -> new Author(b.authorId(), "Author " + b.authorId())).toList());
        }

        @RayfoldCommand("restock")
        public CommandOutcome restock(@Arg String id, @Arg int qty) {
            Book b = books.get(id);
            Book next = new Book(id, b.stock() + qty, b.authorId());
            books.put(id, next);
            return Rayfold.result(next).set("Book:b2", Map.of("stock", 9)).invalidate("book").emit("Restocked", Map.of("bookId", id, "qty", qty));
        }

        @RayfoldCommand("reserve")
        public CompletionStage<CommandOutcome> reserve(@Arg String id, @Arg int qty) {
            if (qty < 0) return CompletableFuture.failedFuture(Rayfold.error(Code.FAILED_PRECONDITION, "qty must not be negative"));
            return CompletableFuture.supplyAsync(() -> {
                Book b = books.get(id);
                Book next = new Book(id, b.stock() - qty, b.authorId());
                books.put(id, next);
                return Rayfold.result(next).invalidate("book");
            });
        }

        @RayfoldStream("ticks")
        public List<Integer> ticks(@Arg int n) {
            return IntStream.rangeClosed(1, n).boxed().toList();
        }
    }
}
