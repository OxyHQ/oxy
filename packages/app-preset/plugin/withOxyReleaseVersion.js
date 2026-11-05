/**
 * Expo Config Plugin: withOxyReleaseVersion (always applied by the preset)
 *
 * Derives the store build number from the app's `version`, so it is never kept
 * by hand and never drifts: Android `versionCode` and iOS `buildNumber` are
 *
 *   major * 1_000_000 + minor * 1_000 + patch      (1.2.3 → 1002003)
 *
 * The app `version` is already the OTA compatibility boundary (`withOxyUpdates`
 * uses the `appVersion` runtime policy): a new native binary is exactly a new
 * version, and every new version gets a strictly higher build number, which is
 * what Google Play and the App Store require. JS-only changes ship as OTA
 * updates under the same version and never need a build number.
 *
 * Applied by the preset and by `withOxyUpdates` (the OTA boundary it rests on),
 * so it is idempotent: a number equal to the derived one passes. An app that
 * keeps any OTHER `android.versionCode` or `ios.buildNumber` fails: two sources
 * for one number is how a release ends up rejected for reusing one.
 */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const MAX_MAJOR = 2099; // Play's versionCode ceiling is 2_100_000_000.

/**
 * @param {string} version
 * @returns {number}
 */
function releaseBuildNumber(version) {
  const match = VERSION_PATTERN.exec(String(version));
  if (!match) {
    throw new Error(
      `[@oxy.so/app-preset] The app \`version\` must be MAJOR.MINOR.PATCH (got ${JSON.stringify(version)}): ` +
        'the store build number is derived from it.',
    );
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major > MAX_MAJOR || minor > 999 || patch > 999) {
    throw new Error(
      `[@oxy.so/app-preset] The app \`version\` ${version} is out of range: major ≤ ${MAX_MAJOR}, minor and patch ≤ 999.`,
    );
  }
  return major * 1_000_000 + minor * 1_000 + patch;
}

/**
 * @param {import('expo/config').ExpoConfig} config
 */
function withOxyReleaseVersion(config) {
  if (config.version === undefined) {
    throw new Error('[@oxy.so/app-preset] The app config needs a `version` (MAJOR.MINOR.PATCH).');
  }
  const buildNumber = releaseBuildNumber(config.version);
  const versionCode = config.android?.versionCode;
  if (versionCode !== undefined && versionCode !== buildNumber) {
    throw new Error(
      `[@oxy.so/app-preset] Remove \`android.versionCode\` (${versionCode}): the preset derives it from \`version\` (${buildNumber}).`,
    );
  }
  const iosBuildNumber = config.ios?.buildNumber;
  if (iosBuildNumber !== undefined && iosBuildNumber !== String(buildNumber)) {
    throw new Error(
      `[@oxy.so/app-preset] Remove \`ios.buildNumber\` (${iosBuildNumber}): the preset derives it from \`version\` (${buildNumber}).`,
    );
  }
  return {
    ...config,
    android: { ...config.android, versionCode: buildNumber },
    ios: { ...config.ios, buildNumber: String(buildNumber) },
  };
}

module.exports = withOxyReleaseVersion;
module.exports.releaseBuildNumber = releaseBuildNumber;
