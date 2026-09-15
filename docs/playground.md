---
title: Playground
description: Run Rayfold in your browser. Edit the schema, send requests and watch the frames come back.
layout: page
sidebar: false
aside: false
pageClass: playground-page
---

<div class="vp-doc playground-intro">

# Playground

The bookshop from the guides, running in this page. Pick an example, change the request or the schema, and see what
the server sends back.

</div>

<ClientOnly>
  <Playground />
</ClientOnly>

<style>
.playground-intro { padding: 32px 24px 12px; max-width: 1440px; margin: 0 auto; }
.playground-intro + div, .VPPage > div > .pg { padding: 0 24px 48px; max-width: 1440px; margin: 0 auto; }
</style>
