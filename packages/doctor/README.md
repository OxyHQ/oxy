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
npm, fails on duplicate copies of a package in `bun.lock` or `node_modules`
(below), and fails clearly when the lockfile is missing.

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
A missing lockfile is always an error. Operational failures use status 2.
Default mode is informational.

## Duplicate copies

Each copy of a module is its own module instance: two `@oxy.so/contracts` are
two schema sets, two `@oxy.so/bloom` two theme contexts (a provider from one
copy is invisible to a consumer of the other), two `react` an invalid-hook
crash, two native modules a build that links one and runs the other. OxyOS's
packager refuses a duplicate module outright.

Doctor reads every copy `bun.lock` installs and who pulls each one (the
workspaces and packages whose dependency resolves to it), and reports:

- **`duplicate-copy`** (error, any package): the newest locked copy satisfies
  every range that pulls a copy, so one would do. Bun reuses an existing copy
  only when it satisfies a range, so after an SDK release moves the hoisted copy
  forward, a dependent's older nested copy stays locked: Dropsea once held
  `@oxy.so/protocol/@oxy.so/contracts@6.8.0` beside the hoisted 6.9.0, though
  protocol's `^6.5.0` accepts 6.9.0. Fix: `bun update <pkg>` and commit
  `bun.lock` (it needs no package that is not already locked).
- **`duplicate-pinned`**: every range accepts one older locked version, but a
  dependent pins below the newest, and Bun resolves the wider ranges to the
  newest, so `bun update` keeps both. An **error** for a single-copy package
  (fix: a release of the pinning dependent, or a root `overrides` entry); a
  **warning** for any other.
- **`duplicate-conflict`** (error, single-copy packages): no one version
  satisfies every range. No update can fix it; it names the dependents whose
  ranges reject the version the rest use, and they need a release (or, for a
  workspace, a wider range in its `package.json`).
- **`installed-duplicate`** (error): a single-copy package installed more than
  once under `node_modules` (hoisted, nested, or Bun's isolated `.bun` store,
  by real path) although `bun.lock` names one copy: a stale install, fixed by
  `bun install --frozen-lockfile`. Without `node_modules` only `bun.lock` is
  checked, and the CLI says so.

Single-copy packages: every `@oxy.so/*`, `react`, `react-dom`, `react-native`,
`expo`, `expo-modules-core`, `react-native-reanimated`,
`react-native-gesture-handler`, `react-native-safe-area-context`,
`react-native-screens`, `socket.io-client`, and `zod` among the copies
`@oxy.so/*` packages use (`@oxy.so/contracts` and an app's own
`@oxy.so/*-contracts` build schemas with it; a build tool's private zod may
differ). Copies of an ordinary package forced by incompatible ranges (two
majors of a utility) are normal and not reported. A copy bundled inside its
dependent's tarball is that dependent's own unless the package is single-copy.

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

## Translation keys

Every translation catalog follows one key convention (oxy
`docs/adr/0055-translation-keys.md`): nested objects of identifier segments
(`compose.toolbar.addImage`), the first segment a namespace, never the English
text and never a flat dotted string, and English as the source.

```bash
bunx oxy-doctor-i18n --ci            # every locales/ directory with an en catalog
bunx oxy-doctor-i18n --root=packages/frontend --json
```

It finds `locales/<lang>.json` (single file) and `locales/<lang>/<namespace>.json`
(per namespace) catalogs. **Errors** (`--ci` exits 1): a key segment that is
text (`text-key`), a dotted key stored flat (`flat-key`), a top-level string in
a single-file catalog (`top-level-string`), a leaf that is neither a string
nor a list of strings (`non-string`), a translation key the source lacks
(`stray-key`), a string where the source has a namespace or the reverse
(`shape-mismatch`). **Warnings**: a missing translation (`missing-translation`,
rendered in English) and a placeholder set that differs from the source
(`placeholder-mismatch`).

## Expo Android device-session autolinking

After a complete frozen install, run the separate check against the Expo app
root (the current directory by default):

```bash
oxy-doctor-expo-android --project-root=packages/frontend \
  --require-source=SharedDeviceSessionPublish.kt \
  --require-source=SharedDeviceSessionSweep.kt \
  --require-source=OxyDeviceSessionStore.kt
```

The command invokes the app's installed `expo-modules-autolinking` resolver and
requires exactly one Oxy Services entry matching the version resolved by Node
from the app root, and one device-session module from that package's Android
directory. It requires
`OxyDeviceSessionModule.kt` and any repeated `--require-source` filenames.
Choose additional sources according to the Services version and guarantees the
app expects; older releases need not contain newer files. Missing or ambiguous
results and resolver failures exit nonzero. This does not change the existing
Doctor or emulator preflight commands.

The check verifies discovery and source presence in the installed dependency
graph, not source contents, Android compilation, native binary distribution,
or device runtime behavior. It cannot exclude additional installed copies or
prove which copy Metro resolves from nested importers. Run it in a complete
install; a partial install cannot establish that the full app graph is correct.

## Android emulator preflight

`oxy-emulator-preflight --serial emulator-5554` checks that the explicitly
selected serial occurs exactly once as an online device in `adb devices -l`,
then asks its emulator console for the AVD name. It prints only the serial on
success and exits nonzero on invalid input, offline or ambiguous devices, an
unavailable ADB, or a missing AVD response. It never starts an emulator or runs
shell, installation, clearing, or uninstallation commands on a device.

The caller must carry the returned serial into every subsequent command, for
example using `adb -s "$serial" ...`; never rely on ADB's default selection.
Run the preflight immediately before the operation and fail on errors. This is a
read-only selection check, not an atomic device lock: devices can disconnect or
change between commands. It does not prove the AVD is disposable, has no user
data, or is isolated from production networks. Those are separate prerequisites
for an isolated mobile test.
