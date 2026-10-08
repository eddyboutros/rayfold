package dev.rayfold.spring

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
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * A `java.time.Clock` bean is the clock of the server the starter builds, so an application that injects a clock to
 * test its own code moves the server's time with it. Every test has its own context, clock and resolver bean.
 */
class ClockBeanTest {
    private val runner = WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(RayfoldAutoConfiguration::class.java))
        .withPropertyValues("rayfold.schema=classpath:clock.rayfold")
    private val viewer = Json.parseToJsonElement("""{"id":"u1"}""")
    private val read = Json.parseToJsonElement("""{"ops":[{"id":1,"op":"post","args":{"id":"p1"},"shape":"{ id title }"}]}""").jsonObject
    private val publish = Json.parseToJsonElement("""{"ops":[{"id":1,"op":"publish","args":{"id":"p1"},"key":"starter-key-0000001","shape":"{ id }"}]}""").jsonObject
    private val hello = Json.parseToJsonElement("""{"${'$'}type":"Post","id":"p1","title":"Hello"}""")

    /** A resolver bean, as an application writes one. */
    class Blog(private val publishedAt: Long) {
        val published = AtomicInteger()

        @RayfoldQuery("post")
        fun post(@Arg("id") id: String): Map<String, Any> = mapOf("id" to id, "title" to "Hello", "publishedAt" to publishedAt)

        @RayfoldCommand("publish")
        fun publish(@Arg("id") id: String): Map<String, Any> = post(id).also { published.incrementAndGet() }
    }

    /** A clock an application would inject, reading what the test set. */
    private class SetClock(start: Long) : Clock() {
        val millis = AtomicLong(start)

        override fun instant(): Instant = Instant.ofEpochMilli(millis.get())
        override fun getZone(): ZoneId = ZoneOffset.UTC
        override fun withZone(zone: ZoneId): Clock = this
    }

    private fun answer(server: RayfoldServer, batch: JsonObject): JsonObject =
        runBlocking { withTimeout(5_000) { server.collect(batch, viewer) } }.single()

    private fun JsonObject.code(): String? = ((this["error"] as? JsonObject)?.get("code") as? JsonPrimitive)?.content

    private fun JsonObject.replayed(): Boolean = (this["meta"] as? JsonObject)?.get("replay") == JsonPrimitive(true)

    @Test
    fun `a Clock bean decides a policy that reads the time - refused before the hour, allowed from it`() {
        val clock = SetClock(999)
        runner.withBean(Clock::class.java, { clock }).withBean(Blog::class.java, { Blog(publishedAt = 1_000) }).run { ctx ->
            val server = ctx.getBean(RayfoldServer::class.java)
            assertThat(answer(server, read).code()).isEqualTo("permission_denied")

            clock.millis.set(1_000)
            assertThat(answer(server, read)["data"]).isEqualTo(hello)
        }
    }

    @Test
    fun `a Clock bean is when the server started, how long it has been up, and when its own store forgets a command`() {
        val day = 24 * 60 * 60 * 1000L
        val clock = SetClock(1_000)
        val blog = Blog(publishedAt = 0)
        runner.withBean(Clock::class.java, { clock }).withBean(Blog::class.java, { blog }).run { ctx ->
            val server = ctx.getBean(RayfoldServer::class.java)
            assertThat(answer(server, publish).replayed()).isFalse()

            clock.millis.set(1_000 + day - 1)
            assertThat(server.identity.startedAt).isEqualTo(1_000)
            assertThat(server.uptimeMs).isEqualTo(day - 1)
            assertThat(answer(server, publish).replayed()).describedAs("guard: a millisecond short of a day the record answers").isTrue()
            assertThat(blog.published.get()).isEqualTo(1)

            clock.millis.set(1_000 + day)
            assertThat(answer(server, publish).replayed()).isFalse()
            assertThat(blog.published.get()).isEqualTo(2)
        }
    }

    @Test
    fun `guard - an application without a Clock bean starts, on the system clock`() {
        // a millisecond into 1970 is behind any machine's clock, and the last one a Long holds is ahead of it
        runner.withBean(Blog::class.java, { Blog(publishedAt = 1) }).run { ctx ->
            assertThat(ctx).hasNotFailed().doesNotHaveBean(Clock::class.java)
            assertThat(answer(ctx.getBean(RayfoldServer::class.java), read)["data"]).isEqualTo(hello)
        }
        runner.withBean(Blog::class.java, { Blog(publishedAt = Long.MAX_VALUE) }).run { ctx ->
            assertThat(answer(ctx.getBean(RayfoldServer::class.java), read).code()).isEqualTo("permission_denied")
        }
    }

    @Test
    fun `guard - an application with two clocks and no primary one starts, on the system clock`() {
        val clocks = runner.withBean("early", Clock::class.java, { SetClock(0) }).withBean("late", Clock::class.java, { SetClock(Long.MAX_VALUE) })
        clocks.withBean(Blog::class.java, { Blog(publishedAt = 1) }).run { ctx ->
            assertThat(ctx).hasNotFailed()
            assertThat(answer(ctx.getBean(RayfoldServer::class.java), read)["data"]).describedAs("the clock at 0 would refuse it").isEqualTo(hello)
        }
        clocks.withBean(Blog::class.java, { Blog(publishedAt = Long.MAX_VALUE - 1) }).run { ctx ->
            assertThat(answer(ctx.getBean(RayfoldServer::class.java), read).code()).describedAs("the clock at the end of time would allow it").isEqualTo("permission_denied")
        }
    }
}
