# Changelog: `@oxy.so/app-preset`

## 6.7.3

### Fixed

- The base worker's offline shell failed in production (`net::ERR_FAILED` on
  an offline reload of alia.onl). It was stored from `/index.html`, which
  Cloudflare's static assets redirect to `/` (307), and Chrome refuses a
  redirected response for a navigation. The shell is now fetched from `/`, and
  any stored or served shell is rebuilt as a response that went through no
  redirect (which also repairs shells stored by 6.7.2).
- An app only worked offline from its second visit: the first one loads its
  bundles and route chunks before the worker controls the page, so none of
  them was cached. The worker now stores the bundles and CSS the shell links
  when it installs, and `oxy-sw-register.js` sends it the same-origin files the
  page loaded once it takes over (`OXY_SW_STORE`; only static same-origin
  files are stored). Verified against alia.onl in Chromium: a first visit, then
  offline, renders the app.

## 6.7.2

### Added

- `oxy-web-pwa --remove-sw` ships a `/sw.js` that deletes the Oxy caches and
  unregisters itself: the way to take the worker away (shipping none leaves the
  old one running).
- The registration skips the HTTP cache (`updateViaCache: 'none'`) and a page
  back in the foreground checks for a new worker at most once an hour, so an
  installed app left open picks up deploys.

### Fixed

- A deploy no longer empties the cache: its name was a hash of the export, so
  `activate` dropped the previous deploy's chunks while a tab opened before the
  deploy could still need them. The cache is now `oxy-sw-v1`, bounded at 150
  entries oldest first; `activate` drops other `oxy-sw-*` caches.

## 6.7.1

### Added

- `oxy-web-pwa --theme-color=<light>,<dark>` writes the startup `theme-color`
  as a pair scoped by `prefers-color-scheme`, the shape Bloom adopts and owns at
  runtime, instead of the manifest's single `theme_color` (a brand accent such
  as Alia's would otherwise colour the browser bar until the app hydrates).

### Fixed

- The base worker served no offline shell: it skipped every request with
  `credentials: 'include'`, and every navigation has that mode, so an offline
  reload got the browser's error page. The rule protected nothing (a
  same-origin request sends cookies under `same-origin` too); private responses
  stay out through the same-origin, `Authorization`, `/api/` and
  `private`/`no-store` rules.

## 6.7.0

### Added

- `oxy-web-pwa <dist>`: makes an Expo web export installable. With
  `web.output: 'single'` Expo ignores `app/+html.tsx`, so the manifest link most
  Oxy apps wrote there never reached the page and no browser offered to install
  them. Run after `expo export`, the step fails the build on a manifest browsers
  refuse (or icons the export lacks), adds the manifest link, Apple tags,
  `theme-color` and the worker registration to every exported page that lacks
  them, and ships the Oxy base service worker. See README "Installable web apps".
- `web/oxy-sw-base.js`: the shared service worker, from Inbosh's: network-first
  navigation with an offline shell, stale-while-revalidate for same-origin
  hashed files, and nothing private or cross-origin ever stored. Apps with their
  own worker import it with `importScripts('/oxy-sw-base.js')`.

## 6.6.0

### Added

- Add `@oxy.so/app-preset/css/document-scroll.css` as an explicit web host opt-in
  for document-owned scrolling. It enables body overflow while preserving the
  default bounded reset, root geometry, nested bounded owners and modal scroll
  locking. The base stylesheet does not enable it automatically.

## 6.5.1

### Fixed

- Leave Expo's experimental Noxcturnal transformer opt-in. With Expo Metro 58.0.21
  and Noxcturnal 0.1.11, private-field lowering breaks TanStack Query 5.103.3
  observers during development startup. Default apps now use Babel again.
  Explicit `noxcturnal: true` still enables development transforms, and explicit
  `experiments.noxcturnalTransformWorker` values remain authoritative.

## 6.5.0

### Security

- **Signed builds are checked, not only prebuild output (security review R6-15).** `oxy-check-keychain-entitlements <bundle id> <path>` accepts a signed `.app`, `.xcarchive` or `.ipa`: it runs `codesign -d --entitlements - --xml` (macOS) on the app and on every extension it embeds (`PlugIns/*.appex`, `Extensions/*.appex`) and judges each under the bundle id and team its OWN signature names (`application-identifier`, `com.apple.developer.team-identifier`); the app must be signed as the bundle id asked about, and `--team-id` is refused there (the signature says it). Run it on every iOS archive before upload (oxy `docs/engineering/build-and-deploy.md`).
- **Bundle ids are compared without case, as Apple does.** A holder id in another case (`So.Oxy.Commons`, `TO.PEABLE.APP`) is refused as a misspelled holder instead of being judged as "every other app".

## 6.4.0

### Security

- The keychain access-group list is EXACT, not a floor (security re-review R5-4). An app may list only its bundle id's layout — Commons `[so.oxy.identity, so.oxy.wallet, group.so.oxy.shared]`, its dev build the `.dev` groups, the Peable wallet `[so.oxy.wallet, group.so.oxy.shared]`, its dev build `[so.oxy.wallet.dev, group.so.oxy.shared]`, every other app `[group.so.oxy.shared]` — in that order, optionally followed by its own `$(AppIdentifierPrefix)<bundle id>` (a holder may still list the shared group alone, before its split build). Any other entry fails prebuild; above all another app's bundle id (`$(AppIdentifierPrefix)to.peable.app` or `$(AppIdentifierPrefix)so.oxy.commons` in Mention, `to.peable.app.dev` anywhere but that build), because `<TEAM>.<bundle id>` is that app's private group, where its session and own items live (ADR 0062 D6). Before, any group other than the restricted ones passed.
- Every entry, the shared group included, must be spelled exactly `$(AppIdentifierPrefix)<group>` (or `<TEAMID>.<group>` with `--team-id`); another spelling of an allowed group is refused, not judged by its normalised name.
- `withOxyKeychain` no longer keeps another group a plugin or the app declared after the Oxy groups: it is kept, then refused.

### Added

- `allowedKeychainLayouts(bundleId)` (`@oxy.so/app-preset/plugin/oxyKeychainGroups`).
- Oxy's shared native release workflow runs `oxy-check-keychain-entitlements` over an iOS prebuild of every release and requires this version.

## 6.3.0

### Security

- The keychain access-group policy judges every SPELLING of a group, not only `$(AppIdentifierPrefix)<group>`. Each entry is normalised first (leading build variables such as `$(TeamIdentifierPrefix)` or `${AppIdentifierPrefix}`, nested ones included, a leading ten-character team id and surrounding whitespace are stripped; the name is compared without case), so `ABCDE12345.so.oxy.identity` or `$(TeamIdentifierPrefix)so.oxy.identity` no longer passes for an app that is not a holder. A restricted group must be spelled exactly `$(AppIdentifierPrefix)<group>`, even by its holder, and an entry that still carries a build variable, a wildcard or whitespace after normalisation is refused. `withOxyKeychain` keeps a misspelled restricted group another plugin wrote, so the check refuses it instead of repairing it.
- The dev builds no longer get the production restricted groups: `so.oxy.commons.dev` lists `[so.oxy.identity.dev, so.oxy.wallet.dev, group.so.oxy.shared]` and `to.peable.app.dev` `[so.oxy.wallet.dev, group.so.oxy.shared]` (`OXY_KEYCHAIN_GROUPS.identityDev` / `walletDev`). A dev build naming a production restricted group, a production app naming a `.dev` one, or any other app naming either, fails prebuild. A dev build sits next to the production app on the same phone, under the same team, running JavaScript from a dev server; it must not read the production identity or phrases.

### Added

- `oxy-check-keychain-entitlements <bundle-id> <entitlements-file-or-ios-dir> [--team-id <TEAMID>]` (also `@oxy.so/app-preset/check-entitlements`): the same policy over the entitlements a prebuild or a codesign actually wrote. Exits 1 on a violation, 2 when there is nothing readable to check. `--team-id` checks codesigned output, whose restricted entries must read `<TEAMID>.<group>`.
- `@oxy.so/app-preset/plugin/oxyKeychainGroups` is exported.

## 6.2.0

### Security

- The iOS keychain access groups are policy (ADR 0062 of the oxy repo): every app keeps `group.so.oxy.shared` as its default; only Commons (`so.oxy.commons`, `.dev`) may list `[so.oxy.identity, so.oxy.wallet, group.so.oxy.shared]` and only the Peable wallet (`to.peable.app`, `.dev`) `[so.oxy.wallet, group.so.oxy.shared]`, in that order (the first entry is the default group, which decides the app's role). Any other app naming either restricted group, or a holder putting another group first, fails prebuild — in `withOxyKeychain` and, for apps that declare `ios.entitlements` themselves, in `withOxyUpdates`, which every Oxy app applies.

### Changed

- `keychainGroup` defaults to the bundle id's groups (`keychainGroupsFor`), still the shared group for every app but the two holders, and accepts an array.


## 6.1.1

### Fixed

- `withOxyAbiSplits` turns the ABI splits off in a Gradle invocation that builds an app bundle. With R8 resource shrinking (every Oxy release), AGP failed `:app:bundleRelease :app:assembleRelease` at `buildReleasePreBundle`: "Multiple shrunk-resources files found … Please disable building multiple APKs when building an Android app bundle" ([issuetracker 402800800](https://issuetracker.google.com/402800800)). Build the AAB and the APKs in two invocations, as Oxy's release workflow now does.

## 6.1.0

### Added

- One APK per ABI, always (`withOxyAbiSplits`, applied by the preset and by `withOxyUpdates`): `assembleRelease` writes `app-arm64-v8a-release.apk` (phones from about 2017 on) and `app-armeabi-v7a-release.apk` (older phones, Android TVs) instead of one universal APK that carried both ABIs' native libraries (Mention: 126 MB, of which 55 MB arm64-v8a and 37 MB armeabi-v7a). The AAB is unaffected. A build that compiles none of those ABIs (`expo run:android` on an x86_64 emulator) splits to the ABIs it compiles. Both APKs keep the app's one `versionCode`, which is right for sideloading; Play gets the AAB. Oxy's release workflow now requires the split APKs, so an app's next native release needs this version. An app `build.gradle` that already has a `splits {}` block fails prebuild: remove the plugin that writes it.

## 6.0.0

### Breaking

- The preset derives the store build number from the app's `version`, always (`withOxyReleaseVersion`): Android `versionCode` and iOS `buildNumber` are `major * 1_000_000 + minor * 1_000 + patch` (1.2.3 → 1002003). An app config that still sets `android.versionCode` or `ios.buildNumber` now fails to load, and so does a `version` that is not `MAJOR.MINOR.PATCH`: remove both fields. Every new version gets a strictly higher build number, which Google Play requires, and a native release is exactly a version bump (`version` is already the OTA boundary).

## 5.3.1

### Fixed

- `staticHydrationBoundary` supports `@expo/router-server` 58.0.18–58.0.21, the renderer Expo 58.0.23 and expo-router 58.0.30 install. From 58.0.18 the CLI passes the renderer the route it matched and its params, and expo-router no longer exports `getRouteInfoForLocation`. The adapter reads the route with `getRouteInfoForMatchedRoute` and keys loader data by the route's own search params, as Expo's renderer does. 58.0.14–58.0.16 keep the location-based path. 58.0.17, a halfway renderer, stays refused. Before, an app on Expo 58.0.23 with the adapter enabled could not export.

## 5.3.0

### Changed

- The static-hydration document assembly parses with `parse5` 8 (was 7.3.0). parse5 8 is published ESM-only and is loaded with `require`, so the preset now declares Node `>=20.19.0`, the first release that loads an ES module from `require` without a flag (Expo SDK 58 already requires it).

## 5.2.0

### Security

- Ships the Oxy Updates code-signing certificate,
  `certs/oxy-updates-code-signing.pem` (RSA 2048, CN=Oxy Updates Code Signing,
  SHA-256 `E9:1D:40:E6:…:39:DA:81`, valid to 2036-10-24). Every OTA-enabled
  binary built with this preset verifies manifest signatures.
- `withOxyUpdates` now FAILS CLOSED, as its README already said: the default
  `codeSigning` is `'require'` (it was `'auto'`, which only warned and produced
  a binary that accepts unsigned manifests for its whole lifetime). A
  certificate file that is not a PEM certificate, or an unknown `codeSigning`
  value, is refused. `'auto'` and `false` remain for local development builds,
  explicitly.

## 5.1.0

### Fixed

- Metro answers an OPTIONAL require (`try { require('x') }`, an `import()` in a
  `try`) that lands on a native package Expo autolinking does not link with
  "not found", which is what the probe sees on a clean install. Commons 1.3.0
  crashed on launch from a checkout whose bun store kept a stale hoisted
  `node_modules/.bun/node_modules/@expo/ui` (57.0.17, in no lockfile):
  expo-router's `@expo/ui/jetpack-compose` probe found it and SDK 57 JS ran
  against an SDK 58 binary that never linked it. Static imports are unchanged
  (warned about once). `metro/linked-native-packages.js`.
- A RELEASE bundle (Metro `dev: false`, or NODE_ENV=production) refuses a
  workspace package's `dist/` that was not built from the checkout's `src/`.
  The same 1.3.0 build bundled a five-day-old `packages/contracts/dist` (Zod 3
  era) whose module scope called `innerType()` against Zod 4, and a core from
  before the commit's own KeyManager changes. A package opts in with
  `"oxySourceStamp": "dist"` and runs `metro/source-stamp.js` last in its
  build (core, contracts, protocol, telemetry and expo-splash do); the check is
  by content, so a checkout round trip that only changes mtimes passes. A
  package that does not opt in is only warned about, by mtime.
  `metro/fresh-workspace-builds.js`.

## 5.0.0

### Breaking

- `plugin/withOxyAndroidRelease` is removed; listing it throws with the fix.
  Release signing moved to `@oxy.so/services/plugins/withOxySharedPermissions`
  (services 13.4.0), which every Oxy Android app applies, directly or through
  this preset, and it now FAILS CLOSED: a release build is always signed by
  `signingConfigs.release` from the `OXY_UPLOAD_*` Gradle properties (new:
  `OXY_UPLOAD_STORE_PASSWORD_FILE` / `OXY_UPLOAD_KEY_PASSWORD_FILE`, and the key
  password defaults to the store's), and `oxyVerifyReleaseSigning` fails every
  release variant whose certificate is not the ecosystem one. A debug-signed
  Mention release, built without the properties, had taken ownership of
  `so.oxy.permission.IDENTITY` / `DEVICE_SESSION` on a phone, and every correctly
  signed Oxy app then failed with `INSTALL_FAILED_DUPLICATE_PERMISSION`. Debug
  builds are unchanged unless `OXY_UPLOAD_SIGN_DEBUG=true` opts them in. Delete
  the entry (and any app-local signing plugin).
- The `@oxy.so/services` peer floor is `>=13.4.0`, and the preset refuses an
  older Services: it would declare the permissions without release signing.

### Changed

- `['@oxy.so/app-preset', {}]` applies the R8 `-optimize` ProGuard swap that
  `withOxyAndroidRelease` did (a no-op on Expo SDK 58, whose template already
  uses it).

## 4.1.0

### Fixed

- `import … from 'react-native'` on native no longer loses every name
  NativeWind's `react-native-css/components` shim does not list. React Native
  0.88 added `AssetRegistry`, which Expo SDK 58's `expo-asset` imports from
  `'react-native'`; the shim lacked it, every `useFonts` failed with
  `Cannot read property 'getAssetByID' of undefined`, and Android release builds
  stayed on a blank screen. Metro now resolves that import to
  `metro/react-native.js`: the shim's own getters unchanged, plus a forwarding
  getter for each remaining name of React Native's index. No `node_modules`
  patch is needed (upstream: nativewind/react-native-css#506, #504).

### Added

- `withCompleteReactNative(config, projectRoot)` from `@oxy.so/app-preset/metro`,
  the same fix for an app that still composes `withNativeWind` itself. Apply it
  last.

## 4.0.0

### Breaking

- The Babel config no longer adds `babel-plugin-module-resolver`. `@/` resolves
  from the app's `tsconfig.json` paths instead (`"@/*": ["./*"]`), which Metro
  reads by default. An app that imports `@/…` without that path breaks, and its
  Jest config needs `"^@/(.*)$": "<rootDir>/$1"` in `moduleNameMapper`.

### Changed

- In development the Babel config is exactly `babel-preset-expo`. Expo SDK 58's
  oxc transformer, Noxcturnal, runs only when the Babel config resolves to the
  bare Expo preset, and any extra plugin or option sends every file back to Babel.
  The explicit `react-native-worklets/plugin` and `unstable_transformImportMeta`
  are gone because `babel-preset-expo` 58 does both itself. The build-id inliner
  now runs in production only; development already used a constant id.
- The config plugin turns on `experiments.noxcturnalTransformWorker` in
  development (`NODE_ENV !== 'production'`). Production builds stay on Babel:
  Noxcturnal keeps the requires of dead platform branches, which pulled
  `@livekit/react-native` into Mention's web bundle (+6.8% JS). Pass
  `noxcturnal: false` to opt out; an app that sets the experiment keeps its value.
  Measured in Mention with `noxcturnal` 0.1.9: cold Android dev bundle 55.5 s →
  26.0 s, and web 92.9 s → 56.2 s. `noxcturnal` 0.1.5 (`@expo/metro-config`
  58.0.15) fails on TS generic arrows in `.ts` files, so take `expo` 58.0.19 or
  later.

## 3.6.1

- Match Expo's development web root when `staticHydrationBoundary` is enabled.
  The server now uses Expo's actual development-tools wrapper, preserving React
  IDs and existing DOM when `EXPO_WEB_DEV_HYDRATE=1` enables local hydration.
  Production rendering and Fast Refresh retain their existing behavior.

## 3.6.0

### Added

- Opt-in `staticHydrationBoundary` Metro adapter for Expo Router 58 static
  exports. The app and document render at separate React roots, matching the
  browser's `#root` hydration boundary and preserving `useId` and workspace DOM.
  Fonts, styles, metadata, loader data and scripts retain their Expo contracts;
  live streaming delegates to Expo unchanged. Version guard and real hydration
  tests protect the private renderer integration.

## 3.5.0

### Fixed

- The Android build-property defaults no longer pin `compileSdkVersion` (36),
  `targetSdkVersion` (35) or `buildToolsVersion` (`36.0.0`). Expo SDK 58's Expo
  modules (`expo.modules.integrity`, `expo.modules.application` and 25 more)
  require compileSdk 37, so every SDK 58 Android release build of an app using
  the preset failed in `:expo:checkReleaseAarMetadata`. The Expo SDK's template
  now sets all three (SDK 58: compileSdk 37, targetSdk 36, build tools 37.0.0)
  and they follow each SDK upgrade. **targetSdk moves from 35 to 36** (Android 16
  behaviour: edge-to-edge and predictive back are no longer opt-outs, large
  screens ignore orientation/resizability locks) — test on a device. An app that
  must hold a level back passes it as an `android` override.

## 3.4.0

### Fixed

- Metro watches the app's install root instead of `../..` of the project. The
  root is the nearest ancestor whose `package.json` declares `workspaces`, else
  the nearest one holding a lockfile, else the git checkout's top level — never
  above the checkout. For a single-package app at `~/Oxy/<repo>`, `../..` was the
  home directory: Metro crawled every sibling repository and worktree with its
  `node_modules` and ran out of memory. Monorepo apps (`packages/<app>`) still
  watch the monorepo root.
- Agent worktrees under `<root>/.claude/worktrees` are blocked like
  `<root>/.worktrees`.

### Added

- `workspaceRoot` option to set the install root explicitly, and the
  `findWorkspaceRoot(projectRoot)` export that computes the default.

## 3.3.1

### Fixed

- The Metro block list's cache and test directories (`.cache`, `.expo`,
  `.expo-shared`, `.metro`, `__tests__`) are matched only BELOW the project and
  its watch folders. The unanchored patterns also matched a checkout that lived
  under such a directory — a worktree in `~/.cache` blocked every file of its
  own app, and the bundle failed with "Unable to resolve module
  ./node_modules/expo-router/entry". `node_modules/.cache` and `.expo/types`
  stay blocked: both are inside the project.

## 3.3.0

### Added

- Documented opt-in: `android: { gifEnabled: false, webpEnabled: false }` passes
  through the preset's build-properties overrides to `expo-build-properties` 58,
  dropping React Native's GIF and WebP decoders from the Android build. Not a
  default.

### Changed

- Validated on Expo SDK 58 / React Native 0.88: a clean `expo prebuild` of
  Android and iOS applies every plugin unchanged. SDK 58's template already
  generates `proguard-android-optimize.txt`, so `withOxyAndroidRelease` only adds
  the release signing config there.
## 3.2.1

### Changed

- The `@oxy.so/bloom` and `@oxy.so/services` peers are open-ended above their
  floors (`>=6.0.0` for the last Bloom alternative, `>=11.0.0` for Services). The
  `^6.0.0` and `^11.0.0` caps made every app on Bloom 7 or later report a peer
  conflict, and would have done so again for each new major.

## 3.2.0

### Added

Two opt-in options for an app that draws with WebGPU on native and runs its
own modules on a worklet runtime (GoWay's 3D city). An app that passes
neither gets exactly the 3.1.0 config.

- **`workletsBundleMode`** turns on react-native-worklets' Bundle Mode, in
  which a worker runtime runs the app's MODULES, not just copied closures.
  - **Babel:** pass `require('@oxy.so/app-preset/babel').createOxyBabelConfig({
    workletsBundleMode: { importForwarding: { relativePaths: [...] } } })`.
    It gives the worklets plugin `bundleMode: true` and the import forwarding
    lists, and turns off babel-preset-expo's own worklets plugin, which would
    otherwise run a second, option-less copy.
  - **Metro:** pass `createOxyMetroConfig(__dirname, { workletsBundleMode: true })`.
    It wraps the finished config, after the Bloom and NativeWind resolvers,
    with worklets' `getBundleModeMetroConfig`.
  - **Both are needed.** Neither works alone.
  - **Misspellings throw.** A misspelt `importForwarding` key fails the build
    instead of being ignored.
  - **Measured on GoWay's harness:** Expo 57, worklets 0.10.0, Hermes release
    build on an Android emulator. GoWay's mesher runs on a worker runtime, and
    the JS thread's longest frame drops from about 1–2.5 s to under 0.1 s
    (GoWay `docs/MAP_NATIVE_3D.md`).
  - **No native config is needed.** A clean build needs no `pickFirsts`.
  - **worklets' `FETCH_PREVIEW_ENABLED` is not set.** In 0.10.0 a release build
    crashes creating a worker runtime with it.
- **`webgpu: true`** on the config plugin applies `react-native-webgpu`'s own
  config plugin, which turns off Metal API validation in the iOS scheme.
  - `react-native-webgpu` is a new optional peer, `>=0.5.18 <1.0.0`. 0.5.18
    is the first release that ships `app.plugin.js` (bisected over the
    published tarballs), and 0.5.18 and 0.13.1 both apply.
  - Without the package installed, `webgpu: true` throws and names it.

### Unchanged

- `module.exports = require('@oxy.so/app-preset/babel')` still works, and its
  output is identical.

## 3.1.0

### Changed

- `tsconfig/backend.json` resolves with `module`/`moduleResolution: node16`
  instead of `commonjs` + `node` (node10). TypeScript 7, which `bun check`
  implements, removes node10 (TS5108), and TypeScript 5.x rejects `bundler`
  with `commonjs` (TS5095), so Node16 is the one setting both accept. A
  backend that extends the preset can now run `bun check` without overriding
  it.
- The emitted JavaScript is unchanged for a CommonJS package (no
  `"type": "module"`) with no dynamic `import()`. Measured with TypeScript
  5.9.3: `dist/` (JavaScript, declarations and source maps) is byte-identical
  on a probe backend, on Atlas `shared-types` and on GoWay `contracts`.
- Two cases change. A dynamic `import()` stays a real `import()` instead of
  becoming `require()`, and a relative one needs a `.js` extension (TS2835).
  A package with `"type": "module"` emits ESM. Of the preset's consumers, only
  GoWay `backend` has dynamic `import()`s (in `src/import/osm/run.ts`); it
  pins `module: commonjs` itself (OxyHQ/GoWay#179). Imports now resolve
  through each dependency's `exports` map, as Node does.

## 3.0.0

### Breaking changes

- No Oxy Android app shares a UID any more (OxyHQ/oxy#1388): the preset no
  longer writes `android:sharedUserId`, and `plugin/withSharedUserId` is
  deleted. The `sharedUserId` and `sharedIdentityReader` options throw if
  passed.
- The preset always applies `@oxy.so/services/plugins/withOxySharedPermissions`
  (declares and requests `so.oxy.permission.IDENTITY` and
  `so.oxy.permission.DEVICE_SESSION`, `<queries>` for the Commons and Accounts
  providers). `@oxy.so/services` ^11.0.0 is a required peer.

## 2.2.1

### Changed

- Publish the additive Bloom 6 and Services 10 peer compatibility already validated on main. Runtime configuration remains unchanged.

## 2.1.0

### Added

- The build id `@oxy.so/services` 8.3 busts its persisted query caches on:
  the commit (`GITHUB_SHA`, `EAS_BUILD_GIT_COMMIT_HASH`, else
  `git rev-parse HEAD`; `development` in dev). The Babel config inlines it as
  `process.env.OXY_BUILD_ID` in every module, node_modules included (Expo's own
  `EXPO_PUBLIC_*` inlining skips them), and the Metro config folds it into
  `cacheVersion` so a cached transform never carries an old id.

## 2.0.5

### Changed

- The `@oxy.so/services` peer admits `^8.0.0`: the plugin entry point the
  preset requires (`plugins/withSharedIdentityReader`) is unchanged.

## 2.0.4

### Changed

- The `@oxy.so/services` peer admits `^7.0.0`: the plugin entry point the
  preset requires (`plugins/withSharedIdentityReader`) is unchanged.

## 2.0.3

### Changed

- The `@oxy.so/services` peer admits `^6.0.0`: the plugin entry point the
  preset requires (`plugins/withSharedIdentityReader`) is unchanged.

## 2.0.2

### Changed

- The `@oxy.so/services` peer admits `^5.0.0`: the plugin entry point the
  preset requires (`plugins/withSharedIdentityReader`) is unchanged.

## 2.0.1

### Changed

- Peer ranges admit `@oxy.so/bloom` `^2.0.0 || ^3.0.0 || ^4.2.0` and
  `@oxy.so/services` `^2.0.0 || ^3.0.0 || ^4.0.0`; the preset couples only to
  their CSS and plugin entry points, whose paths are unchanged.

## 1.0.1

### Fixed

- Compatible `@oxy.so/services` patches now deduplicate in consuming apps.

## 0.4.1

### Fixed

- Preserved Tailwind v4 theme variables in the shared web stylesheet and made
  Metro resolve workspace source extensions consistently.

## 0.3.1

### Fixed

The web `ws` shim resolves through Metro's own empty module again
(`{ type: 'empty' }`), and the `metro/empty-module.js` stub that briefly stood in
for it is gone.

The stub was added to fix a `scaffold-smoke` CI failure. It did not fix it: the
failing path was `resolver.emptyModulePath`, which `metro-config` computes with
`require.resolve` when the config is built, so it never went through the shim at
all. The real fault was in the workflow, which installed the preset by pointing a
`file:` override at a directory outside the generated app. Bun materializes that
as a tree of symlinks, node resolves each one to its realpath, and the preset's
whole `require` graph landed in the wrong checkout. That is fixed in the
workflow.

No behaviour changes for apps installing this package from the registry, where
the preset has always been real files inside the app's own `node_modules`.

## 0.2.0

### Licence: MIT becomes Apache-2.0

**Breaking for anyone who tracks the licence, and for nobody else.**
`@oxy.so/app-preset` is now Apache-2.0. The code, the API surface and the behaviour are
unchanged in this release. It exists to carry the licence change.

The last published version, `0.1.0`, carried MIT, even though the
repository manifest said AGPL-3.0-only. Apache-2.0 is what both should have
said: it grants everything MIT grants, and adds an express patent grant
and a notice requirement. No existing use becomes non-compliant.

Versions published before this one keep the licence they were published under,
permanently. `0.1.0` stays MIT for anyone who already has it. A licence
change binds future versions only.

`@oxy.so/app-preset` is below 1.0.0, where semver puts the breaking position in the minor
and `^0.1.0` does not accept `0.2.0`. Bumping the minor is therefore the
same signal a major bump gives a 1.x package: no consumer picks this up
without editing their manifest, which is the whole point.

### Added

- A `NOTICE` file, which Apache-2.0 section 4(d) requires downstream
  redistributors to reproduce, and a verbatim `LICENSE`.
