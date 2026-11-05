// `import … from 'react-native'` on native, under the real NativeWind resolver.
//
// NativeWind sends it to `react-native-css/components`, a fixed list of React
// Native's API. React Native 0.88 added `AssetRegistry`; the list lacks it, so
// `expo-asset` read `undefined`, every `useFonts` failed and Android release
// builds showed a blank screen. These tests resolve the import the way Metro
// does (real `nativewind/metro`, real `react-native-css`, real React Native
// 0.88 and `expo-asset` files) and load what it resolves to.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { withNativeWind } = require('nativewind/metro');
const { withCompleteReactNative } = require('../metro');

const PRESET_ROOT = path.resolve(__dirname, '..');
const COMPLETE_REACT_NATIVE = fs.realpathSync(path.join(PRESET_ROOT, 'metro/react-native.js'));
const REACT_NATIVE_INDEX = fs.realpathSync(require.resolve('react-native'));
const CSS_COMPONENTS = fs.realpathSync(require.resolve('react-native-css/components'));
const EXPO_ASSET = path.dirname(
  fs.realpathSync(
    createRequire(require.resolve('expo/package.json')).resolve('expo-asset/package.json'),
  ),
);
const EXPO_ASSET_ORIGIN = path.join(EXPO_ASSET, 'build/Asset.js');

/**
 * Metro's own resolver, standing in for `context.resolveRequest`: node_modules
 * lookup from the origin, then from the project (Metro's `nodeModulesPaths`).
 */
function metroResolve(context, moduleName) {
  const filePath = require.resolve(moduleName, {
    paths: [path.dirname(context.originModulePath), PRESET_ROOT],
  });
  return { type: 'sourceFile', filePath: fs.realpathSync(filePath) };
}

function nativeWindConfig() {
  return withNativeWind(
    { projectRoot: PRESET_ROOT, resolver: { sourceExts: ['js'] }, transformer: {} },
    { disableTypeScriptGeneration: true },
  );
}

function resolverOf(config) {
  return (originModulePath, moduleName, platform = 'android') =>
    config.resolver.resolveRequest(
      { originModulePath, resolveRequest: metroResolve },
      moduleName,
      platform,
    );
}

/**
 * Every name React Native 0.88's runtime index exports: its getters, its one
 * method, and the names it adds with `defineProperty`. The file is Flow, so it
 * is read rather than run.
 */
function reactNativeIndexNames() {
  const source = fs.readFileSync(REACT_NATIVE_INDEX, 'utf8');
  const names = new Set();
  for (const pattern of [
    /^ {2}get (\w+)\(\)/gm,
    /^ {2}(\w+)(?:<[^>\n]*>)?\(.*\) \{$/gm,
    /Object\.defineProperty\(module\.exports, '(\w+)'/g,
  ]) {
    for (const [, name] of source.matchAll(pattern)) names.add(name);
  }
  return [...names];
}

/**
 * React Native's index as the app sees it at runtime: an object of getters,
 * one per exported name, each returning a value that is that name's alone.
 */
function reactNativeStandIn() {
  const standIn = {};
  for (const name of reactNativeIndexNames()) {
    const value = { reactNative: name };
    Object.defineProperty(standIn, name, {
      enumerable: true,
      configurable: true,
      get: () => value,
    });
  }
  return standIn;
}

/**
 * Loads `filePath` the way the bundle would: its requires resolved by `resolve`
 * (the preset's Metro resolver), React Native's index replaced by `reactNative`.
 */
function load(filePath, resolve, reactNative, cache = new Map()) {
  if (filePath === REACT_NATIVE_INDEX) return reactNative;
  if (filePath === CSS_COMPONENTS) return require(CSS_COMPONENTS);
  if (cache.has(filePath)) return cache.get(filePath).exports;
  const module = { exports: {} };
  cache.set(filePath, module);
  const localRequire = (moduleName) =>
    load(resolve(filePath, moduleName).filePath, resolve, reactNative, cache);
  new Function('require', 'module', 'exports', fs.readFileSync(filePath, 'utf8'))(
    localRequire,
    module,
    module.exports,
  );
  return module.exports;
}

test('NativeWind alone sends expo-asset to a shim without AssetRegistry', () => {
  const resolve = resolverOf(nativeWindConfig());
  const resolved = resolve(EXPO_ASSET_ORIGIN, 'react-native');
  assert.equal(resolved.filePath, CSS_COMPONENTS);
  // What the preset exists to fix. When react-native-css lists AssetRegistry
  // (upstream PR #504), this half no longer holds and can go.
  assert.equal(Object.hasOwn(require(CSS_COMPONENTS), 'AssetRegistry'), false);
  assert.match(
    fs.readFileSync(EXPO_ASSET_ORIGIN, 'utf8'),
    /import \{ AssetRegistry \} from 'react-native'/,
  );
});

test("expo-asset's AssetRegistry is React Native's under the preset", () => {
  const resolve = resolverOf(withCompleteReactNative(nativeWindConfig()));
  const resolved = resolve(EXPO_ASSET_ORIGIN, 'react-native');
  assert.equal(fs.realpathSync(resolved.filePath), COMPLETE_REACT_NATIVE);

  // The completed module's own imports skip NativeWind's redirect.
  assert.equal(resolve(COMPLETE_REACT_NATIVE, 'react-native').filePath, REACT_NATIVE_INDEX);
  assert.equal(
    resolve(COMPLETE_REACT_NATIVE, 'react-native-css/components').filePath,
    CSS_COMPONENTS,
  );

  const reactNative = reactNativeStandIn();
  const seen = load(resolved.filePath, resolve, reactNative);
  assert.equal(seen.AssetRegistry, reactNative.AssetRegistry);
});

test('every name of React Native 0.88 is defined, and the shim keeps its own getters', () => {
  const names = reactNativeIndexNames();
  // The census reads source; keep it honest about what it found.
  assert.ok(names.length > 90, `only ${names.length} names read from React Native's index`);
  for (const name of ['View', 'Text', 'AssetRegistry', 'unstable_batchedUpdates', 'Touchable']) {
    assert.ok(names.includes(name), name);
  }

  const resolve = resolverOf(withCompleteReactNative(nativeWindConfig()));
  const reactNative = reactNativeStandIn();
  const seen = load(resolve(EXPO_ASSET_ORIGIN, 'react-native').filePath, resolve, reactNative);
  const css = require(CSS_COMPONENTS);

  const missing = names.filter((name) => !(name in seen));
  assert.deepEqual(missing, [], 'names of React Native the app would read as undefined');

  for (const name of names.filter((key) => !Object.hasOwn(css, key))) {
    assert.equal(seen[name], reactNative[name], name);
  }
  // className behaviour is NativeWind's: the shim's getters, not copies of them.
  for (const name of Object.getOwnPropertyNames(css)) {
    assert.equal(
      Object.getOwnPropertyDescriptor(seen, name).get,
      Object.getOwnPropertyDescriptor(css, name).get,
      name,
    );
  }
});

test('touches nothing but a react-native import NativeWind sent to the shim', () => {
  const alone = resolverOf(nativeWindConfig());
  const completed = resolverOf(withCompleteReactNative(nativeWindConfig()));
  const appFile = path.join(PRESET_ROOT, 'app/index.tsx');
  for (const [origin, moduleName, platform] of [
    // Web: NativeWind leaves react-native alone at this level.
    [EXPO_ASSET_ORIGIN, 'react-native', 'web'],
    // A deep import NativeWind maps to its own Text.
    [appFile, 'react-native/Libraries/Text/Text', 'android'],
    // NativeWind's own requires reach React Native itself.
    [CSS_COMPONENTS, 'react-native', 'ios'],
    [appFile, 'react-native-css/components', 'ios'],
    [appFile, 'react', 'android'],
  ]) {
    assert.deepEqual(
      completed(origin, moduleName, platform),
      alone(origin, moduleName, platform),
      `${moduleName} from ${path.relative(PRESET_ROOT, origin)} on ${platform}`,
    );
  }
});
