/**
 * The places Markdown names the version to install, rewritten to a new one. `set-version.mjs` runs it over every
 * tracked Markdown file at a release; `docs/.vitepress/docs-facts.test.ts` fails if one is left behind.
 *
 * The changelog and the versioning page are history and are written by hand, so they are not passed in.
 */
export function pinVersions(text, version) {
  const minor = version.split(".").slice(0, 2).join(".");
  return text
    .replace(/(dev\.rayfold:[a-z-]+:)\d+\.\d+\.\d+/g, `$1${version}`)
    .replace(/(<groupId>dev\.rayfold<\/groupId>\s*<artifactId>[^<]+<\/artifactId>\s*<version>)\d+\.\d+\.\d+(<\/version>)/g, `$1${version}$2`)
    .replace(/(@rayfold\/[a-z-]+@)\d+\.\d+\.\d+/g, `$1${version}`)
    .replace(/([Vv]ersion )\d+\.\d+\.\d+( is on npm)/g, `$1${version}$2`)
    .replace(/(Rayfold )\d+\.\d+\.\d+( is out)/g, `$1${version}$2`)
    .replace(/^(\|\s*)\d+\.\d+(\.x\s*\|\s*yes\s*\|)/gm, `$1${minor}$2`);
}

/** Markdown that is history rather than instructions. */
export const HISTORY = new Set(["CHANGELOG.md", "docs/versioning.md"]);
