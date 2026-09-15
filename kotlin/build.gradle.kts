plugins {
    // one version for both: the serialization plugin brings its own Kotlin compiler, and the newer one wins
    kotlin("jvm") version "2.4.20" apply false
    kotlin("plugin.serialization") version "2.4.20" apply false
    id("com.vanniktech.maven.publish") version "0.37.0" apply false
    // checks that the Android-facing modules call only APIs Android has (API level 26)
    id("ru.vyarus.animalsniffer") version "2.0.1" apply false
    // `cyclonedxBom`: the software bill of materials attached to every GitHub release
    id("org.cyclonedx.bom") version "3.4.1"
}
allprojects {
    group = providers.gradleProperty("GROUP").get()
    version = providers.gradleProperty("VERSION_NAME").get()
    repositories { mavenCentral() }
}
// The published classes and POMs target Kotlin 2.2, whatever compiler builds them, so projects on Kotlin 2.2 (and the
// Kotlin that Spring Boot manages) can compile against them. 2.2 is the floor anyway: kotlinx-serialization-json 1.9.0,
// part of the API, carries 2.2 metadata and needs kotlin-stdlib 2.2.0.
subprojects {
    plugins.withId("org.jetbrains.kotlin.jvm") {
        extensions.configure<org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension> {
            coreLibrariesVersion = "2.2.0"
            compilerOptions {
                languageVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
                apiVersion.set(org.jetbrains.kotlin.gradle.dsl.KotlinVersion.KOTLIN_2_2)
            }
        }
    }
}
