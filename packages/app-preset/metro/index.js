/**
 * @oxy.so/app-preset — Metro config factory.
 *
 * Lifts the shared Metro configuration every Oxy Expo app used to copy-paste:
 * monorepo watch folders, the block list, symlink + package-exports resolution
 * (required by @oxy.so/bloom's subpath exports), the web-font/wasm asset
 * extensions, the release minifier tuning, Bloom's base face for raw text, and
 * the NativeWind wrapper for an app that still styles with `className`.
 *
 * Usage — a three-line metro.config.js:
 *
 *   const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');
 *   module.exports = createOxyMetroConfig(__dirname, {
 *     sharedTypesPackage: '@myapp/shared-types',
 *   });
 *
 * @param {string} projectRoot Absolute path to the app package (pass `__dirname`).
 * @param {object} [options]
 * @param {string} [options.sharedTypesPackage] Bare name of the app's
 *   `packages/shared-types` workspace package. When set, it is aliased to the
 *   monorepo `packages/shared-types` dir and its `src` is added to the block
 *   list (so Metro never bundles the un-built TypeScript source).
 * @param {boolean} [options.nativewind] Wrap the config for NativeWind
 *   (react-native-css). Defaults to whether the app's package.json depends on
 *   `nativewind`: Bloom needs none, so an app that no longer writes `className`
 *   drops the dependency and gets no wrapper, no react-native-css runtime and no
 *   redirect of React Native's components.
 * @param {string} [options.cssInput='./global.css'] NativeWind CSS entry point.
 * @param {(string|RegExp)[]} [options.extraBlockList=[]] Extra Metro
 *   `blockList` patterns appended to the Oxy defaults.
 * @param {boolean} [options.dropConsole=false] Strip console calls from the
 *   production web bundle. Hermes native bundles do not use Metro's minifier.
 * @param {string} [options.svgTransformerPath] Resolved SVG transformer path.
 *   When set, `svg` moves from asset extensions to source extensions. A custom
 *   Babel transformer keeps every file on Babel, so the app loses Noxcturnal.
 * @param {Record<string,string>} [options.extraNodeModules={}] Extra aliases.
 * @param {string[]} [options.extraWatchFolders=[]] Additional watch roots.
 * @param {string} [options.workspaceRoot] The install root Metro watches and
 *   resolves hoisted deps from. Defaults to {@link findWorkspaceRoot}.
 * @param {string[]} [options.extraAssetExts=[]] Additional asset extensions.
 * @param {string[]} [options.extraSourceExts=[]] Additional source extensions.
 * @param {boolean} [options.workletsBundleMode=false] react-native-worklets'
 *   Bundle Mode: wraps the config with `getBundleModeMetroConfig` (worklets'
 *   module ids, its resolver shims, inline requires), so a worker runtime can
 *   load the app's bundle. Pair it with the Babel factory's option of the same
 *   name; neither works alone. Needs `react-native-worklets` installed.
 * @param {boolean} [options.staticHydrationBoundary=false] Correct the app/document
 *   render boundary in Expo 58 static exports; guarded to reviewed router versions.
 * @param {boolean} [options.baseFont=true] Give a React Native `Text` or
 *   `TextInput` that names no family Bloom's base face ({@link withBaseFontText}).
 *   `false` leaves React Native's own: the platform face (Roboto on Android, San
 *   Francisco on iOS, react-native-web's system stack on the web), as an app on
 *   app-preset 6.7 drew it.
 * @returns {import('metro-config').MetroConfig}
 */
const { getDefaultConfig } = require('expo/metro-config');
const fs = require('node:fs');
const path = require('node:path');
const { resolveOxyBuildId } = require('../build-id');
const { requireFromProject } = require('../plugin/requireFromProject');
const { withStaticHydrationBoundary } = require('./static-hydration/resolver');
const { withLinkedNativePackagesOnly } = require('./linked-native-packages');
const { withFreshWorkspaceBuilds } = require('./fresh-workspace-builds');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function blockPath(dir) {
  return new RegExp(`${escapeRegExp(path.resolve(dir))}/.*`);
}

/**
 * Every directory called `name` BELOW one of `roots` — never one in a root's
 * own path. An unanchored `.cache/` pattern also matched the CHECKOUT when it
 * lived under `~/.cache` (a worktree there), blocking every file of the app and
 * failing the bundle with "Unable to resolve module ./node_modules/expo-router/
 * entry"; the same held for `.expo`, `.expo-shared`, `.metro` and `__tests__`.
 */
function dirsUnder(roots, name) {
  const anyRoot = unique(roots.map((root) => escapeRegExp(path.resolve(root)))).join('|');
  return new RegExp(`^(?:${anyRoot})/(?:.*/)?${escapeRegExp(name)}/.*`);
}

function unique(values) {
  return [...new Set(values)];
}

const LOCKFILES = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
];

function declaresWorkspaces(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return Boolean(manifest?.workspaces);
  } catch {
    return false;
  }
}

/**
 * The directory the app was installed from — what Metro watches and resolves
 * hoisted deps from. Walking up from the project, never past the git checkout
 * that contains it: the nearest ancestor whose package.json declares
 * `workspaces`, else the nearest one holding a lockfile, else the checkout's
 * top level, else the project itself.
 *
 * Never a blind `../..`: for a single-package app at `~/Oxy/<repo>` that is the
 * home directory, and Metro crawled all of it (every sibling repo and worktree
 * with its node_modules) until it ran out of memory.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function findWorkspaceRoot(projectRoot) {
  const start = path.resolve(projectRoot);
  let lockfileRoot;
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (declaresWorkspaces(dir)) return dir;
    if (!lockfileRoot && LOCKFILES.some((name) => fs.existsSync(path.join(dir, name)))) {
      lockfileRoot = dir;
    }
    // `.git` is a directory in a checkout and a file in a worktree.
    if (fs.existsSync(path.join(dir, '.git'))) return lockfileRoot || dir;
    if (path.dirname(dir) === dir) return lockfileRoot || start;
  }
}

/**
 * Whether the app at `projectRoot` depends on NativeWind: its own package.json,
 * never a copy hoisted from another app of the monorepo.
 *
 * @param {string} projectRoot
 * @returns {boolean}
 */
function dependsOnNativeWind(projectRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    return ['dependencies', 'devDependencies'].some((field) =>
      Boolean(manifest?.[field]?.nativewind),
    );
  } catch {
    return false;
  }
}

/** The `nativewind` option, or the app's own dependency on it. */
function usesNativeWind(projectRoot, options) {
  return options.nativewind ?? dependsOnNativeWind(projectRoot);
}

function createOxyMetroConfig(projectRoot, options = {}) {
  const {
    sharedTypesPackage,
    cssInput = './global.css',
    extraBlockList = [],
    dropConsole = false,
    svgTransformerPath,
    extraNodeModules: configuredExtraNodeModules = {},
    extraWatchFolders = [],
    extraAssetExts = [],
    extraSourceExts = [],
    workspaceRoot,
  } = options;

  const monorepoRoot = workspaceRoot ? path.resolve(workspaceRoot) : findWorkspaceRoot(projectRoot);
  const config = getDefaultConfig(projectRoot);

  // In a production build the preset's Babel plugin inlines this id into every
  // module (development uses a constant id and no plugin), but Metro's
  // transform cache key does not cover it: without the id in `cacheVersion`, a
  // cached SDK module would keep an old build's id. Published so the Babel
  // workers Metro forks resolve the same value.
  const buildId = resolveOxyBuildId(projectRoot);
  process.env.OXY_BUILD_ID = buildId;
  config.cacheVersion = [config.cacheVersion, `oxy-build:${buildId}`].filter(Boolean).join('|');

  config.projectRoot = projectRoot;

  // Watch the install root so Metro resolves hoisted deps in its node_modules/.
  config.watchFolders = unique([
    monorepoRoot,
    ...extraWatchFolders.map((folder) => path.resolve(folder)),
  ]);

  const blockList = [
    blockPath(path.join(monorepoRoot, 'packages/backend')),
    blockPath(path.join(monorepoRoot, 'docs')),
    // Sibling git worktrees live under <monorepoRoot>/.worktrees and each carries a
    // full node_modules; leaving them watchable makes Metro's file crawler walk
    // hundreds of thousands of extra directories and time out starting watch mode.
    blockPath(path.join(monorepoRoot, '.worktrees')),
    blockPath(path.join(monorepoRoot, '.claude/worktrees')),
    // Caches and tests anywhere inside what Metro crawls (`node_modules/.cache`
    // and `.expo/types` included), and nowhere above it.
    ...['.expo', '.expo-shared', '.metro', '.cache', '__tests__'].map((name) =>
      dirsUnder([projectRoot, ...config.watchFolders], name),
    ),
    /\.tsbuildinfo$/,
    /\.test\.(js|ts|tsx|jsx)$/,
    /\.spec\.(js|ts|tsx|jsx)$/,
    /\.md$/,
    /(?:^|[/\\])README(?:\.[^/\\]+)?$/,
    ...extraBlockList.map((pattern) =>
      typeof pattern === 'string' ? blockPath(pattern) : pattern,
    ),
  ];

  const extraNodeModules = {};
  if (sharedTypesPackage) {
    const sharedTypesDir = path.join(monorepoRoot, 'packages/shared-types');
    blockList.push(blockPath(path.join(sharedTypesDir, 'src')));
    extraNodeModules[sharedTypesPackage] = sharedTypesDir;
  }

  config.resolver = {
    ...config.resolver,
    blockList,
    extraNodeModules: {
      ...config.resolver.extraNodeModules,
      ...extraNodeModules,
      ...configuredExtraNodeModules,
    },
    // Resolve from the app's node_modules first, then the monorepo root (hoisted deps).
    nodeModulesPaths: unique([
      path.join(projectRoot, 'node_modules'),
      path.join(monorepoRoot, 'node_modules'),
    ]),
    // Enable symlinks for workspace resolution.
    unstable_enableSymlinks: true,
    // Enable package.json "exports" resolution (required by @oxy.so/bloom subpath exports).
    unstable_enablePackageExports: true,
    sourceExts: unique([
      ...config.resolver.sourceExts,
      'ts',
      'tsx',
      ...(svgTransformerPath ? ['svg'] : []),
      ...extraSourceExts,
    ]),
    // Bloom imports `.woff2`/`.woff` fonts directly from JS on web; Metro does not
    // include them in default assetExts. SVGs stay ASSETS (metro's default): the
    // apps `require('*.svg')` them as image URIs (e.g. `<Image source={require(
    // '…/empty.svg')} />`) — there is no react-native-svg-transformer configured,
    // so removing `svg` from assetExts leaves it unresolvable (breaks the build).
    assetExts: [
      ...config.resolver.assetExts.filter(
        (extension) => !svgTransformerPath || extension !== 'svg',
      ),
      'wasm',
      'woff2',
      'woff',
      ...extraAssetExts,
    ],
  };
  config.resolver.assetExts = unique(config.resolver.assetExts);

  config.transformer = {
    ...config.transformer,
    ...(svgTransformerPath ? { babelTransformerPath: svgTransformerPath } : {}),
    minifierConfig: {
      ...config.transformer?.minifierConfig,
      keep_classnames: false,
      keep_fnames: false,
      mangle: {
        keep_classnames: false,
        keep_fnames: false,
      },
      output: {
        ascii_only: true,
        quote_style: 3,
        wrap_iife: true,
      },
      sourceMap: {
        includeSources: false,
      },
      toplevel: false,
      compress: {
        arguments: true,
        dead_code: true,
        drop_console: dropConsole,
        drop_debugger: true,
        ecma: 2020,
        evaluate: true,
        inline: 1,
        passes: 3,
        reduce_funcs: true,
        reduce_vars: true,
        unsafe: false,
        unsafe_comps: false,
        unsafe_math: false,
        unsafe_methods: false,
      },
    },
  };

  if (!usesNativeWind(projectRoot, options)) return config;
  // Loaded only for an app that styles with NativeWind: the others may not install it.
  const { withNativeWind } = require('nativewind/metro');
  return withNativeWind(withReactNativeCssSingleInstance(config, projectRoot), {
    input: cssInput,
    inlineRem: 16,
    inlineVariables: false,
  });
}

/** Keep CSS injection and consumers on one runtime, including NativeWind redirects.
 * Its ESM and CommonJS builds have separate root-variable registries. NativeWind
 * injects through require(), so native imports must select the same export.
 * Preserve react-native conditions: some component adapters require native code.
 */
function cssRuntimeContext(context, moduleName, platform, projectRoot) {
  if (
    platform === 'web' ||
    platform == null ||
    !(moduleName === 'react-native-css' || moduleName.startsWith('react-native-css/'))
  )
    return context;
  const conditions = (values = []) =>
    values.filter((value) => value !== 'import' && value !== 'source');
  return {
    ...context,
    originModulePath: path.join(projectRoot, 'package.json'),
    isESMImport: false,
    unstable_conditionNames: conditions(context.unstable_conditionNames),
    unstable_conditionsByPlatform: Object.fromEntries(
      Object.entries(context.unstable_conditionsByPlatform ?? {}).map(([key, values]) => [
        key,
        conditions(values),
      ]),
    ),
  };
}

function withReactNativeCssSingleInstance(config, projectRoot = config.projectRoot) {
  const parentResolveRequest = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) =>
    (parentResolveRequest ?? context.resolveRequest)(
      cssRuntimeContext(context, moduleName, platform, projectRoot),
      moduleName,
      platform,
    );
  return config;
}

const COMPLETE_REACT_NATIVE = path.join(__dirname, 'react-native.js');
/** Both spellings: Metro reports real paths, and the preset may sit behind a symlink. */
const COMPLETE_REACT_NATIVE_PATHS = new Set([
  COMPLETE_REACT_NATIVE,
  fs.realpathSync(COMPLETE_REACT_NATIVE),
]);
/** `react-native-css/components`' entry, by any of the conditions Metro may pick. */
const CSS_COMPONENTS_ENTRY =
  /[/\\]react-native-css[/\\](?:dist[/\\](?:commonjs|module)[/\\]components[/\\]index\.cjs|src[/\\]components[/\\]index\.cts)$/;

/**
 * Wraps a NativeWind Metro config so that wherever NativeWind sends
 * `react-native` to `react-native-css/components`, the import gets
 * `./react-native.js` instead: that shim with every name of React Native's
 * index it lacks (React Native 0.88's `AssetRegistry`, which `expo-asset`
 * reads) forwarded to React Native. Every name the shim defines keeps its own
 * getter, so `className` behaves exactly as NativeWind makes it.
 *
 * Narrow on purpose: only a request for exactly `react-native` that NativeWind
 * resolved to the shim's entry is touched. Web (NativeWind leaves
 * `react-native-web` imports alone at this level), deep `react-native/…`
 * imports and every other module resolve as before.
 *
 * Apply it LAST, over every other resolver (NativeWind's, worklets' Bundle
 * Mode, an app's own): it has to see the final resolution, and the completed
 * module's own two imports must reach no redirect beneath it. They go straight
 * to Metro's resolver (NativeWind's redirect would point the module at itself,
 * worklets' at a module that requires it back) and resolve from the project,
 * which sees both packages under any linker; the preset depends on neither.
 *
 * @param {import('metro-config').MetroConfig} config The finished config, NativeWind applied.
 * @param {string} [projectRoot=config.projectRoot] The app package.
 * @returns {import('metro-config').MetroConfig} `config`, its resolver wrapped.
 */
function withCompleteReactNative(config, projectRoot = config.projectRoot) {
  const parentResolveRequest = config.resolver.resolveRequest;
  const projectOrigin = path.join(projectRoot, 'package.json');

  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (
      COMPLETE_REACT_NATIVE_PATHS.has(context.originModulePath) &&
      (moduleName === 'react-native' || moduleName === 'react-native-css/components')
    ) {
      return context.resolveRequest(
        cssRuntimeContext(
          { ...context, originModulePath: projectOrigin },
          moduleName,
          platform,
          projectRoot,
        ),
        moduleName,
        platform,
      );
    }

    const resolution = (parentResolveRequest ?? context.resolveRequest)(
      context,
      moduleName,
      platform,
    );
    if (
      moduleName === 'react-native' &&
      resolution?.type === 'sourceFile' &&
      CSS_COMPONENTS_ENTRY.test(resolution.filePath)
    ) {
      return { type: 'sourceFile', filePath: COMPLETE_REACT_NATIVE };
    }
    return resolution;
  };

  return config;
}

const BASE_FONT_DIR = path.join(__dirname, 'base-font');
/** The base-font modules, by both spellings (as for the completed module). */
const BASE_FONT_MODULES = new Set(
  fs
    .readdirSync(BASE_FONT_DIR)
    .flatMap((file) => [
      path.join(BASE_FONT_DIR, file),
      fs.realpathSync(path.join(BASE_FONT_DIR, file)),
    ]),
);
/** NativeWind's `Text` and `TextInput` components, by any of the conditions Metro may pick. */
const CSS_TEXT_COMPONENT =
  /[/\\]react-native-css[/\\](?:dist[/\\](?:commonjs|module)[/\\]components[/\\](Text|TextInput)\.js|src[/\\]components[/\\](Text|TextInput)\.tsx)$/;
/**
 * React Native's own `Text` and `TextInput` files, and react-native-web's (the
 * path Expo's Babel preset rewrites `import { Text } from 'react-native'` to on
 * the web, in either of its builds).
 */
const REACT_NATIVE_TEXT_COMPONENT =
  /[/\\](?:react-native[/\\]Libraries[/\\](?:Text[/\\](Text)|Components[/\\]TextInput[/\\](TextInput))\.js|react-native-web[/\\]dist[/\\](?:cjs[/\\])?exports[/\\](Text|TextInput)[/\\]index\.js)$/;

/**
 * Wraps a Metro config so that wherever the app's `Text` or `TextInput` would be
 * bundled, the same component drawing Bloom's base face when the text names no
 * family is (Inter on Android and iOS, the document's family on the web; see
 * `./base-font/hosts.native.js` and `.web.js` for why each platform needs it).
 *
 * The match is on the RESOLVED file, by every route that reaches it; nothing
 * else changes:
 *
 * - Without NativeWind, React Native's own `Text` and `TextInput` files (and
 *   react-native-web's on the web) become `./base-font/PlainText.js` and
 *   `./base-font/PlainTextInput.js`, the base-face hosts. Bloom's and the Bloom
 *   language's texts name their family, so only a raw text takes the face.
 * - With NativeWind, every text already passes through its components (it sends
 *   `import { Text } from 'react-native'` there), so NativeWind's `Text` and
 *   `TextInput` become `./base-font/Text.js` and `./base-font/TextInput.js`, the
 *   same hosts under NativeWind's `styled()`.
 *
 * Apply it OUTERMOST. The base-font modules' own imports (React Native's hosts,
 * NativeWind's runtime) go straight to Metro's resolver from the project, past
 * every redirect: this one, or NativeWind's, would send the hosts back to the
 * components these modules replace.
 *
 * @param {import('metro-config').MetroConfig} config The finished config.
 * @param {string} [projectRoot=config.projectRoot] The app package.
 * @param {{ nativewind?: boolean }} [options] Whether `config` is NativeWind's
 *   (defaults to the app's own dependency on it, as `createOxyMetroConfig`).
 * @returns {import('metro-config').MetroConfig} `config`, its resolver wrapped.
 */
function withBaseFontText(config, projectRoot = config.projectRoot, options = {}) {
  const nativewind = usesNativeWind(projectRoot, options);
  const component = nativewind ? CSS_TEXT_COMPONENT : REACT_NATIVE_TEXT_COMPONENT;
  const replacement = nativewind ? '' : 'Plain';
  const parentResolveRequest = config.resolver.resolveRequest;
  const projectOrigin = path.join(projectRoot, 'package.json');

  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (BASE_FONT_MODULES.has(context.originModulePath)) {
      const own = moduleName.startsWith('.')
        ? context
        : cssRuntimeContext(
            { ...context, originModulePath: projectOrigin },
            moduleName,
            platform,
            projectRoot,
          );
      return context.resolveRequest(own, moduleName, platform);
    }

    const resolution = (parentResolveRequest ?? context.resolveRequest)(
      context,
      moduleName,
      platform,
    );
    const match = resolution?.type === 'sourceFile' && component.exec(resolution.filePath);
    if (match) {
      const name = match.slice(1).find(Boolean);
      return { type: 'sourceFile', filePath: path.join(BASE_FONT_DIR, `${replacement}${name}.js`) };
    }
    return resolution;
  };

  return config;
}

/**
 * Wraps a NativeWind Metro config with the Bloom single-instance rewrite and the
 * web `ws` shim. In hoisted monorepos the same Bloom version is duplicated under
 * root `node_modules` and each app's local `node_modules`; two copies mean two
 * React Context objects, so `<BloomThemeProvider>` (services) does not satisfy
 * `useTheme()` (app code) and the app crashes.
 */
function withBloomSingleInstance(nativeWindConfig, projectRoot) {
  const parentResolveRequest = nativeWindConfig.resolver.resolveRequest;
  const bloomOrigin = path.join(projectRoot, 'package.json');

  nativeWindConfig.resolver.resolveRequest = (context, moduleName, platform) => {
    if (platform === 'web' && (moduleName === 'ws' || moduleName === 'node:ws')) {
      return { type: 'empty' };
    }

    const resolveContext =
      moduleName === '@oxy.so/bloom' || moduleName.startsWith('@oxy.so/bloom/')
        ? { ...context, originModulePath: bloomOrigin }
        : context;

    return parentResolveRequest(resolveContext, moduleName, platform);
  };

  return nativeWindConfig;
}

/**
 * Wraps the finished config for react-native-worklets' Bundle Mode. Applied
 * after Bloom's and NativeWind's resolvers, so worklets' resolver sees every
 * request before them and hands the rest down; only
 * {@link withCompleteReactNative} sits above it.
 */
function withWorkletsBundleMode(config, projectRoot) {
  let bundleMode;
  try {
    bundleMode = requireFromProject('react-native-worklets/bundleMode', projectRoot);
  } catch (error) {
    throw new Error(
      "[@oxy.so/app-preset/metro] `workletsBundleMode` needs 'react-native-worklets' installed in the app. " +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return bundleMode.getBundleModeMetroConfig(config);
}

function createOxyMetroConfigWithBloom(projectRoot, options = {}) {
  const { workletsBundleMode = false, staticHydrationBoundary = false, baseFont = true } = options;
  const nativewind = usesNativeWind(projectRoot, options);
  const nativeWindConfig = createOxyMetroConfig(projectRoot, options);
  let config = withBloomSingleInstance(nativeWindConfig, projectRoot);
  if (staticHydrationBoundary) config = withStaticHydrationBoundary(config, projectRoot);
  if (workletsBundleMode) config = withWorkletsBundleMode(config, projectRoot);
  // Sees every resolution but the complete-react-native module's own two
  // imports: an optional probe for a native package autolinking does not link
  // is answered "not found" (see the module header for the launch crash).
  config = withLinkedNativePackagesOnly(config, projectRoot);
  // A production bundle never ships a workspace package's build output that is
  // older than its sources (the same launch crash, second cause).
  config = withFreshWorkspaceBuilds(
    config,
    options.workspaceRoot ? path.resolve(options.workspaceRoot) : findWorkspaceRoot(projectRoot),
  );
  // Outermost, so they see the final resolution and their own modules'
  // imports reach no redirect beneath them. The completed module answers
  // NativeWind's redirect of `react-native`; without NativeWind there is none.
  if (nativewind) config = withCompleteReactNative(config, projectRoot);
  return baseFont ? withBaseFontText(config, projectRoot, { nativewind }) : config;
}

module.exports = {
  createOxyMetroConfig: createOxyMetroConfigWithBloom,
  findWorkspaceRoot,
  withBloomSingleInstance,
  withReactNativeCssSingleInstance,
  withCompleteReactNative,
  withBaseFontText,
  withLinkedNativePackagesOnly,
  withFreshWorkspaceBuilds,
};
