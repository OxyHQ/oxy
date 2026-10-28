const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { withNativeWind } = require('nativewind/metro');
const { withReactNativeCssSingleInstance, withCompleteReactNative } = require('../metro');
const projectRoot = path.resolve(__dirname, '..');
const expoRequire = createRequire(require.resolve('expo/package.json'));
const { resolvePackageTargetFromExports } = require(
  path.join(path.dirname(expoRequire.resolve('metro-resolver')), 'PackageExportsResolve.js'),
);
const cssRoot = path.dirname(require.resolve('react-native-css/package.json'));
const cssPackage = require('react-native-css/package.json');
function resolve(context, name, platform) {
  if (name === 'react-native-css' || name.startsWith('react-native-css/')) {
    const subpath = name.slice('react-native-css'.length + 1);
    return resolvePackageTargetFromExports(
      {
        ...context,
        assetExts: new Set(),
        fileSystemLookup(filePath) {
          return { exists: fs.existsSync(filePath), type: 'f', realPath: filePath };
        },
      },
      cssRoot,
      path.join(cssRoot, subpath),
      subpath,
      cssPackage.exports,
      platform,
    );
  }
  return { type: 'sourceFile', filePath: require.resolve(name) };
}
function context(isESMImport) {
  return {
    originModulePath: path.join(projectRoot, 'app.tsx'),
    resolveRequest: resolve,
    isESMImport,
    unstable_conditionNames: ['react-native'],
    unstable_conditionsByPlatform: {},
  };
}
function config() {
  return withCompleteReactNative(
    withNativeWind(
      withReactNativeCssSingleInstance({
        projectRoot,
        resolver: { sourceExts: ['js'] },
        transformer: {},
      }),
      { disableTypeScriptGeneration: true },
    ),
  );
}
test('native import consumers and require stylesheet injection share actual package exports', () => {
  const native = config().resolver.resolveRequest;
  for (const platform of ['android', 'ios']) {
    for (const name of [
      'react-native-css',
      'react-native-css/native',
      'react-native-css/native-internal',
    ]) {
      // Reproduces the split in the original resolver using the published export map.
      assert.notEqual(
        resolve(context(true), name, platform).filePath,
        resolve(context(false), name, platform).filePath,
      );
      assert.deepEqual(
        native(context(true), name, platform),
        native(context(false), name, platform),
      );
      assert.match(native(context(true), name, platform).filePath, /dist[/\\]commonjs/);
    }
  }
});
test('NativeWind redirects and the complete RN shim use that same native runtime', () => {
  const native = config().resolver.resolveRequest;
  const shim = native(context(true), 'react-native', 'android');
  assert.match(shim.filePath, /metro[/\\]react-native.js$/);
  const components = native(
    { ...context(true), originModulePath: shim.filePath },
    'react-native-css/components',
    'android',
  );
  assert.equal(
    components.filePath,
    resolve(context(false), 'react-native-css/components', 'android').filePath,
  );
  // Keep the native safe-area adapter, rather than incorrectly selecting its web default.
  const safeArea = native(
    context(true),
    'react-native-css/components/react-native-safe-area-context',
    'android',
  );
  assert.match(safeArea.filePath, /react-native-safe-area-context.native.tsx$/);
});
test('web and unrelated requests retain their conditions and origin', () => {
  const seen = [];
  const wrapped = withReactNativeCssSingleInstance({
    projectRoot,
    resolver: {
      resolveRequest: (ctx) => {
        seen.push(ctx);
        return {};
      },
    },
  });
  const original = context(true);
  wrapped.resolver.resolveRequest(original, 'react-native-css', 'web');
  wrapped.resolver.resolveRequest(original, 'react', 'android');
  assert.deepEqual(seen, [original, original]);
  assert.equal(seen[0], original);
  assert.equal(seen[1], original);
});
