// Bloom's base face for a text that names no family (`metro/base-font/`).
//
// React 19 ignores `Text.defaultProps` (it applies `defaultProps` to class
// components only), so every raw `<Text>` drew the system face. The preset
// swaps React Native's `Text` and `TextInput` (NativeWind's, in an app that
// styles with it) for the same components over a host that puts the base face
// first. These tests resolve the routes to them the way Metro does (real
// `nativewind/metro`, real `react-native-css`, React Native and react-native-web
// files), then render the components with stand-in hosts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { withNativeWind } = require('nativewind/metro');
const { withBaseFontText, withCompleteReactNative } = require('../metro');

const PRESET_ROOT = path.resolve(__dirname, '..');
const BASE_FONT = path.join(PRESET_ROOT, 'metro/base-font');
const real = (moduleName) => fs.realpathSync(require.resolve(moduleName));
const REACT_NATIVE_INDEX = real('react-native');
const CSS_ROOT = path.dirname(real('react-native-css/package.json'));
const RNW_TEXT = real('react-native-web/dist/exports/Text');
const RNW_INDEX = real('react-native-web');

/** Metro's own resolver, standing in for `context.resolveRequest`. */
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
  return (originModulePath, moduleName, platform) =>
    config.resolver.resolveRequest(
      { originModulePath, resolveRequest: metroResolve },
      moduleName,
      platform,
    ).filePath;
}

const preset = () =>
  resolverOf(
    withBaseFontText(withCompleteReactNative(nativeWindConfig()), PRESET_ROOT, {
      nativewind: true,
    }),
  );
/** An app without NativeWind: Expo's config alone, the base face over React Native's files. */
const plainConfig = () => ({
  projectRoot: PRESET_ROOT,
  resolver: { sourceExts: ['js'], resolveRequest: (context, name) => metroResolve(context, name) },
  transformer: {},
});
const plain = () => resolverOf(withBaseFontText(plainConfig(), PRESET_ROOT, { nativewind: false }));
const RN_ROOT = path.dirname(real('react-native/package.json'));
const appFile = path.join(PRESET_ROOT, 'app/index.tsx');

test('every route to NativeWind’s Text and TextInput reaches the base-font components', () => {
  const resolve = preset();
  const cssComponents = path.dirname(real('react-native-css/components'));
  for (const [origin, moduleName, platform, expected] of [
    // Native: the components NativeWind's `react-native` lists, and deep imports.
    [path.join(cssComponents, 'index.cjs'), './Text', 'android', 'Text.js'],
    [path.join(cssComponents, 'index.cjs'), './TextInput', 'ios', 'TextInput.js'],
    [appFile, 'react-native/Libraries/Text/Text', 'android', 'Text.js'],
    [appFile, 'react-native-css/components/Text', 'ios', 'Text.js'],
    // Web: the deep import Expo's Babel preset writes, and react-native-web's index.
    [appFile, 'react-native-web/dist/exports/Text', 'web', 'Text.js'],
    [RNW_INDEX, './exports/TextInput', 'web', 'TextInput.js'],
  ]) {
    assert.equal(resolve(origin, moduleName, platform), path.join(BASE_FONT, expected), moduleName);
  }
});

test('the base-font modules reach the real hosts, past every redirect', () => {
  for (const resolve of [preset(), plain()]) {
    const nativeHosts = path.join(BASE_FONT, 'hosts.native.js');
    const webHosts = path.join(BASE_FONT, 'hosts.web.js');
    assert.equal(
      resolve(nativeHosts, 'react-native/Libraries/Text/Text', 'android'),
      path.join(RN_ROOT, 'Libraries/Text/Text.js'),
    );
    assert.equal(resolve(webHosts, 'react-native-web/dist/exports/Text', 'web'), RNW_TEXT);
  }
  const resolve = preset();
  const native = path.join(BASE_FONT, 'base-font.native.js');
  assert.ok(resolve(native, 'react-native-css', 'ios').startsWith(CSS_ROOT));
  // A relative import stays relative to the module.
  assert.equal(resolve(native, './mappings', 'android'), path.join(BASE_FONT, 'mappings.js'));
});

test('without NativeWind, every route to React Native’s Text and TextInput reaches the base face', () => {
  const resolve = plain();
  for (const [origin, moduleName, platform, expected] of [
    // Native: React Native's index getters and a deep import.
    [REACT_NATIVE_INDEX, './Libraries/Text/Text', 'android', 'PlainText.js'],
    [REACT_NATIVE_INDEX, './Libraries/Components/TextInput/TextInput', 'ios', 'PlainTextInput.js'],
    [appFile, 'react-native/Libraries/Text/Text', 'android', 'PlainText.js'],
    // Web: the deep import Expo's Babel preset writes, and react-native-web's index.
    [appFile, 'react-native-web/dist/exports/Text', 'web', 'PlainText.js'],
    [RNW_INDEX, './exports/TextInput', 'web', 'PlainTextInput.js'],
  ]) {
    assert.equal(resolve(origin, moduleName, platform), path.join(BASE_FONT, expected), moduleName);
  }
  // Nothing else, and no NativeWind module, is touched.
  assert.equal(resolve(appFile, 'react-native', 'android'), REACT_NATIVE_INDEX);
  assert.equal(
    resolve(appFile, 'react-native/Libraries/Components/View/View', 'android'),
    path.join(RN_ROOT, 'Libraries/Components/View/View.js'),
  );
});

test('touches nothing else', () => {
  const alone = resolverOf(withCompleteReactNative(nativeWindConfig()));
  const resolve = preset();
  for (const [origin, moduleName, platform] of [
    [appFile, 'react-native', 'android'],
    [appFile, 'react-native/Libraries/Components/View/View', 'android'],
    [appFile, 'react-native-web/dist/exports/View', 'web'],
    [appFile, 'react', 'ios'],
  ]) {
    assert.equal(resolve(origin, moduleName, platform), alone(origin, moduleName, platform));
  }
});

/**
 * Loads a base-font module with stand-ins: hosts that record the props they
 * render with, a real React context as React Native's TextAncestorContext, and
 * `styled()` as the identity that keeps its mapping (`react-native-css` needs a
 * native runtime). A base-font module's own `./x` imports load the same way.
 */
function loadBaseFont(file) {
  const rendered = [];
  const host = (name, statics = {}) =>
    Object.assign(
      (props) => {
        rendered.push({ name, props });
        return null;
      },
      { displayName: name, ...statics },
    );
  const Text = host('Text');
  const TextInput = host('TextInput', { State: { focused: 1 } });
  const TextAncestorContext = React.createContext(false);
  const platform = file.endsWith('.web.js') ? 'web' : 'native';
  const modules = {
    react: React,
    'react-native/Libraries/Text/Text': { default: Text },
    'react-native/Libraries/Components/TextInput/TextInput': { default: TextInput },
    'react-native/Libraries/Text/TextAncestorContext': { default: TextAncestorContext },
    'react-native-web/dist/exports/Text': { default: Text },
    'react-native-web/dist/exports/TextInput': { default: TextInput },
    'react-native-web/dist/exports/StyleSheet': { default: { create: (styles) => styles } },
    'react-native-css': {
      styled: (component, mapping) => Object.assign((props) => component(props), { mapping }),
    },
    'react-native-css/components/copyComponentProperties': require(
      path.join(CSS_ROOT, 'dist/commonjs/components/copyComponentProperties.js'),
    ),
  };
  const loaded = new Map();
  const load = (name) => {
    if (!name.startsWith('./')) return modules[name];
    const base = name.slice(2);
    const own = fs.existsSync(path.join(BASE_FONT, `${base}.js`))
      ? `${base}.js`
      : `${base}.${platform}.js`;
    if (!loaded.has(own)) {
      const module = { exports: {} };
      loaded.set(own, module);
      new Function(
        'require',
        'module',
        'exports',
        fs.readFileSync(path.join(BASE_FONT, own), 'utf8'),
      )(load, module, module.exports);
    }
    return loaded.get(own).exports;
  };
  return { components: load(`./${file.replace(/\.js$/, '')}`), rendered, TextAncestorContext };
}

const render = (element) => renderToStaticMarkup(element);

test('native: a text that names no family draws Inter, under its own style', () => {
  const { components, rendered } = loadBaseFont('base-font.native.js');
  const own = { color: 'red' };
  render(React.createElement(components.Text, { style: own, numberOfLines: 1 }));
  render(React.createElement(components.TextInput, {}));
  assert.deepEqual(rendered, [
    { name: 'Text', props: { style: [{ fontFamily: 'Inter' }, own], numberOfLines: 1 } },
    { name: 'TextInput', props: { style: [{ fontFamily: 'Inter' }, undefined] } },
  ]);
});

test("native: a text nested in a text inherits its parent's family", () => {
  const { components, rendered, TextAncestorContext } = loadBaseFont('base-font.native.js');
  const own = { fontWeight: '600' };
  render(
    React.createElement(
      TextAncestorContext.Provider,
      { value: true },
      React.createElement(components.Text, { style: own }),
    ),
  );
  assert.deepEqual(rendered, [{ name: 'Text', props: { style: own } }]);
});

test('web: a text inherits the document family beneath its own style', () => {
  const { components, rendered } = loadBaseFont('base-font.web.js');
  const own = { color: 'red' };
  render(React.createElement(components.Text, { style: own }));
  assert.deepEqual(rendered, [
    { name: 'Text', props: { style: [{ fontFamily: 'inherit' }, own] } },
  ]);
});

test('without NativeWind, the base face reaches the text with React Native’s statics', () => {
  for (const file of ['hosts.native.js', 'hosts.web.js']) {
    const { components, rendered } = loadBaseFont(file);
    render(React.createElement(components.Text, { style: { color: 'red' } }));
    assert.equal(rendered.length, 1, file);
    assert.deepEqual(rendered[0].props.style[1], { color: 'red' }, file);
    assert.deepEqual(components.TextInput.State, { focused: 1 }, file);
    assert.equal(components.TextInput.displayName, 'TextInput', file);
  }
  for (const file of ['PlainText.js', 'PlainTextInput.js']) {
    const { components } = loadBaseFont(file);
    assert.equal(typeof components.default, 'function', file);
  }
});

test("both platforms keep NativeWind's mappings and React Native's statics", () => {
  for (const file of ['base-font.native.js', 'base-font.web.js']) {
    const { components } = loadBaseFont(file);
    const TextInput = components.TextInput;
    assert.deepEqual(components.Text.mapping, { className: 'style' }, file);
    assert.deepEqual(TextInput.mapping, {
      className: { target: 'style', nativeStyleMapping: { textAlign: true } },
    });
    assert.deepEqual(TextInput.State, { focused: 1 }, file);
    assert.equal(TextInput.displayName, 'TextInput', file);
  }
});
