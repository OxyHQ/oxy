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
npm, reports duplicate versions in `bun.lock`, and fails clearly when the
lockfile is missing.

It reads the manifests Bun installs from: the root `package.json` and the
workspaces its `workspaces` patterns match. A `catalog:` dependency is checked
where its range lives, the root's `workspaces.catalog` (or `catalogs.<name>`).
A `package.json` outside the workspaces, such as a frozen copy kept as audit
evidence, is not this repository's dependency state and is not read.

A range that doesn't include the newest published `@oxy.so/*` release is a
**warning** for 14 days after that release was published (`--grace-days=N`
changes the window), and an **error** after that. `--ci` exits 1 on errors
only, so publishing a new major never turns every app's CI, and every deploy
gated on it, red at once; each app still has to upgrade inside the window.
Duplicate locked versions and a missing lockfile are always errors.
Operational failures use status 2. Default mode is informational.

It also checks that every app (a manifest on `@oxy.so/services` and on `expo`
or `react-native`) declares each REQUIRED native peer of the services it has
installed, an **error** otherwise (`undeclared-native-peer`, with the
`npx expo install …` line). Expo's autolinking skips optional peers and an
undeclared native module installs at whatever version the package manager
picks: an Android release without `expo-crypto` built, then had no CSPRNG and
no sign-in. The check reads the installed `@oxy.so/services` manifest, so run it
after `bun install`; a manifest whose services is not installed is listed as
unverified (`nativePeersUnverified` in `--json`), never passed.

Use Renovate with a shared organisation preset for grouped, reviewable updates.
Require normal tests and typecheck before merging; never use `latest` ranges or
mutate dependencies during application startup or CI. Renovate proposes
changes; Doctor detects drift and duplicate installations.
