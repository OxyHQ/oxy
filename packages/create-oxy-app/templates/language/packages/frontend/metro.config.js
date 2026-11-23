// Shared Oxy Metro config (monorepo watch folders, block list, symlink +
// package-exports resolution, web-font/wasm asset exts, minifier). The app has
// no CSS toolchain, so @oxy.so/app-preset (6.9+) wraps Metro in none.
//
// `withBloomLanguage` puts the Bloom language compiler in front of Expo's
// transform worker: it checks every chain against the language spec (an unknown
// modifier or token fails the build), hoists static chains and opts view bodies
// into the React Compiler. See @oxy.so/bloom-language-compiler.
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');
const { withBloomLanguage } = require('@oxy.so/bloom-language-compiler/metro');

module.exports = withBloomLanguage(
  createOxyMetroConfig(__dirname, {
    sharedTypesPackage: '@{{APP_SLUG}}/shared-types',
  }),
);
