package dev.rayfold.core

import java.util.concurrent.ConcurrentHashMap

/** Default views and shape resolution (mirrors packages/server/src/views.ts). */
class Views(private val ir: RayfoldSchemaIR, private val maxInline: Int = 10_000) {
    private val memo = ConcurrentHashMap<String, Shape>()

    /** `Type.default` if declared, else every scalar/enum field (plus `items` for Page). */
    fun defaultShape(t: TypeRef): Shape {
        val name = t.listBase().typeName
        ir.views["$name.default"]?.let { return it.shape }
        return memo.getOrPut(name) {
            val fields = ir.fieldsOf(t) ?: emptyList()
            Shape(fields.filter { it.args.isEmpty() && (ir.isScalarLike(it.type) || (name == "Page" && it.name == "items")) }
                .map { ShapeItem(kind = "field", name = it.name) })
        }
    }

    /** Shapes the server registered ([RayfoldServer.registerShape]); never evicted. */
    private val registry = ConcurrentHashMap<String, Shape>()

    /** Inline shapes clients sent, by id, least recently used first and at most [maxInline]; guarded by its own monitor. */
    private val inline = object : LinkedHashMap<String, Shape>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Shape>?): Boolean = size > maxInline
    }

    /** An op's shape; [inlineId] is set for inline text, which [registerInline] stores once the op passed planning. */
    class Resolved(val shape: Shape, val inlineId: String?)

    fun register(shape: Shape): String {
        val id = Shapes.idOf(Shapes.canonical(shape, ir))
        registry.putIfAbsent(id, shape)
        return id
    }

    fun registerInline(id: String, shape: Shape) {
        if (!registry.containsKey(id)) synchronized(inline) { inline[id] = shape }
    }

    fun resolveRequestShape(text: String?, returns: TypeRef, trustedOnly: Boolean): Resolved {
        if (text == null) return Resolved(defaultShape(returns), null)
        if (Shapes.isShapeId(text)) {
            val known = registry[text] ?: synchronized(inline) { inline[text] } ?: throw RayfoldException(Code.NOT_FOUND, "Unknown shape $text")
            return Resolved(known, null)
        }
        if (trustedOnly) throw RayfoldException(Code.PERMISSION_DENIED, "Only registered shapes are accepted")
        val parsed = Shapes.parse(text)
        return Resolved(parsed, Shapes.idOf(Shapes.canonical(parsed, ir)))
    }
}
