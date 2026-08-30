# @oxyhq/app-preset

The **Oxy distro of Expo** — the shared configuration every Oxy app (Mention,
Homiio, Allo, accounts, Commons, …) used to copy-paste, centralized into one
zero-build package. Apps replace four config-plugin entries, a hand-tuned Metro
config, a Babel config, an ESLint config, a Tailwind CSS header, and three
tsconfigs with a single dependency, and pick up ecosystem changes with a version
bump instead of re-editing every repo.

There is no build step: this package ships plain CommonJS config plus static CSS
and JSON.

## What it centralizes

| Piece | Import | Replaces |
| --- | --- | --- |
| Config plugin | `['@oxyhq/app-preset', {}]` | `withSharedUserId` + iOS keychain entitlement + `expo-build-properties` + `@oxyhq/services/plugins/withSharedIdentityReader` |
| Android release build | `@oxyhq/app-preset/plugin/withOxyAndroidRelease` | R8 `-optimize` ProGuard file + shared-keystore release signing (opt-in, see below) |
| Android WebP resources | `@oxyhq/app-preset/plugin/withOxyAndroidWebp` | re-encoding generated mipmaps/splash bitmaps to real lossless WebP (opt-in, needs `sharp`) |
| Oxy Updates (OTA) | `@oxyhq/app-preset/plugin/withOxyUpdates` | the `expo-updates` manifest URL, release channel, `runtimeVersion` policy and the shared code-signing certificate (opt-in, see below) |
| Metro | `@oxyhq/app-preset/metro` | monorepo watch folders, block list, symlink + package-exports resolution, web-font/wasm asset exts, release minifier, NativeWind wrapper |
| Babel | `@oxyhq/app-preset/babel` | `babel-preset-expo` + `module-resolver` + `react-native-worklets/plugin` |
| ESLint | `@oxyhq/app-preset/eslint` | `eslint-config-expo/flat` + `dist/*` ignore |
| CSS base | `@oxyhq/app-preset/base.css` | Tailwind v4 + NativeWind + Bloom design-token imports + SDK `@source` globs |
| tsconfig | `@oxyhq/app-preset/tsconfig/{base,frontend,backend}.json` | the shared strict/composite TypeScript bases |

## Usage

### 1. Config plugin (`app.config.js` / `app.json`)

```js
plugins: [
  // …app-specific plugins…
  ['@oxyhq/app-preset', {}],
]
```

This adds `android:sharedUserId="so.oxy.shared"`, the iOS
`keychain-access-groups` entitlement (`$(AppIdentifierPrefix)group.so.oxy.shared`),
the Oxy `expo-build-properties` defaults (iOS `deploymentTarget 16.4`; Android
`compileSdk 36` / `targetSdk 35` / ProGuard + resource shrinking), and the
`@oxyhq/services` shared-identity reader plugin (Android signature permission +
`<queries>` for silent "Sign in with Oxy").

Each piece is individually disableable and overridable:

```js
['@oxyhq/app-preset', {
  sharedUserId: 'so.oxy.shared',        // false → skip android:sharedUserId
  keychainGroup: 'group.so.oxy.shared', // false → skip iOS keychain entitlement
  ios: { deploymentTarget: '17.0' },    // deep-merges over defaults; false → skip iOS build props
  android: { targetSdkVersion: 34 },    // deep-merges over defaults; false → skip Android build props
  sharedIdentityReader: true,           // false → skip @oxyhq/services reader plugin
}]
```

#### Android release-build plugins (opt-in)

These two are deliberately NOT part of `['@oxyhq/app-preset', {}]`: one writes a
signing config and the other needs `sharp` installed, so both are registered
explicitly by apps that ship to Play.

```js
plugins: [
  // FIRST in the array so it RUNS LAST — mods execute in reverse registration
  // order, and this has to run after every image generator (splash included).
  '@oxyhq/app-preset/plugin/withOxyAndroidWebp',
  // …app-specific plugins…
  '@oxyhq/app-preset/plugin/withOxyAndroidRelease',
]
```

`withOxyAndroidRelease` reads the release keystore from four Gradle properties
(`OXY_UPLOAD_STORE_FILE`, `OXY_UPLOAD_STORE_PASSWORD`, `OXY_UPLOAD_KEY_ALIAS`,
`OXY_UPLOAD_KEY_PASSWORD`) in `~/.gradle/gradle.properties` or CI secrets — never
from the repo. When they are absent the release buildType falls back to the debug
keystore, so **always verify the artefact's certificate** (`keytool -printcert
-jarfile <aab>`, `apksigner verify --print-certs <apk>`) instead of assuming.

`withOxyAndroidWebp` requires `sharp` as a devDependency of the app.

#### Oxy Updates (OTA) (opt-in)

`withOxyUpdates` points `expo-updates` at the self-hosted **Oxy Updates** server
(`/updates/v1` in oxy-api) and wires the ecosystem code-signing certificate. It is
opt-in because it needs the app's own registered client id.

```js
plugins: [
  ['@oxyhq/app-preset/plugin/withOxyUpdates', { clientId: OXY_CLIENT_ID }],
]
```

Prerequisites in the app: `expo-updates` as a dependency (at the version
`expo install expo-updates` resolves for its SDK), and a registered
`ApplicationCredential` publicKey (`oxy_dk_...`), normally already present as an
`EXPO_PUBLIC_OXY_CLIENT_ID`-backed constant because the same id identifies the app
to the session and OAuth flows. `expo-updates` needs no plugin entry of its own:
prebuild applies its config plugin automatically.

| Option | Default | Meaning |
| --- | --- | --- |
| `clientId` | required | The registered `ApplicationCredential` publicKey |
| `apiOrigin` | `https://api.oxy.so` | Origin serving `/updates/v1` |
| `channel` | `production` | Release channel this binary polls |
| `codeSigning` | `auto` | `require` to fail the build when the certificate is missing; `false` to skip signing |
| `certificatePath` | bundled certificate | Only for a key-rotation overlap |
| `runtimeVersionPolicy` | `appVersion` | `false` leaves whatever the app declared |

**runtimeVersion is the `appVersion` policy on purpose.** It is the only policy the
Oxy toolchain resolves end to end: `oxy-ship` derives the publish runtime from
`expo config --json --type public`, where `fingerprint` resolves only to the
sentinel `file:fingerprint` (it is a build-time value), so a fingerprint app would
need `--runtime-version` passed by hand on every publish. The rule that follows:
**the app `version` is the OTA compatibility boundary. Bump it whenever native
code changes.** Installs on the old `version` then correctly stop receiving
updates published under the new one; installs on an unbumped version would
receive JS assuming native modules they do not have.

**Code signing is one certificate for the whole ecosystem**, shipped in this
package at `certs/oxy-updates-code-signing.pem` rather than copied into each app
repo, so a rotation is one preset bump. See `certs/README.md` for how it is
generated and rotated. Until that file exists, `withOxyUpdates` wires the update
URL but not signature verification and warns on both platforms; because the
certificate is baked into the native build, a binary shipped in that state can
never verify a manifest for its lifetime, so **do not ship a store build of an
OTA-enabled app before the certificate is committed.** Pass
`{ codeSigning: 'require' }` to make that a build failure instead of a warning.

Publishing is `oxy-ship` (`@oxyhq/ship`); see that package's README and its
`templates/publish-update.yml` CI workflow.

### 2. Metro (`metro.config.js`)

```js
const { createOxyMetroConfig } = require('@oxyhq/app-preset/metro');

module.exports = createOxyMetroConfig(__dirname, {
  sharedTypesPackage: '@myapp/shared-types', // optional
  cssInput: './global.css',                  // optional, this is the default
  dropConsole: true,                         // optional, production web only
  // svgTransformerPath: require.resolve('react-native-svg-transformer/expo'),
  // extraBlockList: [path.join(__dirname, '../../.claude/worktrees')],
});
```

`extraBlockList` accepts regular expressions or directory paths. Directory
paths are escaped and block only their descendants. `extraNodeModules`,
`extraWatchFolders`, `extraAssetExts`, and `extraSourceExts` extend the shared
defaults without replacing them.

### 3. Babel (`babel.config.js`)

```js
module.exports = require('@oxyhq/app-preset/babel');
```

### 4. ESLint (`eslint.config.js`)

```js
const oxyConfig = require('@oxyhq/app-preset/eslint');
module.exports = [...oxyConfig];
```

### 5. CSS (`global.css`)

```css
@import "@oxyhq/app-preset/base.css";

/* App-specific globs (later rules win on overlap): */
@source "./app/**/*.{js,jsx,ts,tsx}";
@source "./components/**/*.{js,jsx,ts,tsx}";
```

### 6. TypeScript (`tsconfig.json`)

```jsonc
// frontend
{ "extends": "@oxyhq/app-preset/tsconfig/frontend.json", "compilerOptions": { "paths": { "@/*": ["./*"] } }, "include": ["**/*.ts", "**/*.tsx"] }
// backend
{ "extends": "@oxyhq/app-preset/tsconfig/backend.json", "compilerOptions": { "rootDir": "./", "outDir": "dist" }, "include": ["**/*.ts"] }
```

## Peer dependencies

All peers are **optional** except `expo` — a piece's peer is only needed when you
use that piece (e.g. `expo-build-properties` only when build properties are
enabled, `eslint-config-expo` only for the ESLint config). The config plugin and
factories throw a clear, actionable error if a required peer is missing.

## Compatibility

Requires **Expo SDK 56+**; validated against **Expo SDK 57 / React Native 0.86**
(the current Oxy ecosystem target) via `test-app-expo`.
