package com.example.bookshop;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;

import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Date;

/**
 * Tokens as an identity provider would issue them at sign-in, signed with a development key: for local runs and tests,
 * never production. {@code ./mvnw -q compile exec:java -Dexec.args=staff} prints one.
 */
public final class DevTokens {
    private DevTokens() {}

    static final SecretKey KEY = new SecretKeySpec("bookshop development key, not a secret".getBytes(StandardCharsets.UTF_8), "HmacSHA256");
    static final String ISSUER = "http://localhost:4000/dev";

    public static String token(String subject, String role) {
        var now = new Date();
        var claims = new JWTClaimsSet.Builder().subject(subject).issuer(ISSUER).audience("bookshop").claim("role", role)
            .issueTime(now).expirationTime(new Date(now.getTime() + 8 * 3_600_000L)).build();
        try {
            var jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
            jwt.sign(new MACSigner(KEY));
            return jwt.serialize();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
    }

    public static void main(String[] args) {
        boolean staff = args.length > 0 && args[0].equals("staff");
        System.out.println(token(staff ? "s1" : "u1", staff ? "staff" : "customer"));
    }
}
