import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { defineAsyncComponent, h } from "vue";
import HomeScoreboard from "./HomeScoreboard.vue";
import HomeStart from "./HomeStart.vue";
import NotFound from "./NotFound.vue";
import StackNav from "./StackNav.vue";
import { rememberCodeTabs } from "./tabs.ts";
import "./style.css";

export default {
  extends: DefaultTheme,
  // the home page's first screen: what is measured beside the pitch, and how to start under it
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      "not-found": () => h(NotFound),
      "home-hero-image": () => h(HomeScoreboard),
      "home-hero-actions-after": () => h(HomeStart),
    }),
  enhanceApp({ app }) {
    app.component("StackNav", StackNav);
    // CodeMirror and the runtime load only on the page that shows the playground
    app.component("Playground", defineAsyncComponent(() => import("./playground/Playground.vue")));
  },
  setup() {
    rememberCodeTabs();
  },
} satisfies Theme;
