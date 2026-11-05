/**
 * Expo Config Plugin: withOxyR8Optimize (applied by `['@oxy.so/app-preset', {}]`).
 *
 * Expo SDK 56/57 generate `getDefaultProguardFile("proguard-android.txt")` for
 * the release buildType, whose only meaningful line is `-dontoptimize`. The
 * `-optimize` variant drops it and adds `-allowaccessmodification`, which is what
 * lets R8 inline and merge classes (measured on Mention: dex 22,814,960 →
 * 15,290,636 bytes uncompressed, -33%, 4 dex files → 2). SDK 58's template
 * already generates the `-optimize` file, so there this is a no-op.
 *
 * Release signing is not here: `@oxy.so/services/plugins/withOxySharedPermissions`
 * (which the preset applies) owns it, because the signature permissions it
 * declares are what make the certificate load-bearing.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const DEFAULT_PROGUARD = 'getDefaultProguardFile("proguard-android.txt")';
const OPTIMIZED_PROGUARD = 'getDefaultProguardFile("proguard-android-optimize.txt")';

/** @param {string} contents */
function optimizeProguardFile(contents) {
  if (contents.includes(OPTIMIZED_PROGUARD)) return contents;
  if (!contents.includes(DEFAULT_PROGUARD)) {
    throw new Error(
      `[@oxy.so/app-preset withOxyR8Optimize] Could not find ${DEFAULT_PROGUARD} in app/build.gradle. ` +
        'The Expo template changed: update this plugin instead of editing android/ by hand.',
    );
  }
  return contents.replace(DEFAULT_PROGUARD, OPTIMIZED_PROGUARD);
}

module.exports = function withOxyR8Optimize(config) {
  return withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language === 'groovy') {
      modConfig.modResults.contents = optimizeProguardFile(modConfig.modResults.contents);
    }
    return modConfig;
  });
};
module.exports.optimizeProguardFile = optimizeProguardFile;
