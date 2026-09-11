package dev.rayfold.spring

/**
 * The resolver of a query: `@RayfoldQuery("book") public Book book(@Arg String id)`. Parameters take `@Arg` (converted
 * with the application's Jackson mapper), [dev.rayfold.java.Values] for all arguments, or [dev.rayfold.java.Context].
 * The method may return a CompletionStage.
 */
@Target(AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
@MustBeDocumented
annotation class RayfoldQuery(val value: String)

/** The resolver of a command. Return the result, or `Rayfold.result(value)` to add cache patches and events. */
@Target(AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
@MustBeDocumented
annotation class RayfoldCommand(val value: String)

/** The resolver of a stream: return a java.util.stream.Stream or an Iterable; each element becomes one frame. */
@Target(AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
@MustBeDocumented
annotation class RayfoldStream(val value: String)

/**
 * A batch loader for `type.field`: the first parameter is the list of parent objects (a List of your class, or of
 * [dev.rayfold.java.Values]), the result holds one value per parent, in order. Called once per nesting level.
 */
@Target(AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
@MustBeDocumented
annotation class RayfoldField(val type: String, val field: String)

/** Binds a parameter to an argument. The name defaults to the parameter's name, which needs `-parameters` (Spring Boot's build plugins set it). */
@Target(AnnotationTarget.VALUE_PARAMETER)
@Retention(AnnotationRetention.RUNTIME)
@MustBeDocumented
annotation class Arg(val value: String = "")
