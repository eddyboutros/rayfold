/**
 * How a link in a Markdown file is read: once by the site, as it builds the page, and once by the test that checks
 * every Markdown file in the repository, the READMEs included, which the site never builds.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const REPO = "https://github.com/eddyboutros/rayfold";

/** GitHub's heading ids, so an anchor that works on GitHub works here too. */
export const slugify = (text: string) =>
  text.toLowerCase().trim().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");

export type Target =
  /** another site, a mail address, or a link within the same page */
  | { kind: "elsewhere" }
  /** a path on the site, written as one (`/errors/internal`) */
  | { kind: "route"; route: string; hash: string | undefined }
  /** a file in the repository, relative to the root */
  | { kind: "file"; path: string; hash: string | undefined };

/** What a link in `sourcePath` (relative to the repository root) points at. */
export function linkTarget(sourcePath: string, href: string): Target {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return { kind: "elsewhere" };
  const [path = "", hash] = href.split("#");
  if (href.startsWith("/")) return { kind: "route", route: path, hash };
  return { kind: "file", path: posix.normalize(posix.join(posix.dirname(sourcePath), path)), hash };
}

/**
 * Where a relative link in a page goes. Pages are written to work on GitHub, so links point at files: another page
 * of the site becomes that page, and any other file in the repository becomes its page on GitHub. A link to a file
 * that does not exist fails the build.
 */
export function siteLink(sourcePath: string, href: string): string {
  const t = linkTarget(sourcePath, href);
  if (t.kind !== "file") return href;
  const anchor = t.hash ? `#${t.hash}` : "";
  if (/^(docs|spec)\/.+\.md$/.test(t.path) && existsSync(join(ROOT, t.path))) {
    return `/${t.path.replace(/^docs\//, "").replace(/\.md$/, "")}${anchor}`;
  }
  if (!existsSync(join(ROOT, t.path))) throw new Error(`${sourcePath}: link to ${href}, which does not exist`);
  return `${REPO}/${statSync(join(ROOT, t.path)).isDirectory() ? "tree" : "blob"}/main/${t.path}${anchor}`;
}

/**
 * The anchors a Markdown file offers: its headings as GitHub and the site number them (a repeated heading gets -1,
 * -2...), and any `<a id>` or `<a name>` it sets. Headings inside code fences are code, not headings.
 */
export function anchorsOf(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]!.slice(0, 3);
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const text = h[1]!.replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_]/g, "");
      const base = slugify(text);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      out.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]!);
  }
  return out;
}

export const readText = (path: string) => readFileSync(join(ROOT, path), "utf8");
