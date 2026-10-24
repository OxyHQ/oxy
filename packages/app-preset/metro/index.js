/**
 * @oxy.so/app-preset — Metro config factory.
 *
 * Lifts the shared Metro configuration every Oxy Expo app used to copy-paste:
 * monorepo watch folders, the block list, symlink + package-exports resolution
 * (required by @oxy.so/bloom's subpath exports), the web-font/wasm asset
 * extensions, the release minifier tuning, and the NativeWind wrapper.
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
 * @returns {import('metro-config').MetroConfig}
 */
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const fs = require('node:fs');
const path = require('node:path');
const { resolveOxyBuildId } = require('../build-id');
const { requireFromProject } = require('../plugin/requireFromProject');
const { withStaticHydrationBoundary } = require('./static-hydration/resolver');

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

  return withNativeWind(config, {
    input: cssInput,
    inlineRem: 16,
    inlineVariables: false,
  });
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
 * LAST, so worklets' resolver sees every request first and hands the rest to
 * the Bloom and NativeWind resolvers underneath.
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
  const { workletsBundleMode = false, staticHydrationBoundary = false } = options;
  const nativeWindConfig = createOxyMetroConfig(projectRoot, options);
  let config = withBloomSingleInstance(nativeWindConfig, projectRoot);
  if (staticHydrationBoundary) config = withStaticHydrationBoundary(config, projectRoot);
  return workletsBundleMode ? withWorkletsBundleMode(config, projectRoot) : config;
}

module.exports = {
  createOxyMetroConfig: createOxyMetroConfigWithBloom,
  findWorkspaceRoot,
  withBloomSingleInstance,
};
