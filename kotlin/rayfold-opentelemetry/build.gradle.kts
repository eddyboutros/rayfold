plugins {
    kotlin("jvm")
    `java-library`
    id("com.vanniktech.maven.publish")
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) } }
java { sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }

val openTelemetry = "1.65.0"

dependencies {
    api(project(":rayfold-core"))
    api("io.opentelemetry:opentelemetry-api:$openTelemetry")
    // keeps the current span in the coroutine context, so work inside a span sees it as Context.current()
    implementation("io.opentelemetry:opentelemetry-extension-kotlin:$openTelemetry")
    testImplementation("io.opentelemetry:opentelemetry-sdk-testing:$openTelemetry")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.13.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    testLogging { events("failed"); showStandardStreams = false; exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
