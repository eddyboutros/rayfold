plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
    `java-library`
    id("com.vanniktech.maven.publish")
    id("ru.vyarus.animalsniffer")
}

// Java 17 bytecode and no server dependency, so Android apps can use the client too
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    // `check` fails when the client calls an API that Android 8.0 (API level 26) lacks
    signature("net.sf.androidscents.signature:android-api-level-26:8.0.0_r2@signature")
    // the tests run the client against the real Kotlin server
    testImplementation(project(":rayfold-core"))
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// the test server (rayfold-core) is Java 21 bytecode; only the tests need it
tasks.named<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>("compileTestKotlin") { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) } }
tasks.named<JavaCompile>("compileTestJava") { sourceCompatibility = "21"; targetCompatibility = "21" }
configurations.named("testCompileClasspath") { attributes { attribute(TargetJvmVersion.TARGET_JVM_VERSION_ATTRIBUTE, 21) } }
configurations.named("testRuntimeClasspath") { attributes { attribute(TargetJvmVersion.TARGET_JVM_VERSION_ATTRIBUTE, 21) } }

animalsniffer {
    sourceSets = listOf(project.sourceSets["main"])
    // JdkWebSocketTransport is the one JVM-only class; Android apps use rayfold-client-okhttp instead
    ignore("java.net.http.*")
}

tasks.test {
    useJUnitPlatform()
    testLogging { events("failed"); showStandardStreams = false; exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
