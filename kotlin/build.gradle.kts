plugins {
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
