/**
 * @oxy.so/app-preset — flat ESLint config.
 *
 * `eslint-config-expo/flat` plus the shared `dist/*` ignore. Consumers spread
 * it and append their own rules:
 *
 *   const oxyConfig = require('@oxy.so/app-preset/eslint');
 *   module.exports = [...oxyConfig];
 *
 * `eslint` and `eslint-config-expo` resolve from the consuming app's
 * node_modules (both are optional peers of the preset).
 *
 * @type {import('eslint').Linter.Config[]}
 */
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
]);
