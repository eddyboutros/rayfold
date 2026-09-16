package dev.rayfold.spring

import dev.rayfold.core.RayfoldServer
import dev.rayfold.spring.properties.PropertiesApplication
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.boot.builder.SpringApplicationBuilder
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.ConfigurableApplicationContext
import org.springframework.context.annotation.Bean
import java.io.IOException
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** A command the test holds: it says when it is [entered] and finishes once [release] is counted down. */
@TestConfiguration(proxyBeanMethods = false)
class HeldShop {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)

    @Bean
    fun everyoneIsU1(): RayfoldViewerResolver = RayfoldViewerResolver { mapOf("id" to "u1") }

    @Bean
    fun shop(): Shop = Shop(entered, release)

    class Shop(private val entered: CountDownLatch, private val release: CountDownLatch) {
        @RayfoldCommand("buy")
        fun buy(@Arg("id") id: String, @Arg("qty") qty: Int): Map<String, Any> {
            entered.countDown()
            check(release.await(30, TimeUnit.SECONDS)) { "the test never released the command" }
            return mapOf("id" to id, "title" to "The Dispossessed", "stock" to qty)
        }
    }
}

/** Closing the context, as a SIGTERM does, drains the server before the port goes: what is running finishes, what arrives is sent elsewhere. */
class LifecycleStarterTest {
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
    private var context: ConfigurableApplicationContext? = null
    private var held: HeldShop? = null

    @AfterEach
    fun stop() {
        held?.release?.countDown()
        context?.takeIf { it.isActive }?.close()
        client.shutdownNow()
    }

    private fun request(method: String, url: String, body: String? = null): HttpRequest = HttpRequest.newBuilder(URI(url)).timeout(Duration.ofSeconds(5))
        .method(method, if (body == null) HttpRequest.BodyPublishers.noBody() else HttpRequest.BodyPublishers.ofString(body))
        .header("Content-Type", "application/rayfold+json").build()

    @Test
    fun `closing the context drains, so a running command finishes and only then is the port down`() {
        val ctx = SpringApplicationBuilder(PropertiesApplication::class.java, HeldShop::class.java)
            .properties("server.port=0", "rayfold.schema=classpath:schema.rayfold", "spring.main.banner-mode=off")
            .run()
        context = ctx
        val shop = ctx.getBean(HeldShop::class.java).also { held = it }
        val server = ctx.getBean(RayfoldServer::class.java)
        val base = "http://127.0.0.1:${ctx.environment.getProperty("local.server.port") ?: error("no port")}"
        assertThat(client.send(request("GET", "$base/rayfold/ready"), HttpResponse.BodyHandlers.ofString()).body()).isEqualTo("""{"ready":true,"reasons":[]}""")

        val command = client.sendAsync(request("POST", "$base/rayfold", """{"ops":[{"id":1,"op":"buy","args":{"id":"b1","qty":1},"key":"starter-key-0000003"}]}"""), HttpResponse.BodyHandlers.ofString())
        assertThat(shop.entered.await(5, TimeUnit.SECONDS)).describedAs("the command running").isTrue()

        val closing = thread(name = "context-close") { ctx.close() }
        runBlocking { withTimeout(5_000) { server.draining.join() } } // the close has reached the drain
        assertThat(server.readiness().reasons).containsExactly("shutting down")
        val notReady = client.send(request("GET", "$base/rayfold/ready"), HttpResponse.BodyHandlers.ofString())
        assertThat(notReady.statusCode()).describedAs("the port still answers while draining").isEqualTo(503)
        assertThat(notReady.body()).isEqualTo("""{"ready":false,"reasons":["shutting down"]}""")
        assertThat(closing.isAlive).describedAs("closing waits for the running command").isTrue()
        assertThat(server.inflight).isEqualTo(1)

        shop.release.countDown()
        val answered = command.get(5, TimeUnit.SECONDS)
        assertThat(answered.statusCode()).isEqualTo(200)
        assertThat(answered.body()).contains(""""ok":{"${'$'}type":"Book","id":"b1","stock":1,"title":"The Dispossessed"}""")
        closing.join(5_000)
        assertThat(closing.isAlive).describedAs("closed once the command answered").isFalse()
        assertThat(server.inflight).isZero()
        assertThat(ctx.isActive).isFalse()
        assertThatThrownBy { client.send(request("GET", "$base/rayfold/health"), HttpResponse.BodyHandlers.ofString()) }.isInstanceOf(IOException::class.java)
    }
}
