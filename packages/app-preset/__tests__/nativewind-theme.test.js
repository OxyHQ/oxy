// `BloomNativeWindTheme` (nativewind/theme.js): Bloom's colour tokens reach
// react-native-css's root variables on native, by the names theme.css reads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const FILE = path.join(__dirname, '../nativewind/theme.js');

/** NativeWind's scoped variables, as react-native-css resolves them: merged over the parent's. */
const Variables = React.createContext({});
function VariableContextProvider({ value, children }) {
  const parent = React.useContext(Variables);
  return React.createElement(Variables.Provider, { value: { ...parent, ...value } }, children);
}
const ColorScopeLayerContext = React.createContext(null);

function load(os, tokens) {
  const set = [];
  const modules = {
    react: { ...React, useLayoutEffect: (effect) => effect() },
    'react-native': { Platform: { OS: os } },
    '@oxy.so/bloom/theme': { useColorTokens: () => tokens, ColorScopeLayerContext },
    nativewind: { VariableContextProvider },
    'react-native-css/native-internal': {
      rootVariables: (name) => ({ set: (value) => set.push([name, value]) }),
    },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', fs.readFileSync(FILE, 'utf8'))(
    (name) => modules[name],
    module,
    module.exports,
  );
  return { ...module.exports, set };
}

test('names every token as theme.css reads it', () => {
  const { tokenName } = load('android', {});
  assert.equal(tokenName('mutedForeground'), 'muted-foreground');
  assert.equal(tokenName('chart1Active'), 'chart-1-active');
  assert.equal(tokenName('primary'), 'primary');
});

test('native publishes the tokens into the root variables; the web draws nothing', () => {
  const tokens = { primary: 'rgb(1 2 3)', mutedForeground: 'rgb(4 5 6)' };
  const native = load('ios', tokens);
  assert.equal(renderToStaticMarkup(React.createElement(native.BloomNativeWindTheme)), '');
  assert.deepEqual(native.set, [
    ['primary', [['rgb(1 2 3)']]],
    ['muted-foreground', [['rgb(4 5 6)']]],
  ]);
  const web = load('web', tokens);
  renderToStaticMarkup(React.createElement(web.BloomNativeWindTheme));
  assert.deepEqual(web.set, []);
});

/** What a class reading `var(--color-primary)` resolves to: the nearest scoped value, else the root's. */
function ClassProbe() {
  return React.createElement('i', null, React.useContext(Variables)['--color-primary'] ?? 'root');
}

/** A Bloom colour scope, as it draws its subtree: through the layer, with its token record. */
function Scope({ vars, children }) {
  const Layer = React.useContext(ColorScopeLayerContext);
  return Layer ? React.createElement(Layer, { vars }, children) : children;
}

test('on native a class inside a colour scope follows the scope, outside it the app theme', () => {
  const { BloomNativeWindTheme } = load('android', { primary: 'rgb(1 2 3)' });
  const html = renderToStaticMarkup(
    React.createElement(
      BloomNativeWindTheme,
      null,
      React.createElement(ClassProbe),
      React.createElement(
        Scope,
        { vars: { '--primary': '#5433eb', '--color-primary': '#5433eb' } },
        React.createElement(ClassProbe),
        React.createElement(Scope, { vars: {} }, React.createElement(ClassProbe)),
      ),
    ),
  );
  assert.equal(html, '<i>root</i><i>#5433eb</i><i>#5433eb</i>');
});

test('on the web no layer is given: scopes carry their palette as CSS variables', () => {
  const { BloomNativeWindTheme } = load('web', { primary: 'rgb(1 2 3)' });
  const html = renderToStaticMarkup(
    React.createElement(
      BloomNativeWindTheme,
      null,
      React.createElement(
        Scope,
        { vars: { '--color-primary': '#5433eb' } },
        React.createElement(ClassProbe),
      ),
    ),
  );
  assert.equal(html, '<i>root</i>');
});
