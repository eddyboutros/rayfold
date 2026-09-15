---
title: Errors
description: Every error a Rayfold server can answer with, what it means and what to do about it.
---

<script setup>
import { ERROR_TYPES } from "../.vitepress/errors.ts";
</script>

# Errors

Every Rayfold error has a `code` from a fixed list, the same in every API, so retries, alerts and status codes work
the same way everywhere. Errors an operation declares in the schema, such as `OutOfStock`, use the code `domain` and
carry their own `type` and data.

When a whole request is refused over HTTP, the answer is an RFC 9457 problem document whose `type` links to one of
these pages.

<table class="error-table">
  <thead>
    <tr><th>Type</th><th>HTTP</th><th>Retry?</th><th>Meaning</th></tr>
  </thead>
  <tbody>
    <tr v-for="e in ERROR_TYPES" :key="e.type">
      <td><a :href="`./${e.type}`"><code>{{ e.type }}</code></a></td>
      <td>{{ e.status }}</td>
      <td>{{ e.retryable ? "yes" : "no" }}</td>
      <td>{{ e.summary }}</td>
    </tr>
  </tbody>
</table>

Commands can always be sent again with the same idempotency key: if the first attempt went through, the server
answers with its original result instead of running the command twice.
