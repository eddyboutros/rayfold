<script setup lang="ts">
import { computed } from "vue";
import { useData, withBase } from "vitepress";

const { site } = useData();

// An error type an API defines in its own schema (OutOfStock, say) links here too, from REST bindings.
const declared = computed(() => {
  if (typeof window === "undefined") return null;
  const path = window.location.pathname.slice(site.value.base.length - 1);
  const match = /^\/errors\/([A-Za-z][A-Za-z0-9_]*)\/?$/.exec(path);
  return match ? match[1] : null;
});
</script>

<template>
  <div class="not-found">
    <template v-if="declared">
      <p class="code">Declared error</p>
      <h1><code>{{ declared }}</code></h1>
      <p>
        <code>{{ declared }}</code> is an error defined by the API you called, in its own schema. Look for
        <code>error {{ declared }}</code> there, or in that API's explorer, to see its fields and when it happens.
      </p>
      <p>
        Rayfold delivers these as <a :href="withBase('/errors/domain')">domain errors</a>, with the name in
        <code>type</code> and the fields in <code>data</code>.
      </p>
    </template>
    <template v-else>
      <p class="code">404</p>
      <h1>This page does not exist</h1>
      <p>It may have moved. Try the search, or start from one of these:</p>
    </template>
    <div class="links">
      <a :href="withBase('/get-started')">Get started</a>
      <a :href="withBase('/errors/')">All error types</a>
      <a :href="withBase('/')">Home</a>
    </div>
  </div>
</template>

<style scoped>
.not-found {
  max-width: 640px;
  margin: 0 auto;
  padding: 96px 24px 128px;
}
.code {
  margin: 0;
  font: 600 14px var(--vp-font-family-mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--vp-c-brand-1);
}
h1 {
  margin: 8px 0 20px;
  font-size: 32px;
  line-height: 1.2;
  font-weight: 700;
}
p {
  margin: 0 0 14px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}
p code {
  font-size: 0.9em;
  color: var(--vp-c-text-1);
}
a {
  color: var(--vp-c-brand-1);
}
.links {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  margin-top: 28px;
  font-weight: 500;
}
</style>
