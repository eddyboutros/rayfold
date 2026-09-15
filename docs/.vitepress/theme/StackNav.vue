<script setup lang="ts">
import { withBase } from "vitepress";

defineProps<{ current: string }>();

const STACKS = [
  { id: "typescript", label: "TypeScript" },
  { id: "react", label: "React" },
  { id: "kotlin", label: "Kotlin" },
  { id: "java", label: "Java" },
  { id: "spring-boot", label: "Spring Boot" },
];
</script>

<template>
  <nav class="stack-nav" aria-label="Choose your stack">
    <a
      v-for="stack in STACKS"
      :key="stack.id"
      :href="withBase(`/get-started/${stack.id}`)"
      :class="{ active: stack.id === current }"
      :aria-current="stack.id === current ? 'page' : undefined"
    >
      {{ stack.label }}
    </a>
  </nav>
</template>

<style scoped>
.stack-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 28px;
}
.stack-nav a {
  padding: 4px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 999px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  text-decoration: none;
  transition: border-color 0.15s, color 0.15s;
}
.stack-nav a:hover {
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-brand-2);
}
.stack-nav a.active {
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
</style>
