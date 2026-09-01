/**
 * @oxyhq/app-preset — Metro config factory.
 *
 * Lifts the shared Metro configuration every Oxy Expo app used to copy-paste:
 * monorepo watch folders, the block list, symlink + package-exports resolution
 * (required by @oxyhq/bloom's subpath exports), the web-font/wasm asset
 * extensions, the release minifier tuning, and the NativeWind wrapper.
 *
 * Usage — a three-line metro.config.js:
 *
 *   const { createOxyMetroConfig } = require('@oxyhq/app-preset/metro');
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
 * @returns {import('metro-config').MetroConfig}
 */
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

function blockPath(dir) {
  const resolved = path.resolve(dir);
  return new RegExp(`${resolved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*`);
}

function createOxyMetroConfig(projectRoot, options = {}) {
  const {
    sharedTypesPackage,
    cssInput = './global.css',
    extraBlockList = [],
  } = options;

  const monorepoRoot = path.resolve(projectRoot, '../..');
  const config = getDefaultConfig(projectRoot);

  config.projectRoot = projectRoot;

  // Include the monorepo root so Metro resolves hoisted deps in root node_modules/.
  config.watchFolders = [monorepoRoot];

  const blockList = [
    blockPath(path.join(monorepoRoot, 'packages/backend')),
    blockPath(path.join(monorepoRoot, 'docs')),
    // Sibling git worktrees live under <monorepoRoot>/.worktrees and each carries a
    // full node_modules; leaving them watchable makes Metro's file crawler walk
    // hundreds of thousands of extra directories and time out starting watch mode.
    /\.worktrees\/.*/,
    /\.expo\/.*/,
    /\.expo-shared\/.*/,
    /\.metro\/.*/,
    /\.cache\/.*/,
    /node_modules\/\.cache\/.*/,
    /\.tsbuildinfo$/,
    /.*\.expo\/types\/.*/,
    /__tests__\/.*/,
    /\.test\.(js|ts|tsx|jsx)$/,
    /\.spec\.(js|ts|tsx|jsx)$/,
    /\.md$/,
    /README/,
    ...extraBlockList,
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
    },
    // Resolve from the app's node_modules first, then the monorepo root (hoisted deps).
    nodeModulesPaths: [
      path.join(projectRoot, 'node_modules'),
      path.join(monorepoRoot, 'node_modules'),
    ],
    // Enable symlinks for workspace resolution.
    unstable_enableSymlinks: true,
    // Enable package.json "exports" resolution (required by @oxyhq/bloom subpath exports).
    unstable_enablePackageExports: true,
    sourceExts: [...config.resolver.sourceExts, 'ts', 'tsx'],
    // Bloom imports `.woff2`/`.woff` fonts directly from JS on web; Metro does not
    // include them in default assetExts. SVGs stay ASSETS (metro's default): the
    // apps `require('*.svg')` them as image URIs (e.g. `<Image source={require(
    // '…/empty.svg')} />`) — there is no react-native-svg-transformer configured,
    // so removing `svg` from assetExts leaves it unresolvable (breaks the build).
    assetExts: [
      ...config.resolver.assetExts,
      'wasm',
      'woff2',
      'woff',
    ],
  };

  config.transformer = {
    ...config.transformer,
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
        drop_console: false,
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
      moduleName === '@oxyhq/bloom' || moduleName.startsWith('@oxyhq/bloom/')
        ? { ...context, originModulePath: bloomOrigin }
        : context;

    return parentResolveRequest(resolveContext, moduleName, platform);
  };

  return nativeWindConfig;
}

function createOxyMetroConfigWithBloom(projectRoot, options = {}) {
  const nativeWindConfig = createOxyMetroConfig(projectRoot, options);
  return withBloomSingleInstance(nativeWindConfig, projectRoot);
}

module.exports = { createOxyMetroConfig: createOxyMetroConfigWithBloom, withBloomSingleInstance };
