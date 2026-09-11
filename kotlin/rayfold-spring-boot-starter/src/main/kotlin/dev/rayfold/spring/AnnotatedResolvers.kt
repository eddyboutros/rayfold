package dev.rayfold.spring

import dev.rayfold.core.RayfoldContext
import dev.rayfold.core.RayfoldSchemaIR
import dev.rayfold.java.CommandOutcome
import dev.rayfold.java.Context
import dev.rayfold.java.ServerBuilder
import dev.rayfold.java.Values
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import org.springframework.aop.support.AopUtils
import org.springframework.context.ApplicationContext
import org.springframework.core.annotation.AnnotatedElementUtils
import org.springframework.util.ClassUtils
import org.springframework.util.ReflectionUtils
import tools.jackson.databind.JavaType
import tools.jackson.databind.ObjectMapper
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.util.concurrent.CompletionStage
import java.util.stream.Stream

/**
 * Finds `@RayfoldQuery`, `@RayfoldCommand`, `@RayfoldStream` and `@RayfoldField` methods on the application's beans
 * and binds them to a [ServerBuilder]. Arguments and results go through the application's Jackson mapper, so records,
 * java.time types and Jackson annotations work as they do in Spring MVC. Every mistake that can be caught at startup
 * (an operation or argument the schema does not have, a parameter nothing can fill) fails the startup with its reason.
 */
internal class AnnotatedResolvers(private val context: ApplicationContext, private val mapper: ObjectMapper, private val ir: RayfoldSchemaIR) {
    private sealed interface Param
    private class ArgParam(val name: String, val type: JavaType) : Param
    private class ParentsParam(val element: JavaType) : Param
    private data object AllArgs : Param
    private data object ContextParam : Param
    private data object RawContextParam : Param

    private val annotations = listOf(RayfoldQuery::class.java, RayfoldCommand::class.java, RayfoldStream::class.java, RayfoldField::class.java)

    /** Binds every annotated method; returns one line per binding ("query book -> BookResolvers.book") for the log. */
    fun bindTo(builder: ServerBuilder): List<String> {
        val bound = mutableListOf<String>()
        for (name in context.beanDefinitionNames) {
            val type = context.getType(name, false) ?: continue
            val methods = ReflectionUtils.getUniqueDeclaredMethods(ClassUtils.getUserClass(type)).filter { m -> annotations.any { AnnotatedElementUtils.hasAnnotation(m, it) } }
            if (methods.isEmpty()) continue
            val bean = context.getBean(name)
            for (m in methods) bound += bind(builder, bean, m)
        }
        return bound
    }

    private fun bind(builder: ServerBuilder, bean: Any, m: Method): String {
        val invocable = AopUtils.selectInvocableMethod(m, bean.javaClass).also { ReflectionUtils.makeAccessible(it) }
        val where = "${ClassUtils.getShortName(m.declaringClass)}.${m.name}"
        val async = CompletionStage::class.java.isAssignableFrom(m.returnType)
        AnnotatedElementUtils.findMergedAnnotation(m, RayfoldQuery::class.java)?.let { q ->
            val params = params(m, where, argNames(q.value, where), parents = false)
            if (async) builder.queryAsync(q.value) { args, ctx -> stage(call(bean, invocable, params, args, ctx, null), where).thenApply { json(it) } }
            else builder.query(q.value) { args, ctx -> json(call(bean, invocable, params, args, ctx, null)) }
            return "query ${q.value} -> $where"
        }
        AnnotatedElementUtils.findMergedAnnotation(m, RayfoldCommand::class.java)?.let { c ->
            val params = params(m, where, argNames(c.value, where), parents = false)
            if (async) builder.commandAsync(c.value) { args, ctx -> stage(call(bean, invocable, params, args, ctx, null), where).thenApply { result(it) } }
            else builder.command(c.value) { args, ctx -> result(call(bean, invocable, params, args, ctx, null)) }
            return "command ${c.value} -> $where"
        }
        AnnotatedElementUtils.findMergedAnnotation(m, RayfoldStream::class.java)?.let { s ->
            val params = params(m, where, argNames(s.value, where), parents = false)
            builder.stream(s.value) { args, ctx ->
                when (val r = call(bean, invocable, params, args, ctx, null)) {
                    is Stream<*> -> r.map { json(it) }
                    is Iterable<*> -> r.map { json(it) }.stream()
                    else -> throw IllegalStateException("$where must return a Stream or an Iterable, not ${r?.javaClass?.name}")
                }
            }
            return "stream ${s.value} -> $where"
        }
        val f = AnnotatedElementUtils.findMergedAnnotation(m, RayfoldField::class.java) ?: throw IllegalStateException("$where carries no Rayfold annotation")
        val field = ir.types[f.type]?.fields?.find { it.name == f.field } ?: throw IllegalStateException("$where: the schema has no field ${f.type}.${f.field}")
        val params = params(m, where, field.args.map { it.name }.toSet(), parents = true)
        val parents = params.first() as ParentsParam
        fun parentsOf(values: List<Values>): List<Any?> =
            if (parents.element.rawClass == Values::class.java) values else values.map { mapper.readValue(it.json().toString(), parents.element) }
        if (async) {
            builder.fieldAsync(f.type, f.field) { ps, args, ctx -> stage(call(bean, invocable, params, args, ctx, parentsOf(ps)), where).thenApply { r -> list(r, where).map { json(it) } } }
        } else {
            builder.field(f.type, f.field) { ps, args, ctx -> list(call(bean, invocable, params, args, ctx, parentsOf(ps)), where).map { json(it) } }
        }
        return "field ${f.type}.${f.field} -> $where"
    }

    private fun argNames(op: String, where: String): Set<String> =
        ir.ops[op]?.args?.map { it.name }?.toSet() ?: throw IllegalStateException("$where: the schema has no operation $op")

    private fun params(m: Method, where: String, known: Set<String>, parents: Boolean): List<Param> = m.parameters.mapIndexed { i, p ->
        when {
            parents && i == 0 -> {
                if (!List::class.java.isAssignableFrom(p.type)) throw IllegalStateException("$where: the first parameter of a field loader is the List of parents")
                ParentsParam(mapper.constructType(p.parameterizedType).contentType)
            }
            p.type == Values::class.java -> AllArgs
            p.type == Context::class.java -> ContextParam
            p.type == RayfoldContext::class.java -> RawContextParam
            else -> {
                val arg = p.getAnnotation(Arg::class.java) ?: throw IllegalStateException("$where: parameter ${p.name} needs @Arg, or the type Values or Context")
                val name = arg.value.ifEmpty {
                    if (p.isNamePresent) p.name else throw IllegalStateException("$where: compile with -parameters, or name the argument: @Arg(\"...\")")
                }
                if (name !in known) throw IllegalStateException("$where: the schema declares no argument $name (it has ${known.sorted().joinToString().ifEmpty { "none" }})")
                ArgParam(name, mapper.constructType(p.parameterizedType))
            }
        }
    }

    private fun call(bean: Any, m: Method, params: List<Param>, args: Values, ctx: Context, parents: List<Any?>?): Any? {
        val values = params.map { p ->
            when (p) {
                is ArgParam -> args.json()[p.name]?.let { mapper.readValue<Any?>(it.toString(), p.type) }
                is ParentsParam -> parents
                AllArgs -> args
                ContextParam -> ctx
                RawContextParam -> ctx.raw()
            }
        }
        return try {
            m.invoke(bean, *values.toTypedArray())
        } catch (e: InvocationTargetException) {
            throw e.targetException
        }
    }

    private fun stage(v: Any?, where: String): CompletionStage<*> = v as? CompletionStage<*> ?: throw IllegalStateException("$where returned null instead of a CompletionStage")

    private fun list(v: Any?, where: String): List<*> = v as? List<*> ?: throw IllegalStateException("$where must return a List, one value per parent")

    /** JSON for a result, through the application's Jackson mapper. */
    private fun json(v: Any?): JsonElement = when (v) {
        null -> JsonNull
        is JsonElement -> v
        else -> Json.parseToJsonElement(mapper.writeValueAsString(v))
    }

    private fun result(v: Any?): Any? = v as? CommandOutcome ?: json(v)
}
