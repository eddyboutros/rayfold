package dev.rayfold.java

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import dev.rayfold.core.Instrumentation
import dev.rayfold.core.BatchOptions
import dev.rayfold.core.Code
import dev.rayfold.core.CommandResult
import dev.rayfold.core.HttpOptions
import dev.rayfold.core.IdempotencyStore
import dev.rayfold.core.ManifestMode
import dev.rayfold.core.MemoryIdempotencyStore
import dev.rayfold.core.RayfoldContext
import dev.rayfold.core.RayfoldException
import dev.rayfold.core.RayfoldHttp
import dev.rayfold.core.RayfoldSchemaIR
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Relay
import dev.rayfold.core.Resolvers
import dev.rayfold.core.RootResolver
import dev.rayfold.core.SchemaText
import dev.rayfold.core.UploadOptions
import dev.rayfold.core.UploadStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.future.await
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.util.concurrent.Callable
import java.util.concurrent.CompletionStage
import java.util.function.Consumer
import java.util.function.Function
import dev.rayfold.core.FieldLoader as CoreFieldLoader
import dev.rayfold.core.StreamResolver as CoreStreamResolver

/** A query resolver: return a record, a map, a list, or null. */
fun interface QueryResolver {
    @Throws(Exception::class)
    fun resolve(args: Values, ctx: Context): Any?
}

/** A command resolver: return the result, or `Rayfold.result(value)` to add cache patches and events. */
fun interface CommandResolver {
    @Throws(Exception::class)
    fun resolve(args: Values, ctx: Context): Any?
}

/** A query or command resolver that answers later. A failed stage fails the operation with its cause. */
fun interface AsyncResolver {
    @Throws(Exception::class)
    fun resolve(args: Values, ctx: Context): CompletionStage<*>
}

/**
 * A batch loader for one field: called once per nesting level with every parent object, it returns one value per
 * parent, in the same order. This is what keeps N+1 queries out.
 */
fun interface FieldLoader {
    @Throws(Exception::class)
    fun load(parents: List<Values>, args: Values, ctx: Context): List<*>
}

fun interface AsyncFieldLoader {
    @Throws(Exception::class)
    fun load(parents: List<Values>, args: Values, ctx: Context): CompletionStage<out List<*>>
}

/** A stream: each element of the Java stream becomes one frame. The stream is closed when the client stops. */
fun interface StreamResolver {
    @Throws(Exception::class)
    fun open(args: Values, ctx: Context): java.util.stream.Stream<*>
}

/** A command's result together with cache patches and events: `return Rayfold.result(order).emit("OrderPlaced", payload);` */
class CommandOutcome internal constructor(private val value: Any?) {
    private val patch = mutableListOf<JsonObject>()
    private val events = mutableListOf<Pair<String, JsonObject>>()

    /** Tells every client that these fields of an entity changed: `set("Book:b1", Map.of("stock", 4))`. */
    fun set(entityKey: String, fields: Map<String, *>): CommandOutcome = apply {
        patch.add(buildJsonObject { put("set", entityKey); put("value", JavaJson.toJson(fields)) })
    }

    /** Tells every client that an entity is gone. */
    fun delete(entityKey: String): CommandOutcome = apply { patch.add(buildJsonObject { put("del", entityKey) }) }

    /** Tells every client to fetch these queries again. */
    fun invalidate(vararg queries: String): CommandOutcome = apply { patch.add(buildJsonObject { put("invOp", JavaJson.toJson(queries.toList())) }) }

    /** Publishes an event the operation declares with `emits`. */
    fun emit(event: String, payload: Map<String, *>): CommandOutcome = apply {
        events.add(event to (JavaJson.toJson(payload) as? JsonObject ?: JsonObject(emptyMap())))
    }

    internal fun toResult(): CommandResult = CommandResult(JavaJson.toJson(value), patch.toList(), events.toList())
}

/**
 * The Java entry point.
 *
 * ```java
 * RayfoldServer server = Rayfold.server(schemaText)
 *     .query("book", (args, ctx) -> books.get(args.getString("id")))
 *     .command("restock", (args, ctx) -> restock(args.getString("id"), args.getInt("qty")))
 *     .build();
 * HttpServer http = Rayfold.http(server).viewer(exchange -> userOf(exchange)).start(8080);
 * ```
 */
object Rayfold {
    /** A server for `.rayfold` schema text. Throws when the schema does not parse or validate. */
    @JvmStatic
    fun server(schemaText: String): ServerBuilder = ServerBuilder(SchemaText.load(schemaText).ir)

    @JvmStatic
    fun server(schema: RayfoldSchemaIR): ServerBuilder = ServerBuilder(schema)

    /** The built-in HTTP server (the JDK's), configured step by step. */
    @JvmStatic
    fun http(server: RayfoldServer): HttpBuilder = HttpBuilder(server)

    /** A command result with room for cache patches and events. */
    @JvmStatic
    fun result(value: Any?): CommandOutcome = CommandOutcome(value)

    /** A declared error (`throws OutOfStock { available: Int }`) to throw from a resolver; clients receive it typed. */
    @JvmStatic
    @JvmOverloads
    fun domainError(type: String, data: Any? = null, message: String = type): RayfoldException =
        RayfoldException.domain(type, JavaJson.toJson(data ?: emptyMap<String, Any?>()), message)

    /** A protocol error to throw from a resolver, such as `error(Code.NOT_FOUND, "No book b9")`. */
    @JvmStatic
    fun error(code: Code, message: String): RayfoldException = RayfoldException(code, message)

    /** JSON for a Java value, as resolvers' results are converted. */
    @JvmStatic
    fun toJson(value: Any?): JsonElement = JavaJson.toJson(value)

    /** Plain Java (String, Boolean, Long, Double, Map, List) for JSON. */
    @JvmStatic
    fun fromJson(json: JsonElement?): Any? = JavaJson.fromJson(json)

    /** Plain Java for JSON text. */
    @JvmStatic
    fun parseJson(text: String): Any? = JavaJson.fromJson(Json.parseToJsonElement(text))
}

/** Collects resolvers and builds the [RayfoldServer]. Registering a resolver the schema does not declare fails at once. */
class ServerBuilder internal constructor(private val ir: RayfoldSchemaIR) {
    private val queries = linkedMapOf<String, RootResolver>()
    private val commands = linkedMapOf<String, suspend (JsonObject, RayfoldContext) -> Any?>()
    private val streams = linkedMapOf<String, CoreStreamResolver>()
    private val fields = linkedMapOf<String, MutableMap<String, CoreFieldLoader>>()
    private var options = BatchOptions()
    private var idempotency: IdempotencyStore = MemoryIdempotencyStore()
    private var instrumentation: Instrumentation = Instrumentation.NONE
    private var relay: Relay? = null
    private var onRelayError: Consumer<Throwable> = Consumer {}

    private fun op(name: String, kind: String): String {
        val op = ir.ops[name] ?: throw IllegalArgumentException("The schema has no operation $name")
        require(op.kind == kind) { "$name is a ${op.kind} in the schema, not a $kind" }
        return name
    }

    private fun fieldsOf(type: String, field: String): MutableMap<String, CoreFieldLoader> {
        val t = ir.types[type] ?: throw IllegalArgumentException("The schema has no type $type")
        require(t.fields.any { it.name == field }) { "The schema has no field $type.$field" }
        return fields.getOrPut(type) { linkedMapOf() }
    }

    private fun outcome(v: Any?): CommandResult = (v as? CommandOutcome)?.toResult() ?: CommandResult(JavaJson.toJson(v))

    private fun aligned(type: String, field: String, parents: Int, values: List<*>): List<JsonElement?> {
        check(values.size == parents) { "$type.$field loader returned ${values.size} values for $parents parents" }
        return values.map { JavaJson.toJson(it) }
    }

    fun query(name: String, resolver: QueryResolver): ServerBuilder = apply {
        queries[op(name, "query")] = { args, ctx -> JavaJson.toJson(resolver.resolve(Values(args), Context(ctx))) }
    }

    fun queryAsync(name: String, resolver: AsyncResolver): ServerBuilder = apply {
        queries[op(name, "query")] = { args, ctx -> JavaJson.toJson(resolver.resolve(Values(args), Context(ctx)).await()) }
    }

    fun command(name: String, resolver: CommandResolver): ServerBuilder = apply {
        commands[op(name, "command")] = { args, ctx -> outcome(resolver.resolve(Values(args), Context(ctx))) }
    }

    fun commandAsync(name: String, resolver: AsyncResolver): ServerBuilder = apply {
        commands[op(name, "command")] = { args, ctx -> outcome(resolver.resolve(Values(args), Context(ctx)).await()) }
    }

    fun field(type: String, field: String, loader: FieldLoader): ServerBuilder = apply {
        fieldsOf(type, field)[field] = { parents, args, ctx -> aligned(type, field, parents.size, loader.load(parents.map(::Values), Values(args), Context(ctx))) }
    }

    fun fieldAsync(type: String, field: String, loader: AsyncFieldLoader): ServerBuilder = apply {
        fieldsOf(type, field)[field] = { parents, args, ctx ->
            aligned(type, field, parents.size, loader.load(parents.map(::Values), Values(args), Context(ctx)).await())
        }
    }

    fun stream(name: String, resolver: StreamResolver): ServerBuilder = apply {
        streams[op(name, "stream")] = { args, ctx ->
            flow { resolver.open(Values(args), Context(ctx)).use { s -> for (item in s.iterator()) emit(JavaJson.toJson(item)) } }.flowOn(Dispatchers.IO)
        }
    }

    /** Limits and production settings: cost budget, trusted shapes, maximum depth. */
    fun options(options: BatchOptions): ServerBuilder = apply { this.options = options }

    /** Where command results are kept for idempotent retries. The default keeps them in memory. */
    fun idempotencyStore(store: IdempotencyStore): ServerBuilder = apply { idempotency = store }

    /** Hooks around batches, ops and loaders, for tracing: `RayfoldOpenTelemetry` from module rayfold-opentelemetry. */
    fun instrumentation(instrumentation: Instrumentation): ServerBuilder = apply { this.instrumentation = instrumentation }

    /** Carries changes and events between the instances of this application, so live queries and streams on each hear the others. */
    fun relay(relay: Relay): ServerBuilder = apply { this.relay = relay }

    /** Called when the relay refuses a message; what it carried already happened on this instance. */
    fun onRelayError(handler: Consumer<Throwable>): ServerBuilder = apply { onRelayError = handler }

    fun build(): RayfoldServer = RayfoldServer(
        ir, Resolvers(queries, commands, streams, fields), options, idempotency, instrumentation,
        relay = relay, onRelayError = { onRelayError.accept(it) },
    )
}

/** The built-in HTTP server, configured for Java callers. */
class HttpBuilder internal constructor(private val server: RayfoldServer) {
    private var options = HttpOptions()
    private var viewer: (HttpExchange) -> JsonElement = { JsonNull }

    /** Origins (such as `https://app.example`) allowed to send requests that change data. */
    fun allowedOrigins(vararg origins: String): HttpBuilder = apply { options = options.copy(allowedOrigins = origins.toSet()) }

    /** Host names the server answers to; by default a loopback server answers only loopback names. */
    fun allowedHosts(vararg hosts: String): HttpBuilder = apply { options = options.copy(allowedHosts = hosts.toSet()) }

    fun manifest(mode: ManifestMode): HttpBuilder = apply { options = options.copy(manifest = mode) }

    fun maxBodyBytes(bytes: Int): HttpBuilder = apply { options = options.copy(maxBodyBytes = bytes) }

    fun threads(threads: Int): HttpBuilder = apply { options = options.copy(threads = threads) }

    /**
     * A dependency `GET {path}/ready` checks, by name: the callable returns when it answers and throws when it does not.
     * A failure, or no answer within [readinessTimeout], names the check in the reasons the server is not ready.
     */
    fun readiness(name: String, check: Callable<*>): HttpBuilder = apply {
        options = options.copy(readiness = options.readiness + (name to { check.call(); Unit }))
    }

    fun readinessTimeout(millis: Long): HttpBuilder = apply { options = options.copy(readinessTimeoutMs = millis) }

    /**
     * Serves `POST {path}/uploads` (spec 04 section 9) with [store] behind it: bytes arrive on their own route and a
     * command names what arrived. Without a store that route is not there at all.
     */
    @JvmOverloads
    fun uploads(store: UploadStore, maxBytes: Long = 25L * 1024 * 1024, viewerRequired: Boolean = true): HttpBuilder =
        apply { options = options.copy(uploads = UploadOptions(store, maxBytes, viewerRequired)) }

    /** Turns a request into the viewer the schema's policies see (a map or a record), or null when anonymous. */
    fun viewer(resolve: Function<HttpExchange, Any?>): HttpBuilder = apply { viewer = { ex -> JavaJson.toJson(resolve.apply(ex)) } }

    /**
     * Serves the explorer at `{path}/explorer`, with [title] in its header. Off unless called: the page reads whatever
     * the viewer's token allows (see [HttpOptions.explorer]).
     */
    @JvmOverloads
    fun explorer(title: String? = null): HttpBuilder = apply { options = options.copy(explorer = true, explorerTitle = title) }

    /** Starts listening on loopback; pass host "0.0.0.0" to listen on every interface. Throws when the port cannot be bound. */
    @JvmOverloads
    @Throws(IOException::class)
    fun start(port: Int, path: String = "/rayfold", host: String = "127.0.0.1"): HttpServer = RayfoldHttp(server, options, viewer).start(port, path, host)
}
