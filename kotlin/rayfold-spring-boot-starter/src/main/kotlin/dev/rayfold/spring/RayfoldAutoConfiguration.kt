package dev.rayfold.spring

import dev.rayfold.core.BatchOptions
import dev.rayfold.core.HttpCall
import dev.rayfold.core.HttpOptions
import dev.rayfold.core.IdempotencyStore
import dev.rayfold.core.Instrumentation
import dev.rayfold.core.ManifestMode
import dev.rayfold.core.RayfoldHttp
import dev.rayfold.core.RayfoldSchemaIR
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Relay
import dev.rayfold.core.SchemaText
import dev.rayfold.java.Rayfold
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import kotlinx.coroutines.runBlocking
import org.apache.commons.logging.LogFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.boot.autoconfigure.AutoConfiguration
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.ApplicationContext
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.ApplicationListener
import org.springframework.context.annotation.Import
import org.springframework.context.event.ContextClosedEvent
import org.springframework.core.Ordered
import org.springframework.core.io.ResourceLoader
import org.springframework.security.authentication.AnonymousAuthenticationToken
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.web.HttpRequestHandler
import org.springframework.web.servlet.handler.SimpleUrlHandlerMapping
import org.springframework.web.util.UriUtils
import tools.jackson.databind.ObjectMapper
import tools.jackson.databind.json.JsonMapper
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress

/** `rayfold.*` settings. */
@ConfigurationProperties("rayfold")
class RayfoldProperties {
    /** The schema: `.rayfold` text, or the IR as `.json`. */
    var schema: String = "classpath:schema.rayfold"

    /** Where the endpoint lives. */
    var path: String = "/rayfold"

    /** Origins (such as `https://app.example`) allowed to send requests that change data, besides the server's own. */
    var allowedOrigins: List<String> = emptyList()

    /** Host names the endpoint answers to; by default a loopback server answers only loopback names. */
    var allowedHosts: List<String>? = null

    /** What `{path}/manifest` serves: off, redacted (no policy expressions) or full. */
    var manifest: ManifestMode = ManifestMode.REDACTED

    var maxBodyBytes: Int = 1024 * 1024

    /** Production mode: only shapes registered at startup are accepted. */
    var trustedShapes: Boolean = false

    /** Cost budget per batch. */
    var budget: Int = 1000

    var maxDepth: Int = 8

    /** Serve the WebSocket transport at `{path}/ws` on the application's port; needs spring-boot-starter-websocket. */
    var websocket: Boolean = true

    /** The explorer at `{path}/explorer`. */
    var explorer: ExplorerProperties = ExplorerProperties()
}

/** `rayfold.explorer.*` settings. */
class ExplorerProperties {
    /**
     * Serve the explorer at `{path}/explorer`. Off by default: the page reads whatever the viewer's token allows, so
     * turn it on where the application's own security already stands in front of it, or only in development.
     */
    var enabled: Boolean = false

    /** Shown in the explorer's header, to tell one service from another. */
    var title: String? = null
}

/** Turns a request into the viewer the schema's policies see: a map or a record with at least `id`, or null when anonymous. */
fun interface RayfoldViewerResolver {
    fun viewer(request: HttpServletRequest): Any?
}

/**
 * Serves the application's Rayfold schema at `rayfold.path` (default `/rayfold`) in Spring MVC. Resolvers are
 * annotated methods on any bean (`@RayfoldQuery`, `@RayfoldCommand`, `@RayfoldStream`, `@RayfoldField`). Every bean
 * here backs off when the application defines its own.
 */
@AutoConfiguration
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@EnableConfigurationProperties(RayfoldProperties::class)
@Import(SecurityViewerConfiguration::class)
class RayfoldAutoConfiguration {
    private val log = LogFactory.getLog(RayfoldAutoConfiguration::class.java)

    @Bean
    @ConditionalOnMissingBean
    fun rayfoldSchema(properties: RayfoldProperties, resources: ResourceLoader): RayfoldSchemaIR {
        val resource = resources.getResource(properties.schema)
        check(resource.exists()) { "Rayfold schema not found at ${properties.schema} (set rayfold.schema)" }
        val text = resource.inputStream.use { String(it.readAllBytes(), Charsets.UTF_8) }
        return if (properties.schema.endsWith(".json")) RayfoldSchemaIR.parse(text) else SchemaText.load(text).ir
    }

    @Bean
    @ConditionalOnMissingBean
    fun rayfoldServer(
        schema: RayfoldSchemaIR,
        properties: RayfoldProperties,
        context: ApplicationContext,
        mapper: ObjectProvider<ObjectMapper>,
        instrumentation: ObjectProvider<Instrumentation>,
        idempotency: ObjectProvider<IdempotencyStore>,
        relay: ObjectProvider<Relay>,
    ): RayfoldServer {
        val builder = Rayfold.server(schema).options(BatchOptions(trustedShapes = properties.trustedShapes, budget = properties.budget, maxDepth = properties.maxDepth))
        // an Instrumentation bean, such as RayfoldOpenTelemetry(openTelemetry), traces every batch
        instrumentation.ifAvailable { builder.instrumentation(it) }
        // an IdempotencyStore bean, such as JdbcIdempotencyStore, keeps commands running once across every instance
        idempotency.ifAvailable { builder.idempotencyStore(it) }
        // a Relay bean, such as PgRelay, lets live queries and streams on every instance hear the others' commands
        relay.ifAvailable { builder.relay(it) }
        val bound = AnnotatedResolvers(context, mapper.getIfAvailable { JsonMapper.builder().build() }, schema).bindTo(builder)
        log.info("Rayfold at ${properties.path}: ${bound.size} resolvers bound" + bound.joinToString("") { "\n  $it" })
        return builder.build()
    }

    @Bean
    @ConditionalOnMissingBean
    fun rayfoldHttp(server: RayfoldServer, properties: RayfoldProperties): RayfoldHttp = RayfoldHttp(
        server,
        HttpOptions(
            allowedOrigins = properties.allowedOrigins.toSet(),
            allowedHosts = properties.allowedHosts?.toSet(),
            manifest = properties.manifest,
            maxBodyBytes = properties.maxBodyBytes,
            explorer = properties.explorer.enabled,
            explorerTitle = properties.explorer.title,
        ),
    )

    @Bean
    @ConditionalOnMissingBean
    fun rayfoldViewerResolver(): RayfoldViewerResolver = RayfoldViewerResolver { null }

    /** On context close, before the web server stops: drain, so a SIGTERM to the application is a rolling deploy's shutdown. */
    @Bean
    fun rayfoldLifecycle(server: RayfoldServer): RayfoldLifecycle = RayfoldLifecycle(server)

    @Bean
    fun rayfoldHandlerMapping(http: RayfoldHttp, properties: RayfoldProperties, viewer: RayfoldViewerResolver): SimpleUrlHandlerMapping {
        val base = properties.path.trimEnd('/')
        val handler = HttpRequestHandler { request, response ->
            http.serve(ServletCall(request, response), request.contextPath + base) { Rayfold.toJson(viewer.viewer(request)) }
        }
        return SimpleUrlHandlerMapping(mapOf(base to handler, "$base/**" to handler)).apply { order = Ordered.HIGHEST_PRECEDENCE + 10 }
    }
}

/**
 * Drains the server when the context closes. The closed event goes out before any lifecycle bean stops, so this runs
 * while the web server still answers: readiness turns false, live queries and streams are sent elsewhere, batches in
 * flight get [drainTimeoutMs] to finish, the relay is left, and only then does the web server close its port.
 */
class RayfoldLifecycle(private val server: RayfoldServer, private val drainTimeoutMs: Long = 10_000) : ApplicationListener<ContextClosedEvent> {
    override fun onApplicationEvent(event: ContextClosedEvent) {
        runBlocking {
            server.drain(drainTimeoutMs)
            server.close()
        }
    }
}

/**
 * The viewer from Spring Security: `id` is the user name, `roles` the ROLE_ authorities without the prefix, `role` the
 * first of them, and `authorities` every authority as Spring Security grants it (FACTOR_PASSWORD, SCOPE_read, ...).
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnClass(name = ["org.springframework.security.core.context.SecurityContextHolder"])
class SecurityViewerConfiguration {
    @Bean
    @ConditionalOnMissingBean
    fun rayfoldViewerResolver(): RayfoldViewerResolver = RayfoldViewerResolver {
        val auth = SecurityContextHolder.getContext().authentication
        if (auth == null || !auth.isAuthenticated || auth is AnonymousAuthenticationToken) {
            null
        } else {
            // sorted before anything is derived from them: Spring Security's order can change from one request to the next
            // (a FACTOR_ authority hashes differently each time), and the viewer is the scope of idempotency records, so a
            // retry must see the same roles, the same first role and the same authorities
            val authorities = auth.authorities.mapNotNull { it.authority }.sorted()
            val roles = authorities.filter { it.startsWith("ROLE_") }.map { it.removePrefix("ROLE_") }
            mapOf("id" to auth.name, "roles" to roles, "role" to roles.firstOrNull(), "authorities" to authorities)
        }
    }
}

/** A servlet request and response as an [HttpCall]. */
internal class ServletCall(private val req: HttpServletRequest, private val res: HttpServletResponse) : HttpCall {
    override val method: String get() = req.method
    override val path: String get() = UriUtils.decode(req.requestURI, Charsets.UTF_8)
    override val rawQuery: String? get() = req.queryString
    override fun header(name: String): String? = req.getHeader(name)
    override val body: InputStream get() = req.inputStream

    override val secure: Boolean get() = req.isSecure

    // the local address is a literal IP, so this does no name lookup
    override val localAddress: InetAddress? get() = req.localAddr?.let { runCatching { InetAddress.getByName(it) }.getOrNull() }

    override fun setHeader(name: String, value: String) = res.setHeader(name, value)

    override fun respond(status: Int, length: Long): OutputStream {
        res.status = status
        if (length >= 0) res.setContentLengthLong(length)
        return res.outputStream
    }

    override fun abort() {
        runCatching { res.outputStream.close() }
    }
}
