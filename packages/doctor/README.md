# Oxy Doctor

Read-only health checks for JavaScript/TypeScript repositories in the Oxy
ecosystem. Doctor never edits manifests, installs packages, or bypasses a
lockfile; dependency changes remain reviewable commits produced by Renovate or
a developer.

## Usage

```bash
bunx @oxy.so/doctor
bunx @oxy.so/doctor --ci
bunx @oxy.so/doctor --json
```

It checks direct dependencies under the canonical `@oxy.so/*` scope against
npm, reports duplicate
versions in `bun.lock`, and fails
clearly when the lockfile is missing. `--ci` exits 1 for findings; operational
failures use status 2. Default mode is informational.

Use Renovate with a shared organisation preset for grouped, reviewable updates.
Require normal tests and typecheck before merging; never use `latest` ranges or
mutate dependencies during application startup or CI. Renovate proposes
changes; Doctor detects drift and duplicate installations.
