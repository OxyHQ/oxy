/**
 * Expo Config Plugin: withOxyAbiSplits (always applied by the preset)
 *
 * Builds one APK per ABI instead of one universal APK. A universal Oxy APK
 * carries the native libraries of every ABI, of which a phone loads one
 * (Mention 126 MB: 55 MB of arm64-v8a libraries, 37 MB of armeabi-v7a), so a
 * release ships
 *
 *   app-arm64-v8a-release.apk     every phone from about 2017 on
 *   app-armeabi-v7a-release.apk   older phones and many Android TVs
 *
 * and no universal APK. Gradle's ABI splits only affect APKs: `bundleRelease`
 * still builds one AAB with every ABI, and Google Play serves each device its
 * own slice of it.
 *
 * The splits are OFF in a Gradle invocation that builds a bundle. When R8
 * shrinks resources (`shrinkResources`, which every Oxy release does), AGP
 * fails `buildReleasePreBundle` with "Multiple shrunk-resources files found …
 * Please disable building multiple APKs when building an Android app bundle"
 * (https://issuetracker.google.com/402800800). So the AAB and the APKs are
 * two invocations, `./gradlew :app:bundleRelease` then
 * `./gradlew :app:assembleRelease`; one invocation asking for both builds a
 * universal APK, which Oxy's release workflow refuses.
 *
 * A build for ONE device keeps working: `expo run:android` passes
 * `-PreactNativeArchitectures=<the device's ABI>` for a debug build, so the
 * split follows the ABIs Gradle compiles whenever none of the release ABIs is
 * among them (an x86_64 emulator gets `app-x86_64-debug.apk`, which the Expo
 * CLI finds by the device's ABI). A release ABI that is not compiled is never
 * split out, because its APK would carry no native libraries.
 *
 * Every split APK has the app's one `versionCode` (`withOxyReleaseVersion`).
 * That is what sideloading needs: they are the same version of the same app,
 * and Android installs either over the other. Unique versionCodes per APK are
 * a Google Play rule for publishing several APKs to Play; Play gets the AAB.
 *
 * Applied by the preset and by `withOxyUpdates`, the entry every app on the
 * release pipeline lists, so it is idempotent: the second run finds its marker
 * and changes nothing. A build.gradle that already has a `splits {}` block
 * (another plugin's, or a hand edit) fails: two sources for the APK layout is
 * how a release ends up shipping the wrong files.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const PLUGIN = '[@oxy.so/app-preset withOxyAbiSplits]';
const MARKER = '@generated oxy-abi-splits';

/** The ABIs every Oxy release ships an APK for, in the order people should pick them. */
const RELEASE_ABIS = ['arm64-v8a', 'armeabi-v7a'];

/** Inserted before `android {`: which APKs this build splits out. */
const RESOLVE_ABIS = `// ${MARKER}: one APK per ABI, no universal APK (@oxy.so/app-preset
// withOxyAbiSplits). Edit the plugin, never this file. A release ships ${RELEASE_ABIS.join(' and ')};
// a build that compiles none of them (-PreactNativeArchitectures=x86_64, as \`expo run:android\`
// passes for an emulator) splits to the ABIs it compiles, so that device still gets an APK.
def oxyBuiltAbis = (findProperty('reactNativeArchitectures') ?: 'armeabi-v7a,arm64-v8a,x86,x86_64').toString().split(',').collect { it.trim() }.findAll { it }
def oxyReleaseAbis = [${RELEASE_ABIS.map((abi) => `'${abi}'`).join(', ')}].findAll { oxyBuiltAbis.contains(it) }
def oxyApkAbis = oxyReleaseAbis ?: oxyBuiltAbis
// AGP refuses ABI splits in an invocation that also builds an app bundle while R8 shrinks
// resources (https://issuetracker.google.com/402800800), and a bundle never uses them: build
// the AAB and the APKs in two invocations.
def oxyBuildsBundle = gradle.startParameter.taskNames.any { it.tokenize(':').last().toLowerCase().startsWith('bundle') }

`;

/** Inserted as the first entry of `android {`. */
const SPLITS = `
    // ${MARKER}: the APKs are oxyApkAbis, one each; off while building a bundle.
    splits {
        abi {
            reset()
            enable !oxyBuildsBundle
            universalApk false
            include(*oxyApkAbis)
        }
    }
`;

function fail(message) {
  throw new Error(`${PLUGIN} ${message}`);
}

/**
 * Apply the split to the text of a Groovy `android/app/build.gradle`. Idempotent.
 *
 * @param {string} contents
 * @returns {string}
 */
function applyAbiSplits(contents) {
  if (contents.includes(MARKER)) return contents;

  if (/^\s*splits\s*\{/m.test(contents)) {
    fail(
      'app/build.gradle already has a `splits {}` block written by another plugin or by hand. ' +
        'Remove it: the preset splits every Oxy APK by ABI.',
    );
  }

  const androidBlock = /^android \{$/m;
  if (!androidBlock.test(contents)) {
    fail(
      'Could not find the top-level `android {` block in app/build.gradle. The Expo template changed: update this plugin instead of editing android/ by hand.',
    );
  }
  return contents.replace(androidBlock, `${RESOLVE_ABIS}android {${SPLITS}`);
}

/** @param {import('expo/config').ExpoConfig} config */
module.exports = function withOxyAbiSplits(config) {
  return withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== 'groovy') {
      fail(
        `app/build.gradle is ${modConfig.modResults.language}, not Groovy. Oxy releases ship one APK per ABI; ` +
          'add the split to this plugin for that language instead of shipping a universal APK.',
      );
    }
    modConfig.modResults.contents = applyAbiSplits(modConfig.modResults.contents);
    return modConfig;
  });
};
module.exports.applyAbiSplits = applyAbiSplits;
module.exports.RELEASE_ABIS = RELEASE_ABIS;
