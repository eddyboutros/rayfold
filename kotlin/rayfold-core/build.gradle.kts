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
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
tasks.test {
    useJUnitPlatform()
    systemProperty("rayfold.fixtures", rootProject.projectDir.resolve("../conformance/fixtures").absolutePath)
    // the JDK HTTP server reads its request timeout once per JVM; short here so the slow-loris test ends quickly
    systemProperty("sun.net.httpserver.maxReqTime", "2")
    inputs.dir(rootProject.projectDir.resolve("../conformance/fixtures"))
    testLogging { events("failed"); showStandardStreams = false; exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
