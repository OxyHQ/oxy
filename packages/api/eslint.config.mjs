import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.cjs', 'scripts/**'],
  },
  {
    // `jest.config.js` is CommonJS — this package has no `"type": "module"` —
    // so it reads node builtins with `require`, which the TS ruleset's
    // ESM-only import rule flags. Every other jest config in this repo is
    // `.cjs` and is already ignored above for exactly that reason; this one
    // keeps the `.js` extension only because `.slugignore` and a dozen
    // comments name it. Turn off the one rule that does not apply rather than
    // renaming the file or dropping it from linting entirely.
    files: ['jest.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.eslint.json',
      },
    },
    rules: {
      // Disable rules for existing code patterns
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // Best practices
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'warn',
      'no-var': 'error',
    },
  },
]);
