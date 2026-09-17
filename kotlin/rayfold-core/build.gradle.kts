plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
    `java-library`
    id("com.vanniktech.maven.publish")
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) } }
java { sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }
dependencies {
    // JsonElement, JsonObject and Flow are part of the public API
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    // The lowest supported version, the one Spring Boot 4.1 manages. Do not raise it past what Boot manages: code compiled
    // against 1.11 calls BuildersKt.runBlockingK, which 1.10 lacks, so every HTTP batch failed under Boot.
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
tasks.test {
    useJUnitPlatform()
    systemProperty("rayfold.fixtures", rootProject.projectDir.resolve("../conformance/fixtures").absolutePath)
    systemProperty("rayfold.vectors", rootProject.projectDir.resolve("../conformance/vectors").absolutePath)
    // the JDK HTTP server reads its request timeout once per JVM; short here so the slow-loris test ends quickly
    systemProperty("sun.net.httpserver.maxReqTime", "2")
    inputs.dir(rootProject.projectDir.resolve("../conformance/fixtures"))
    inputs.dir(rootProject.projectDir.resolve("../conformance/vectors"))
    testLogging { events("failed"); showStandardStreams = false; exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
