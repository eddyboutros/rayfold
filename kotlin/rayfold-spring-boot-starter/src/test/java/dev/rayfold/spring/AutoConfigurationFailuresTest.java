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

    public static class Fine {
        @RayfoldQuery("book")
        public Object book(@Arg String id) { return null; }
    }

    @Test
    void anOperationTheSchemaDoesNotHaveStopsTheStartup() {
        runner.withBean(UnknownOperation.class).run(ctx ->
            assertThat(ctx).getFailure().rootCause().hasMessageContaining("UnknownOperation.nope: the schema has no operation nope"));
    }

    @Test
    void anArgumentTheOperationDoesNotDeclareStopsTheStartup() {
        runner.withBean(UnknownArgument.class).run(ctx ->
            assertThat(ctx).getFailure().rootCause().hasMessageContaining("UnknownArgument.book: the schema declares no argument isbn (it has id)"));
    }

    @Test
    void aParameterNothingCanFillStopsTheStartup() {
        runner.withBean(UnboundParameter.class).run(ctx ->
            assertThat(ctx).getFailure().rootCause().hasMessageContaining("UnboundParameter.book: parameter id needs @Arg, or the type Values or Context"));
    }

    @Test
    void aMissingSchemaStopsTheStartup() {
        runner.withPropertyValues("rayfold.schema=classpath:missing.rayfold").run(ctx ->
            assertThat(ctx).getFailure().rootCause().hasMessageContaining("Rayfold schema not found at classpath:missing.rayfold"));
    }

    @Test
    void guardCorrectResolversStart() {
        runner.withBean(Fine.class).run(ctx -> {
            assertThat(ctx).hasNotFailed();
            assertThat(ctx).hasSingleBean(RayfoldServer.class);
        });
    }
}
