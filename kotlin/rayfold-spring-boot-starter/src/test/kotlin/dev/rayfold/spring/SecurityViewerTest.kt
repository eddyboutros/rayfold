package dev.rayfold.spring

import dev.rayfold.spring.properties.PropertiesApplication
import dev.rayfold.spring.properties.RunningApplication
import jakarta.servlet.http.HttpServletRequest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.core.annotation.Order
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.security.authentication.AnonymousAuthenticationToken
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.config.Customizer
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.core.GrantedAuthority
import org.springframework.security.core.authority.FactorGrantedAuthority
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.core.userdetails.User
import org.springframework.security.core.userdetails.UserDetailsService
import org.springframework.security.provisioning.InMemoryUserDetailsManager
import org.springframework.security.web.SecurityFilterChain
import org.springframework.test.annotation.DirtiesContext
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger

/**
 * The viewer Spring Security gives a Rayfold server, which is the scope an idempotency record is filed under
 * (spec 12 section 4): a viewer that is not identical from one request to the next files a retry under another scope,
 * and the command runs a second time instead of replaying.
 */
class SecurityViewerResolverTest {
    private val resolver = SecurityViewerConfiguration().rayfoldViewerResolver()
    private val request: HttpServletRequest = MockHttpServletRequest()

    @AfterEach
    fun clearAuthentication() = SecurityContextHolder.clearContext()

    /** The viewer for a caller holding [authorities], in the order given. */
    private fun viewer(vararg authorities: GrantedAuthority): Any? {
        SecurityContextHolder.getContext().authentication = UsernamePasswordAuthenticationToken.authenticated("u1", null, authorities.toList())
        return resolver.viewer(request)
    }

    private val role = SimpleGrantedAuthority("ROLE_customer")
    private val staff = SimpleGrantedAuthority("ROLE_staff")

    /** As Spring Security grants it: a factor carries the instant it was issued, so it hashes differently every time. */
    private fun factor() = FactorGrantedAuthority.fromAuthority(FactorGrantedAuthority.PASSWORD_AUTHORITY)

    @Test
    fun `the same authorities in another order are the same viewer`() {
        // Spring Security keeps authorities in whatever order the provider built them, and a set holding a factor
        // reorders itself between requests: the viewer must not carry that order through to the scope
        assertThat(viewer(role, staff, factor()))
            .isEqualTo(viewer(factor(), staff, role))
    }

    @Test
    fun `a caller holding other authorities is another viewer`() {
        // guard: sorting settles the order, it does not flatten callers into one another
        assertThat(viewer(role, factor()))
            .isNotEqualTo(viewer(role, staff, factor()))
    }

    @Test
    fun `the viewer carries the id, every role, the first of them and every authority`() {
        assertThat(viewer(staff, role, factor())).isEqualTo(
            mapOf(
                "id" to "u1",
                "roles" to listOf("customer", "staff"),
                "role" to "customer",
                "authorities" to listOf("FACTOR_PASSWORD", "ROLE_customer", "ROLE_staff"),
            ),
        )
    }

    @Test
    fun `a caller who has not signed in has no viewer at all`() {
        assertThat(resolver.viewer(request)).describedAs("no authentication").isNull()
        SecurityContextHolder.getContext().authentication = AnonymousAuthenticationToken("key", "anonymous", listOf(SimpleGrantedAuthority("ROLE_ANONYMOUS")))
        assertThat(resolver.viewer(request)).describedAs("anonymous").isNull()
    }
}

/** An application whose Rayfold endpoint is behind Spring Security, with the starter resolving the viewer itself. */
@TestConfiguration(proxyBeanMethods = false)
class SignedInShop {
    val sales = AtomicInteger()

    /**
     * Ahead of [PropertiesApplication]'s own chain, and only for the endpoint: HTTP Basic grants a factor authority
     * beside the role, which is the case the scope of an idempotency record has to survive.
     */
    @Bean
    @Order(0)
    fun rayfoldSecurity(http: HttpSecurity): SecurityFilterChain = http
        .securityMatcher("/rayfold/**")
        .authorizeHttpRequests { it.anyRequest().permitAll() }
        .httpBasic(Customizer.withDefaults())
        // Rayfold checks the Origin and the content type of every request that can change data itself
        .csrf { it.disable() }
        .build()

    @Bean
    fun users(): UserDetailsService =
        InMemoryUserDetailsManager(User.withUsername("u1").password("{noop}pw").roles("customer").build())

    @Bean
    fun shop(): Shop = Shop(sales)

    class Shop(private val sales: AtomicInteger) {
        @RayfoldCommand("buy")
        fun buy(@Arg("id") id: String, @Arg("qty") qty: Int): Map<String, Any> = mapOf("id" to id, "title" to "The Dispossessed", "stock" to sales.addAndGet(qty))
    }
}

/** The whole path the example's flaky purchase takes: Spring Security, the starter's own resolver, and the store. */
@SpringBootTest(classes = [PropertiesApplication::class, SignedInShop::class], webEnvironment = WebEnvironment.RANDOM_PORT, properties = ["rayfold.schema=classpath:schema.rayfold"])
@DirtiesContext
class SecurityViewerHttpTest : RunningApplication() {
    @field:Autowired
    lateinit var shop: SignedInShop

    private val body = """{"ops":[{"id":1,"op":"buy","args":{"id":"b1","qty":1},"key":"starter-key-0000002","shape":"{ id stock }"}]}"""
    private val basic = "Basic " + Base64.getEncoder().encodeToString("u1:pw".toByteArray())

    private fun buy(): JsonObject =
        frames(send("POST", "/rayfold", body, mapOf("Content-Type" to "application/rayfold+json", "Authorization" to basic))).single().jsonObject

    @Test
    fun `a signed-in caller's keyed command replays on retry and sells once`() {
        val first = buy()
        val retry = buy()
        assertThat(first["ok"]).isEqualTo(json("""{"${'$'}type":"Book","id":"b1","stock":1}"""))
        val firstMeta = first["meta"] as? JsonObject ?: JsonObject(emptyMap())
        assertThat(retry).isEqualTo(JsonObject(first + ("meta" to JsonObject(firstMeta + ("replay" to JsonPrimitive(true))))))
        assertThat(shop.sales.get()).describedAs("the command ran once").isEqualTo(1)
    }
}
