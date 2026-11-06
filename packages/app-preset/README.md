# @oxy.so/app-preset

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
| Config plugin | `['@oxy.so/app-preset', {}]` | iOS keychain entitlement + `expo-build-properties` + `@oxy.so/services/plugins/withOxySharedPermissions` (which signs every release with the ecosystem key, see below) + the R8 `-optimize` ProGuard file + one APK per ABI |
| Android WebP resources | `@oxy.so/app-preset/plugin/withOxyAndroidWebp` | re-encoding generated mipmaps/splash bitmaps to real lossless WebP (opt-in, needs `sharp`) |
| Oxy Updates (OTA) | `@oxy.so/app-preset/plugin/withOxyUpdates` | the `expo-updates` manifest URL, release channel, `runtimeVersion` policy and the shared code-signing certificate, required (opt-in, see below) |
| Metro | `@oxy.so/app-preset/metro` | monorepo watch folders, block list, symlink + package-exports resolution, web-font/wasm asset exts, release minifier, NativeWind wrapper |
| Babel | `@oxy.so/app-preset/babel` | `babel-preset-expo` alone in development, so Expo's oxc transformer (Noxcturnal) runs; the build-id inliner in production |
| ESLint | `@oxy.so/app-preset/eslint` | `eslint-config-expo/flat` + `dist/*` ignore |
| CSS base | `@oxy.so/app-preset/base.css` | Tailwind v4 + NativeWind + Bloom design-token imports + SDK `@source` globs |
| tsconfig | `@oxy.so/app-preset/tsconfig/{base,frontend,backend}.json` | the shared strict/composite TypeScript bases |

## Static web hydration on Expo 58

Apps exporting static HTML can enable the reviewed Expo 58 compatibility adapter:

```js
module.exports = createOxyMetroConfig(__dirname, {
  staticHydrationBoundary: true,
});
```

Expo Router's renderer in `@expo/router-server` 58.0.14–58.0.16 and 58.0.18–58.0.21
(Expo 58.0.23, expo-router 58.0.30) renders the app
inside `+html`, but the browser hydrates only `#root`. Document siblings then
change React `useId` paths. An ID in text (for example Bloom's scoped stylesheet)
causes React to replace the workspace during hydration.

The adapter renders the app at its own React root and then renders the document
around that completed markup. It preserves Expo's route/loader contexts,
metadata, asset order, bootstrap script, fonts and styles, including resources
registered inside async Suspense content. React’s public `prerender` API waits
for all content without hidden streaming segments that would require JavaScript. React 19's hoisted document resources
move into the final head; the app's remaining HTML and hydration markers retain
the exact bytes produced by React. Server errors fail the static export. `Head` metadata is collected from the
routed app tree; `+html` owns its literal head and `useServerDocumentContext`,
as in Expo (the route-aware `Head` component requires navigation context).

Only web/node bundles and `output: 'static'` use the adapter. Live streaming
requests delegate to Expo unchanged. It is off by default; enabling it with an
unreviewed router-server version fails with a diagnostic instead of silently
assuming private APIs are compatible. Optional peer ranges do not restrict
older Expo apps when the adapter is off. Review/remove the adapter when Expo
fixes the app/document render boundary upstream. The adapted Expo code retains
its MIT license in `metro/static-hydration/EXPO-LICENSE`.

Development uses the same boundary when starting Expo with
`EXPO_WEB_DEV_HYDRATE=1`. Expo otherwise calls `createRoot`, replacing its server
markup rather than hydrating it. In development the adapter also uses Expo's
actual web `withDevTools` wrapper: its refresh indicator is initially invisible,
but its sibling still changes React's `useId` paths. Production does not include
that wrapper. Keep Fast Refresh enabled; do not compensate for IDs in app code.

Verify production exports, not just Metro development: JavaScript-disabled
screenshots must show real chrome, and hydration must retain the same workspace
DOM node without recoverable React errors. The package tests exercise real
`prerender` and `hydrateRoot`; publication runs those gates too.

## Usage

### 1. Config plugin (`app.config.js` / `app.json`)

```js
plugins: [
  // …app-specific plugins…
  ['@oxy.so/app-preset', {}],
]
```

This adds the iOS `keychain-access-groups` entitlement
(`$(AppIdentifierPrefix)group.so.oxy.shared`; only Commons and the Peable wallet get
more, and any other app naming `so.oxy.identity` or `so.oxy.wallet` fails prebuild —
ADR 0062 of the oxy repo), the Oxy `expo-build-properties`
defaults (iOS `deploymentTarget 16.4`; Android ProGuard + resource shrinking — the
Android compile/target SDK and build tools are the Expo SDK's own, never pinned here), and `@oxy.so/services/plugins/withOxySharedPermissions`:
the app declares and requests the signature-level `so.oxy.permission.IDENTITY` and
`so.oxy.permission.DEVICE_SESSION`, with `<queries>` for the Commons and Accounts
providers. That is how silent "Sign in with Oxy" works on Android: each Oxy app
has its own UID, and Commons — the only holder of the identity key — answers over
signature-protected IPC. **Never add `android:sharedUserId`.**

The iOS and build-property pieces are overridable:

```js
['@oxy.so/app-preset', {
  keychainGroup: 'group.so.oxy.shared', // default: the bundle id's groups; false → skip (the policy still checks)
  ios: { deploymentTarget: '17.0' },    // deep-merges over defaults; false → skip iOS build props
  android: { targetSdkVersion: 34 },    // deep-merges over defaults; false → skip Android build props
}]
```

##### Dropping React Native's GIF / WebP decoders (opt-in, Expo SDK 58+)

An app that renders no GIF and no animated WebP through react-native's own
`Image`/`ImageBackground` (Bloom included — `expo-image` decodes on its own) can
leave Fresco's GIF and WebP decoders out of the Android build, about 340 KB of
download and 870 KB installed with R8:

```js
['@oxy.so/app-preset', {
  android: { gifEnabled: false, webpEnabled: false }, // deep-merges over the defaults
}]
```

The keys pass straight through to `expo-build-properties`, which writes
`expo.gif.enabled=false` / `expo.webp.enabled=false` to `gradle.properties`. This
is **not a default**: an app that still shows a GIF or an animated WebP through
react-native's `Image` renders nothing for it, with no error. The keys exist from
`expo-build-properties` 58 (Expo SDK 58); older versions ignore them silently.

The `sharedUserId` and `sharedIdentityReader` options were removed in 3.0.0 and
throw if passed. `@oxy.so/services` 13.4.0+ is a required peer (the preset refuses an older one: it would declare the permissions without release signing).

`webgpu: true` (opt-in, 3.2.0+) also applies `react-native-webgpu`'s config
plugin, for an app that draws with WebGPU on native. Install
`react-native-webgpu` in the app first; the option throws without it.

#### Android release signing (always on, fails closed)

Every Oxy Android release is signed with the ONE ecosystem key (certificate
SHA-256 `b8ab3746466ce4569d7a6a0ffa1eed91bc375174d503613987ca09cb33d6a58d`,
alias `oxy`). It is not a preset plugin: `@oxy.so/services/plugins/withOxySharedPermissions`
applies `withOxyReleaseSigning` (services 13.4.0+), because the signature
permissions it declares are what make the certificate load-bearing. A release
signed with anything else takes ownership of `so.oxy.permission.IDENTITY` /
`DEVICE_SESSION`, after which every correctly signed Oxy app fails to install
(`INSTALL_FAILED_DUPLICATE_PERMISSION`), and Commons refuses it. So every app
that declares the permissions, through the preset or directly, gets the rule;
**list no signing plugin**.

The keystore comes from Gradle properties (`~/.gradle/gradle.properties`, `-P`,
or `ORG_GRADLE_PROJECT_<name>` environment variables), never from the repo:

```properties
OXY_UPLOAD_STORE_FILE=~/.config/oxy/oxy-ecosystem-release.keystore
OXY_UPLOAD_STORE_PASSWORD_FILE=~/.config/oxy/oxy-ecosystem-release-keystore.pass
OXY_UPLOAD_KEY_ALIAS=oxy
```

`OXY_UPLOAD_STORE_PASSWORD` takes the password itself instead of a file;
`OXY_UPLOAD_KEY_PASSWORD` (or `_FILE`) is needed only when the key's password
differs from the store's. `~/` is expanded, a password file is trimmed.

Release always uses `signingConfigs.release`; nothing falls back to the debug
key. A task, `oxyVerifyReleaseSigning`, runs before every release variant
(`pre…ReleaseBuild`, `validateSigning…Release`, so `assembleRelease`,
`bundleRelease`, `expo run:android --variant release` and EAS's release
builds) and fails the build, saying how to provide the key, unless the release
buildType's EFFECTIVE signing config opens and its certificate is the ecosystem
one. It checks the outcome, not the properties, so it also refuses EAS-managed
or per-app keys and a wrong alias. Debug builds never run it. There is no
opt-out for release.

Debug builds keep Expo's debug key unless `OXY_UPLOAD_SIGN_DEBUG=true` is set:
then debug is signed with the same key and checked by the same task, so a dev
client can be installed next to real Oxy apps and be granted the permissions
(this replaces Willo's `withOxyDebugSigning`, which prebuild now refuses). An app
that declares no Oxy permission (Authenticator) lists
`@oxy.so/services/plugins/withOxyReleaseSigning` directly for the same release
signing.

`withOxyAndroidRelease` was removed in 5.0.0; listing it throws and says to delete it.

#### Store build number (always on, 6.0.0+)

The preset derives Android `versionCode` and iOS `buildNumber` from the app's
`version`: `major * 1_000_000 + minor * 1_000 + patch` (1.2.3 → 1002003; minor
and patch ≤ 999). Every later version gets a strictly higher number, which is
what Google Play and the App Store require, and nobody keeps it by hand. An app
config that still sets `android.versionCode` or `ios.buildNumber` fails to
load: delete them. `version` must be `MAJOR.MINOR.PATCH`.

`version` is also the OTA boundary (`withOxyUpdates`, `appVersion` policy):
bump it for a native change and the next push to main releases a new binary
(oxy's `android-release.yml`, docs/engineering/build-and-deploy.md#native-android-releases);
a JS-only change keeps the version and ships as an OTA update.

#### One APK per ABI (always on, 6.1.1+)

`withOxyAbiSplits`, applied by the preset and by `withOxyUpdates`, adds Gradle
ABI splits to `android/app/build.gradle`, so `assembleRelease` writes one APK per
ABI and no universal APK:

| APK | For |
| --- | --- |
| `app-arm64-v8a-release.apk` | almost every phone and tablet, anything from about 2017 on |
| `app-armeabi-v7a-release.apk` | older phones, and Android TVs and TV boxes |

A universal APK carries every ABI's native libraries and a phone loads one
(Mention: 126 MB, of which 55 MB arm64-v8a and 37 MB armeabi-v7a libraries).
`bundleRelease` is unaffected: the AAB keeps every ABI and Google Play serves
each device its slice.

Build the AAB and the APKs in **two Gradle invocations**
(`./gradlew :app:bundleRelease`, then `./gradlew :app:assembleRelease`). When R8
shrinks resources, AGP fails a build that makes split APKs next to an app bundle
("Multiple shrunk-resources files found … Please disable building multiple APKs
when building an Android app bundle",
[issuetracker 402800800](https://issuetracker.google.com/402800800)), so the
splits are off in any invocation that builds a bundle, and that invocation's
`assembleRelease` gives a universal APK.

A build that compiles none of those ABIs splits to the ones it compiles, so
`expo run:android` on an x86_64 emulator (it passes
`-PreactNativeArchitectures=x86_64`) still gets `app-x86_64-debug.apk`, which the
Expo CLI installs by the device's ABI. An ABI that is not compiled never gets
an APK of its own, since it would carry no native libraries.

Both release APKs have the app's one `versionCode`. They are the same version of
the same app, so Android installs either over the other; Google Play's rule of a
distinct versionCode per APK applies only to APKs uploaded to Play, and Play
gets the AAB. A `build.gradle` that already has a `splits {}` block (an app's own
plugin) fails prebuild: remove it. The release workflow
(docs/engineering/build-and-deploy.md#native-android-releases) publishes the two
APKs and fails a build without them.

#### Android WebP resources (opt-in)

`withOxyAndroidWebp` needs `sharp` installed, so it is registered explicitly:

```js
plugins: [
  // FIRST in the array so it RUNS LAST — mods execute in reverse registration
  // order, and this has to run after every image generator (splash included).
  '@oxy.so/app-preset/plugin/withOxyAndroidWebp',
  // …app-specific plugins…
]
```

`withOxyAndroidWebp` requires `sharp` as a devDependency of the app.

#### Oxy Updates (OTA) (opt-in)

`withOxyUpdates` points `expo-updates` at the self-hosted **Oxy Updates** server
(`/updates/v1` in oxy-api) and wires the ecosystem code-signing certificate. It is
opt-in because it needs the app's own registered client id.

```js
plugins: [
  ['@oxy.so/app-preset/plugin/withOxyUpdates', { clientId: OXY_CLIENT_ID }],
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
| `codeSigning` | `require` | Fails when the certificate is missing; `auto` warns and `false` skips signing (development only) |
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
repo, so a rotation is one preset bump. See `certs/README.md` for how it was
generated, where its private key lives, and how to rotate it. `withOxyUpdates`
fails the build (5.2.0+; before that the code defaulted to a warning) when the
certificate is missing or is not a PEM certificate, rather than producing a
binary that accepts unsigned manifests for its whole lifetime. The server side
matches: oxy-api signs every manifest and directive and serves nothing, and
accepts no publish, without its key. Development builds may explicitly pass
`{ codeSigning: 'auto' }` to receive platform warnings, or
`{ codeSigning: false }` to opt out of verification.

Publishing is `oxy-ship` (`@oxy.so/ship`) from GitHub Actions, with **no stored
secret** (oxy ADR 0057, GitHub trusted publishing). Per app repository:

1. Declare the repository as the app's trusted publisher: an Oxy app adds
   `trustedPublishers: [otaPublisher('OxyHQ/<Repo>', '<numeric id>')]` to its
   entry in oxy's `seedOxyApplicationsSpecs.ts` and runs the seed; a
   third-party app registers it with
   `POST https://api.oxy.so/applications/<appId>/trusted-publishers`.
2. Add `@oxy.so/ship` as a devDependency.
3. Copy `@oxy.so/ship/templates/publish-update.yml` to
   `.github/workflows/publish-update.yml` and set `OXY_CLIENT_ID` in it to the
   same public client id passed to `withOxyUpdates` above.

Every push to `main` then publishes to `production`; the job's GitHub OIDC
token (`permissions: id-token: write`) is exchanged for a five-minute
`updates:publish` token of that app only. Pull requests never publish. See the
`@oxy.so/ship` README for the exchange and the registration fields.

### 2. Metro (`metro.config.js`)

```js
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

module.exports = createOxyMetroConfig(__dirname, {
  sharedTypesPackage: '@myapp/shared-types', // optional
  cssInput: './global.css',                  // optional, this is the default
  dropConsole: true,                         // optional, production web only
  // svgTransformerPath: require.resolve('react-native-svg-transformer/expo'),
  // workspaceRoot: path.join(__dirname, '../..'), // optional, see below
});
```

Metro watches the app's install root and resolves hoisted dependencies from its
`node_modules`. The root is found by walking up from the project, never past its
git checkout: the nearest `package.json` that declares `workspaces`, else the
nearest lockfile, else the checkout's top level. A monorepo app watches the
monorepo; a single-package app watches only itself. `workspaceRoot` overrides it.
Worktrees under `<root>/.worktrees` and `<root>/.claude/worktrees` are blocked.

`workletsBundleMode: true` (opt-in, 3.2.0+) turns on react-native-worklets'
[Bundle Mode](https://docs.swmansion.com/react-native-worklets/docs/bundleMode).
It wraps the finished config with worklets' `getBundleModeMetroConfig`. Use it
together with the Babel option of the same name (below); neither works alone.

`extraBlockList` accepts regular expressions or directory paths. Directory
paths are escaped and block only their descendants. `extraNodeModules`,
`extraWatchFolders`, `extraAssetExts`, and `extraSourceExts` extend the shared
defaults without replacing them.

#### Native CSS runtime identity (5.2.1+)

Native bundles resolve `react-native-css` runtime imports and stylesheet injection
through the app's CommonJS export condition. The package's ESM and CommonJS builds
own separate root-variable registries; loading both can leave variable-based
utilities such as `text-white` without their registered color. The resolver runs
below NativeWind so redirected component imports share the same runtime, while
preserving native component export conditions. Web resolution is unchanged.

When validating a packed dependency on Android, force Metro to regenerate the
release bundle: Gradle can otherwise reuse its previous bundle despite a changed
package install. Inspect the regenerated source map for a single CSS runtime
before comparing device behavior.

#### `react-native` on native: the complete NativeWind shim (4.1.0+)

On native, NativeWind's resolver sends every `import … from 'react-native'`
outside React Native itself to `react-native-css/components`, a shim that
re-exports a FIXED list of React Native's API. A name React Native adds and the
list lacks reads as `undefined`: React Native 0.88 added `AssetRegistry`, Expo
SDK 58's `expo-asset` imports it from `'react-native'`, every `useFonts` failed
(`Cannot read property 'getAssetByID' of undefined`), Bloom's font loader never
rendered its children, and Android release builds showed a blank screen with no
visible error (upstream: nativewind/react-native-css#506, #504).

`createOxyMetroConfig` returns `metro/react-native.js` wherever NativeWind
resolved `react-native` to that shim: the shim's own properties, copied as they
are (so `className` behaves exactly as NativeWind makes it), plus every other
name of React Native's index, forwarded to React Native. Only a request for
exactly `react-native` that NativeWind resolved to the shim is touched; web,
deep `react-native/…` imports and every other module resolve as before. No
`node_modules` patch is needed, and a name React Native adds later is covered
without one. An app that wraps the returned `resolveRequest` in its own (Allo's
`@hpke` and harness aliases) sits above this one, which is fine as long as it
hands `react-native` and `react-native-css/components` down unchanged.

An app that still composes `withNativeWind` itself gets the same fix by
wrapping its finished config, LAST (over worklets' Bundle Mode too):

```js
const { withCompleteReactNative } = require('@oxy.so/app-preset/metro');

module.exports = withCompleteReactNative(withNativeWind(config, options), __dirname);
```

### 3. Babel (`babel.config.js`)

```js
module.exports = require('@oxy.so/app-preset/babel');
```

In development this is exactly `babel-preset-expo`. Expo's oxc transformer,
Noxcturnal, runs only when the Babel config resolves to the bare Expo preset;
one extra plugin or preset option sends every file back to Babel. The config
plugin turns the experiment (`experiments.noxcturnalTransformWorker`) on for
development; `noxcturnal: false` opts out. Production builds stay on Babel,
with the build-id inliner, because Noxcturnal keeps the requires of dead
platform branches and pulls native-only packages into a web bundle.

`@/` resolves from the app's `tsconfig.json` paths (`"@/*": ["./*"]`), not from
Babel. Jest needs the same alias in `moduleNameMapper`
(`"^@/(.*)$": "<rootDir>/$1"`). `babel-preset-expo` adds
`react-native-worklets/plugin` and the `import.meta` transform itself. An app
that adds its own Babel plugins, or a custom `babelTransformerPath` such as
`react-native-svg-transformer`, keeps every file on Babel.

With Bundle Mode (opt-in, 3.2.0+), a worker runtime runs the app's own modules:

```js
module.exports = require('@oxy.so/app-preset/babel').createOxyBabelConfig({
  workletsBundleMode: {
    // The modules whose imports a worklet runs ON its runtime (worklets'
    // `importForwarding`). An import not forwarded stays on the RN runtime,
    // and a synchronous call to it from a worker runtime throws.
    importForwarding: { relativePaths: ['components/map/engine/city3d'] },
  },
});
```

### 4. ESLint (`eslint.config.js`)

```js
const oxyConfig = require('@oxy.so/app-preset/eslint');
module.exports = [...oxyConfig];
```

### 5. CSS (`global.css`)

```css
@import "@oxy.so/app-preset/base.css";

/* App-specific globs (later rules win on overlap): */
@source "./app/**/*.{js,jsx,ts,tsx}";
@source "./components/**/*.{js,jsx,ts,tsx}";
```

### 6. TypeScript (`tsconfig.json`)

```jsonc
// frontend
{ "extends": "@oxy.so/app-preset/tsconfig/frontend.json", "compilerOptions": { "paths": { "@/*": ["./*"] } }, "include": ["**/*.ts", "**/*.tsx"] }
// backend
{ "extends": "@oxy.so/app-preset/tsconfig/backend.json", "compilerOptions": { "rootDir": "./", "outDir": "dist" }, "include": ["**/*.ts"] }
```

## Peer dependencies

All peers are **optional** except `expo` — a piece's peer is only needed when you
use that piece (e.g. `expo-build-properties` only when build properties are
enabled, `eslint-config-expo` only for the ESLint config). The config plugin and
factories throw a clear, actionable error if a required peer is missing.

## Compatibility

Requires **Expo SDK 56+**; validated against **Expo SDK 58 / React Native 0.88**
(the current Oxy ecosystem target) with a clean `expo prebuild` of `test-app-expo`,
`accounts` and `commons` (Android and iOS). SDK 58's Android template already
uses `proguard-android-optimize.txt` and turns R8 on through `gradle.properties`
(`android.enableMinifyInReleaseBuilds`), so the preset's `-optimize` ProGuard
swap only changes anything on SDK 56/57.
