package com.example.bookshop;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import com.sun.net.httpserver.HttpExchange;
import dev.rayfold.core.Code;
import dev.rayfold.java.Rayfold;

import java.net.MalformedURLException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Date;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Who is calling: the bearer token the identity provider issued at sign-in, verified before anything in it is believed. */
public final class Auth {
    private Auth() {}

    /** Signs development tokens when no identity provider is configured. Never set in production. */
    private static final byte[] DEV_SECRET = "bookshop development key, not a secret".getBytes(StandardCharsets.UTF_8);
    private static final String DEV_ISSUER = "http://localhost:4000/dev";
    private static final Pattern BEARER = Pattern.compile("^Bearer (\\S+)$");

    // #region auth
    // In production, AUTH_JWKS_URL and AUTH_ISSUER name your identity provider (Auth0, Entra ID, Keycloak, Cognito, ...).
    // Nimbus fetches its published signing keys, caches them and follows its key rotation.
    private static final DefaultJWTProcessor<SecurityContext> TOKENS = tokens(System.getenv("AUTH_JWKS_URL"), System.getenv("AUTH_ISSUER"));

    private static DefaultJWTProcessor<SecurityContext> tokens(String jwks, String issuer) {
        if (jwks != null && issuer == null) throw new IllegalStateException("AUTH_ISSUER must be set with AUTH_JWKS_URL");
        var tokens = new DefaultJWTProcessor<SecurityContext>();
        try {
            tokens.setJWSKeySelector(jwks != null
                ? new JWSVerificationKeySelector<>(JWSAlgorithm.RS256, JWKSourceBuilder.<SecurityContext>create(URI.create(jwks).toURL()).build())
                : new JWSVerificationKeySelector<>(JWSAlgorithm.HS256, new ImmutableSecret<>(DEV_SECRET)));
        } catch (MalformedURLException e) {
            throw new IllegalArgumentException("AUTH_JWKS_URL is not a URL: " + jwks, e);
        }
        // the audience, the issuer, a subject and an expiry are required; the expiry is checked against the clock
        tokens.setJWTClaimsSetVerifier(new DefaultJWTClaimsVerifier<>(Set.of("bookshop"),
            new JWTClaimsSet.Builder().issuer(jwks != null ? issuer : DEV_ISSUER).build(), Set.of("sub", "exp"), null));
        return tokens;
    }

    /** The viewer the schema's policies see as {@code viewer}, or null for an anonymous request. */
    static Map<String, String> viewerOf(HttpExchange exchange) {
        String authorization = exchange.getRequestHeaders().getFirst("Authorization");
        if (authorization == null) return null;
        Matcher bearer = BEARER.matcher(authorization);
        if (!bearer.matches()) throw Rayfold.error(Code.UNAUTHENTICATED, "Expected Authorization: Bearer <token>");
        JWTClaimsSet claims;
        try {
            claims = TOKENS.process(bearer.group(1), null); // checks the signature and the claims above; nothing is read before both pass
        } catch (Exception e) {
            throw Rayfold.error(Code.UNAUTHENTICATED, "Invalid or expired token");
        }
        // `role` is the claim this provider carries roles in; the schema's rules compare against what it maps to
        return Map.of("id", claims.getSubject(), "role", "staff".equals(claims.getClaim("role")) ? "staff" : "customer");
    }
    // #endregion auth

    /** A token as the identity provider would issue it, signed with the development key: for local runs and tests. */
    public static String devToken(String subject, String role) {
        var now = new Date();
        var claims = new JWTClaimsSet.Builder().subject(subject).issuer(DEV_ISSUER).audience("bookshop").claim("role", role)
            .issueTime(now).expirationTime(new Date(now.getTime() + 8 * 3_600_000L)).build();
        try {
            var jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
            jwt.sign(new MACSigner(DEV_SECRET));
            return jwt.serialize();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Prints a development token: {@code ./mvnw -q compile exec:java -Dexec.mainClass=com.example.bookshop.Auth -Dexec.args=staff} */
    public static void main(String[] args) {
        boolean staff = args.length > 0 && args[0].equals("staff");
        System.out.println(devToken(staff ? "s1" : "u1", staff ? "staff" : "customer"));
    }
}
