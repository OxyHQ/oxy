// `BloomNativeWindTheme` (nativewind/theme.js): Bloom's colour tokens reach
// react-native-css's root variables on native, by the names theme.css reads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const FILE = path.join(__dirname, '../nativewind/theme.js');

function load(os, tokens) {
  const set = [];
  const modules = {
    react: { ...React, useLayoutEffect: (effect) => effect() },
    'react-native': { Platform: { OS: os } },
    '@oxy.so/bloom/theme': { useColorTokens: () => tokens },
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
