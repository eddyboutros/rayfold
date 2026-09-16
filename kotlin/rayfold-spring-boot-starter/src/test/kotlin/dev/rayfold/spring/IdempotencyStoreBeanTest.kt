package dev.rayfold.spring

import dev.rayfold.core.IdempotencyClaim
import dev.rayfold.core.IdempotencyRecord
import dev.rayfold.core.IdempotencyStore
import dev.rayfold.core.MemoryIdempotencyStore
import dev.rayfold.core.RayfoldServer
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.autoconfigure.AutoConfigurations
import org.springframework.boot.test.context.runner.WebApplicationContextRunner
import java.util.concurrent.atomic.AtomicInteger

/**
 * An [IdempotencyStore] bean is where the server the starter builds keeps command results, which is how several
 * instances of one application share them (`JdbcIdempotencyStore` over the application's database).
 */
class IdempotencyStoreBeanTest {
    private val runner = WebApplicationContextRunner().withConfiguration(AutoConfigurations.of(RayfoldAutoConfiguration::class.java))
    private val viewer = Json.parseToJsonElement("""{"id":"u1"}""")
    private val buy = Json.parseToJsonElement("""{"ops":[{"id":1,"op":"buy","args":{"id":"b1","qty":1},"key":"starter-key-0000001","shape":"{ id stock }"}]}""").jsonObject

    /** A resolver bean, as an application writes one. */
    class Shop {
        val sales = AtomicInteger()

        @RayfoldCommand("buy")
        fun buy(@Arg("id") id: String, @Arg("qty") qty: Int): Map<String, Any> =
            mapOf("id" to id, "title" to "The Dispossessed", "stock" to sales.addAndGet(qty))
    }

    /** What the server asked of the bean: a store of its own would leave these at zero. */
    private class Counting(private val inner: IdempotencyStore) : IdempotencyStore by inner {
        val claims = AtomicInteger()
        val records = AtomicInteger()

        override fun claim(scope: String, key: String, leaseMs: Long): IdempotencyClaim =
            inner.claim(scope, key, leaseMs).also { claims.incrementAndGet() }

        override fun put(scope: String, key: String, record: IdempotencyRecord, token: String) {
            records.incrementAndGet()
            inner.put(scope, key, record, token)
        }
    }

    private fun answer(server: RayfoldServer): JsonObject =
        runBlocking { withTimeout(5_000) { server.collect(buy, viewer) } }.single()

    private fun JsonObject.replayed(): Boolean = ((this["meta"] as? JsonObject)?.get("replay") as? JsonPrimitive)?.content == "true"

    @Test
    fun `an IdempotencyStore bean holds what a retry replays`() {
        val store = Counting(MemoryIdempotencyStore())
        val shop = Shop()
        runner.withBean(IdempotencyStore::class.java, { store }).withBean(Shop::class.java, { shop }).run { ctx ->
            val server = ctx.getBean(RayfoldServer::class.java)
            val first = answer(server)
            val retry = answer(server)
            assertThat(shop.sales.get()).describedAs("the command ran once").isEqualTo(1)
            assertThat(first.replayed()).isFalse()
            assertThat(retry.replayed()).isTrue()
            assertThat(retry["ok"]).isEqualTo(first["ok"])
            assertThat(store.claims.get()).describedAs("both calls claimed through the bean").isEqualTo(2)
            assertThat(store.records.get()).isEqualTo(1)
        }
    }

    @Test
    fun `guard - without the bean the server keeps them in a store of its own`() {
        val shop = Shop()
        runner.withBean(Shop::class.java, { shop }).run { ctx ->
            val server = ctx.getBean(RayfoldServer::class.java)
            val first = answer(server)
            val retry = answer(server)
            assertThat(shop.sales.get()).isEqualTo(1)
            assertThat(retry.replayed()).isTrue()
            assertThat(retry["ok"]).isEqualTo(first["ok"])
        }
    }
}
