plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
    `java-library`
    id("com.vanniktech.maven.publish")
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) } }
java { sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }

dependencies {
    api(project(":rayfold-core"))
    // PgNotifications reads LISTEN/NOTIFY through pgjdbc's own interface; only applications using the relay need the driver
    compileOnly("org.postgresql:postgresql:42.7.13")
    // the tests run against a real database; the adapter itself needs nothing but JDBC from the JDK
    testImplementation("com.h2database:h2:2.5.250")
    // the driver's own interfaces, so a test can stand in for the one part of this module that is pgjdbc-specific
    testImplementation("org.postgresql:postgresql:42.7.13")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    testLogging { events("failed"); showStandardStreams = false; exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
