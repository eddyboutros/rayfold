package dev.rayfold.spring.scalars;

import com.fasterxml.jackson.annotation.JsonProperty;
import dev.rayfold.spring.RayfoldQuery;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.jackson.autoconfigure.JsonMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;
import tools.jackson.databind.cfg.DateTimeFeature;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;

/**
 * An application whose Jackson writes dates as timestamps, besides its defaults of BigDecimal and long as JSON numbers
 * and bytes as padded base64: none of them the schema's encoding.
 */
@SpringBootApplication
public class ScalarsApplication {
    public record Reading(
        BigDecimal amount, long big, Long small, Instant at, ZonedDateTime zoned, LocalDate day, byte[] raw,
        @JsonProperty("ratio") double fraction) {}

    static final Reading READING = new Reading(
        new BigDecimal("4.20"), 9007199254740993L, 9007199254740991L, Instant.parse("2026-09-15T08:30:00Z"),
        ZonedDateTime.of(2026, 9, 15, 10, 30, 0, 0, ZoneId.of("Europe/Paris")), LocalDate.of(2026, 9, 15),
        new byte[] {(byte) 0xfb, (byte) 0xff}, 0.5);

    @Bean
    SecurityFilterChain security(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(a -> a.anyRequest().permitAll()).csrf(c -> c.ignoringRequestMatchers("/rayfold/**")).build();
    }

    @Bean
    JsonMapperBuilderCustomizer datesAsTimestamps() {
        return builder -> builder.enable(DateTimeFeature.WRITE_DATES_AS_TIMESTAMPS);
    }

    @RayfoldQuery("reading")
    public Reading reading() {
        return READING;
    }
}
