#!/usr/bin/env node
/**
 * Publishes the JVM modules to the local Maven repository (~/.m2) and builds a fresh Gradle project outside this
 * repository against them, the way a user's project would: Kotlin code that reads a schema, serves it with the Java
 * API over HTTP and calls it with the Kotlin client, plus a Java class using the Java API. Proves the POMs carry
 * the right dependencies and that the published jars work together.
 *
 *   node scripts/smoke-maven.mjs [--keep]
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KOTLIN = join(ROOT, "kotlin");
const gradlew = join(KOTLIN, process.platform === "win32" ? "gradlew.bat" : "gradlew");
const props = readFileSync(join(KOTLIN, "gradle.properties"), "utf8");
const group = /^GROUP=(.*)$/m.exec(props)?.[1]?.trim();
const version = /^VERSION_NAME=(.*)$/m.exec(props)?.[1]?.trim();
const work = mkdtempSync(join(tmpdir(), "rayfold-maven-smoke-"));
const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const MAIN_KT = `package smoke

import dev.rayfold.client.HttpTransport
import dev.rayfold.client.RayfoldClient
import dev.rayfold.client.args
import dev.rayfold.java.Rayfold
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

fun main() {
    val stock = mutableMapOf("b1" to 3)
    val server = Rayfold.server(
        """
        entity Book { id: ID title: String stock: Int }
        query book(id: ID): Book?
        command restock(id: ID, qty: Int): Book
        """,
    )
        .query("book") { a, _ -> mapOf("id" to a.getString("id"), "title" to "Dune", "stock" to stock[a.getString("id")]) }
        .command("restock") { a, _ ->
            val id = a.getString("id") ?: error("no id")
            stock[id] = (stock[id] ?: 0) + (a.getInt("qty") ?: 0)
            mapOf("id" to id, "title" to "Dune", "stock" to stock[id])
        }
        .build()
    val http = Rayfold.http(server).viewer { mapOf("id" to "smoke") }.start(0)
    try {
        runBlocking {
            val client = RayfoldClient(HttpTransport("http://127.0.0.1:" + http.address.port + "/rayfold"))
            val before = client.query("book", args("id" to "b1"), "{ id title stock }")
            val after = client.command("restock", args("id" to "b1", "qty" to 2), "{ stock }")
            check(before.jsonObject["title"]?.jsonPrimitive?.content == "Dune" && before.jsonObject["stock"]?.jsonPrimitive?.content == "3") { "query: " + before }
            check(after.jsonObject["stock"]?.jsonPrimitive?.content == "5") { "command: " + after }
            println("smoke ok")
        }
    } finally {
        http.stop(0)
    }
}
`;

const JAVA_CHECK = `package smoke;

import dev.rayfold.core.RayfoldServer;
import dev.rayfold.java.Rayfold;

import java.util.Map;

/** Compiles only if the Java API is usable from Java through the published POMs. */
public final class JavaCheck {
    private JavaCheck() {}

    public static RayfoldServer server() {
        return Rayfold.server("entity A { id: ID } query a(id: ID): A?")
            .query("a", (args, ctx) -> Map.of("id", args.getString("id")))
            .build();
    }
}
`;

let ok = false;
try {
  if (!group || !version) throw new Error("GROUP or VERSION_NAME missing from kotlin/gradle.properties");
  console.log(`- publish ${group}:*:${version} to the local Maven repository`);
  sh(`"${gradlew}" --no-daemon -q publishToMavenLocal`, KOTLIN);

  console.log("- build and run a separate Gradle project against the published jars");
  mkdirSync(join(work, "src/main/kotlin/smoke"), { recursive: true });
  mkdirSync(join(work, "src/main/java/smoke"), { recursive: true });
  writeFileSync(join(work, "settings.gradle.kts"), 'rootProject.name = "consumer"\n');
  writeFileSync(join(work, "build.gradle.kts"), `plugins {
    kotlin("jvm") version "2.2.0"
    application
}
repositories {
    mavenLocal()
    mavenCentral()
}
dependencies {
    implementation("${group}:rayfold-java:${version}")
    implementation("${group}:rayfold-client:${version}")
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) } }
java { sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }
application { mainClass.set("smoke.MainKt") }
`);
  writeFileSync(join(work, "src/main/kotlin/smoke/Main.kt"), MAIN_KT);
  writeFileSync(join(work, "src/main/java/smoke/JavaCheck.java"), JAVA_CHECK);
  const out = sh(`"${gradlew}" --no-daemon -q -p "${work}" run`, KOTLIN);
  if (!out.includes("smoke ok")) throw new Error(`the consumer did not finish:\n${out}`);
  ok = true;
  console.log("maven smoke test passed");
} catch (e) {
  console.error(`maven smoke test FAILED: ${e.stderr || e.stdout || e.message}`);
  console.error(`work folder kept for inspection: ${work}`);
  process.exitCode = 1;
} finally {
  if (ok && !process.argv.includes("--keep")) rmSync(work, { recursive: true, force: true });
}
