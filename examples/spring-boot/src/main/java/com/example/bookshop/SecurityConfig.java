package com.example.bookshop;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.oauth2.core.DefaultOAuth2AuthenticatedPrincipal;
import org.springframework.security.oauth2.core.OAuth2AuthenticatedPrincipal;
import org.springframework.security.oauth2.server.resource.introspection.BadOpaqueTokenException;
import org.springframework.security.oauth2.server.resource.introspection.OpaqueTokenIntrospector;
import org.springframework.security.web.SecurityFilterChain;

import java.util.Map;
import java.util.Optional;

// #region auth
@Configuration
public class SecurityConfig {
    @Bean
    SecurityFilterChain security(HttpSecurity http) throws Exception {
        return http
            .authorizeHttpRequests(requests -> requests.anyRequest().permitAll())
            .oauth2ResourceServer(oauth2 -> oauth2.opaqueToken(Customizer.withDefaults()))
            // Rayfold checks the Origin and content type of every request that can change data itself
            .csrf(csrf -> csrf.ignoringRequestMatchers("/rayfold/**"))
            .build();
    }

    // Two fixed tokens stand in for real authentication; a real application asks its authorization server here.
    // The starter turns the signed-in principal into the viewer: its name is viewer.id and its first role viewer.role.
    @Bean
    OpaqueTokenIntrospector tokens() {
        Map<String, OAuth2AuthenticatedPrincipal> principals = Map.of(
            "customer", principal("u1", "customer"),
            "staff", principal("s1", "staff"));
        return token -> Optional.ofNullable(principals.get(token))
            .orElseThrow(() -> new BadOpaqueTokenException("Unknown token"));
    }

    private static OAuth2AuthenticatedPrincipal principal(String id, String role) {
        return new DefaultOAuth2AuthenticatedPrincipal(id, Map.of("sub", id), AuthorityUtils.createAuthorityList("ROLE_" + role));
    }
}
// #endregion auth
