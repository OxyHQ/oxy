// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // Icon-font glyphs go through `components/icons/*`, which hides them from
    // assistive technology (TalkBack otherwise reads the private-use code point).
    files: ['**/*.{ts,tsx,js,jsx}'],
    ignores: ['components/icons/**', '__mocks__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@expo/vector-icons', '@expo/vector-icons/*'],
              message:
                'Import the icon family from @/components/icons/* — it hides the glyph from screen readers.',
            },
          ],
        },
      ],
    },
  },
]);
