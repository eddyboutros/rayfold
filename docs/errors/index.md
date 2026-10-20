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
these pages. A declared error is the exception: its `type` ends with its own name, such as `/errors/OutOfStock`, and
the `domain` page in the table below says where to look it up.

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

A command can be sent again with the same idempotency key: if the first attempt went through, the server answers with
its original result instead of running the command twice. If the key is reused for another operation, or for the
same one with different arguments, the server answers `already_exists`.
