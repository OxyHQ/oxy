/**
 * Pinned dependency snapshot for scaffolded apps — a single known-good set that
 * every generated monorepo starts from. Bump these deliberately (the nightly
 * scaffold-smoke CI detects drift against the live Oxy SDK + Expo SDK).
 *
 * Keys are camelCase aliases; templates reference them as `{{v.<alias>}}` tokens
 * (e.g. `"expo": "{{v.expo}}"`). The npm package a key maps to is documented
 * inline where it is not obvious from the alias.
 */
export const VERSIONS = {
  // --- Oxy SDK ---
  // Every range here must resolve on the PUBLIC registry — a generated app
  // installs from npm, not from this workspace. So a pin tracks the PUBLISHED
  // version, never `packages/<pkg>/package.json`: a workspace version that has
  // been bumped but not yet published names a range nothing can resolve.
  // PAIRED WITH `oxyBloom` BELOW, and the pairing is load-bearing. Bloom's
  // composition contracts are React contexts, which do not cross copies: a Bloom
  // pin outside the published Services' `@oxy.so/bloom` peer range makes a
  // package manager resolve a SECOND, nested Bloom, and the SDK's screens render
  // against a provider the app never mounted. Services' own peer ranges are the
  // authority — `scripts/assert-oxy-ranges-resolve.mjs` reads them from npm and
  // fails the scaffold smoke when this pair falls outside them.
  //
  // The Bloom pin also never runs ahead of the workspace catalog
  // (`workspaces.catalog["@oxy.so/bloom"]` in the root package.json): that is
  // the Bloom the published Services was built and tested against, and the one
  // the HEAD smoke pairs with the packed Services. A newer Bloom major that
  // merely satisfies an open-ended peer floor is unmeasured, so it waits for
  // the workspace to move first.
  //
  // Core is a peer of Services too (`^5.5.0 || ^6.0.0` as of 12.2.0) and is
  // forced over the whole tree by the generated root overrides/resolutions, so
  // this pin must sit inside that peer range. Core pins Contracts EXACTLY, and
  // Services depends on Contracts' major, so `oxyContracts` follows Core.
  //
  // Keep this set paired. Publish Core, Bloom, Services and App Preset before
  // releasing the scaffolder: its ranges must resolve outside this workspace.
  oxyServices: '^12.2.0', // @oxy.so/services — Bloom peer >=11.1.0, Core peer ^5.5.0 || ^6.0.0
  oxyCore: '^6.0.0', // @oxy.so/core — OxyServer and the namespaced client the backend template uses
  oxyBloom: '^11.1.1', // @oxy.so/bloom — the workspace catalog's Bloom, inside Services' peer

  oxyContracts: '^5.0.0', // @oxy.so/contracts — the major Core 6 pins and Services 12 depends on
  oxyAppPreset: '^3.3.0', // @oxy.so/app-preset
  oxyExpoSplash: '^1.1.0', // @oxy.so/expo-splash — the shared native splash + "from Oxy" branding

  // --- Expo SDK 58 core (expo's own bundledNativeModules.json for 58.0.14) ---
  expo: '~58.0.14',
  expoConstants: '~58.0.12',
  expoFont: '~58.0.8',
  expoImage: '~58.0.15',
  expoLinking: '~58.0.13',
  expoRouter: '~58.0.23',
  expoSplashScreen: '~58.0.10',
  expoStatusBar: '~58.0.3',
  expoSystemUi: '~58.0.6',
  expoWebBrowser: '~58.0.6',
  expoBuildProperties: '~58.0.11',
  // Bloom's non-optional peer; SDK 58 made it an optional peer of expo-router,
  // so nothing else installs the SDK 58 build of it.
  expoSymbols: '~58.0.4',
  expoVectorIcons: '^15.1.1', // @expo/vector-icons

  // --- Oxy SDK UI optional peers (toast / haptics / avatar crop / file picking / QR sign-in) ---
  // These are declared OPTIONAL by @oxy.so/services, but the screens that name
  // them are reachable from its root barrel — and `tsc` resolves the specifier
  // of an `import()` even when the call is lazy — so a consumer of the barrel
  // must install them or fail to typecheck with TS2307. Adding a screen to the
  // barrel upstream therefore adds a peer here; the list is not optional in
  // practice. See packages/services/__tests__/notifications/barrelIsolation.test.ts.
  expoHaptics: '~58.0.7',
  expoImagePicker: '~58.0.10',
  expoImageManipulator: '~58.0.14',
  expoDocumentPicker: '~58.0.4',
  reactNativeQrcodeSvg: '^6.3.0',

  // --- React / React Native (Expo SDK 58 pins) ---
  react: '19.3.0',
  reactDom: '19.3.0',
  reactNative: '0.88.0',
  reactNativeWeb: '~0.21.4',
  reactTypes: '~19.3.0', // @types/react
  reactDomTypes: '~19.2.3', // @types/react-dom — SDK 58's expected range (expo-doctor)

  // --- Native modules (Expo SDK 58 aligned) ---
  asyncStorage: '2.2.0', // @react-native-async-storage/async-storage
  gestureHandler: '~3.3.0', // react-native-gesture-handler
  reanimated: '4.7.1', // react-native-reanimated
  safeAreaContext: '~5.10.1', // react-native-safe-area-context
  screens: '~4.30.0', // react-native-screens
  svg: '15.16.0', // react-native-svg
  worklets: '0.13.0', // react-native-worklets
  keyboardController: '1.22.7', // react-native-keyboard-controller
  // REQUIRED native peers of @oxy.so/services that nothing above installs. An
  // app must declare each itself: Expo's autolinking skips optional peers, and
  // an undeclared one installs at whatever version the package manager picks.
  // expo-crypto is the CSPRNG and sign-in challenge; expo-secure-store holds the
  // device credential (`oxy-doctor` fails an app missing any of them).
  expoCrypto: '~58.0.7',
  expoSecureStore: '~58.0.2',
  expoFileSystem: '~58.0.10',
  expoAppIntegrity: '~58.0.2', // @expo/app-integrity
  netinfo: '12.0.1', // @react-native-community/netinfo

  // --- Styling (NativeWind 5 preview + Tailwind v4) ---
  nativewind: '5.0.0-preview.3',
  tailwindcss: '4.3.2',
  tailwindPostcss: '4.3.2', // @tailwindcss/postcss — runs Tailwind over global.css on the web build
  reactNativeCss: '^3.0.6', // react-native-css (NativeWind 5 runtime)
  // EXACT, and forced over the whole tree by the root overrides/resolutions:
  // react-native-css 3.0.x is ABI-locked to lightningcss 1.30.1's native serde
  // structs, and 1.32 (what a fresh install resolves) fails the native Metro
  // bundle — so `assembleRelease` — with "failed to deserialize Specifier".
  lightningcss: '1.30.1',

  // --- Data / realtime ---
  reactQuery: '^5.101.0', // @tanstack/react-query
  reactQueryPersist: '^5.101.0', // @tanstack/react-query-persist-client
  queryAsyncStoragePersister: '^5.101.0', // @tanstack/query-async-storage-persister
  socketIoClient: '^4.8.1', // socket.io-client
  zustand: '^5.0.14',

  // --- Babel ---
  babelPresetExpo: '~58.0.17',
  babelModuleResolver: '^5.0.3', // babel-plugin-module-resolver

  // --- Tooling ---
  typescript: '~6.0.3', // the SDK 58 default template's
  eslint: '^9.25.0',
  eslintConfigExpo: '~58.0.4',
  nodeTypes: '^20.0.0', // @types/node

  // --- Backend (Express + Socket.IO) ---
  express: '^4.22.2',
  expressTypes: '^4.17.23', // @types/express
  socketIo: '^4.8.1', // socket.io
  dotenv: '^16.4.7',

  // --- Backend datastore (PostgreSQL via drizzle) ---
  // drizzle-orm and postgres are pinned EXACTLY, not caret-ranged: they are the
  // peer dependencies @oxy.so/db declares, and drizzle's minor releases have
  // changed generated DDL. One resolved version per ecosystem backend is what
  // keeps a scaffolded app's migrations comparable with everyone else's.
  // @oxy.so/db — column builders, casing authority, migration ledger. Published
  // version, not the workspace one (see the Oxy SDK note at the top).
  oxyDb: '^1.0.0',
  drizzleOrm: '0.45.2', // drizzle-orm
  postgres: '3.4.9', // postgres (postgres.js driver)
  drizzleKit: '0.31.10', // drizzle-kit — devDependency; generates migrations only
} as const;

export type VersionKey = keyof typeof VERSIONS;

/** Bun version pinned across CI + Dockerfiles for reproducible installs. */
export const BUN_VERSION = '1.4.3';
