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
bunx @oxy.so/doctor --ci --grace-days=7
```

It checks direct dependencies under the canonical `@oxy.so/*` scope against
npm, reports duplicate
versions in `bun.lock`, and fails
clearly when the lockfile is missing.

A range that doesn't include the newest published `@oxy.so/*` release is a
**warning** for 14 days after that release was published (`--grace-days=N`
changes the window), and an **error** after that. `--ci` exits 1 on errors
only, so publishing a new major never turns every app's CI, and every deploy
gated on it, red at once; each app still has to upgrade inside the window.
Duplicate locked versions and a missing lockfile are always errors.
Operational failures use status 2. Default mode is informational.

Use Renovate with a shared organisation preset for grouped, reviewable updates.
Require normal tests and typecheck before merging; never use `latest` ranges or
mutate dependencies during application startup or CI. Renovate proposes
changes; Doctor detects drift and duplicate installations.
