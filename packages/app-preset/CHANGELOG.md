# Changelog: `@oxy.so/app-preset`

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
