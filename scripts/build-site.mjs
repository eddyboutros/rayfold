#!/usr/bin/env node
/**
 * Builds the documentation site into site/: the guides (docs/), the specification (spec/) and the comparison report,
 * under one navigation. Links between pages become links between the HTML pages; a link to a page or heading that
 * does not exist fails the build, so a broken link never ships. Links to other files in the repository point at the
 * repository when package.json has a "repository", and become plain text otherwise.
 *
 *   node scripts/build-site.mjs [out-dir]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? join(ROOT, "site");
const repo = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).repository;
const repoUrl = typeof repo === "string" ? repo : repo?.url?.replace(/^git\+/, "").replace(/\.git$/, "");

const titleOf = (md) => /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? "Untitled";
const list = (dir) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".md")).sort().map((f) => `${dir}/${f}`);

/** Every page: its source (repo-relative, forward slashes), its output path and its navigation section. */
const pages = [
  { src: "docs/index.md", section: "" },
  ...["quickstart", "react", "kotlin", "java-spring", "offline", "postgres", "jdbc", "tracing", "explorer", "editors", "typescript", "from-rest", "from-graphql"].map((g) => ({ src: `docs/guide/${g}.md`, section: "Guides" })),
  ...list("spec").map((src) => ({ src, section: "Specification" })),
  ...list("spec/adr").map((src) => ({ src, section: "Design decisions" })),
  { src: "docs/comparison.md", section: "Background" },
  { src: "docs/landscape.md", section: "Background" },
  { src: "docs/versioning.md", section: "Background" },
].map((p) => {
  const md = readFileSync(join(ROOT, p.src), "utf8");
  const out = p.src === "docs/index.md" ? "index.html" : p.src.replace(/^docs\//, "").replace(/\.md$/, ".html");
  return { ...p, md, out, title: titleOf(md) };
});
const bySrc = new Map(pages.map((p) => [p.src, p]));

/** GitHub-style heading slugs: lower case, punctuation dropped, spaces to dashes, repeats numbered. */
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().trim().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// first pass: every page's heading ids, so links to #anchors can be checked
const anchors = new Map();
for (const p of pages) {
  const slug = slugger();
  const ids = new Set();
  for (const m of p.md.matchAll(/^#{1,6}\s+(.+)$/gm)) ids.add(slug(m[1].replace(/`/g, "")));
  anchors.set(p.src, ids);
}

const problems = [];

function render(page) {
  const slug = slugger();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }) {
        const id = slug(text.replace(/`/g, ""));
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const target = resolveLink(page, href);
        if (target === null) return text;
        return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ""}>${text}</a>`;
      },
    },
  });
  return marked.parse(page.md);
}

/** The href for a link written in [page]: a page of the site, the repository, or null for plain text. */
function resolveLink(page, href) {
  if (/^[a-z]+:/i.test(href)) return href; // http:, https:, mailto:
  const [path, hash] = href.split("#");
  if (!path) {
    if (hash && !anchors.get(page.src)?.has(hash)) problems.push(`${page.src}: no heading #${hash}`);
    return href;
  }
  const target = posix.normalize(posix.join(posix.dirname(page.src), path));
  const linked = bySrc.get(target);
  if (linked) {
    if (hash && !anchors.get(target)?.has(hash)) problems.push(`${page.src}: ${target} has no heading #${hash}`);
    const rel = posix.relative(posix.dirname(page.out), linked.out) || linked.out.split("/").pop();
    return hash ? `${rel}#${hash}` : rel;
  }
  if (!existsSync(join(ROOT, target))) problems.push(`${page.src}: link to ${href}, which does not exist`);
  return repoUrl ? `${repoUrl}/blob/main/${target}` : null;
}

function nav(current) {
  const sections = [...new Set(pages.map((p) => p.section))];
  return sections
    .map((s) => {
      const items = pages
        .filter((p) => p.section === s)
        .map((p) => {
          const href = posix.relative(posix.dirname(current.out), p.out) || p.out.split("/").pop();
          return `<li${p === current ? ' class="current"' : ""}><a href="${href}">${escapeHtml(p.title.replace(/^\d+\s+-\s+/, ""))}</a></li>`;
        })
        .join("");
      return `${s ? `<h2>${escapeHtml(s)}</h2>` : ""}<ul>${items}</ul>`;
    })
    .join("");
}

const CSS = `
:root { --bg: #fbfbf9; --ink: #1d2126; --muted: #5d6670; --line: #e2e4e0; --accent: #1f6f5c; --code: #f1f2ee; }
@media (prefers-color-scheme: dark) { :root { --bg: #15181b; --ink: #e6e8e4; --muted: #9aa3ab; --line: #2a2f34; --accent: #6cc4a8; --code: #1e2226; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
.layout { display: grid; grid-template-columns: 17rem minmax(0, 1fr); min-height: 100vh; }
nav { border-right: 1px solid var(--line); padding: 1.5rem 1.25rem; position: sticky; top: 0; height: 100vh; overflow-y: auto; font-size: 0.92rem; }
nav .brand { font-weight: 700; font-size: 1.15rem; color: var(--ink); text-decoration: none; letter-spacing: 0.01em; }
nav h2 { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 1.4rem 0 0.4rem; }
nav ul { list-style: none; margin: 0; padding: 0; }
nav li a { display: block; padding: 0.2rem 0.5rem; border-radius: 4px; color: var(--ink); text-decoration: none; }
nav li a:hover { background: var(--code); }
nav li.current a { background: var(--code); color: var(--accent); font-weight: 600; }
main { padding: 2.5rem 3rem 4rem; max-width: 52rem; }
h1, h2, h3 { line-height: 1.25; text-wrap: balance; }
h1 { font-size: 2.1rem; margin-top: 0; }
h2 { margin-top: 2.2rem; padding-top: 0.4rem; border-top: 1px solid var(--line); }
a { color: var(--accent); }
a.anchor { visibility: hidden; margin-left: -1.1em; padding-right: 0.3em; text-decoration: none; color: var(--muted); }
h1:hover a.anchor, h2:hover a.anchor, h3:hover a.anchor, h4:hover a.anchor { visibility: visible; }
code { background: var(--code); padding: 0.1em 0.35em; border-radius: 4px; font: 0.88em/1.5 ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; }
pre { background: var(--code); padding: 1rem 1.1rem; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; display: block; overflow-x: auto; margin: 1rem 0; }
th, td { border: 1px solid var(--line); padding: 0.45rem 0.7rem; text-align: left; vertical-align: top; }
th { background: var(--code); }
blockquote { margin: 1rem 0; padding: 0.2rem 1rem; border-left: 3px solid var(--accent); color: var(--muted); }
@media (max-width: 800px) { .layout { display: block; } nav { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); } main { padding: 1.5rem 1.2rem 3rem; } }
`;

rmSync(OUT, { recursive: true, force: true });
for (const page of pages) {
  const body = render(page);
  const css = posix.relative(posix.dirname(page.out), "style.css") || "style.css";
  const home = posix.relative(posix.dirname(page.out), "index.html") || "index.html";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}${page.src === "docs/index.md" ? "" : " · Rayfold"}</title>
<link rel="stylesheet" href="${css}">
</head>
<body>
<div class="layout">
<nav><a class="brand" href="${home}">Rayfold</a>${nav(page)}</nav>
<main>${body}</main>
</div>
</body>
</html>
`;
  mkdirSync(join(OUT, dirname(page.out)), { recursive: true });
  writeFileSync(join(OUT, page.out), html);
}
writeFileSync(join(OUT, "style.css"), CSS.trim() + "\n");
const report = join(ROOT, "e2e", "report.html");
if (existsSync(report)) cpSync(report, join(OUT, "should-you-use-rayfold.html"));

if (problems.length) {
  console.error(`site: ${problems.length} broken link(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`site: ${pages.length} pages in ${relative(ROOT, OUT) || OUT}`);
