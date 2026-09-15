import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.4.20"
    application
}

repositories {
    mavenCentral()
}

// #region deps
dependencies {
    implementation("dev.rayfold:rayfold-core:0.1.0")
    implementation("dev.rayfold:rayfold-client:0.1.0")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
// #endregion deps

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_21
    }
}

application {
    mainClass = "com.example.bookshop.ServerKt"
}

tasks.register<JavaExec>("runClient") {
    group = "application"
    description = "Runs the client app against the server that `run` started."
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass = "com.example.bookshop.ClientKt"
}

tasks.test {
    useJUnitPlatform()
}
