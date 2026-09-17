# Java and Spring Boot

| Artifact | For |
|---|---|
| `dev.rayfold:rayfold-java` | A Rayfold server with a Java API: a builder, functional resolver interfaces, records and maps as results. |
| `dev.rayfold:rayfold-spring-boot-starter` | The same inside Spring Boot 4: annotated methods on your beans, Spring MVC, Spring Security. |

Both read `.rayfold` schema files directly. Java 21 or later.

## Plain Java

```xml
<dependency>
  <groupId>dev.rayfold</groupId>
  <artifactId>rayfold-java</artifactId>
  <version>0.1.0</version>
</dependency>
```

```java
import dev.rayfold.java.Rayfold;

record Book(String id, String title, int stock, String authorId) {}
record Author(String id, String name) {}

RayfoldServer server = Rayfold.server(Files.readString(Path.of("schema.rayfold")))
    .query("book", (args, ctx) -> books.get(args.getString("id")))
    .field("Book", "author", (parents, args, ctx) ->
        parents.stream().map(p -> authors.get(p.getString("authorId"))).toList())   // one call for every book
    .command("buy", (args, ctx) -> {
        Book b = books.get(args.getString("id"));
        int qty = args.getInt("qty");
        if (qty > b.stock()) throw Rayfold.domainError("OutOfStock", Map.of("available", b.stock()), "Only " + b.stock() + " left");
        Book next = new Book(b.id(), b.title(), b.stock() - qty, b.authorId());
        books.put(b.id(), next);
        return Rayfold.result(next).emit("Sold", Map.of("bookId", b.id(), "qty", qty));
    })
    .build();

HttpServer http = Rayfold.http(server)
    .allowedOrigins("https://app.example")
    .viewer(exchange -> userOf(exchange))          // a Map or record with "id", or null when anonymous
    .start(8080);
```

- Results can be records, maps, lists, enums, `Optional`, `java.time` values or objects with getters. `BigDecimal`
  travels as exact text, which is how the schema's `Decimal` is sent.
- `args.getString`, `getInt`, `getLong`, `getDouble`, `getBoolean`, `getDecimal`, `getValues` (nested input) and
  `getList` read arguments. `ctx.viewerId()` is the signed-in user.
- `queryAsync`, `commandAsync` and `fieldAsync` take resolvers that return a `CompletionStage`.
- Registering a resolver for an operation or field the schema does not have fails when you call it, not at the first
  request.

## Spring Boot

```xml
<dependency>
  <groupId>dev.rayfold</groupId>
  <artifactId>rayfold-spring-boot-starter</artifactId>
  <version>0.1.0</version>
</dependency>
```

Put the schema at `src/main/resources/schema.rayfold` and annotate methods on any bean:

```java
@Component
public class BookResolvers {
    @RayfoldQuery("book")
    public Book book(@Arg String id) { return books.get(id); }

    @RayfoldField(type = "Book", field = "author")
    public List<Author> author(List<Book> parents) {   // called once per level, for every book
        return parents.stream().map(b -> authors.get(b.authorId())).toList();
    }

    @RayfoldCommand("buy")
    public Book buy(@Arg String id, @Arg int qty, Context ctx) { ... }

    @RayfoldStream("ticks")
    public Stream<Integer> ticks(@Arg int n) { return IntStream.range(0, n).boxed(); }
}
```

The endpoint is at `/rayfold`. Arguments and results go through your application's Jackson mapper, so records,
`java.time` types and Jackson annotations behave as in Spring MVC. Methods may return a `CompletableFuture`. A
parameter can be `@Arg` (named after the parameter), `Values` for all arguments, or `Context`.

Startup fails with a clear message when a method names an operation, field or argument the schema does not have, or
has a parameter nothing can fill.

### Settings

```properties
rayfold.schema=classpath:schema.rayfold
rayfold.path=/rayfold
rayfold.allowed-origins=https://app.example
rayfold.manifest=redacted
rayfold.trusted-shapes=false
rayfold.budget=1000
rayfold.websocket=true
```

### Live queries and WebSocket

Live queries work over the HTTP endpoint as they are: the response stays open and gets keep-alives while nothing
changes. For many batches over one connection, add `spring-boot-starter-websocket`; the starter then serves the
WebSocket transport at `/rayfold/ws` on the application's own port, with the same viewer (from Spring Security) and
the same Origin check. `rayfold.websocket=false` turns it off.

### Tracing

Declare an `Instrumentation` bean, such as `new RayfoldOpenTelemetry(openTelemetry)` from `rayfold-opentelemetry`,
and every batch, op and loader call becomes a span ([Tracing](tracing.md)).

### More than one instance

Idempotency records are kept in memory, so a command retried against another instance runs a second time. Declare an
`IdempotencyStore` bean and the starter hands it to the server; `JdbcIdempotencyStore` from `rayfold-jdbc` keeps the
records in the database, so every instance shares them and a keyed command runs once across the fleet ([JDBC](jdbc.md)).

```java
@Bean
IdempotencyStore idempotency(DataSource dataSource) {
    return new JdbcIdempotencyStore(dataSource::getConnection);
}
```

Declare a `Relay` bean as well and live queries and streams on every instance hear the commands run on the others;
`PgRelay` from `rayfold-jdbc` carries them over Postgres `LISTEN`/`NOTIFY` ([JDBC](jdbc.md#live-updates-across-servers)).

If you serve uploads, the store has to be shared for the same reason: an `UploadStore` bean turns the route on, and
`JdbcUploadStore` puts the bytes where every instance can find them ([Uploads](uploads.md)). Without a bean there is no
upload route at all.

### Who is asking

With Spring Security on the classpath, the viewer is the signed-in user: `id` is the user name, `roles` the `ROLE_`
authorities without the prefix, `role` the first of them, and `authorities` all of them. Policies in the schema
(`@allow(read: viewer.role == "ADMIN")`) see exactly that. Define a `RayfoldViewerResolver` bean to build the viewer
yourself.

Rayfold protects its endpoint against cross-site requests itself: it accepts only JSON bodies and checks the Origin
of every request that can change data. So turn off Spring Security's CSRF token check for that path:

```java
@Bean
SecurityFilterChain security(HttpSecurity http) throws Exception {
    return http
        .authorizeHttpRequests(a -> a.anyRequest().permitAll())
        .httpBasic(Customizer.withDefaults())
        .csrf(c -> c.ignoringRequestMatchers("/rayfold/**"))
        .build();
}
```

## Generated records

```sh
npx @rayfold/cli gen java schema.rayfold --package com.example.api --class Api --out src/main/java/com/example/api/Api.java
```

One file with a record per entity, object, input, error and event, an enum per enum, `Page` and `PageArgs`, and
`Api.Ops` with the operation names and an argument record per operation. Records of union members carry `$type`.
