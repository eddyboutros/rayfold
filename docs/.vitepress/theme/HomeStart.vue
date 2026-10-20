<script setup lang="ts">
import { ref } from "vue";

const INSTALL = "npm install @rayfold/server @rayfold/client";
const copied = ref(false);

async function copy() {
  try {
    await navigator.clipboard.writeText(INSTALL);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <section class="home-start" aria-labelledby="home-start-title">
    <h2 id="home-start-title">Start in three steps</h2>
    <ol>
      <li>
        <span class="step">Install the server and the client</span>
        <span class="command">
          <code>{{ INSTALL }}</code>
          <button type="button" class="copy" @click="copy">{{ copied ? "Copied" : "Copy" }}</button>
          <span class="visually-hidden" aria-live="polite">{{ copied ? "Install command copied" : "" }}</span>
        </span>
      </li>
      <li><span class="step">Describe your API in a <code>.rayfold</code> schema: types, operations and their rules</span></li>
      <li>
        <span class="step">Serve it with <code>createRayfoldServer</code> and call it with <code>RayfoldClient</code></span>
      </li>
    </ol>
    <p class="more">
      <a href="/guide/quickstart">The quickstart, step by step</a>
      <span class="dot" aria-hidden="true">·</span>
      On the JVM: <a href="/get-started/kotlin">Kotlin</a>, <a href="/get-started/java">Java</a>,
      <a href="/get-started/spring-boot">Spring Boot</a>
    </p>
  </section>
</template>
