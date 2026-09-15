plugins {
    kotlin("jvm")
    `java-library`
    id("com.vanniktech.maven.publish")
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
        javaParameters.set(true)
    }
}
java { sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }

val springBoot = "4.1.1"

dependencies {
    api(project(":rayfold-java"))
    api("org.springframework.boot:spring-boot-starter-webmvc:$springBoot")
    // Spring reads Kotlin classes (the configuration properties) through Kotlin reflection
    implementation(kotlin("reflect"))
    // the viewer comes from Spring Security when the application uses it
    compileOnly("org.springframework.boot:spring-boot-starter-security:$springBoot")
    // the WebSocket transport on the application's port, when the application has spring-boot-starter-websocket
    compileOnly("org.springframework.boot:spring-boot-starter-websocket:$springBoot")

    testImplementation("org.springframework.boot:spring-boot-starter-test:$springBoot")
    testImplementation("org.springframework.boot:spring-boot-starter-security:$springBoot")
    testImplementation("org.springframework.boot:spring-boot-starter-websocket:$springBoot")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:6.1.3")
}

// the tests are Spring applications written in Java, as users write them; -parameters lets @Arg take the parameter name
tasks.withType<JavaCompile>().configureEach { options.compilerArgs.addAll(listOf("-parameters", "-Xlint:all", "-Werror")) }

tasks.test {
    useJUnitPlatform()
    testLogging { events("failed"); showStandardStreams = false; exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
