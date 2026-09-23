package com.example.bookshop;

import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.JwtClaimValidator;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;
import org.springframework.security.oauth2.server.resource.authentication.JwtGrantedAuthoritiesConverter;
import org.springframework.security.web.SecurityFilterChain;

import java.util.List;

// #region auth
@Configuration
public class SecurityConfig {
    @Bean
    SecurityFilterChain security(HttpSecurity http) throws Exception {
        return http
            .authorizeHttpRequests(requests -> requests.anyRequest().permitAll())
            // every bearer token is a JWT whose signature, issuer, audience and expiry Spring checks before the request
            // goes on; the issuer and its signing keys are configured in application.properties
            .oauth2ResourceServer(oauth2 -> oauth2.jwt(jwt -> jwt.jwtAuthenticationConverter(roles())))
            // Rayfold checks the Origin and content type of every request that can change data itself
            .csrf(csrf -> csrf.ignoringRequestMatchers("/rayfold/**"))
            .build();
    }

    // The starter turns the signed-in principal into the viewer: its name, the token's `sub`, is viewer.id, and its
    // first role viewer.role. `role` is the claim this provider carries roles in.
    private static JwtAuthenticationConverter roles() {
        var authorities = new JwtGrantedAuthoritiesConverter();
        authorities.setAuthoritiesClaimName("role");
        authorities.setAuthorityPrefix("ROLE_");
        var converter = new JwtAuthenticationConverter();
        converter.setJwtGrantedAuthoritiesConverter(authorities);
        return converter;
    }
}
// #endregion auth

/**
 * With no identity provider configured, tokens are signed and checked with a development key (see {@link DevTokens}),
 * so the example runs on its own. Setting spring.security.oauth2.resourceserver.jwt.issuer-uri turns this off.
 */
@Configuration
@ConditionalOnExpression("'${spring.security.oauth2.resourceserver.jwt.issuer-uri:}' == ''")
class DevelopmentTokens {
    @Bean
    JwtDecoder developmentDecoder() {
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(DevTokens.KEY).build();
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(
            JwtValidators.createDefaultWithIssuer(DevTokens.ISSUER),
            new JwtClaimValidator<List<String>>("aud", aud -> aud != null && aud.contains("bookshop"))));
        return decoder;
    }
}
