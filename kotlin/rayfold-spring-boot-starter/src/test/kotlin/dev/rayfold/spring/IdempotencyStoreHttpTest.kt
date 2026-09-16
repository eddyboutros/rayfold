package dev.rayfold.spring

import dev.rayfold.core.IdempotencyClaim
import dev.rayfold.core.IdempotencyRecord
import dev.rayfold.core.IdempotencyStore
import dev.rayfold.core.MemoryIdempotencyStore
import dev.rayfold.spring.properties.PropertiesApplication
import dev.rayfold.spring.properties.RunningApplication
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.test.annotation.DirtiesContext
import java.util.concurrent.atomic.AtomicInteger

/** What an application adds to share command results between its instances: a store bean, here counting what the server asks of it. */
@TestConfiguration(proxyBeanMethods = false)
class KeyedShop {
    val claims = AtomicInteger()
    val records = AtomicInteger()
    val sales = AtomicInteger()
    private val inner = MemoryIdempotencyStore()

    @Bean
    fun sharedIdempotencyStore(): IdempotencyStore = object : IdempotencyStore by inner {
        override fun claim(scope: String, key: String, leaseMs: Long): IdempotencyClaim = inner.claim(scope, key, leaseMs).also { claims.incrementAndGet() }

        override fun put(scope: String, key: String, record: IdempotencyRecord, token: String) {
            records.incrementAndGet()
            inner.put(scope, key, record, token)
        }
    }

    /** The caller named by `X-User`, or anonymous. */
    @Bean
    fun headerViewer(): RayfoldViewerResolver = RayfoldViewerResolver { request -> request.getHeader("X-User")?.let { mapOf("id" to it) } }

    @Bean
    fun shop(): Shop = Shop(sales)

    class Shop(private val sales: AtomicInteger) {
        @RayfoldCommand("buy")
        fun buy(@Arg("id") id: String, @Arg("qty") qty: Int): Map<String, Any> = mapOf("id" to id, "title" to "The Dispossessed", "stock" to sales.addAndGet(qty))
    }
}

/** A keyed command sent twice over the starter's own endpoint replays from the store bean, and the resolver runs once. */
@SpringBootTest(classes = [PropertiesApplication::class, KeyedShop::class], webEnvironment = WebEnvironment.RANDOM_PORT, properties = ["rayfold.schema=classpath:schema.rayfold"])
@DirtiesContext
class IdempotencyStoreHttpTest : RunningApplication() {
    @field:Autowired
    lateinit var shop: KeyedShop

    private val body = """{"ops":[{"id":1,"op":"buy","args":{"id":"b1","qty":1},"key":"starter-key-0000001","shape":"{ id stock }"}]}"""

    private fun buy(user: String?): JsonObject {
        val headers = mapOf("Content-Type" to "application/rayfold+json") + (user?.let { mapOf("X-User" to it) } ?: emptyMap())
        return frames(send("POST", "/rayfold", body, headers)).single().jsonObject
    }

    @Test
    fun `a keyed command sent twice replays from the store bean, and the resolver ran once`() {
        val first = buy("u1")
        val retry = buy("u1")
        assertThat(first["ok"]).isEqualTo(json("""{"${'$'}type":"Book","id":"b1","stock":1}"""))
        val firstMeta = first["meta"] as? JsonObject ?: JsonObject(emptyMap())
        assertThat(retry).isEqualTo(JsonObject(first + ("meta" to JsonObject(firstMeta + ("replay" to JsonPrimitive(true))))))
        assertThat(shop.sales.get()).describedAs("the command ran once").isEqualTo(1)
        assertThat(shop.claims.get()).describedAs("both requests claimed through the bean").isEqualTo(2)
        assertThat(shop.records.get()).isEqualTo(1)

        val anonymous = buy(null)
        assertThat(anonymous).isEqualTo(json("""{"id":1,"error":{"code":"unauthenticated","message":"buy(): idempotency keys need an identified caller"},"fin":true}"""))
        assertThat(shop.claims.get()).describedAs("guard: a caller with no viewer never reaches the store").isEqualTo(2)
        assertThat(shop.sales.get()).isEqualTo(1)
    }
}
