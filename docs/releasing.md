# Releasing Rayfold

How a version goes out, and the one-time setup it relies on. The npm packages and the JVM artifacts share one version
number ([versioning.md](versioning.md)).

## Cutting a release

1. Set the version everywhere: `node scripts/set-version.mjs 0.2.0`.
2. Move the "Unreleased" entries of `CHANGELOG.md` under a heading for the version and its date.
3. Check locally: `npm ci && npm test && npm run build && npm run smoke:packages`, then `cd kotlin && ./gradlew check`
   and `npm run smoke:maven`. `npm run release:dry-run` lists what each npm package would contain, and uploads nothing.
4. Commit, then tag and push: `git tag v0.2.0 && git push origin main --tags`.

The tag starts `.github/workflows/release.yml`:

- **Test both runtimes:** checks the tag against the package version and against `VERSION_NAME` in
  `kotlin/gradle.properties`, then runs `npm test` and `./gradlew check`. Neither registry publishes until this passes,
  so a version cannot reach one of them while the other runtime is broken.
- **npm:** publishes every package in dependency order with a provenance statement (`scripts/publish.mjs
  --provenance`). The script refuses to run when the packages disagree on the version, or when that version is already
  on npm.
- **Maven Central:** signs and releases with `publishAndReleaseToMavenCentral`.
- **GitHub release:** once both are out, a release for the tag with that version's section of `CHANGELOG.md` as its
  notes (`scripts/release-notes.mjs`) and CycloneDX bills of materials for the npm packages and the JVM artifacts.

A published version can never be replaced. Fix a mistake with a new patch version and `npm deprecate` the bad one: npm
allows unpublishing only within 72 hours, and Maven Central not at all.

## Afterwards

- `npm view @rayfold/server version`, then `npm install @rayfold/server @rayfold/client` in an empty folder.
- The artifacts under `dev.rayfold` on central.sonatype.com. Search shows them a while after the repository does.
- The GitHub release with its two bills of materials.

## What a release relies on

| What | Where |
|---|---|
| The `@rayfold` npm scope | the `rayfold` organisation on npmjs.com |
| Publishing to npm | repository secret `NPM_TOKEN`. Once every package has a trusted publisher on npmjs.com (GitHub Actions, workflow `release.yml`), the secret can be removed |
| The `dev.rayfold` namespace | verified on central.sonatype.com by a TXT record on rayfold.dev. Keep the record, and keep the domain on auto-renew |
| Maven Central credentials | secrets `MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD`: a user token from central.sonatype.com |
| Signing | secrets `SIGNING_KEY` (the ASCII-armored private key) and `SIGNING_KEY_PASSWORD`, with the public key on a public key server |
| POM details | `kotlin/gradle.properties` |
| The documentation site | `.github/workflows/docs.yml` deploys rayfold.dev on every push to `main`. Settings > Pages holds the custom domain with Enforce HTTPS ticked; DNS has four A records on `@` for GitHub Pages and a CNAME `www` |

To publish the JVM artifacts from a machine instead, put the same four secrets, plus `signAllPublications=true`, in `~/.gradle/gradle.properties`
(`mavenCentralUsername`, `mavenCentralPassword`, `signingInMemoryKey`, `signingInMemoryKeyPassword`, and
`signAllPublications=true`), then run `./gradlew publishAndReleaseToMavenCentral` in `kotlin/`.

## Before offering anything commercial

- Run a trademark search on the name. If it has to change, `python scripts/rename-project.py rayfold NEWNAME` renames
  everything in one command.
- `NOTICE` names "The Rayfold Authors". Decide whether the specification is also offered under CC BY 4.0.
- If the demo or the real-data set is published anywhere else, keep `data/README.md` with it: the catalogue comes from
  Project Gutenberg, and that name is their trademark.
