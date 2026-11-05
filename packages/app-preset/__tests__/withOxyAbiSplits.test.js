const { test } = require('node:test');
const assert = require('node:assert/strict');

const withOxyAbiSplits = require('../plugin/withOxyAbiSplits');
const withOxyUpdates = require('../plugin/withOxyUpdates');
const { applyAbiSplits, RELEASE_ABIS } = withOxyAbiSplits;

/** The shape of Expo SDK 58's generated android/app/build.gradle around `android {`. */
const TEMPLATE = `apply plugin: "com.android.application"
apply plugin: "com.facebook.react"

def jscFlavor = 'io.github.react-native-community:jsc-android:2026004.+'

android {
    ndkVersion rootProject.ext.ndkVersion

    namespace 'so.oxy.app'
    defaultConfig {
        applicationId 'so.oxy.app'
        versionCode 1001000
        versionName "1.1.0"
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
    packagingOptions {
        jniLibs {
            useLegacyPackaging false
        }
    }
}

dependencies {
    implementation("com.facebook.react:react-android")
}
`;

/** Run the app build.gradle mods registered on `config` over `contents`. */
async function runAppBuildGradleMods(config, contents, language = 'groovy') {
  const mod = config.mods?.android?.appBuildGradle;
  assert.equal(typeof mod, 'function', 'an app build.gradle mod is registered');
  const result = await mod({
    ...config,
    modResults: { contents, language, path: 'android/app/build.gradle' },
    modRequest: { platform: 'android', modName: 'appBuildGradle', projectRoot: '/app' },
  });
  return result.modResults.contents;
}

test('the release ships arm64-v8a and armeabi-v7a, never a universal APK', () => {
  assert.deepEqual(RELEASE_ABIS, ['arm64-v8a', 'armeabi-v7a']);
  const out = applyAbiSplits(TEMPLATE);
  assert.match(
    out,
    /android \{\n {4}\/\/ @generated oxy-abi-splits[^\n]*\n {4}splits \{\n {8}abi \{\n {12}reset\(\)\n {12}enable true\n {12}universalApk false\n {12}include\(\*oxyApkAbis\)\n {8}\}\n {4}\}\n/,
  );
  assert.match(out, /def oxyReleaseAbis = \['arm64-v8a', 'armeabi-v7a'\]/);
  // The ABIs are resolved before `android {`, at the top level of the script.
  assert.ok(out.indexOf('def oxyApkAbis') < out.indexOf('android {'));
  assert.equal(out.match(/^android \{$/gm).length, 1);
  // Nothing else in the file moves.
  assert.ok(out.endsWith(TEMPLATE.slice(TEMPLATE.indexOf('android {') + 'android {'.length)));
  assert.ok(out.startsWith(TEMPLATE.slice(0, TEMPLATE.indexOf('android {'))));
});

test('a build that compiles none of the release ABIs splits to the ABIs it compiles', () => {
  // `expo run:android` on an x86_64 emulator passes -PreactNativeArchitectures=x86_64.
  const out = applyAbiSplits(TEMPLATE);
  assert.match(out, /findProperty\('reactNativeArchitectures'\)/);
  assert.match(out, /def oxyApkAbis = oxyReleaseAbis \?: oxyBuiltAbis/);
  assert.match(out, /\.findAll \{ oxyBuiltAbis\.contains\(it\) \}/);
});

test('applying it twice is harmless (the preset and withOxyUpdates both apply it)', async () => {
  const once = applyAbiSplits(TEMPLATE);
  assert.equal(applyAbiSplits(once), once);

  const config = withOxyAbiSplits(
    withOxyUpdates(
      { name: 'app', slug: 'app', version: '1.0.0', _internal: { projectRoot: '/app' } },
      { clientId: 'oxy_dk_test', codeSigning: false },
    ),
  );
  const out = await runAppBuildGradleMods(config, TEMPLATE);
  assert.equal(out, once);
  assert.equal(out.match(/splits \{/g).length, 1);
});

test('withOxyUpdates alone splits the APKs (apps that skip the main preset plugin)', async () => {
  const config = withOxyUpdates(
    { name: 'app', slug: 'app', version: '1.0.0', _internal: { projectRoot: '/app' } },
    { clientId: 'oxy_dk_test', codeSigning: false },
  );
  assert.equal(await runAppBuildGradleMods(config, TEMPLATE), applyAbiSplits(TEMPLATE));
});

test('a splits block from elsewhere, or a changed template, is refused', async () => {
  const handSplit = TEMPLATE.replace(
    'android {\n',
    'android {\n    splits {\n        abi {\n            enable true\n        }\n    }\n',
  );
  assert.throws(() => applyAbiSplits(handSplit), /already has a `splits \{\}` block/);
  assert.throws(
    () => applyAbiSplits(TEMPLATE.replace('android {', 'android{')),
    /top-level `android \{` block/,
  );
  await assert.rejects(
    runAppBuildGradleMods(withOxyAbiSplits({ name: 'app' }), TEMPLATE, 'kt'),
    /not Groovy/,
  );
});
