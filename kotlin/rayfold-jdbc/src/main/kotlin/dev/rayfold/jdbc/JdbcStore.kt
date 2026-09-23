package dev.rayfold.jdbc

import dev.rayfold.core.Expr
import dev.rayfold.core.ExprEnv
import dev.rayfold.core.RayfoldContext
import dev.rayfold.core.RayfoldSchemaIR
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.sql.Connection
import java.sql.ResultSet

/**
 * A SQL database behind Rayfold resolvers, the JVM counterpart of `@rayfold/postgres`: batch loads by id, keyset
 * pages, one query for a whole level of one-to-many pages, and read policies pushed into the `WHERE` clause
 * (spec 06 section 4), so a list never fetches rows its viewer may not see.
 *
 * Only JDBC is required; the SQL is plain enough for Postgres, H2 and friends. Every value travels as a bound
 * parameter and every identifier is quoted.
 *
 * The pushed-down filter is a **superset** of the policy: it may let through a row the policy denies, which the
 * runtime's own check then removes, but it never drops a row the policy allows. Anything it cannot translate exactly
 * (ordering comparisons, comparisons across types) is left to the runtime.
 */
class JdbcStore(private val connections: () -> Connection, private val opts: JdbcStoreOptions) {
    private val tables: Map<String, Table> = opts.tables.mapValues { (type, mapping) ->
        val def = opts.ir.types[type] ?: error("rayfold-jdbc: $type is not a type of the schema")
        require(def.hasFields) { "rayfold-jdbc: $type has no fields" }
        val columns = LinkedHashMap<String, String>()
        for (f in def.fields) columns[f.name] = mapping.columns[f.name] ?: if (opts.naming == Naming.SNAKE) snake(f.name) else f.name
        val idColumn = mapping.id
        Table(
            name = mapping.table.split(".").joinToString(".") { quote(it) },
            id = quote(idColumn),
            idField = columns.entries.firstOrNull { it.value == idColumn }?.key ?: "id",
            columns = columns,
            fieldOf = columns.entries.associate { (f, c) -> c to f },
        )
    }

    /** Rows for [ids] in the order asked, with null where a row is missing or hidden by the pushed-down policy. */
    fun byIds(type: String, ids: List<JsonElement?>, ctx: RayfoldContext? = null): List<JsonObject?> {
        if (ids.isEmpty()) return emptyList()
        val t = table(type)
        val wanted = ids.mapNotNull { text(it) }.distinct()
        if (wanted.isEmpty()) return ids.map { null }
        val params = mutableListOf<Any?>()
        val conds = mutableListOf(inList("CAST(${t.id} AS VARCHAR)", wanted, params))
        policyWhere(t, ctx, params)?.let { conds.add(it) }
        val rows = query(t, "SELECT * FROM ${t.name} WHERE ${conds.joinToString(" AND ")}", params)
        val byId = rows.associateBy { text(it[t.idField]) }
        return ids.map { id -> text(id)?.let { byId[it] } }
    }

    /** Rows whose fields equal [where], in key order. One query. */
    fun find(type: String, where: Map<String, JsonElement?> = emptyMap(), ctx: RayfoldContext? = null): List<JsonObject> {
        val t = table(type)
        val params = mutableListOf<Any?>()
        val conds = equalities(t, where, params).toMutableList()
        policyWhere(t, ctx, params)?.let { conds.add(it) }
        val sql = "SELECT * FROM ${t.name}" + (if (conds.isEmpty()) "" else " WHERE ${conds.joinToString(" AND ")}") + " ORDER BY ${t.id}"
        return query(t, sql, params)
    }

    /** One page in key order, after the [after] cursor, with `total` counting every row the viewer may see. */
    fun page(type: String, first: Int, after: String? = null, where: Map<String, JsonElement?> = emptyMap(), ctx: RayfoldContext? = null): JdbcPage {
        val t = table(type)
        val params = mutableListOf<Any?>()
        val conds = equalities(t, where, params).toMutableList()
        policyWhere(t, ctx, params)?.let { conds.add(it) }
        val filtered = "SELECT *, COUNT(*) OVER () AS \"__total\" FROM ${t.name}" + (if (conds.isEmpty()) "" else " WHERE ${conds.joinToString(" AND ")}")
        var sql = "SELECT * FROM ($filtered) AS \"__s\""
        if (after != null) {
            sql += " WHERE CAST(\"__s\".${t.id} AS VARCHAR) > ?"
            params.add(after)
        }
        sql += " ORDER BY CAST(\"__s\".${t.id} AS VARCHAR) LIMIT ?"
        params.add(first + 1)
        val rows = query(t, sql, params)
        var total = rows.firstOrNull()?.get(TOTAL)?.let { (it as? JsonPrimitive)?.content?.toIntOrNull() } ?: 0
        if (rows.isEmpty() && after != null) {
            val countParams = mutableListOf<Any?>()
            val countConds = equalities(t, where, countParams).toMutableList()
            policyWhere(t, ctx, countParams)?.let { countConds.add(it) }
            val countSql = "SELECT COUNT(*) AS \"n\" FROM ${t.name}" + (if (countConds.isEmpty()) "" else " WHERE ${countConds.joinToString(" AND ")}")
            total = scalarInt(countSql, countParams)
        }
        return pageOf(t, rows, first, total)
    }

    /**
     * For each parent key in [values], the page of rows whose [field] equals it: the batch loader for a paged
     * one-to-many field. One query for the whole level, whatever the number of parents.
     */
    fun pagesByField(type: String, field: String, values: List<JsonElement?>, first: Int, ctx: RayfoldContext? = null): List<JdbcPage> {
        if (values.isEmpty()) return emptyList()
        val t = table(type)
        val column = t.columns[field]?.let { quote(it) } ?: error("rayfold-jdbc: $type has no field $field")
        val keys = values.mapNotNull { text(it) }.distinct()
        val params = mutableListOf<Any?>()
        val conds = mutableListOf(inList("CAST($column AS VARCHAR)", keys, params))
        policyWhere(t, ctx, params)?.let { conds.add(it) }
        val numbered =
            "SELECT *, COUNT(*) OVER (PARTITION BY $column) AS \"__total\", " +
                "ROW_NUMBER() OVER (PARTITION BY $column ORDER BY CAST(${t.id} AS VARCHAR)) AS \"__n\" " +
                "FROM ${t.name} WHERE ${conds.joinToString(" AND ")}"
        params.add(first + 1)
        val rows = query(t, "SELECT * FROM ($numbered) AS \"__s\" WHERE \"__s\".\"__n\" <= ? ORDER BY CAST(\"__s\".${t.id} AS VARCHAR)", params)
        val grouped = rows.groupBy { text(it[field]) }
        return values.map { v ->
            val group = grouped[text(v)] ?: return@map JdbcPage(emptyList(), null, false, 0)
            pageOf(t, group, first, (group.first()[TOTAL] as? JsonPrimitive)?.content?.toIntOrNull() ?: group.size)
        }
    }

    // ------------------------------------------------------------------ the policy, as SQL

    /** The WHERE fragment for the read policy the runtime pushed down, or null when there is none to push. */
    private fun policyWhere(t: Table, ctx: RayfoldContext?, params: MutableList<Any?>): String? {
        val filter = ctx?.policy ?: return null
        val env = ExprEnv(ctx.viewer, JsonObject(emptyMap()), JsonNull)
        val frag = compile(filter, env, t, params)
        return if (frag.sql == "TRUE") null else frag.sql
    }

    private data class Frag(val sql: String, val exact: Boolean)

    private val loose = Frag("TRUE", false)

    private fun compile(e: JsonObject, env: ExprEnv, t: Table, params: MutableList<Any?>): Frag {
        if (!readsRow(e)) {
            return try {
                Frag(if (Expr.truthy(Expr.eval(e, env))) "TRUE" else "FALSE", true)
            } catch (_: Throwable) {
                loose // an expression that cannot be evaluated denies, but maybe only where it is reached
            }
        }
        return when (e["k"]?.jsonPrimitive?.content) {
            // SQL reads a comparison with a null column as unknown, and NOT unknown drops the row; the policy reads it as
            // false, so its negation keeps the row. COALESCE gives SQL the policy's reading before negating.
            "not" -> compile(e["e"] as? JsonObject ?: return loose, env, t, params).let { if (it.exact) Frag("(NOT COALESCE(${it.sql}, FALSE))", true) else loose }
            "bin" -> binary(e, env, t, params)
            else -> loose
        }
    }

    private fun binary(e: JsonObject, env: ExprEnv, t: Table, params: MutableList<Any?>): Frag {
        val op = e["op"]?.jsonPrimitive?.content
        val left = e["l"] as? JsonObject ?: return loose
        val right = e["r"] as? JsonObject ?: return loose
        if (op == "&&" || op == "||") {
            // a side this cannot translate becomes TRUE, which keeps the result a superset of what the policy allows
            val l = compile(left, env, t, params)
            val r = compile(right, env, t, params)
            return Frag("(${l.sql} ${if (op == "&&") "AND" else "OR"} ${r.sql})", l.exact && r.exact)
        }
        val column = columnOf(left, t) ?: columnOf(right, t) ?: return loose
        val other = if (columnOf(left, t) != null) right else left
        if (readsRow(other)) return loose
        val value = try {
            Expr.eval(other, env)
        } catch (_: Throwable) {
            return loose
        }
        return when (op) {
            "==" -> if (value is JsonNull) Frag("($column IS NULL)", true) else Frag("($column = ?)", true).also { params.add(bind(value) ?: return loose) }
            // a null column is not equal to a value, and SQL would drop it, so it is named here
            "!=" -> if (value is JsonNull) Frag("($column IS NOT NULL)", true) else Frag("($column IS NULL OR $column <> ?)", true).also { params.add(bind(value) ?: return loose) }
            "in" -> {
                val items = (value as? JsonArray)?.mapNotNull { bind(it) } ?: return loose
                if (items.isEmpty()) Frag("FALSE", true) else Frag("($column IN (${items.joinToString(", ") { "?" }}))", true).also { params.addAll(items) }
            }
            else -> loose // ordering comparisons differ between SQL and the expression language: leave them
        }
    }

    /** The column a single-segment path into the row names, or null for anything else. */
    private fun columnOf(e: JsonObject, t: Table): String? {
        if (e["k"]?.jsonPrimitive?.content != "path") return null
        if ((e["root"]?.jsonPrimitive?.content ?: "this") != "this") return null
        val path = e["path"] as? JsonArray ?: return null
        if (path.size != 1) return null
        return t.columns[path[0].jsonPrimitive.content]?.let { quote(it) }
    }

    private fun readsRow(e: JsonElement): Boolean = when (e) {
        is JsonObject ->
            if (e["k"]?.jsonPrimitive?.content == "path") (e["root"]?.jsonPrimitive?.content ?: "this") == "this"
            else e.values.any { readsRow(it) }
        is JsonArray -> e.any { readsRow(it) }
        else -> false
    }

    // ------------------------------------------------------------------ plumbing

    private fun equalities(t: Table, where: Map<String, JsonElement?>, params: MutableList<Any?>): List<String> =
        where.map { (field, value) ->
            val column = t.columns[field]?.let { quote(it) } ?: error("rayfold-jdbc: ${t.name} has no field $field")
            if (value == null || value is JsonNull) {
                "$column IS NULL"
            } else {
                params.add(bind(value))
                "$column = ?"
            }
        }

    private fun inList(expr: String, values: List<String>, params: MutableList<Any?>): String {
        params.addAll(values)
        return "$expr IN (${values.joinToString(", ") { "?" }})"
    }

    private fun pageOf(t: Table, rows: List<JsonObject>, first: Int, total: Int): JdbcPage {
        val items = rows.take(first).map { JsonObject(it - TOTAL - ROW_NUMBER) }
        return JdbcPage(
            items = items,
            cursor = items.lastOrNull()?.let { text(it[t.idField]) },
            hasMore = rows.size > first,
            total = total,
        )
    }

    private fun query(t: Table, sql: String, params: List<Any?>): List<JsonObject> = connections().use { connection ->
        connection.prepareStatement(sql).use { statement ->
            params.forEachIndexed { i, p -> statement.setObject(i + 1, p) }
            statement.executeQuery().use { rows -> read(t, rows) }
        }
    }

    private fun scalarInt(sql: String, params: List<Any?>): Int = connections().use { connection ->
        connection.prepareStatement(sql).use { statement ->
            params.forEachIndexed { i, p -> statement.setObject(i + 1, p) }
            statement.executeQuery().use { rows -> if (rows.next()) rows.getInt(1) else 0 }
        }
    }

    private fun read(t: Table, rows: ResultSet): List<JsonObject> {
        val meta = rows.metaData
        val out = mutableListOf<JsonObject>()
        while (rows.next()) {
            out.add(
                buildJsonObject {
                    for (i in 1..meta.columnCount) {
                        val label = meta.getColumnLabel(i)
                        val name = if (label == TOTAL || label == ROW_NUMBER) label else t.fieldOf[label] ?: t.fieldOf[label.lowercase()] ?: label.lowercase()
                        put(name, json(rows.getObject(i)))
                    }
                },
            )
        }
        return out
    }

    private fun table(type: String): Table = tables[type] ?: error("rayfold-jdbc: no table mapped for $type")

    private class Table(
        val name: String,
        val id: String,
        val idField: String,
        val columns: Map<String, String>,
        val fieldOf: Map<String, String>,
    )

    private companion object {
        const val TOTAL = "__total"
        const val ROW_NUMBER = "__n"

        fun quote(name: String): String = "\"" + name.replace("\"", "\"\"") + "\""

        fun snake(name: String): String = name.replace(Regex("([a-z0-9])([A-Z])"), "$1_$2").lowercase()

        fun text(v: JsonElement?): String? = (v as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

        /** A JDBC value as JSON: numbers and booleans keep their kind, everything else travels as text. */
        fun json(v: Any?): JsonElement = when (v) {
            null -> JsonNull
            is Boolean -> JsonPrimitive(v)
            is Int, is Long, is Short, is Byte -> JsonPrimitive(v as Number)
            is Double, is Float -> JsonPrimitive(v as Number)
            is java.math.BigDecimal -> JsonPrimitive(v.toPlainString())
            else -> JsonPrimitive(v.toString())
        }

        /** A JSON value as a JDBC parameter; null when it is not a value a column can be compared with. */
        fun bind(v: JsonElement): Any? = when {
            v is JsonNull -> null
            v is JsonPrimitive && v.isString -> v.content
            v is JsonPrimitive -> v.content.toLongOrNull() ?: v.content.toDoubleOrNull() ?: v.content
            else -> null
        }
    }
}

enum class Naming { SAME, SNAKE }

/** One table behind a type: where it lives, its key column, and any column whose name differs from the field's. */
data class JdbcTable(val table: String, val id: String = "id", val columns: Map<String, String> = emptyMap())

data class JdbcStoreOptions(val ir: RayfoldSchemaIR, val tables: Map<String, JdbcTable>, val naming: Naming = Naming.SAME)

/** A page of rows: what the runtime's `Page<T>` needs. */
data class JdbcPage(val items: List<JsonObject>, val cursor: String?, val hasMore: Boolean, val total: Int)
