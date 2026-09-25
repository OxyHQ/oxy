// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // Every glyph is a Bloom SVG from `@/constants/icons`. An icon font ships
    // its whole TTF for one glyph, and TalkBack reads its private-use code point.
    files: ['**/*.{ts,tsx,js,jsx}'],
    ignores: ['__mocks__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@expo/vector-icons', '@expo/vector-icons/*'],
              message:
                'Draw glyphs from @/constants/icons (Bloom SVGs), not an icon font.',
            },
          ],
        },
      ],
    },
  },
]);
