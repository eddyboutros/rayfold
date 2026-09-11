# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub:
[Report a vulnerability](https://github.com/eddyboutros/rayfold/security/advisories/new) (the repository's
Security tab, "Report a vulnerability").

Include what you can of:

- the package or module and version (`@rayfold/server 0.1.0`, `dev.rayfold:rayfold-core:0.1.0`, ...);
- the runtime (TypeScript or Kotlin) and transport (HTTP, WebSocket, MCP, REST bindings);
- a request or schema that reproduces it, and what it lets an attacker do.

You will get an acknowledgement within 7 days, and a first assessment within 14. Fixes are released as patch versions
of every affected package, with a GitHub security advisory that credits you unless you prefer otherwise.

## Supported versions

Rayfold is before 1.0: only the latest minor version receives security fixes.

| Version | Supported |
|---|---|
| 0.1.x | yes |

## What is in scope

The security model is written down in [`spec/12-security.md`](spec/12-security.md): what a server must refuse (bodies,
nesting, cost, origins, hosts, keys), and how. A way around any of those rules, in either runtime, is in scope, as is
anything that lets a request read data its viewer's policies deny, change data without the rights to, or exhaust a
server with a request the limits should have refused.

Out of scope: problems that need a malicious server operator or schema author, denial of service through request
volume alone (put rate limits in front of the server, see spec 12), and findings in the demo applications under
`examples/` that do not affect the packages.

## How releases are protected

npm packages are published from GitHub Actions with provenance statements, Maven artifacts are signed, and every
release attaches a CycloneDX software bill of materials. CI scans dependencies (npm audit, OSV-Scanner, Dependabot)
and the history for committed secrets (gitleaks) on every push.
