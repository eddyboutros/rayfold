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
            // what a value compared with each column must be; an enum compares as its name
            scalars = def.fields.associate { f ->
                val base = f.type.baseName()
                f.name to if (f.type.isList) "list" else if (opts.ir.types[base]?.kind == "enum") "String" else base
            },
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
        if (keys.isEmpty()) return values.map { JdbcPage(emptyList(), null, false, 0) }
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
            "not" -> {
                val before = params.size
                val inner = compile(e["e"] as? JsonObject ?: return loose, env, t, params)
                // negating a superset would give a subset, so only an exact fragment can be negated. The values a
                // dropped fragment bound go with it: JDBC refuses a statement handed more parameters than it reads
                if (!inner.exact) while (params.size > before) params.removeAt(params.size - 1)
                if (inner.exact) Frag("(NOT COALESCE(${inner.sql}, FALSE))", true) else loose
            }
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
        val field = fieldOf(left, t) ?: fieldOf(right, t) ?: return loose
        val onLeft = fieldOf(left, t) != null
        // `list in field` asks whether a list is an element of the field, which no column comparison says
        if (op == "in" && !onLeft) return loose
        val other = if (onLeft) right else left
        if (readsRow(other)) return loose
        val value = try {
            Expr.eval(other, env)
        } catch (_: Throwable) {
            return loose
        }
        val column = quote(t.columns.getValue(field))
        return when (op) {
            "==" -> if (value is JsonNull) Frag("($column IS NULL)", true) else operand(t, field, column, value)?.let { (expr, p) -> params.add(p); Frag("($expr = ?)", true) } ?: loose
            // a null column is not equal to a value, and SQL would drop it, so it is named here
            "!=" -> if (value is JsonNull) Frag("($column IS NOT NULL)", true) else operand(t, field, column, value)?.let { (expr, p) -> params.add(p); Frag("($column IS NULL OR $expr <> ?)", true) } ?: loose
            "in" -> {
                val list = value as? JsonArray ?: return loose
                // every item must be a value the column can be compared with: a null in the list matches a null
                // column in the policy, which IN does not say, so a list holding one is left to the runtime
                val items = list.map { operand(t, field, column, it) ?: return loose }
                if (items.isEmpty()) Frag("FALSE", true) else Frag("(${items[0].first} IN (${items.joinToString(", ") { "?" }}))", true).also { params.addAll(items.map { it.second }) }
            }
            else -> loose // ordering comparisons differ between SQL and the expression language: leave them
        }
    }

    /** The field a single-segment path into the row names, when it has a column; null for anything else. */
    private fun fieldOf(e: JsonObject, t: Table): String? {
        if (e["k"]?.jsonPrimitive?.content != "path") return null
        if ((e["root"]?.jsonPrimitive?.content ?: "this") != "this") return null
        val path = e["path"] as? JsonArray ?: return null
        if (path.size != 1) return null
        return path[0].jsonPrimitive.content.takeIf { it in t.columns }
    }

    /**
     * The column and the parameter that compare [field] with [v] as the policy would, or null when they cannot: a
     * value of another kind than the field's, which the runtime compares by its own rules.
     */
    private fun operand(t: Table, field: String, column: String, v: JsonElement): Pair<String, Any>? {
        val p = v as? JsonPrimitive ?: return null
        if (p is JsonNull) return null
        val param: Any? = when (t.scalars[field]) {
            "ID", "String" -> if (p.isString) Literal(p.content) else null
            "Int" -> if (p.isString) null else p.content.toLongOrNull()?.let { Literal(it.toString()) }
            "Float" -> if (p.isString) null else p.content.toBigDecimalOrNull()?.let { Literal(it.toPlainString()) }
            // Long and Decimal may travel as text
            "Long" -> p.content.toLongOrNull()?.let { Literal(it.toString()) }
            "Decimal" -> p.content.toBigDecimalOrNull()?.let { Literal(it.toPlainString()) }
            "Boolean" -> if (p.isString) null else p.content.toBooleanStrictOrNull()
            else -> null
        }
        return param?.let { column to it }
    }

    /**
     * A value the database types from the column it meets, as it types a literal. Bound as text it would be `varchar`,
     * and Postgres has no `uuid = varchar`, `int = varchar` or enum equivalent; bound as `numeric`, an integer column
     * would be cast and lose its index. Postgres is handed it untyped, so it takes the column's type; other databases
     * convert text themselves.
     */
    private class Literal(val text: String)

    private val postgres: Boolean by lazy { connections().use { it.metaData.databaseProductName == "PostgreSQL" } }

    private fun bindAll(statement: java.sql.PreparedStatement, params: List<Any?>) = params.forEachIndexed { i, p ->
        when (p) {
            is Literal -> if (postgres) statement.setObject(i + 1, p.text, java.sql.Types.OTHER) else statement.setString(i + 1, p.text)
            else -> statement.setObject(i + 1, p)
        }
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
                // a resolver asking for equality means it, whatever kind the value arrived as: the database converts it
                val (expr, p) = operand(t, field, column, value) ?: (column to Literal(text(value) ?: error("rayfold-jdbc: ${t.name}.$field cannot be compared with $value")))
                params.add(p)
                "$expr = ?"
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
            bindAll(statement, params)
            statement.executeQuery().use { rows -> read(t, rows) }
        }
    }

    private fun scalarInt(sql: String, params: List<Any?>): Int = connections().use { connection ->
        connection.prepareStatement(sql).use { statement ->
            bindAll(statement, params)
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
        /** Each field's scalar type, as `operand` compares it. */
        val scalars: Map<String, String>,
    )

    private companion object {
        const val TOTAL = "__total"
        const val ROW_NUMBER = "__n"

        fun quote(name: String): String = "\"" + name.replace("\"", "\"\"") + "\""

        fun snake(name: String): String = name.replace(Regex("([a-z0-9])([A-Z])"), "$1_$2").lowercase()

        fun text(v: JsonElement?): String? = (v as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

        /**
         * A JDBC value as JSON: numbers and booleans keep their kind, everything else travels as text. A point in time
         * is written as RFC 3339 UTC (spec 01), where its `toString` prints the JVM's wall clock or the stored offset; a
         * `java.sql.Date` already prints its `YYYY-MM-DD`.
         */
        fun json(v: Any?): JsonElement = when (v) {
            null -> JsonNull
            is Boolean -> JsonPrimitive(v)
            is Int, is Long, is Short, is Byte -> JsonPrimitive(v as Number)
            is Double, is Float -> JsonPrimitive(v as Number)
            is java.math.BigDecimal -> JsonPrimitive(v.toPlainString())
            is java.sql.Timestamp -> JsonPrimitive(v.toInstant().toString())
            is java.time.OffsetDateTime -> JsonPrimitive(v.toInstant().toString())
            else -> JsonPrimitive(v.toString())
        }

    }
}

enum class Naming { SAME, SNAKE }

/** One table behind a type: where it lives, its key column, and any column whose name differs from the field's. */
data class JdbcTable(val table: String, val id: String = "id", val columns: Map<String, String> = emptyMap())

data class JdbcStoreOptions(val ir: RayfoldSchemaIR, val tables: Map<String, JdbcTable>, val naming: Naming = Naming.SAME)

/** A page of rows: what the runtime's `Page<T>` needs. */
data class JdbcPage(val items: List<JsonObject>, val cursor: String?, val hasMore: Boolean, val total: Int)
