import { cpSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type DefaultTheme, type MarkdownOptions } from "vitepress";
import { rayfoldGrammar } from "./rayfold-grammar.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO = "https://github.com/eddyboutros/rayfold";

/** GitHub's heading ids, so an anchor that works on GitHub works here too. */
const slugify = (text: string) =>
  text.toLowerCase().trim().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");

function pagesIn(dir: string, route: string): DefaultTheme.SidebarItem[] {
  return readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".md") && f !== "process.md")
    .sort()
    .map((f) => {
      const title = /^#\s+(.+)$/m.exec(readFileSync(join(ROOT, dir, f), "utf8"))?.[1] ?? f;
      return { text: title.replace(/^\d+\s*[-.]\s*/, "").replace(/`/g, ""), link: `${route}/${f.replace(/\.md$/, "")}` };
    });
}

/**
 * Where a relative link in a page goes. Pages are written to work on GitHub, so links point at files: another page
 * of the site becomes that page, and any other file in the repository becomes its page on GitHub. A link to a file
 * that does not exist fails the build.
 */
function siteLink(sourcePath: string, href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/")) return href;
  const [path = "", hash] = href.split("#");
  const target = posix.normalize(posix.join(posix.dirname(sourcePath), path));
  const anchor = hash ? `#${hash}` : "";
  if (/^(docs|spec)\/.+\.md$/.test(target) && existsSync(join(ROOT, target))) {
    return `/${target.replace(/^docs\//, "").replace(/\.md$/, "")}${anchor}`;
  }
  if (!existsSync(join(ROOT, target))) throw new Error(`${sourcePath}: link to ${href}, which does not exist`);
  return `${REPO}/${statSync(join(ROOT, target)).isDirectory() ? "tree" : "blob"}/main/${target}${anchor}`;
}

/** The file in the repository a page comes from: spec pages are read from spec/, the rest from docs/. */
const sourceOf = (relativePath: string) => (relativePath.startsWith("spec/") ? relativePath : `docs/${relativePath}`);

type Language = NonNullable<MarkdownOptions["languages"]>[number];

export default defineConfig({
  title: "Rayfold",
  description:
    "One protocol for app APIs: a typed schema, queries shaped by the screen, live updates and cache patches. For TypeScript, React, Kotlin, Java and Spring Boot.",
  lang: "en-US",
  base: "/",
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ["releasing.md", "**/README.md"],
  ignoreDeadLinks: "localhostLinks",
  head: [
    ["link", { rel: "icon", href: "/favicon.ico", sizes: "32x32" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
    ["link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }],
    ["meta", { name: "theme-color", content: "#0f6e5a" }],
    // Archivo SemiBold is the wordmark's typeface
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    ["link", { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Archivo:wght@600&display=swap" }],
  ],

  markdown: {
    languages: [rayfoldGrammar as unknown as Language],
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
        { text: "Specification", items: pagesIn("spec", "/spec") },
        { text: "Design decisions", collapsed: true, items: pagesIn("spec/adr", "/spec/adr") },
      ],
      "/errors/": [{ text: "Errors", items: [{ text: "All error types", link: "/errors/" }] }],
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
            { text: "Live updates", link: "/learn/live" },
            { text: "Caching", link: "/learn/caching" },
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
          ],
        },
        {
          text: "In depth, by stack",
          collapsed: true,
          items: [
            { text: "Node.js quickstart", link: "/guide/quickstart" },
            { text: "Schema in TypeScript", link: "/guide/typescript" },
            { text: "React", link: "/guide/react" },
            { text: "Kotlin and Android", link: "/guide/kotlin" },
            { text: "Java and Spring Boot", link: "/guide/java-spring" },
          ],
        },
        {
          text: "Tools",
          items: [
            { text: "The explorer", link: "/guide/explorer" },
            { text: "Command line", link: "https://github.com/eddyboutros/rayfold/blob/main/packages/cli/README.md" },
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
