package dev.rayfold.spring

import dev.rayfold.core.Instrumentation
import dev.rayfold.core.OpInfo
import dev.rayfold.core.Outcome
import dev.rayfold.core.RayfoldContext
import dev.rayfold.core.RayfoldServer
import dev.rayfold.java.Context
import dev.rayfold.java.Values
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.autoconfigure.AutoConfigurations
import org.springframework.boot.test.context.runner.WebApplicationContextRunner
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The parameter and return shapes an annotated resolver may take that the other applications do not: all arguments as
 * [Values], the [Context] and the raw [RayfoldContext], parents as `List<Values>`, a field loader with arguments of its
 * own; and the shapes the starter can only refuse once a request reaches them, each with the reason an operator reads.
 * Every test has its own context, driven through the server the starter built.
 */
class AnnotatedShapesTest {
    private val runner = WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(RayfoldAutoConfiguration::class.java))
        .withPropertyValues("rayfold.schema=classpath:annotated.rayfold")
    private val viewer = Json.parseToJsonElement("""{"id":"u1"}""")

    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    private fun frames(server: RayfoldServer, op: String): List<JsonObject> =
        runBlocking { withTimeout(5_000) { server.collect(obj("""{"ops":[$op]}"""), viewer) } }

    class Shapes {
        @RayfoldQuery("whoami")
        fun whoami(args: Values, ctx: Context, raw: RayfoldContext): String = "${args.getString("tag")} ${ctx.viewerId()} ${raw.opName}"

        @RayfoldQuery("book")
        fun book(@Arg id: String): Map<String, Any> = mapOf("id" to id, "title" to "T-$id", "authorId" to "a1")

        @RayfoldField(type = "Book", field = "author")
        fun author(parents: List<Values>): List<Map<String, Any?>> = parents.map { mapOf("id" to it.getString("authorId"), "name" to "N-${it.getString("authorId")}") }

        @RayfoldField(type = "Author", field = "books")
        fun books(parents: List<Values>, @Arg first: Int): List<List<Map<String, Any>>> =
            parents.map { p -> (1..first).map { mapOf("id" to "${p.getString("id")}-$it", "title" to "T$it", "authorId" to (p.getString("id") ?: "")) } }
    }

    @Test
    fun `a resolver may take all its arguments as Values, the Context and the raw context`() {
        runner.withBean(Shapes::class.java).run { ctx ->
            assertThat(frames(ctx.getBean(RayfoldServer::class.java), """{"id":1,"op":"whoami","args":{"tag":"hi"}}"""))
                .containsExactly(obj("""{"id":1,"data":"hi u1 whoami","meta":{"cost":1},"fin":true}"""))
        }
    }

    @Test
    fun `a field loader may take its parents as Values, and a field's own arguments by name`() {
        runner.withBean(Shapes::class.java).run { ctx ->
            assertThat(frames(ctx.getBean(RayfoldServer::class.java), """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ title author { name books(first: 2) { id } } }"}"""))
                .containsExactly(obj("""{"id":1,"data":{"${'$'}type":"Book","title":"T-b1","author":{"${'$'}type":"Author","name":"N-a1","books":[{"${'$'}type":"Book","id":"a1-1"},{"${'$'}type":"Book","id":"a1-2"}]}},"meta":{"cost":3},"fin":true}"""))
        }
    }

    class Broken {
        @RayfoldStream("ticks")
        fun ticks(): String = "not a stream"

        @RayfoldQuery("pending")
        fun pending(): CompletableFuture<String>? = null

        @RayfoldQuery("book")
        fun book(@Arg id: String): Map<String, Any> = mapOf("id" to id, "title" to "T", "authorId" to "a1")

        @RayfoldField(type = "Book", field = "author")
        fun author(parents: List<Values>): Map<String, Any> = mapOf("id" to "a1")
    }

    @Test
    fun `a resolver that returns what its annotation cannot use fails its op, and the operator is told which method and why`() {
        val causes = CopyOnWriteArrayList<String>()
        val recording = object : Instrumentation {
            override suspend fun op(info: OpInfo, run: suspend () -> Outcome): Outcome = run().also { o -> o.cause?.let { causes.add("${info.name}: ${it.message}") } }
        }
        runner.withBean(Broken::class.java).withBean(Instrumentation::class.java, { recording }).run { ctx ->
            val server = ctx.getBean(RayfoldServer::class.java)
            val internal = """"error":{"code":"internal","message":"Internal error"},"fin":true"""
            assertThat(frames(server, """{"id":1,"op":"ticks"}""")).containsExactly(obj("""{"id":1,$internal}"""))
            assertThat(frames(server, """{"id":1,"op":"pending"}""")).containsExactly(obj("""{"id":1,$internal}"""))
            assertThat(frames(server, """{"id":1,"op":"book","args":{"id":"b1"},"shape":"{ author { name } }"}""")).containsExactly(obj("""{"id":1,$internal}"""))
            assertThat(causes).containsExactly(
                "ticks: AnnotatedShapesTest.Broken.ticks must return a Stream or an Iterable, not java.lang.String",
                "pending: AnnotatedShapesTest.Broken.pending returned null instead of a CompletionStage",
                "book: AnnotatedShapesTest.Broken.author must return a List, one value per parent",
            )
        }
    }
}
