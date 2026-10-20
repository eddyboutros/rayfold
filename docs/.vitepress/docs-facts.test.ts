/**
 * Every Markdown file in the repository, the READMEs and the changelog included, which the site never builds: its links
 * lead somewhere, and what it says about versions and packages is what the packages say.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkProblems, linksIn, packageProblems, versionProblems, voiceProblems, type Repo } from "./docs-facts.ts";
import { ERROR_TYPES } from "./errors.ts";
import { ROOT } from "./links.ts";
import { pinVersions } from "../../scripts/markdown-pins.mjs";
import { PACKAGES } from "../../scripts/packages.mjs";

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
// generated reports are checked by the tests that write them
const GENERATED = /^(e2e\/[^/]+\.md|bench\/results\/.+\.md)$/;
const tracked = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((p) => p && !GENERATED.test(p));

const repo: Repo = {
  text: (p) => (existsSync(join(ROOT, p)) ? read(p) : undefined),
  exists: (p) => existsSync(join(ROOT, p)),
  errorTypes: new Set(ERROR_TYPES.map((e) => e.type)),
};

const version = (JSON.parse(read("packages/schema/package.json")) as { version: string }).version;
const date = new RegExp(`^## ${version.replace(/\./g, "\\.")} \\((\\d{4}-\\d{2}-\\d{2})\\)$`, "m").exec(read("CHANGELOG.md"))?.[1] ?? "?";
const npm = PACKAGES.map((p) => (JSON.parse(read(`${p.dir}/package.json`)) as { name: string }).name);
const jvm = [...read("kotlin/settings.gradle.kts").matchAll(/include\("([^"]+)"\)/g)].map((m) => m[1]!);
const dirs = PACKAGES.map((p) => p.dir).filter((d) => d.startsWith("packages/"));

describe("every Markdown file in the repository", () => {
  it("is found: the READMEs, the changelog and the spec as well as the site's pages", () => {
    expect(tracked).toContain("README.md");
    expect(tracked).toContain("CHANGELOG.md");
    expect(tracked).toContain("packages/server/README.md");
    expect(tracked).toContain("spec/13-patches.md");
    expect(tracked).not.toContain("e2e/report.md");
    expect(tracked.length).toBeGreaterThan(90);
  });

  it("links to files, pages and headings that exist", () => {
    expect(tracked.flatMap((p) => linkProblems(p, read(p), repo))).toEqual([]);
  });

  it("names the current release wherever it says which version to use", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(versionProblems(new Map(tracked.map((p) => [p, read(p)])), { version, date })).toEqual([]);
  });

  it("lists every published package and module in the README", () => {
    expect(npm.length).toBe(13);
    expect(jvm.length).toBe(8);
    expect(packageProblems(read("README.md"), npm, jvm, dirs)).toEqual([]);
  });

  it("reads as written by a person on every page of the site: no em dashes, no stock phrases", () => {
    const site = tracked.filter((p) => /^(docs|spec)\//.test(p) && !/(^|\/)README\.md$|^docs\/releasing\.md$/.test(p));
    expect(site.length).toBeGreaterThan(60);
    expect(site.flatMap((p) => voiceProblems(p, read(p)))).toEqual([]);
  });
});

/** A repository of a few files, for showing each check catches the mistake it is for. */
const small = (files: Record<string, string>, extra: string[] = []): Repo => ({
  text: (p) => files[p],
  exists: (p) => p in files || extra.includes(p) || Object.keys(files).some((f) => f.startsWith(`${p}/`)),
  errorTypes: new Set(["internal"]),
});

describe("the link check", () => {
  const guide = "# Guide\n\n## Live queries\n\nText.\n\n## Live queries\n\n<a id=\"pinned\"></a>\n";

  it("finds a missing file, and passes one that is there", () => {
    const r = small({ "docs/guide/a.md": "", "docs/guide/b.md": guide });
    expect(linkProblems("docs/guide/a.md", "[b](b.md) [c](c.md)", r)).toEqual(["docs/guide/a.md: c.md points at docs/guide/c.md, which does not exist"]);
  });

  it("finds an anchor no heading makes, and passes one that a heading, a repeat of it, or an <a id> makes", () => {
    const r = small({ "docs/guide/a.md": "", "docs/guide/b.md": guide });
    expect(linkProblems("docs/guide/a.md", "[x](b.md#live-queries) [y](b.md#live-queries-1) [z](b.md#pinned) [w](b.md#live)", r)).toEqual([
      "docs/guide/a.md: b.md#live names no heading in docs/guide/b.md",
    ]);
    expect(linkProblems("docs/guide/b.md", `${guide}\n[up](#guide) [down](#nowhere)`, r)).toEqual(["docs/guide/b.md: #nowhere names no heading on this page"]);
  });

  it("reads a site path in a page of the site, and refuses one in a README, which GitHub would send to github.com", () => {
    const r = small({ "docs/comparison.md": "# Comparison\n\n## Speed\n", "docs/guide/a.md": "" }, ["e2e/report.html"]);
    const links = "[c](/comparison#speed) [e](/errors/internal) [r](/should-you-use-rayfold.html) [x](/errors/made_up) [y](/nothing)";
    expect(linkProblems("docs/guide/a.md", links, r)).toEqual(["docs/guide/a.md: /errors/made_up is no page of the site", "docs/guide/a.md: /nothing is no page of the site"]);
    expect(linkProblems("packages/server/README.md", "[c](/comparison)", r)).toEqual(["packages/server/README.md: /comparison is a site path, and this file is read on GitHub and npm"]);
  });

  it("ignores what is written as code, and still checks what is not (guard)", () => {
    const md = "```md\n[gone](gone.md)\n```\n`[also gone](gone.md)` and [real](gone.md)";
    expect(linksIn(md)).toEqual(["gone.md"]);
  });

  it("reads reference links and HTML links too", () => {
    expect(linksIn('[x][r]\n\n[r]: ref.md\n\n<a href="html.md">h</a> <img src="logo.svg" alt="">')).toEqual(["ref.md", "html.md", "logo.svg"]);
  });
});

describe("the version check", () => {
  const good = new Map([
    ["CHANGELOG.md", "## Unreleased\n\n## 0.4.1 (2027-01-02)\n\n## 0.4.0 (2026-12-01)\n"],
    ["docs/versioning.md", "## What is published\n\n| Version | Date | |\n|---|---|---|\n| **0.4.1** | 2027-01-02 | The current release. |\n| **0.4.0** | 2026-12-01 | Older. |\n"],
    ["SECURITY.md", "| Version | Supported |\n|---|---|\n| 0.4.x | yes |\n"],
    ["docs/guide/kotlin.md", 'implementation("dev.rayfold:rayfold-core:0.4.1")'],
    ["README.md", "Version 0.4.1 is on npm and Maven Central."],
  ]);
  const current = { version: "0.4.1", date: "2027-01-02" };

  it("passes files that all name the current release", () => {
    expect(versionProblems(good, current)).toEqual([]);
  });

  it("finds a stale pin, a stale versioning row, a stale supported minor and a missing changelog section", () => {
    const stale = new Map(good);
    stale.set("docs/guide/kotlin.md", 'implementation("dev.rayfold:rayfold-core:0.4.0")\n<groupId>dev.rayfold</groupId>\n<artifactId>rayfold-java</artifactId>\n<version>0.3.9</version>');
    stale.set("docs/versioning.md", "## What is published\n\n| Version | Date | |\n|---|---|---|\n| **0.4.0** | 2026-12-01 | The current release. |\n");
    stale.set("SECURITY.md", "| 0.3.x | yes |\n");
    stale.set("CHANGELOG.md", "## 0.4.0 (2026-12-01)\n");
    stale.set("ROADMAP.md", "Rayfold 0.1.0 is out.");
    expect(versionProblems(stale, current)).toEqual([
      "docs/guide/kotlin.md: names 0.4.0 as the version to use; the current release is 0.4.1",
      "docs/guide/kotlin.md: names 0.3.9 as the version to use; the current release is 0.4.1",
      "ROADMAP.md: names 0.1.0 as the version to use; the current release is 0.4.1",
      'CHANGELOG.md: no "## 0.4.1 (2027-01-02)" section',
      "docs/versioning.md: the newest published version reads 0.4.0 (2026-12-01), not 0.4.1 (2027-01-02)",
      "docs/versioning.md: 0.4.0 is called the current release",
      "SECURITY.md: supports 0.3.x; the latest minor is 0.4.x",
    ]);
  });

  it("leaves the changelog's history alone, which names old versions on purpose (guard - a pin elsewhere is checked)", () => {
    const history = new Map(good);
    history.set("CHANGELOG.md", `${good.get("CHANGELOG.md")}\nUse dev.rayfold:rayfold-core:0.3.0 to get this.\n`);
    expect(versionProblems(history, current)).toEqual([]);
    history.set("docs/guide/java.md", "Use dev.rayfold:rayfold-core:0.3.0 to get this.");
    expect(versionProblems(history, current)).toEqual(["docs/guide/java.md: names 0.3.0 as the version to use; the current release is 0.4.1"]);
  });
});

describe("the version a release writes into Markdown (scripts/markdown-pins.mjs, run by set-version.mjs)", () => {
  const stale = [
    'implementation("dev.rayfold:rayfold-core:0.1.0")',
    "<groupId>dev.rayfold</groupId>\n  <artifactId>rayfold-java</artifactId>\n  <version>0.2.1</version>",
    "npm install @rayfold/server@0.2.0",
    "Version 0.2.1 is on npm and Maven Central.",
    "Rayfold 0.1.0 is out.",
    "| 0.1.x | yes |",
  ].join("\n");

  it("rewrites every pin the version check reads, so a release leaves none behind", () => {
    const pinned = pinVersions(stale, "0.4.1");
    expect(pinned).toBe(
      [
        'implementation("dev.rayfold:rayfold-core:0.4.1")',
        "<groupId>dev.rayfold</groupId>\n  <artifactId>rayfold-java</artifactId>\n  <version>0.4.1</version>",
        "npm install @rayfold/server@0.4.1",
        "Version 0.4.1 is on npm and Maven Central.",
        "Rayfold 0.4.1 is out.",
        "| 0.4.x | yes |",
      ].join("\n"),
    );
    const files = new Map([
      ["CHANGELOG.md", "## 0.4.1 (2027-01-02)\n"],
      ["docs/versioning.md", "## What is published\n\n| Version | Date | |\n|---|---|---|\n| **0.4.1** | 2027-01-02 | The current release. |\n"],
      ["SECURITY.md", pinned],
    ]);
    expect(versionProblems(files, { version: "0.4.1", date: "2027-01-02" })).toEqual([]);
  });

  it("leaves other versions alone: tools, other groups and the protocol's own (guard)", () => {
    const other = 'Node 22.12.0, `npm install vitest@5.0.2`, `org.postgresql:postgresql:42.7.14`, Core 0.1 is frozen.\n<groupId>org.example</groupId>\n<artifactId>x</artifactId>\n<version>1.2.3</version>';
    expect(pinVersions(other, "0.4.1")).toBe(other);
  });
});

describe("the package check", () => {
  const readme = "## Install\n\n| a | `npm install @rayfold/server` |\n| b | `dev.rayfold:rayfold-core` |\n\n## Layout\n\n| [`packages/server`](packages/server) | x |\n";

  it("passes a README that names every package, module and folder", () => {
    expect(packageProblems(readme, ["@rayfold/server"], ["rayfold-core"], ["packages/server"])).toEqual([]);
  });

  it("finds a package, a module and a folder it leaves out, and does not take @rayfold/server-x for @rayfold/server", () => {
    expect(packageProblems(readme, ["@rayfold/server", "@rayfold/rb"], ["rayfold-core", "rayfold-jdbc"], ["packages/server", "packages/rb"])).toEqual([
      "README.md: the Install table has no row for @rayfold/rb",
      "README.md: the Install table has no row for dev.rayfold:rayfold-jdbc",
      "README.md: the layout table has no row for packages/rb",
    ]);
    expect(packageProblems(readme.replace("@rayfold/server", "@rayfold/server-kit"), ["@rayfold/server"], [], [])).toEqual(["README.md: the Install table has no row for @rayfold/server"]);
  });
});

describe("the voice check", () => {
  it("finds an em dash and a stock phrase in prose, with the line they are on", () => {
    expect(voiceProblems("a.md", "One.\nThis is the honest version — of it.\n")).toEqual(["a.md:2: an em dash", 'a.md:2: "honest"']);
    expect(voiceProblems("a.md", "Which Is What it does.")).toEqual(['a.md:1: "Which Is What"']);
  });

  it("leaves code, a table cell of only a dash, and words that only contain a phrase alone (guard - the same dash in a sentence cell is found)", () => {
    expect(voiceProblems("a.md", "```\nx — honest\n```\n`honest —`\n| a | — |\n| b |—|\nDishonesty and unlocked rows.\n")).toEqual([]);
    expect(voiceProblems("a.md", "| a | yes — mostly |\n")).toEqual(["a.md:1: an em dash"]);
  });
});
