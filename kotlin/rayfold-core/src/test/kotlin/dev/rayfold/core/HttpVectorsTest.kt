package dev.rayfold.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The published `http/` vectors, run against `RayfoldHttp` and `RayfoldBindings` on a real JDK server.
 *
 * Requests go over a plain socket rather than `java.net.http`, which will not send a `Host` of the caller's choosing
 * and cannot hang up after the first line of a response. `http-vectors.test.ts` runs the TypeScript entry points
 * against the same file.
 */
class HttpVectorsTest {
    private val root = File(System.getProperty("rayfold.vectors") ?: "../conformance/vectors")

    private val known = mapOf(
        "case" to setOf("name", "why", "route", "badRequestTarget", "server", "request", "expect"),
        "server" to setOf("allowedOrigins", "bindings"),
        "request" to setOf("method", "path", "headers", "body"),
        "expect" to setOf("status", "headers", "problem", "json", "frame", "emptyBody", "streams"),
        "matcher" to setOf("equals", "contains", "includes", "excludes", "includesMatch", "hasKey", "lacksKey", "hasKeyDeep"),
        "header" to setOf("contains", "listIncludes"),
    )

    /** A member this runner has no assertion for fails the case rather than passing it unchecked. */
    private fun onlyKnown(what: String, o: JsonObject?, kind: String) {
        val allowed = known.getValue(kind)
        for (k in o?.keys ?: emptySet()) assertTrue(k in allowed, "$what: no runner for \"$k\"")
    }

    private class Answer(val status: Int, val headers: Map<String, List<String>>, val body: String, val firstLine: String?) {
        fun header(name: String): String? = headers[name.lowercase()]?.joinToString(", ")
    }

    @TestFactory
    fun http(): List<DynamicTest> {
        val doc = Json.parseToJsonElement(File(File(root, "http"), "exchanges.json").readText()).jsonObject
        val ir = SchemaText.load(doc.str("schema")).ir
        val out = mutableListOf<DynamicTest>()
        for (case in doc.req("cases").jsonArray) {
            val c = case.jsonObject
            val name = c.str("name")
            out.add(DynamicTest.dynamicTest("http/$name: over the JDK server") { overJdk(ir, c) })
            // RayfoldHttp.serve is how every other server hosts the endpoint (the Spring starter's, a servlet's); the
            // bindings are served on the JDK server only
            val bindings = ((c["server"] as? JsonObject)?.get("bindings") as? JsonPrimitive)?.content == "true"
            if (c.str("route") == "endpoint" && !bindings) out.add(DynamicTest.dynamicTest("http/$name: through an HttpCall") { overCall(ir, c) })
        }
        assertTrue(out.size > 10, "no http vectors were found under ${root.absolutePath}")
        return out
    }

    private fun validate(c: JsonObject) {
        val name = c.str("name")
        onlyKnown(name, c, "case")
        onlyKnown("$name server", c["server"] as? JsonObject, "server")
        onlyKnown("$name request", c.req("request").jsonObject, "request")
        onlyKnown("$name expect", c.req("expect").jsonObject, "expect")
        assertTrue(c.str("route") in setOf("endpoint", "binding"), "$name: no runner for route ${c.str("route")}")
    }

    private fun origins(c: JsonObject): Set<String> =
        ((c["server"] as? JsonObject)?.get("allowedOrigins") as? JsonArray)?.map { it.jsonPrimitive.content }?.toSet() ?: emptySet()

    /** The fixed resolvers the file's `about` describes. */
    private fun rayfold(ir: RayfoldSchemaIR): RayfoldServer {
        fun echo(args: JsonObject, n: JsonElement?) = buildJsonObject {
            put("id", "h1")
            put("got", args)
            n?.let { put("n", it) }
        }
        return RayfoldServer(
            ir,
            Resolvers(
                queries = mapOf(
                    "book" to { args, _ -> buildJsonObject { put("id", args.getValue("id")); put("title", "T") } },
                    "find" to { args, _ -> echo(args, args["n"] ?: JsonNull) },
                    "hit" to { args, _ -> echo(args, args["hitId"]) },
                    "search" to { args, _ -> echo(args, null) },
                ),
                commands = mapOf("tag" to command { args, _ -> CommandResult(echo(args, null)) }),
            ),
        )
    }

    private fun overJdk(ir: RayfoldSchemaIR, c: JsonObject) {
        validate(c)
        val server = rayfold(ir)
        val origins = origins(c)
        val http = RayfoldHttp(server, HttpOptions(allowedOrigins = origins)) { JsonNull }.start(0)
        try {
            if (((c["server"] as? JsonObject)?.get("bindings") as? JsonPrimitive)?.content == "true") {
                RayfoldBindings(server, BindingOptions(allowedOrigins = origins)) { JsonNull }.mount(http)
            }
            val port = http.address.port
            val answer = exchange(c, "127.0.0.1:$port") { method, path, headers, body, first -> send(port, method, path, headers, body, first) }
            if ((c["badRequestTarget"] as? JsonPrimitive)?.content == "true") {
                // the JDK's HttpServer refuses a request line whose target is no URI with a 400 of its own, before any
                // handler runs; the problem document is checked through an HttpCall, where Rayfold reads the target
                assertEquals(c.req("expect").jsonObject.str("status").toInt(), answer.status, "${c.str("name")}: ${answer.body}")
                return
            }
            check(c, answer)
        } finally {
            http.stop(0)
        }
    }

    private fun overCall(ir: RayfoldSchemaIR, c: JsonObject) {
        validate(c)
        // a short keep-alive, so a live query's exchange notices the hang-up soon after the case is done with it
        val http = RayfoldHttp(rayfold(ir), HttpOptions(allowedOrigins = origins(c), keepAliveMs = 100)) { JsonNull }
        check(c, exchange(c, "api.example") { method, target, headers, body, first -> Call(method, target, headers, body).run(http, first) })
    }

    /**
     * An exchange handed to [RayfoldHttp.serve] as another server hands it over, with the target as the client sent
     * it. It runs on a thread of its own, so a live query can be read while its response is still open.
     */
    private class Call(override val method: String, target: String, private val headers: Map<String, String>, body: String?) : HttpCall {
        override val path: String = java.net.URLDecoder.decode(target.substringBefore('?').replace("+", "%2B"), Charsets.UTF_8)
        override val rawQuery: String? = if ('?' in target) target.substringAfter('?') else null
        override val body: InputStream = (body ?: "").byteInputStream()
        override val secure = false
        override val localAddress: java.net.InetAddress? = null
        override fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

        private val lock = Object()
        private val written = ByteArrayOutputStream()
        private val responseHeaders = linkedMapOf<String, List<String>>()
        private var status = 0
        private var done = false
        private var hungUp = false

        override fun setHeader(name: String, value: String) = synchronized(lock) { responseHeaders[name.lowercase()] = listOf(value) }
        override fun respond(status: Int, length: Long): java.io.OutputStream {
            synchronized(lock) { this.status = status }
            return object : java.io.OutputStream() {
                override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
                override fun write(b: ByteArray, off: Int, len: Int) = synchronized(lock) {
                    if (hungUp) throw java.io.IOException("the client hung up")
                    written.write(b, off, len)
                    lock.notifyAll()
                }
            }
        }
        override fun abort() = Unit

        fun run(http: RayfoldHttp, firstLineOnly: Boolean): Answer {
            val worker = Thread {
                try {
                    http.serve(this, "/rayfold") { JsonNull }
                } finally {
                    synchronized(lock) {
                        done = true
                        lock.notifyAll()
                    }
                }
            }.apply { isDaemon = true; start() }
            val until = System.currentTimeMillis() + 5_000
            synchronized(lock) {
                while (true) {
                    val text = written.toString(Charsets.UTF_8)
                    if (firstLineOnly && '\n' in text && !done) {
                        hungUp = true
                        return Answer(status, responseHeaders.toMap(), text, text.substringBefore('\n'))
                    }
                    if (done) {
                        // a response that has already ended was answered whole, which a live query never is
                        if (firstLineOnly) error("the response ended before its first frame was read: $text")
                        return Answer(status, responseHeaders.toMap(), text, null)
                    }
                    val left = until - System.currentTimeMillis()
                    if (left <= 0) {
                        hungUp = true
                        worker.interrupt()
                        error("no answer within 5 s: $text")
                    }
                    lock.wait(left)
                }
            }
        }
    }

    /** Sends the case's request with `{host}` and `{etag}` filled in. */
    private fun exchange(c: JsonObject, host: String, send: (String, String, Map<String, String>, String?, Boolean) -> Answer): Answer {
        val request = c.req("request").jsonObject
        val method = request.str("method")
        val path = request.str("path")
        val body = request["body"]?.toString()
        val headers = linkedMapOf<String, String>()
        for ((k, v) in (request["headers"] as? JsonObject) ?: JsonObject(emptyMap())) headers[k] = v.jsonPrimitive.content.replace("{host}", host)
        if (headers.keys.none { it.equals("Host", ignoreCase = true) }) headers["Host"] = host
        if (headers.values.any { "{etag}" in it }) {
            val first = send(method, path, headers.filterValues { "{etag}" !in it }, body, false)
            val etag = assertNotNull(first.header("ETag"), "${c.str("name")}: the first answer carries no ETag to send back")
            for (k in headers.keys.toList()) headers[k] = headers.getValue(k).replace("{etag}", etag)
        }
        val streams = ((c.req("expect").jsonObject["streams"]) as? JsonPrimitive)?.content == "true"
        return send(method, path, headers, body, streams)
    }

    private fun send(port: Int, method: String, path: String, headers: Map<String, String>, body: String?, firstLineOnly: Boolean): Answer {
        Socket().use { socket ->
            socket.connect(InetSocketAddress("127.0.0.1", port), 5_000)
            socket.soTimeout = 5_000 // a missed answer fails the case instead of hanging the build
            val bytes = body?.toByteArray(Charsets.UTF_8)
            val head = StringBuilder("$method $path HTTP/1.1\r\n")
            for ((k, v) in headers) head.append("$k: $v\r\n")
            if (bytes != null) head.append("Content-Length: ${bytes.size}\r\n")
            head.append("Connection: close\r\n\r\n")
            val output = socket.getOutputStream()
            output.write(head.toString().toByteArray(Charsets.UTF_8))
            if (bytes != null) output.write(bytes)
            output.flush()

            val input = socket.getInputStream().buffered()
            val statusLine = readLine(input) ?: error("no answer to $method $path")
            val status = statusLine.split(" ")[1].toInt()
            val responseHeaders = linkedMapOf<String, MutableList<String>>()
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                responseHeaders.getOrPut(line.substring(0, colon).trim().lowercase()) { mutableListOf() }.add(line.substring(colon + 1).trim())
            }
            if (status == 204 || status == 304 || method == "HEAD") return Answer(status, responseHeaders, "", null)
            val chunked = responseHeaders["transfer-encoding"]?.any { it.equals("chunked", ignoreCase = true) } == true
            val length = responseHeaders["content-length"]?.firstOrNull()?.toInt()
            val text = ByteArrayOutputStream()
            fun firstLine(): String? = text.toString(Charsets.UTF_8).let { t -> t.indexOf('\n').takeIf { it >= 0 }?.let { t.substring(0, it) } }
            when {
                chunked -> while (true) {
                    val size = (readLine(input) ?: break).substringBefore(';').trim().toInt(16)
                    if (size == 0) break
                    text.write(input.readNBytes(size))
                    readLine(input)
                    if (firstLineOnly) firstLine()?.let { return Answer(status, responseHeaders, text.toString(Charsets.UTF_8), it) }
                }
                length != null -> text.write(input.readNBytes(length))
                else -> text.write(input.readAllBytes())
            }
            val all = text.toString(Charsets.UTF_8)
            if (firstLineOnly) {
                // a response that has already ended was answered whole, which a live query never is
                error("the response ended before its first frame was read: $all")
            }
            return Answer(status, responseHeaders, all, null)
        }
    }

    private fun readLine(input: InputStream): String? {
        val line = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (line.size() == 0) null else line.toString(Charsets.UTF_8)
            if (b == '\n'.code) return line.toString(Charsets.UTF_8).removeSuffix("\r")
            line.write(b)
        }
    }

    private fun check(c: JsonObject, a: Answer) {
        val why = c["why"]?.jsonPrimitive?.content ?: c.str("name")
        val e = c.req("expect").jsonObject
        assertEquals(e.str("status").toInt(), a.status, "$why: ${a.body}")
        for ((name, want) in (e["headers"] as? JsonObject) ?: JsonObject(emptyMap())) {
            val got = a.header(name)
            when (want) {
                is JsonNull -> assertNull(got, "$why: $name must be absent")
                is JsonPrimitive -> assertEquals(want.content, got, "$why: $name")
                is JsonObject -> {
                    onlyKnown("header $name", want, "header")
                    assertNotNull(got, "$why: $name is missing")
                    want["contains"]?.let { assertTrue(it.jsonPrimitive.content in got, "$why: $name was $got") }
                    want["listIncludes"]?.let { item ->
                        val items = got.split(",").map { it.trim().lowercase() }
                        assertTrue(item.jsonPrimitive.content.lowercase() in items, "$why: $name was $got")
                    }
                }
                else -> error("$why: no runner for header expectation $want")
            }
        }
        e["problem"]?.let {
            assertTrue("application/problem+json" in (a.header("Content-Type") ?: ""), "$why: served as ${a.header("Content-Type")}")
            assertEquals(it.jsonPrimitive.content, Json.parseToJsonElement(a.body).jsonObject.str("code"), why)
        }
        if ((e["emptyBody"] as? JsonPrimitive)?.content == "true") assertEquals("", a.body, why)
        if ((e["streams"] as? JsonPrimitive)?.content == "true") assertNotNull(a.firstLine, "$why: the first frame was not read while the response was open")
        (e["json"] as? JsonObject)?.let { checkPaths(why, Json.parseToJsonElement(a.body), it) }
        (e["frame"] as? JsonObject)?.let {
            val line = a.firstLine ?: a.body.lines().firstOrNull { l -> l.isNotBlank() }
            assertNotNull(line, "$why: no frame in ${a.body}")
            checkPaths(why, Json.parseToJsonElement(line), it)
        }
    }

    private fun at(value: JsonElement, path: String): JsonElement? {
        if (path.isEmpty()) return value
        var cur: JsonElement? = value
        for (seg in path.split('.')) cur = (cur as? JsonObject)?.get(seg)
        return cur
    }

    private fun hasKeyDeep(v: JsonElement?, key: String): Boolean = when (v) {
        is JsonObject -> key in v || v.values.any { hasKeyDeep(it, key) }
        is JsonArray -> v.any { hasKeyDeep(it, key) }
        else -> false
    }

    private fun checkPaths(why: String, value: JsonElement, checks: JsonObject) {
        for ((path, matcher) in checks) {
            val m = matcher.jsonObject
            onlyKnown("$why $path", m, "matcher")
            val v = at(value, path)
            val label = "$why at \"$path\": $v"
            m["equals"]?.let { assertEquals(it, v, label) }
            m["contains"]?.let { assertTrue(v is JsonPrimitive && v.isString && it.jsonPrimitive.content in v.content, label) }
            m["includes"]?.let { assertTrue(v is JsonArray && it in v, label) }
            m["excludes"]?.let { assertTrue(v is JsonArray && it !in v, label) }
            m["includesMatch"]?.let { want ->
                val members = want.jsonObject
                assertTrue(v is JsonArray && v.any { el -> el is JsonObject && members.all { (k, x) -> el[k] == x } }, label)
            }
            m["hasKey"]?.let { assertTrue(v is JsonObject && it.jsonPrimitive.content in v, label) }
            m["lacksKey"]?.let { assertTrue(v is JsonObject && it.jsonPrimitive.content !in v, label) }
            m["hasKeyDeep"]?.let { assertTrue(hasKeyDeep(v, it.jsonPrimitive.content), label) }
        }
    }

    private fun JsonObject.req(key: String): JsonElement = this[key] ?: error("vector is missing \"$key\"")
    private fun JsonObject.str(key: String): String = req(key).jsonPrimitive.content
}
