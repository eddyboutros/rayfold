package dev.rayfold.core

import com.sun.net.httpserver.HttpContext
import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The Rayfold explorer: the page a server serves next to its endpoint, the counterpart of Swagger UI and GraphiQL.
 * It lists every operation the manifest declares with its arguments, result, cost and the policies that guard it;
 * helps write a shape; sends a batch and shows the frames as they arrive, with their cost; and dry-runs a command
 * that allows `@simulate`.
 *
 * It is the same page `@rayfold/explorer` serves, kept identical by `node scripts/sync-explorer.mjs`.
 *
 * The page talks to the endpoint over HTTP like any other client, so what a visitor can read through it is what the
 * endpoint's own policies allow for the token they paste into it, and no more. Nothing is served unless it is mounted
 * here or turned on with [HttpOptions.explorer], so it exists only where it is meant to.
 *
 *     RayfoldExplorer(endpoint = "/rayfold", title = "Acme API").mount(http)
 */
class RayfoldExplorer(
    /** Where the endpoint is mounted: where the page sends its batches, and reads the manifest. */
    private val endpoint: String = "/rayfold",
    /** Shown in the header, to tell one service from another. */
    private val title: String = "Rayfold",
) {
    /** The page, for serving it from a server of your own. */
    val html: String by lazy { page(endpoint, title) }

    /** Serves the page at [path] on a JDK server, by default `{endpoint}/explorer`. */
    fun mount(http: HttpServer, path: String = "$endpoint/explorer"): HttpContext =
        http.createContext(path) { ex ->
            ex.use {
                if (ex.requestMethod != "GET") {
                    ex.responseHeaders.add("Allow", "GET")
                    ex.sendResponseHeaders(405, -1)
                } else {
                    val bytes = html.toByteArray()
                    ex.responseHeaders.add("Content-Type", "text/html; charset=utf-8")
                    ex.responseHeaders.add("Cache-Control", "no-store") // it carries the endpoint it talks to
                    ex.sendResponseHeaders(200, bytes.size.toLong())
                    ex.responseBody.use { body -> body.write(bytes) }
                }
            }
        }

    internal companion object {
        private const val PLACEHOLDER = "__RAYFOLD_EXPLORER_CONFIG__"

        private val template: String by lazy {
            RayfoldExplorer::class.java.getResourceAsStream("explorer.html")
                ?.use { String(it.readAllBytes(), Charsets.UTF_8) }
                ?: error("explorer.html is missing from rayfold-core; run node scripts/sync-explorer.mjs")
        }

        /** The page with its configuration written in, escaped so a title cannot close the script element. */
        fun page(endpoint: String, title: String): String {
            val config = Canonical.json(buildJsonObject { put("endpoint", endpoint); put("title", title) })
            return template.replace(PLACEHOLDER, config.replace("<", "\\u003c"))
        }
    }
}
