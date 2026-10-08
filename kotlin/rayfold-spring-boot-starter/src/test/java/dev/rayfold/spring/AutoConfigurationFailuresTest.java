package dev.rayfold.spring;

import dev.rayfold.core.RayfoldServer;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;

import static org.assertj.core.api.Assertions.assertThat;

/** Mistakes the starter catches while the application starts, each with a message that says what to fix. */
class AutoConfigurationFailuresTest {
    final WebApplicationContextRunner runner = new WebApplicationContextRunner().withConfiguration(AutoConfigurations.of(RayfoldAutoConfiguration.class));

    public static class UnknownOperation {
        @RayfoldQuery("nope")
        public String nope() { return ""; }
    }

    public static class UnknownArgument {
        @RayfoldQuery("book")
        public Object book(@Arg String isbn) { return null; }
    }

    public static class UnboundParameter {
        @RayfoldQuery("book")
        public Object book(String id) { return null; }
    }

    public static class UnknownField {
        @RayfoldField(type = "Book", field = "publisher")
        public java.util.List<Object> publisher(java.util.List<Object> parents) { return parents; }
    }

    public static class LoaderWithoutParents {
        @RayfoldField(type = "Book", field = "author")
        public java.util.List<Object> author(String parents) { return java.util.List.of(); }
    }

    public static class Fine {
        @RayfoldQuery("book")
        public Object book(@Arg String id) { return null; }
    }

    @Test
    void anOperationTheSchemaDoesNotHaveStopsTheStartup() {
        runner.withBean(UnknownOperation.class).run(ctx ->
            assertThat(ctx).getFailure().rootCause().hasMessage("AutoConfigurationFailuresTest.UnknownOperation.nope: the schema has no operation nope"));
    }

    @Test
    void anArgumentTheOperationDoesNotDeclareStopsTheStartup() {
        runner.withBean(UnknownArgument.class).run(ctx ->
            assertThat(ctx).getFailure().rootCause().hasMessage("AutoConfigurationFailuresTest.UnknownArgument.book: the schema declares no argument isbn (it has id)"));
    }

    @Test
    void aParameterNothingCanFillStopsTheStartup() {
        runner.withBean(UnboundParameter.class).run(ctx ->
            assertThat(ctx).getFailure().rootCause().hasMessage("AutoConfigurationFailuresTest.UnboundParameter.book: parameter id needs @Arg, or the type Values or Context"));
    }

    @Test
    void aFieldTheSchemaDoesNotHaveStopsTheStartup() {
        runner.withBean(UnknownField.class).run(ctx ->
            assertThat(ctx).getFailure().rootCause().hasMessage("AutoConfigurationFailuresTest.UnknownField.publisher: the schema has no field Book.publisher"));
    }

    @Test
    void aFieldLoaderWhoseFirstParameterIsNotTheParentsStopsTheStartup() {
        runner.withBean(LoaderWithoutParents.class).run(ctx ->
            assertThat(ctx).getFailure().rootCause().hasMessage("AutoConfigurationFailuresTest.LoaderWithoutParents.author: the first parameter of a field loader is the List of parents"));
    }

    @Test
    void aMissingSchemaStopsTheStartup() {
        runner.withPropertyValues("rayfold.schema=classpath:missing.rayfold").run(ctx ->
            assertThat(ctx).getFailure().rootCause().hasMessage("Rayfold schema not found at classpath:missing.rayfold (set rayfold.schema)"));
    }

    @Test
    void guardCorrectResolversStart() {
        runner.withBean(Fine.class).run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx).hasSingleBean(RayfoldServer.class);
        });
    }
}
