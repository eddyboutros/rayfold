# Publishing Rayfold: what remains

Status on 2026-09-11. "Owner" marks steps only the project owner can take: accounts, legal choices, and anything
published under the owner's name.

## What is ready

| Area | State |
|---|---|
| npm packages | Twelve packages build to self-contained `dist/` folders with compiled ESM, type declarations, a publish-ready `package.json`, README, LICENSE and NOTICE: `@rayfold/schema`, `rb`, `builder`, `server`, `postgres`, `otel`, `explorer`, `lsp`, `client`, `react`, `cli`, `conformance`. `npm run smoke:packages` installs the packed tarballs into a fresh project and checks them under plain Node, with strict types, in a browser bundle and with React server rendering. `npm run release:dry-run` lists what each package would contain. |
| JVM artifacts | Seven modules publish to Maven Central through the Central Portal, each with sources, javadoc and a POM (Apache-2.0): `rayfold-core`, `rayfold-java`, `rayfold-spring-boot-starter`, `rayfold-client`, `rayfold-client-okhttp`, `rayfold-opentelemetry`, `rayfold-jdbc`. `npm run smoke:maven` publishes them to the local Maven repository and builds a separate project against the jars. |
| Platforms | Node.js server and client; browsers; React 18/19 hooks; Kotlin server that reads `.rayfold` itself, with JSON and RB over HTTP and WebSocket, cache headers and live queries; Java API; Spring Boot 4 starter with Spring Security and the WebSocket on the application's port; Kotlin and Android client with an OkHttp WebSocket transport; optimistic commands and an offline queue in both clients; Postgres resolvers with policies pushed into SQL; OpenTelemetry tracing in both runtimes; Java code generation (`rayfold gen java`). |
| Tests | 453 TypeScript tests (32 files), including property-based fuzzing of every reader and transport, and 769 JVM tests across the seven modules (`./gradlew check`, which also checks the client modules against Android API level 26). The web demo runs in Chromium, Firefox and WebKit (`npm run test:browsers`, 9 tests) and behind a real nginx proxy and shared cache (`npm run check:proxy`, 9 checks). `npm run bench:load` measures sustained load. |
| CI | `ci.yml`: TypeScript on Node 22 and 24, the JVM check, the three browsers, the nginx proxy check, and dependency and secret scanning (npm audit, OSV-Scanner, gitleaks). `fuzz.yml`: the fuzz tests a hundred times deeper every night, with a new seed. `release.yml`: npm and Maven Central on a `v*` tag, then a GitHub release with CycloneDX SBOMs for both. `docs.yml`: the docs site on GitHub Pages. Every action is pinned to a commit, and Dependabot watches npm, Gradle and the actions. **None has run yet**: nothing is pushed. |
| Documentation | Guides in `docs/guide/` (quickstart, React, Kotlin and Android, Java and Spring Boot, offline and optimistic updates, Postgres, tracing, coming from REST, coming from GraphQL), `docs/versioning.md`, the specification with its change process (`spec/process.md`), `CHANGELOG.md`, and `npm run docs:site`, which builds everything into `site/` and fails on a broken link. |
| Project files | `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and pull-request templates, `.github/dependabot.yml`, `.gitattributes` (LF everywhere). |
| License | Apache-2.0 in `LICENSE`, `"license": "Apache-2.0"` in every package, `NOTICE`. |

## 1. Owner steps before the first release

| Item | Owner step |
|---|---|
| **Name** | Rayfold since 2026-09-10; on that date `rayfold` was free on npm, PyPI, crates.io and GitHub. rayfold.dev is registered to the owner since 2026-09-15, with no website: it exists for the Maven Central namespace, and the documentation lives on GitHub Pages. **Owner:** run a trademark search before offering anything commercial under the name. `python scripts/rename-project.py rayfold NEWNAME` renames everything in one command if needed. |
| **First push** | The repository exists: https://github.com/eddyboutros/rayfold (private, with a one-line README). The local folder is already a git repository whose `main` tracks `origin/main`, with nothing committed. **Owner:** review, `git add -A`, commit (your README replaces the one-liner), `git push`. `repository`, `homepage` and `bugs` in `package.json` and the POM URLs already point at it. |
| **Public repository** | **Owner:** make it public before publishing: npm provenance refuses a private source repository, and private vulnerability reporting, which `SECURITY.md` points to, needs a public one. Then turn on Settings > Security > Private vulnerability reporting. |
| **Documentation site** | Settings > Pages > Source: GitHub Actions, custom domain `rayfold.dev`, HTTPS enforced. The site deploys to https://rayfold.dev/ on every push to `main` (`.github/workflows/docs.yml`); GitHub redirects the old `eddyboutros.github.io/rayfold/` links there, which keeps the problem-type URIs of 0.1.0 working. DNS at GoDaddy: four A records on `@` for GitHub's addresses (185.199.108.153 to 185.199.111.153) and a CNAME `www` to `eddyboutros.github.io`, next to the Maven Central TXT record. |
| **npm organisation** | **Owner:** create the `rayfold` organisation on npmjs.com (free for public packages), so the `@rayfold` scope is yours. |
| **Maven Central namespace** | The group is `dev.rayfold` (`GROUP` in `kotlin/gradle.properties`), and the owner holds rayfold.dev. **Owner:** at central.sonatype.com, add the namespace `dev.rayfold`; Central shows a verification code. At the registrar (GoDaddy: DNS > Manage DNS > Add record), add a TXT record for `@` with that code as its value, then press Verify. No website or hosting is needed. Keep the record, and keep the domain on auto-renew. |
| **POM details** | Filled in `kotlin/gradle.properties` for github.com/eddyboutros. **Owner:** `POM_DEVELOPER_NAME` is your GitHub handle; put your name there if you prefer it. |
| **Signing key** | **Owner:** `gpg --full-generate-key`, publish the public key (`gpg --keyserver keys.openpgp.org --send-keys <id>`), keep the private key for CI. |
| **Copyright holder** | `NOTICE` says "The Rayfold Authors", a common and valid choice. **Owner:** replace it with your name or company if you want; decide whether the spec text should also be offered under CC BY 4.0. |

## 2. Publishing to npm

The first release goes out from your machine; later ones from CI.

1. `npm login` (enable two-factor authentication on the account first).
2. Set the version everywhere, npm and JVM alike: `node scripts/set-version.mjs 0.1.0` (already 0.1.0), and move the
   "Unreleased" entries of `CHANGELOG.md` under the version.
3. Check: `npm ci && npm test && npm run build && npm run smoke:packages`.
4. `npm run release:dry-run` builds and lists every file each package would publish. Nothing is uploaded.
5. `npm run release` publishes the ten packages in dependency order, each with public access. npm asks for your
   one-time password per package. The script refuses to run when the packages disagree on the version, when that
   version is already on npm, or when `repository` is missing.
6. Check: `npm view @rayfold/server`, then `npm install @rayfold/server @rayfold/client` in an empty folder.
7. For later releases: on npmjs.com, add a trusted publisher to each package (GitHub Actions, your repository,
   workflow `release.yml`). Then a release is `node scripts/set-version.mjs 0.2.0`, commit, `git tag v0.2.0`,
   `git push --tags`, and `release.yml` publishes with a provenance statement and no token, then creates the GitHub
   release with the SBOMs. Until trusted publishing is set up, an `NPM_TOKEN` repository secret works too.

A published version can never be replaced: fix a mistake with a new patch version and `npm deprecate` the bad one.
Unpublishing is only possible within 72 hours.

## 3. Publishing to Maven Central

1. Create an account at central.sonatype.com and verify the namespace (section 1).
2. Generate a user token (Account, Generate User Token): a username and a password.
3. Create the signing key (section 1).
4. Check locally: `cd kotlin && ./gradlew check publishToMavenLocal`, then `npm run smoke:maven`.
5. Add repository secrets: `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `SIGNING_KEY` (the ASCII-armored
   private key, `gpg --armor --export-secret-keys <id>`) and `SIGNING_KEY_PASSWORD`.
6. Push a `v*` tag: `release.yml` runs the tests, then `publishAndReleaseToMavenCentral`. From your own machine
   instead, put the same four values in `~/.gradle/gradle.properties` (`mavenCentralUsername`,
   `mavenCentralPassword`, `signingInMemoryKey`, `signingInMemoryKeyPassword`, plus `signAllPublications=true`) and
   run `./gradlew publishAndReleaseToMavenCentral`.

## 4. Still open

- **Independent security review.** `spec/12-security.md` lists the rules, 27 attacks run end to end on every test run,
  and the readers are fuzzed; an outside review or penetration test is still the step before announcing.
- **Environments not tested yet:** Safari itself on macOS and iOS (WebKit on Linux and Windows stands in for it); a real
  Android device or emulator (the client modules are checked against the Android API instead); a commercial CDN
  (nginx's cache stands in for one); load across machines rather than on one.
- **JVM runtime:** resolvers get no pushed-down read policy (`ctx.policy` in TypeScript), and there is no JDBC adapter
  yet; the JDK HTTP server's request timer is JVM-wide (under Spring, the container's timeouts apply).
- **Protocol drafts not implemented:** sync sessions and per-field merge policies (spec 08 section 5), HTTP/3 and
  WebTransport, credit-based flow control, field-usage telemetry, `@confirm`, capability tokens.
- **Community:** a public roadmap, a discussion forum, and an examples repository (bookstore, web demo, Spring Boot
  service, Android app).
- **Data attribution:** if the demo or the real-data set is published, keep `data/README.md` with it. The catalogue
  comes from Project Gutenberg, and its name is their trademark.

## 5. The explorer

Rayfold's counterpart to Swagger UI and GraphiQL is a page served next to the endpoint that reads everything it shows
from `/rayfold/manifest`: every operation with its arguments, result, cost and the policies that guard it; a starting
shape; the batch sent and the frames shown as they arrive, with their cost; dry runs where `@simulate` allows; and
live queries that keep updating. One page, two runtimes, kept identical by `npm run sync:explorer`.

- **TypeScript:** `@rayfold/explorer`, mounted next to the endpoint with `createExplorerHandler()`. `rayfold dev`
  serves it at `/rayfold/explorer`, in place of the playground it grew from.
- **Spring, Java and Kotlin:** the same page from `rayfold-core`, either mounted on a server of its own
  (`RayfoldExplorer(endpoint, title).mount(http)`) or turned on next to the endpoint with `HttpOptions(explorer = true)`;
  in Spring Boot, `rayfold.explorer.enabled=true`, behind the application's security like the endpoint itself.
- **Off unless it is turned on.** The page reads whatever the visitor's own token allows and nothing more, but it is
  still an administration surface: nothing is served until an application mounts it.
- **Already there:** routes bound with `@http` are described in `/rayfold/openapi.json`, which Swagger UI can render
  today.
