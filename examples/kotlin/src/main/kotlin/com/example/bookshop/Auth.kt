package com.example.bookshop

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.MACSigner
import com.nimbusds.jose.jwk.source.ImmutableSecret
import com.nimbusds.jose.jwk.source.JWKSourceBuilder
import com.nimbusds.jose.proc.JWSVerificationKeySelector
import com.nimbusds.jose.proc.SecurityContext
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier
import com.nimbusds.jwt.proc.DefaultJWTProcessor
import com.sun.net.httpserver.HttpExchange
import dev.rayfold.core.Code
import dev.rayfold.core.RayfoldException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URI
import java.util.Date

/** Signs development tokens when no identity provider is configured. Never set in production. */
private val DEV_SECRET = "bookshop development key, not a secret".toByteArray()
private const val DEV_ISSUER = "http://localhost:4000/dev"

// #region auth
// In production, AUTH_JWKS_URL and AUTH_ISSUER name your identity provider (Auth0, Entra ID, Keycloak, Cognito, ...).
// Nimbus fetches its published signing keys, caches them and follows its key rotation.
private val jwks: String? = System.getenv("AUTH_JWKS_URL")

private val tokens = DefaultJWTProcessor<SecurityContext>().apply {
    jwsKeySelector = if (jwks != null) {
        JWSVerificationKeySelector(JWSAlgorithm.RS256, JWKSourceBuilder.create<SecurityContext>(URI(jwks).toURL()).build())
    } else {
        JWSVerificationKeySelector(JWSAlgorithm.HS256, ImmutableSecret(DEV_SECRET))
    }
    val issuer = if (jwks != null) System.getenv("AUTH_ISSUER") ?: error("AUTH_ISSUER must be set with AUTH_JWKS_URL") else DEV_ISSUER
    // the audience, the issuer, a subject and an expiry are required; the expiry is checked against the clock
    jwtClaimsSetVerifier = DefaultJWTClaimsVerifier(setOf("bookshop"), JWTClaimsSet.Builder().issuer(issuer).build(), setOf("sub", "exp"), null)
}

/** The viewer the schema's policies see as `viewer`, or null for an anonymous request. */
fun viewerOf(exchange: HttpExchange): JsonElement {
    val authorization = exchange.requestHeaders.getFirst("Authorization") ?: return JsonNull
    val token = Regex("""^Bearer (\S+)$""").find(authorization)?.groupValues?.get(1)
        ?: throw RayfoldException(Code.UNAUTHENTICATED, "Expected Authorization: Bearer <token>")
    val claims = try {
        tokens.process(token, null) // checks the signature and the claims above; nothing is read before both pass
    } catch (e: Exception) {
        throw RayfoldException(Code.UNAUTHENTICATED, "Invalid or expired token")
    }
    // `role` is the claim this provider carries roles in; the schema's rules compare against what it maps to
    return buildJsonObject {
        put("id", claims.subject)
        put("role", if (claims.getStringClaim("role") == "staff") "staff" else "customer")
    }
}
// #endregion auth

/** A token as the identity provider would issue it, signed with the development key: for local runs and tests. */
fun devToken(subject: String, role: String): String {
    val now = Date()
    val claims = JWTClaimsSet.Builder().subject(subject).issuer(DEV_ISSUER).audience("bookshop").claim("role", role)
        .issueTime(now).expirationTime(Date(now.time + 8 * 3_600_000L)).build()
    return SignedJWT(JWSHeader(JWSAlgorithm.HS256), claims).apply { sign(MACSigner(DEV_SECRET)) }.serialize()
}
