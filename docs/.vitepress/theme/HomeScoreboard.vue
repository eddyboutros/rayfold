<script setup lang="ts">
import { data } from "./scoreboard.data.ts";
</script>

<template>
  <figure class="scoreboard">
    <table>
      <caption>The same bookshop, built three ways and measured. Fewer is better.</caption>
      <thead>
        <tr>
          <th scope="col"><span class="visually-hidden">Task</span></th>
          <th scope="col">REST</th>
          <th scope="col">GraphQL</th>
          <th scope="col" class="ours">Rayfold</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in data.rows" :key="row.label">
          <th scope="row">{{ row.label }}</th>
          <td>{{ row.rest }}</td>
          <td>{{ row.graphql }}</td>
          <td class="ours">{{ row.rayfold }}</td>
        </tr>
      </tbody>
    </table>
    <figcaption>
      Rayfold leads on {{ data.leads }} of {{ data.total }} aspects measured end to end, each cell asserted by a test.
      <a href="/comparison">Every row, and where the others are fine</a>
    </figcaption>
  </figure>
</template>
