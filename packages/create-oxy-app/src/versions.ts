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
  // PAIRED WITH `oxyBloom` BELOW, and the pairing is load-bearing.
  // `@oxy.so/services` caps its Bloom peer at the major it was measured against,
  // so services 2.x + Bloom 3.x makes a package manager resolve a SECOND, nested
  // Bloom — and Bloom 3's composition contracts are React contexts, which do not
  // cross copies.
  //
  // Raised, because the condition it was waiting on is met: services 3.1.0 is on
  // the public registry. Until now a SCAFFOLDED app got the broken pairing — the
  // gap was invisible in CI by design, since `scaffold-smoke` installs the
  // generated app from HEAD tarballs and so pairs Bloom 3 with this tree's
  // services rather than with the `^2.0.0` a real `npm install` resolves.
  //
  // `^3.0.0` and not `^3.1.0`: the rule above is "name a range that resolves",
  // 3.0.0 is the published floor, and a caret picks up 3.1.0 on its own.
  oxyServices: '^3.0.0', // @oxy.so/services
  //
  // `^23.3.0` until now, which is a PRE-RENAME number: the package was
  // `@oxyhq/core` up to 23.x, and versions RESET at the rename to `@oxy.so/core`,
  // whose highest published version is 1.x. So the range matched nothing —
  // `npm view '@oxy.so/core@^23.3.0' version` is an E404 — and because the
  // generated root `package.json` repeats this pin in `overrides` AND
  // `resolutions`, a scaffolded app could not `bun install` at all, not even
  // partially. Every app generated since the rename inherited that.
  //
  // 1.7.1 is published and satisfies the `@oxy.so/core: ^1.0.1` peer that
  // services 3.x declares. The floor is the measured version rather than the
  // major's first release: services' peer floor is only the compatibility
  // minimum, while 1.7.1 is what this workspace and `scaffold-smoke` build
  // against. A caret keeps later 1.x.
  oxyCore: '^1.7.1', // @oxy.so/core
  oxyBloom: '^3.2.1', // @oxy.so/bloom — services imports its per-glyph icon subpaths
  oxyContracts: '^1.0.0', // @oxy.so/contracts
  oxyAppPreset: '^2.0.0', // @oxy.so/app-preset

  // --- Expo SDK 57 core ---
  expo: '^57.0.6',
  expoConstants: '~57.0.5',
  expoFont: '~57.0.1',
  expoImage: '~57.0.1',
  expoLinking: '~57.0.3',
  expoRouter: '~57.0.6',
  expoSplashScreen: '~57.0.2',
  expoStatusBar: '~57.0.1',
  expoSystemUi: '~57.0.1',
  expoWebBrowser: '~57.0.1',
  expoBuildProperties: '~57.0.5',
  expoVectorIcons: '^15.1.1', // @expo/vector-icons

  // --- Oxy SDK UI optional peers (toast / haptics / avatar crop / file picking / QR sign-in) ---
  // These are declared OPTIONAL by @oxy.so/services, but the screens that name
  // them are reachable from its root barrel — and `tsc` resolves the specifier
  // of an `import()` even when the call is lazy — so a consumer of the barrel
  // must install them or fail to typecheck with TS2307. Adding a screen to the
  // barrel upstream therefore adds a peer here; the list is not optional in
  // practice. See packages/services/__tests__/notifications/barrelIsolation.test.ts.
  expoHaptics: '~57.0.1',
  expoImagePicker: '~57.0.4',
  expoImageManipulator: '~57.0.4',
  expoDocumentPicker: '~57.0.1',
  reactNativeQrcodeSvg: '^6.3.0',

  // --- React / React Native (Expo SDK 57 pins) ---
  react: '19.2.3',
  reactDom: '19.2.3',
  reactNative: '0.86.0',
  reactNativeWeb: '~0.21.0',
  reactTypes: '^19.2.17', // @types/react
  reactDomTypes: '^19.2.3', // @types/react-dom

  // --- Native modules (Expo SDK 57 aligned) ---
  asyncStorage: '2.2.0', // @react-native-async-storage/async-storage
  gestureHandler: '~2.32.0', // react-native-gesture-handler
  reanimated: '4.5.0', // react-native-reanimated
  safeAreaContext: '~5.8.0', // react-native-safe-area-context
  screens: '4.25.2', // react-native-screens
  svg: '15.15.5', // react-native-svg
  worklets: '0.10.0', // react-native-worklets
  keyboardController: '~1.21.13', // react-native-keyboard-controller

  // --- Styling (NativeWind 5 preview + Tailwind v4) ---
  nativewind: '5.0.0-preview.3',
  tailwindcss: '4.3.2',
  tailwindPostcss: '4.3.2', // @tailwindcss/postcss — runs Tailwind over global.css on the web build
  reactNativeCss: '^3.0.6', // react-native-css (NativeWind 5 runtime)

  // --- Data / realtime ---
  reactQuery: '^5.101.0', // @tanstack/react-query
  reactQueryPersist: '^5.101.0', // @tanstack/react-query-persist-client
  queryAsyncStoragePersister: '^5.101.0', // @tanstack/query-async-storage-persister
  socketIoClient: '^4.8.1', // socket.io-client
  zustand: '^5.0.14',

  // --- Babel ---
  babelPresetExpo: '~57.0.2',
  babelModuleResolver: '^5.0.3', // babel-plugin-module-resolver

  // --- Tooling ---
  typescript: '^5.9.3',
  eslint: '^9.25.0',
  eslintConfigExpo: '~57.0.0',
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
export const BUN_VERSION = '1.4.2';
