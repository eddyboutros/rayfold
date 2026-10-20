import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type DefaultTheme, type MarkdownOptions } from "vitepress";
import { ERROR_TYPES } from "./errors.ts";
import { REPO, ROOT, siteLink, slugify } from "./links.ts";
import { rayfoldGrammar } from "./rayfold-grammar.ts";

function pagesIn(dir: string, route: string): DefaultTheme.SidebarItem[] {
  return readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".md") && f !== "process.md")
    .sort()
    .map((f) => {
      const title = /^#\s+(.+)$/m.exec(readFileSync(join(ROOT, dir, f), "utf8"))?.[1] ?? f;
      return { text: title.replace(/^\d+\s*[-.]\s*/, "").replace(/`/g, ""), link: `${route}/${f.replace(/\.md$/, "")}` };
    });
}

/** The file in the repository a page comes from: spec pages are read from spec/, the rest from docs/. */
const sourceOf = (relativePath: string) => (relativePath.startsWith("spec/") ? relativePath : `docs/${relativePath}`);

const SITE = "https://rayfold.dev";
const DESCRIPTION =
  "One protocol for app APIs: a typed schema, queries shaped by the screen, live updates and cache patches. For TypeScript, React, Kotlin, Java and Spring Boot.";

/** The address a page is served at, as `cleanUrls` serves it: no `.md`, no `index`. */
const pageUrl = (relativePath: string) => `${SITE}/${relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")}`;

type Language = NonNullable<MarkdownOptions["languages"]>[number];

export default defineConfig({
  title: "Rayfold",
  description: DESCRIPTION,
  lang: "en-US",
  base: "/",
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ["releasing.md", "**/README.md"],
  ignoreDeadLinks: "localhostLinks",
  sitemap: { hostname: SITE },

  // each page says where it lives and what it is, for search engines and for the card a shared link shows
  transformHead({ pageData }) {
    if (pageData.isNotFound) return [];
    const url = pageUrl(pageData.relativePath);
    const title = pageData.frontmatter["titleTemplate"] && pageData.relativePath === "index.md" ? `Rayfold: ${pageData.frontmatter["titleTemplate"]}` : pageData.title ? `${pageData.title} | Rayfold` : "Rayfold";
    const description = (pageData.frontmatter["description"] as string | undefined) ?? pageData.description ?? DESCRIPTION;
    return [
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description || DESCRIPTION }],
    ];
  },
  head: [
    ["link", { rel: "icon", href: "/favicon.ico", sizes: "32x32" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }],
    ["meta", { name: "theme-color", content: "#0f6e5a", media: "(prefers-color-scheme: light)" }],
    ["meta", { name: "theme-color", content: "#1b1b1f", media: "(prefers-color-scheme: dark)" }],
    ["meta", { property: "og:site_name", content: "Rayfold" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:image", content: `${SITE}/og.png` }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { property: "og:image:alt", content: "Rayfold: one request per screen, and every screen stays right" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    // Archivo SemiBold is the wordmark's typeface, served from the site so no other host holds up the first paint
    ["link", { rel: "preload", href: "/fonts/archivo-600-latin.woff2", as: "font", type: "font/woff2", crossorigin: "" }],
  ],

  markdown: {
    languages: [rayfoldGrammar as unknown as Language],
    // a guide shows some example files whole, and their #region markers belong to the other pages, not to the reader
    snippet: { stripRegionMarkers: "all" },
    anchor: { slugify },
    config(md) {
      const render = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
      md.renderer.rules.link_open = (tokens, idx, options, env: { relativePath?: string }, self) => {
        const token = tokens[idx]!;
        const href = token.attrGet("href");
        if (href && env.relativePath) token.attrSet("href", siteLink(sourceOf(env.relativePath), href));
        return render(tokens, idx, options, env, self);
      };
    },
  },

  themeConfig: {
    logo: { light: "/logo.svg", dark: "/logo-dark.svg", alt: "" },
    nav: [
      { text: "Get started", link: "/get-started/", activeMatch: "^/get-started/" },
      { text: "Learn", link: "/learn/schema", activeMatch: "^/(learn|guide)/" },
      { text: "Playground", link: "/playground" },
      { text: "Spec", link: "/spec/00-overview", activeMatch: "^/spec/" },
      { text: "Errors", link: "/errors/", activeMatch: "^/errors/" },
    ],

    sidebar: {
      "/spec/": [
        { text: "Specification", items: [...pagesIn("spec", "/spec"), { text: "How the specification changes", link: "/spec/process" }] },
        { text: "Design decisions", collapsed: true, items: pagesIn("spec/adr", "/spec/adr") },
      ],
      "/errors/": [
        { text: "Errors", items: [{ text: "All error types", link: "/errors/" }] },
        { text: "Each type", items: ERROR_TYPES.map((e) => ({ text: e.type, link: `/errors/${e.type}` })) },
      ],
      "/": [
        {
          text: "Get started",
          items: [
            { text: "Choose your stack", link: "/get-started/" },
            { text: "TypeScript", link: "/get-started/typescript" },
            { text: "React", link: "/get-started/react" },
            { text: "Kotlin", link: "/get-started/kotlin" },
            { text: "Java", link: "/get-started/java" },
            { text: "Spring Boot", link: "/get-started/spring-boot" },
            { text: "Playground", link: "/playground" },
          ],
        },
        {
          text: "Basics",
          items: [
            { text: "The schema", link: "/learn/schema" },
            { text: "Queries and shapes", link: "/learn/queries" },
            { text: "Commands and errors", link: "/learn/commands" },
          ],
        },
        {
          text: "Everyday",
          items: [
            { text: "Who can do what", link: "/learn/auth" },
            { text: "Capability tokens", link: "/guide/capabilities" },
            { text: "Live updates", link: "/learn/live" },
            { text: "Streams and events", link: "/learn/streams" },
            { text: "Caching", link: "/learn/caching" },
            { text: "Testing", link: "/guide/testing" },
          ],
        },
        {
          text: "Advanced",
          items: [
            { text: "Several steps, one request", link: "/learn/batches" },
            { text: "The binary format", link: "/learn/binary" },
            { text: "Changing a schema safely", link: "/learn/evolution" },
            { text: "Offline and optimistic", link: "/guide/offline" },
            { text: "Postgres", link: "/guide/postgres" },
            { text: "JDBC", link: "/guide/jdbc" },
            { text: "Tracing", link: "/guide/tracing" },
            { text: "Deployment", link: "/guide/deployment" },
            { text: "Hono, Workers, Bun, Deno, Next", link: "/guide/runtimes" },
            { text: "REST routes and OpenAPI", link: "/guide/rest-bindings" },
            { text: "Uploads", link: "/guide/uploads" },
          ],
        },
        {
          text: "In depth, by stack",
          collapsed: true,
          items: [
            { text: "Node.js quickstart", link: "/guide/quickstart" },
            { text: "Schema in TypeScript", link: "/guide/typescript" },
            { text: "React", link: "/guide/react" },
            { text: "Angular", link: "/guide/angular" },
            { text: "Kotlin and Android", link: "/guide/kotlin" },
            { text: "Java and Spring Boot", link: "/guide/java-spring" },
          ],
        },
        {
          text: "Tools",
          items: [
            { text: "The explorer", link: "/guide/explorer" },
            { text: "MCP for AI agents", link: "/guide/mcp" },
            { text: "Command line", link: "/guide/cli" },
            { text: "Editors", link: "/guide/editors" },
            { text: "Errors", link: "/errors/" },
          ],
        },
        {
          text: "Coming from",
          items: [
            { text: "REST", link: "/guide/from-rest" },
            { text: "GraphQL", link: "/guide/from-graphql" },
            { text: "Should you use Rayfold?", link: "/should-you-use-rayfold.html", target: "_self" },
          ],
        },
        {
          text: "Background",
          collapsed: true,
          items: [
            { text: "Comparison", link: "/comparison" },
            { text: "Landscape", link: "/landscape" },
            { text: "Versioning", link: "/versioning" },
            { text: "Specification", link: "/spec/00-overview" },
          ],
        },
      ],
    },

    search: { provider: "local" },
    outline: { level: [2, 3] },
    socialLinks: [{ icon: "github", link: REPO }],
    editLink: {
      // this function is sent to the browser as source text, so it cannot use anything defined outside it
      pattern: ({ filePath, params }) => {
        const repo = "https://github.com/eddyboutros/rayfold";
        const page = typeof params?.["page"] === "string" ? params["page"] : null;
        if (page && filePath.startsWith("spec/")) return `${repo}/edit/main/${filePath.replace("[page]", page)}`;
        if (filePath.startsWith("errors/[")) return `${repo}/edit/main/docs/.vitepress/errors.ts`;
        return `${repo}/edit/main/docs/${filePath}`;
      },
      text: "Edit this page on GitHub",
    },
    footer: { message: "Released under the Apache-2.0 license." },
  },

  vite: {
    // the playground and the snippets come straight from the repository: the runtime and the example projects
    server: { fs: { allow: [ROOT] } },
  },

  buildEnd(site) {
    const report = join(ROOT, "e2e", "report.html");
    if (existsSync(report)) cpSync(report, join(site.outDir, "should-you-use-rayfold.html"));
  },
});
