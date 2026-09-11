package dev.rayfold.spring

import dev.rayfold.core.Guard
import dev.rayfold.core.RayfoldServer
import dev.rayfold.core.RayfoldWebSocket
import dev.rayfold.core.RayfoldWsSession
import dev.rayfold.java.Rayfold
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.springframework.boot.autoconfigure.AutoConfiguration
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication
import org.springframework.context.annotation.Bean
import org.springframework.core.Ordered
import org.springframework.http.HttpStatus
import org.springframework.http.server.ServerHttpRequest
import org.springframework.http.server.ServerHttpResponse
import org.springframework.http.server.ServletServerHttpRequest
import org.springframework.web.servlet.handler.SimpleUrlHandlerMapping
import org.springframework.web.socket.BinaryMessage
import org.springframework.web.socket.CloseStatus
import org.springframework.web.socket.TextMessage
import org.springframework.web.socket.WebSocketHandler
import org.springframework.web.socket.WebSocketMessage
import org.springframework.web.socket.WebSocketSession
import org.springframework.web.socket.handler.AbstractWebSocketHandler
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator
import org.springframework.web.socket.server.HandshakeInterceptor
import org.springframework.web.socket.server.support.DefaultHandshakeHandler
import org.springframework.web.socket.server.support.WebSocketHttpRequestHandler
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap

/**
 * The WebSocket transport at `rayfold.path` + `/ws` on the application's own port, when the application has
 * spring-boot-starter-websocket. It runs the same protocol as [RayfoldWebSocket] (JSON text, RB binary, cancel, live
 * queries) with the viewer taken from the handshake request, so Spring Security's user is the viewer here too.
 * `rayfold.websocket=false` turns it off.
 */
@AutoConfiguration(after = [RayfoldAutoConfiguration::class])
@ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
@ConditionalOnClass(name = ["org.springframework.web.socket.server.support.WebSocketHttpRequestHandler"])
@ConditionalOnBean(RayfoldServer::class)
@ConditionalOnProperty(prefix = "rayfold", name = ["websocket"], havingValue = "true", matchIfMissing = true)
class RayfoldWebSocketAutoConfiguration {
    @Bean
    fun rayfoldWebSocketMapping(server: RayfoldServer, properties: RayfoldProperties, viewer: RayfoldViewerResolver): SimpleUrlHandlerMapping {
        val handshake = DefaultHandshakeHandler().apply { setSupportedProtocols(RayfoldWebSocket.SUBPROTOCOL) }
        val handler = WebSocketHttpRequestHandler(RayfoldWebSocketHandler(server, properties.maxBodyBytes), handshake)
        handler.setHandshakeInterceptors(listOf(RayfoldHandshakeInterceptor(properties, viewer)))
        // ahead of the HTTP mapping, whose `{path}/**` would take the socket's path too
        return SimpleUrlHandlerMapping(mapOf(properties.path.trimEnd('/') + "/ws" to handler)).apply { order = Ordered.HIGHEST_PRECEDENCE + 9 }
    }
}

/**
 * Refuses a handshake from a foreign page or for an unexpected Host (spec 12 section 2): browsers attach the user's
 * cookies to it, so without the Origin check any site could open a socket as the user. Resolves the viewer while the
 * handshake request, and Spring Security's context for it, is still at hand.
 */
internal class RayfoldHandshakeInterceptor(private val properties: RayfoldProperties, private val viewer: RayfoldViewerResolver) : HandshakeInterceptor {
    override fun beforeHandshake(request: ServerHttpRequest, response: ServerHttpResponse, wsHandler: WebSocketHandler, attributes: MutableMap<String, Any>): Boolean {
        val servlet = (request as? ServletServerHttpRequest)?.servletRequest ?: return false
        val host = servlet.getHeader("Host")
        // the local address is a literal IP, so this does no name lookup
        val local = servlet.localAddr?.let { runCatching { InetAddress.getByName(it) }.getOrNull() }
        val refused = Guard.hostProblem(host, local, properties.allowedHosts?.toSet())
            ?: Guard.originProblem(servlet.getHeader("Origin"), host, properties.allowedOrigins.toSet())
        if (refused != null) {
            response.setStatusCode(HttpStatus.FORBIDDEN)
            response.body.write(refused.toByteArray())
            return false
        }
        attributes[RayfoldWebSocketHandler.VIEWER] = Rayfold.toJson(viewer.viewer(servlet))
        return true
    }

    override fun afterHandshake(request: ServerHttpRequest, response: ServerHttpResponse, wsHandler: WebSocketHandler, exception: Exception?) = Unit
}

/** Spring's end of each socket, handing its messages to a [RayfoldWsSession]; a closed socket cancels its batches. */
internal class RayfoldWebSocketHandler(private val server: RayfoldServer, private val maxMessageBytes: Int) : AbstractWebSocketHandler() {
    private val sessions = ConcurrentHashMap<String, RayfoldWsSession>()

    override fun afterConnectionEstablished(session: WebSocketSession) {
        session.textMessageSizeLimit = maxMessageBytes
        session.binaryMessageSizeLimit = maxMessageBytes
        // a Spring session is not safe for concurrent sends, and the batches on one socket send from several coroutines
        val out = ConcurrentWebSocketSessionDecorator(session, SEND_TIME_LIMIT_MS, maxMessageBytes * 4)
        val viewer = session.attributes[VIEWER] as? JsonElement ?: JsonNull
        sessions[session.id] = RayfoldWsSession(server, viewer, { send(out, TextMessage(it)) }, { send(out, BinaryMessage(it)) })
    }

    override fun handleTextMessage(session: WebSocketSession, message: TextMessage) {
        sessions[session.id]?.onText(message.payload)
    }

    override fun handleBinaryMessage(session: WebSocketSession, message: BinaryMessage) {
        val buf = message.payload
        sessions[session.id]?.onBinary(ByteArray(buf.remaining()).also { buf.get(it) })
    }

    override fun afterConnectionClosed(session: WebSocketSession, status: CloseStatus) {
        sessions.remove(session.id)?.close()
    }

    private fun send(out: WebSocketSession, message: WebSocketMessage<*>) {
        try {
            out.sendMessage(message)
        } catch (e: Exception) {
            // the socket is closing; afterConnectionClosed cancels its batches
        }
    }

    companion object {
        const val VIEWER = "rayfold.viewer"
        private const val SEND_TIME_LIMIT_MS = 10_000
    }
}
