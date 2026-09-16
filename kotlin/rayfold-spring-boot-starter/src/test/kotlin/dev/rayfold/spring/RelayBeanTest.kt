package dev.rayfold.spring

import dev.rayfold.core.MemoryRelay
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.Relay
import dev.rayfold.core.RelayMessage
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.autoconfigure.AutoConfigurations
import org.springframework.boot.test.context.runner.WebApplicationContextRunner
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** A [Relay] bean reaches the server the starter builds: its commands are carried to the other instances on the relay. */
class RelayBeanTest {
    private val runner = WebApplicationContextRunner().withConfiguration(AutoConfigurations.of(RayfoldAutoConfiguration::class.java))
    private val viewer = Json.parseToJsonElement("""{"id":"u1"}""")
    private val buy = Json.parseToJsonElement("""{"ops":[{"id":1,"op":"buy","args":{"id":"b1","qty":1},"key":"starter-key-0000002","shape":"{ id stock }"}]}""").jsonObject

    @Test
    fun `a Relay bean carries the server's changes to the other ends of the relay`() {
        val relay = MemoryRelay()
        val heard = CopyOnWriteArrayList<String>()
        val arrived = CountDownLatch(1)
        runner.withBean(Relay::class.java, { relay.join() }).withBean(IdempotencyStoreBeanTest.Shop::class.java, { IdempotencyStoreBeanTest.Shop() }).run { ctx ->
            val server = ctx.getBean(RayfoldServer::class.java)
            runBlocking { withTimeout(5_000) { server.ready() } }
            assertThat(relay.size).describedAs("the server listens on the bean's end").isEqualTo(1)
            val other = relay.join()
            val stop = runBlocking { other.subscribe { m -> heard.add(if (m is RelayMessage.Change) "change ${m.keys} ${m.ops}" else "event"); arrived.countDown() } }
            val frame = runBlocking { withTimeout(5_000) { server.collect(buy, viewer) } }.single()
            assertThat(frame["ok"]).isNotNull()
            assertThat(arrived.await(5, TimeUnit.SECONDS)).describedAs("the other end hearing the change").isTrue()
            assertThat(heard).containsExactly("change [Book:b1] []")
            runBlocking { stop(); withTimeout(5_000) { server.close() } }
            assertThat(relay.size).isZero()
        }
    }

    @Test
    fun `guard - without the bean the server joins nothing, and is ready at once`() {
        val relay = MemoryRelay()
        runner.withBean(IdempotencyStoreBeanTest.Shop::class.java, { IdempotencyStoreBeanTest.Shop() }).run { ctx ->
            val server = ctx.getBean(RayfoldServer::class.java)
            runBlocking { withTimeout(5_000) { server.ready() } }
            assertThat(relay.size).isZero()
            assertThat(server.relayFailure).isNull()
        }
    }
}
