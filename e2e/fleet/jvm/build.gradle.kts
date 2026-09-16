import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.4.20"
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("dev.rayfold:rayfold-core:0.1.0")
    implementation("dev.rayfold:rayfold-jdbc:0.1.0")
    // PgNotifications reads LISTEN/NOTIFY through pgjdbc, which rayfold-jdbc leaves to the application
    implementation("org.postgresql:postgresql:42.7.7")
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

kotlin {
    compilerOptions { jvmTarget = JvmTarget.JVM_21 }
}

application {
    mainClass = "dev.rayfold.fleet.ServerKt"
}
