package dev.rayfold.spring.shop

import dev.rayfold.core.Instrumentation
import dev.rayfold.core.OpInfo
import dev.rayfold.core.Outcome
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import java.util.concurrent.BlockingQueue
import java.util.concurrent.LinkedBlockingQueue

/**
 * Hands over every op that ended on the server, as "kind name", so a test waits for a release instead of polling for
 * it: a live op's hook returns only after the op let go of its subscription.
 */
@TestConfiguration(proxyBeanMethods = false)
class OpEnds {
    val ended: BlockingQueue<String> = LinkedBlockingQueue()

    @Bean
    fun opEndsInstrumentation(): Instrumentation = object : Instrumentation {
        override suspend fun op(info: OpInfo, run: suspend () -> Outcome): Outcome = try {
            run()
        } finally {
            ended.add("${info.kind} ${info.name}")
        }
    }
}
