package dev.rayfold.spring.shop;

import dev.rayfold.spring.RayfoldViewerResolver;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.web.SecurityFilterChain;

import java.util.Map;

/** A shop whose users are named by a header, as an API gateway in front of it might do. */
@SpringBootApplication
public class ShopApplication {
    /** Rayfold guards its endpoint against CSRF itself (JSON-only bodies and the Origin check), so Spring's token check is off there. */
    @Bean
    SecurityFilterChain security(HttpSecurity http) throws Exception {
        return http.authorizeHttpRequests(a -> a.anyRequest().permitAll()).csrf(c -> c.ignoringRequestMatchers("/rayfold/**")).build();
    }

    @Bean
    RayfoldViewerResolver viewer() {
        return request -> {
            String user = request.getHeader("X-User");
            return user == null ? null : Map.of("id", user, "role", "customer");
        };
    }
}
