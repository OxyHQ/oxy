// Biome (root biome.jsonc) formats and lints this package. ESLint remains only
// for eslint-plugin-expo's rules, which Biome has no equivalent for: Metro
// inlines `process.env.EXPO_PUBLIC_*` only as a literal member access, so a
// destructured or computed read silently ships `undefined`; and `'use dom'`
// components must keep the export shape the DOM-components bundler expects.
// The same three rules, at the same level, that `eslint-config-expo` applied.
const { defineConfig } = require('eslint/config');
const tsParser = require('@typescript-eslint/parser');
const expo = require('eslint-plugin-expo');

module.exports = defineConfig([
  {
    ignores: ['dist/*', 'android/app/build'],
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { expo },
    rules: {
      'expo/use-dom-exports': 'error',
      'expo/no-env-var-destructuring': 'error',
      'expo/no-dynamic-env-var': 'error',
    },
  },
]);
