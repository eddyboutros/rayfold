package dev.rayfold.client

/**
 * One level of a shape as the cache sees it (spec 07 section 3), mirroring `shapeLevel` in `@rayfold/schema`: the
 * selection under each output name, and which output names belong to the selection rather than to the entity. An
 * alias, or a field asked for with arguments, does: its value is what this selection asked for, and another selection
 * of the same entity may ask for another, so it is kept with the result instead of on the shared entity.
 *
 * Read from the shape's text, since this module does not carry the schema's parser. A named-view spread is not
 * expanded: without the schema's views, its fields are read as the entity's own, as they always were.
 */
internal class SelectionLevel(val bySelection: Set<String>, val child: Map<String, SelectionLevel?>) {
    companion object {
        /** The top level of [shape]; null for a shape that is not text this reader follows, such as a trusted id. */
        fun of(shape: String?): SelectionLevel? {
            if (shape == null || shape.startsWith("sha256:")) return null
            val r = Reader(shape)
            return if (r.at("{")) r.level() else null
        }
    }

    private class Reader(private val src: String) {
        private var i = 0

        private fun skip() {
            while (i < src.length) {
                val c = src[i]
                when {
                    c.isWhitespace() || c == ',' -> i++
                    src.startsWith("//", i) -> while (i < src.length && src[i] != '\n') i++
                    src.startsWith("/*", i) -> i = src.indexOf("*/", i + 2).let { if (it < 0) src.length else it + 2 }
                    else -> return
                }
            }
        }

        fun at(s: String): Boolean {
            skip()
            return src.startsWith(s, i)
        }

        private fun take(s: String): Boolean = at(s).also { if (it) i += s.length }

        private fun name(): String {
            skip()
            val start = i
            while (i < src.length && (src[i].isLetterOrDigit() || src[i] == '_')) i++
            return src.substring(start, i)
        }

        /** Skips a bracketed run, strings included; true when there was anything inside. */
        private fun skipGroup(open: Char, close: Char): Boolean {
            skip()
            i++ // the opening bracket
            val start = i
            var depth = 1
            while (i < src.length && depth > 0) {
                when (src[i]) {
                    '"' -> { i++; while (i < src.length && src[i] != '"') { if (src[i] == '\\') i++; i++ } }
                    open -> depth++
                    close -> depth--
                }
                i++
            }
            return src.substring(start, i - 1).isNotBlank()
        }

        fun level(): SelectionLevel {
            val bySelection = mutableSetOf<String>()
            val child = mutableMapOf<String, SelectionLevel?>()
            fun absorb(l: SelectionLevel) {
                bySelection.addAll(l.bySelection)
                child.putAll(l.child)
            }
            take("{")
            while (!at("}") && i < src.length) {
                when {
                    take("...") -> {
                        val n = name()
                        if (n == "on") {
                            name()
                            absorb(level())
                        } else if (take(".")) name() // a named-view spread: its fields are not known here
                    }
                    take("@") -> {
                        name() // defer
                        if (at("(")) skipGroup('(', ')')
                        if (at("{")) absorb(level())
                    }
                    else -> {
                        val first = name()
                        if (first.isEmpty()) return SelectionLevel(bySelection, child).also { i = src.length } // not a shape this reads
                        var field = first
                        var alias: String? = null
                        if (take(":")) {
                            alias = first
                            field = name()
                        }
                        val hasArgs = at("(") && skipGroup('(', ')')
                        val sub = if (at("{")) level() else null
                        while (at("@") && !src.startsWith("@defer", i)) { take("@"); name() } // @eager, @partial
                        val out = alias ?: field
                        if ((alias != null && alias != field) || hasArgs) bySelection.add(out)
                        child[out] = sub
                    }
                }
            }
            take("}")
            return SelectionLevel(bySelection, child)
        }
    }
}
