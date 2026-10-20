/**
 * The facts about Rayfold that Markdown files restate, and that drift when nobody is looking: where a link goes, which
 * version is current, and which packages exist. Each check is a pure function of the files it is given, so a test can
 * run it over the repository and over a planted mistake alike.
 */
import { anchorsOf, linkTarget } from "./links.ts";

/** What a check is told about the repository: file contents, and which paths exist. */
export interface Repo {
  text(path: string): string | undefined;
  exists(path: string): boolean;
  /** The error types the site has a page for. */
  errorTypes: ReadonlySet<string>;
}

/** The text a reader sees as prose: code fences and inline code spans are code, and their brackets are not links. */
export function prose(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (fence === null) fence = f[1]!.slice(0, 3);
        else if (line.trim().startsWith(fence)) fence = null;
        return "";
      }
      return fence === null ? line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length)) : "";
    })
    .join("\n");
}

/** Every link target written in a Markdown file: inline links and images, reference definitions, and HTML href/src. */
export function linksIn(markdown: string): string[] {
  const text = prose(markdown);
  const out: string[] = [];
  for (const m of text.matchAll(/!?\[(?:[^\]\[]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]!);
  for (const m of text.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm)) out.push(m[1]!);
  for (const m of text.matchAll(/<(?:a|img)\b[^>]*\s(?:href|src)="([^"]+)"/g)) out.push(m[1]!);
  return out;
}

/** The file a site route is built from, or null for a route the site makes from elsewhere. */
function routeFile(route: string, repo: Repo): string | "built" | null {
  const r = route.replace(/\/$/, "/index").replace(/\.html$/, "");
  if (r === "/should-you-use-rayfold") return repo.exists("e2e/report.html") ? "built" : null;
  const error = /^\/errors\/([A-Za-z_]+)$/.exec(r);
  if (error && error[1] !== "index") return repo.errorTypes.has(error[1]!) ? "built" : null;
  const spec = /^\/spec\/(.+)$/.exec(r);
  if (spec) return repo.exists(`spec/${spec[1]}.md`) ? `spec/${spec[1]}.md` : null;
  for (const candidate of [`docs${r}.md`, `docs${r}/index.md`]) if (repo.exists(candidate)) return candidate;
  return null;
}

/**
 * What is wrong with the links in one file: a file that is not there, an anchor no heading makes, or a site route in a
 * file the site never builds, where GitHub would read it as a path on github.com.
 */
export function linkProblems(path: string, markdown: string, repo: Repo): string[] {
  const out: string[] = [];
  const onSite = /^(docs|spec)\//.test(path) && !/(^|\/)README\.md$/.test(path) && path !== "docs/releasing.md";
  for (const href of linksIn(markdown)) {
    const t = linkTarget(path, href);
    if (t.kind === "elsewhere") {
      if (href.startsWith("#") && href.length > 1 && !anchorsOf(markdown).has(decodeURIComponent(href.slice(1)))) out.push(`${path}: ${href} names no heading on this page`);
      continue;
    }
    if (t.kind === "route") {
      if (!onSite) {
        out.push(`${path}: ${href} is a site path, and this file is read on GitHub and npm`);
        continue;
      }
      const file = routeFile(t.route, repo);
      if (file === null) out.push(`${path}: ${href} is no page of the site`);
      else if (t.hash && file !== "built" && !anchorsOf(repo.text(file) ?? "").has(decodeURIComponent(t.hash))) out.push(`${path}: ${href} names no heading in ${file}`);
      continue;
    }
    // a page of the site may link another by its route, as `./typescript`; the site builds that from typescript.md
    const file = !repo.exists(t.path) && onSite && repo.exists(`${t.path}.md`) ? `${t.path}.md` : t.path;
    if (!repo.exists(file)) {
      out.push(`${path}: ${href} points at ${t.path}, which does not exist`);
      continue;
    }
    if (t.hash && file.endsWith(".md") && !anchorsOf(repo.text(file) ?? "").has(decodeURIComponent(t.hash))) out.push(`${path}: ${href} names no heading in ${file}`);
  }
  return out;
}

/** The current release, as the packages and the changelog record it. */
export interface Release {
  version: string;
  date: string;
}

/**
 * Where a Markdown file states the current version and gets it wrong. The changelog and the versioning page's history
 * name older versions on purpose; what is checked is every place that names the version to install.
 */
export function versionProblems(files: ReadonlyMap<string, string>, current: Release): string[] {
  const out: string[] = [];
  const minor = current.version.split(".").slice(0, 2).join(".");
  for (const [path, markdown] of files) {
    if (path === "CHANGELOG.md") continue;
    const text = markdown;
    const pins = [
      ...[...text.matchAll(/dev\.rayfold:[a-z-]+:(\d+\.\d+\.\d+)/g)].map((m) => m[1]!),
      ...[...text.matchAll(/<groupId>dev\.rayfold<\/groupId>\s*<artifactId>[^<]+<\/artifactId>\s*<version>(\d+\.\d+\.\d+)<\/version>/g)].map((m) => m[1]!),
      ...[...text.matchAll(/@rayfold\/[a-z-]+@(\d+\.\d+\.\d+)/g)].map((m) => m[1]!),
      ...[...text.matchAll(/[Vv]ersion (\d+\.\d+\.\d+) is on npm/g)].map((m) => m[1]!),
      ...[...text.matchAll(/Rayfold (\d+\.\d+\.\d+) is out/g)].map((m) => m[1]!),
      ...[...text.matchAll(/a new project starts on (\d+\.\d+\.\d+)/g)].map((m) => m[1]!),
    ];
    for (const v of pins) if (v !== current.version) out.push(`${path}: names ${v} as the version to use; the current release is ${current.version}`);
  }

  const changelog = files.get("CHANGELOG.md") ?? "";
  if (!new RegExp(`^## ${current.version.replace(/\./g, "\\.")} \\(${current.date}\\)$`, "m").test(changelog)) out.push(`CHANGELOG.md: no "## ${current.version} (${current.date})" section`);

  const versioning = files.get("docs/versioning.md") ?? "";
  const published = /## What is published\s+\|[^\n]*\n\|[-| ]+\n\|\s*\*\*([\d.]+)\*\*\s*\|\s*([\d-]+)\s*\|([^\n]*)/.exec(versioning);
  if (!published) out.push("docs/versioning.md: no table of published versions");
  else {
    if (published[1] !== current.version || published[2] !== current.date) out.push(`docs/versioning.md: the newest published version reads ${published[1]} (${published[2]}), not ${current.version} (${current.date})`);
    if (!/current release/i.test(published[3]!)) out.push("docs/versioning.md: the newest row does not say it is the current release");
  }
  for (const m of versioning.matchAll(/^\|\s*\*\*([\d.]+)\*\*\s*\|[^\n]*current release/gim)) {
    if (m[1] !== current.version) out.push(`docs/versioning.md: ${m[1]} is called the current release`);
  }

  const security = files.get("SECURITY.md") ?? "";
  const supported = [...security.matchAll(/^\|\s*([\d.]+\.x)\s*\|\s*yes\s*\|/gm)].map((m) => m[1]!);
  if (supported.join() !== `${minor}.x`) out.push(`SECURITY.md: supports ${supported.join(", ") || "nothing"}; the latest minor is ${minor}.x`);
  return out;
}

/** The README's install and layout tables name every package and module there is. */
export function packageProblems(readme: string, npm: readonly string[], jvm: readonly string[], dirs: readonly string[]): string[] {
  const out: string[] = [];
  const install = /## Install\n([\s\S]*?)\n## /.exec(readme)?.[1] ?? "";
  // a whole name: @rayfold/server is not @rayfold/server-kit
  const named = (name: string) => new RegExp(`(?<![\\w/-])${name.replace(/[/.]/g, "\\$&")}(?![\\w-])`).test(install);
  for (const name of npm) if (!named(name)) out.push(`README.md: the Install table has no row for ${name}`);
  for (const module of jvm) if (!named(module)) out.push(`README.md: the Install table has no row for dev.rayfold:${module}`);
  for (const dir of dirs) if (!readme.includes(`[\`${dir}\`]`)) out.push(`README.md: the layout table has no row for ${dir}`);
  return out;
}

/**
 * Phrases a reader takes as a sign that nobody wrote the page: the writing talking about itself, and the stock words a
 * generator reaches for. Each is checked as a whole word, case-insensitive, in prose only.
 */
export const STOCK_PHRASES = [
  "honest", "honestly", "which is what", "it is worth", "worth noting", "to be clear", "the point is", "put simply",
  "in short", "under the hood", "at its core", "seamless", "seamlessly", "effortless", "leverage", "unlock",
  "game-changer", "cutting-edge", "delve", "robust",
];

/** Where a page of the site sounds machine-written: an em dash in its prose (a table cell of only one is "none"), or a stock phrase. */
export function voiceProblems(path: string, markdown: string): string[] {
  const out: string[] = [];
  const phrases = new RegExp(`(?<![\\w-])(${STOCK_PHRASES.join("|")})(?![\\w-])`, "gi");
  prose(markdown)
    .split("\n")
    .forEach((line, i) => {
      if (line.replace(/\|\s*\u2014\s*(?=\|)/g, "|").includes("\u2014")) out.push(`${path}:${i + 1}: an em dash`);
      for (const m of line.matchAll(phrases)) out.push(`${path}:${i + 1}: "${m[1]}"`);
    });
  return out;
}
