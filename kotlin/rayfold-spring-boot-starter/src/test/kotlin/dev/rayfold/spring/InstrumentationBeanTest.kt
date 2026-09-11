package dev.rayfold.spring

import dev.rayfold.core.BatchInfo
import dev.rayfold.core.Instrumentation
import dev.rayfold.core.OpInfo
import dev.rayfold.core.Outcome
import dev.rayfold.core.RayfoldServer
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.autoconfigure.AutoConfigurations
import org.springframework.boot.test.context.runner.WebApplicationContextRunner
import java.util.concurrent.CopyOnWriteArrayList

/** An [Instrumentation] bean reaches the server the starter builds, which is how tracing is switched on in Spring. */
class InstrumentationBeanTest {
    private val runner = WebApplicationContextRunner().withConfiguration(AutoConfigurations.of(RayfoldAutoConfiguration::class.java))
    private val batch = Json.parseToJsonElement("""{"ops":[{"id":1,"op":"me"},{"id":2,"op":"books","shape":"{ id }"}]}""").jsonObject

    @Test
    fun `an Instrumentation bean wraps every batch and op the server runs`() {
        val seen = CopyOnWriteArrayList<String>()
        val recording = object : Instrumentation {
            override suspend fun batch(info: BatchInfo, run: suspend () -> Outcome): Outcome = run().also { seen.add("batch of ${info.ops}") }
            override suspend fun op(info: OpInfo, run: suspend () -> Outcome): Outcome = run().also { seen.add("${info.kind} ${info.name} ${if (it.failed) it.code else "ok"}") }
        }
        runner.withBean(Instrumentation::class.java, { recording }).run { ctx ->
            val server = ctx.getBean(RayfoldServer::class.java)
            runBlocking { withTimeout(5_000) { server.collect(batch) } }
            // no resolvers are bound in this context, so both ops fail, and the hooks still see them
            assertThat(seen).containsExactlyInAnyOrder("query me unimplemented", "query books unimplemented", "batch of 2")
            assertThat(seen.last()).isEqualTo("batch of 2")
        }
    }

    @Test
    fun `guard - without the bean the server runs its batches untraced`() {
        runner.run { ctx ->
            val frames = runBlocking { withTimeout(5_000) { ctx.getBean(RayfoldServer::class.java).collect(batch) } }
            assertThat(frames).hasSize(2)
        }
    }
}
