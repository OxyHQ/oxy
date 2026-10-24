const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const withOxyAppPreset = require('../plugin/withOxyAppPreset');

/** A throwaway app whose node_modules links the real `@oxy.so/services` of this workspace. */
function fakeApp() {
  const root = mkdtempSync(join(tmpdir(), 'oxy-preset-app-'));
  mkdirSync(join(root, 'node_modules', '@oxy.so'), { recursive: true });
  symlinkSync(
    resolve(__dirname, '../../services'),
    join(root, 'node_modules', '@oxy.so', 'services'),
    'dir',
  );
  return root;
}

/** Run the Android manifest mods the preset registered, over `manifest`. */
async function runManifestMods(config, manifest) {
  const mod = config.mods?.android?.manifest;
  assert.equal(typeof mod, 'function', 'the preset registers an Android manifest mod');
  const result = await mod({
    ...config,
    modResults: { manifest },
    modRequest: {
      platform: 'android',
      modName: 'manifest',
      projectRoot: config._internal.projectRoot,
    },
  });
  return result.modResults.manifest;
}

test('every Oxy app declares and requests both signature permissions, and never a shared UID', async () => {
  const root = fakeApp();
  try {
    const config = withOxyAppPreset(
      { name: 'app', _internal: { projectRoot: root } },
      { ios: false, android: false },
    );
    const manifest = await runManifestMods(config, {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      application: [{}],
    });

    assert.equal(manifest.$['android:sharedUserId'], undefined);
    assert.equal(manifest.$['android:sharedUserMaxSdkVersion'], undefined);
    assert.ok(!JSON.stringify(manifest).includes('sharedUser'));

    for (const name of ['so.oxy.permission.IDENTITY', 'so.oxy.permission.DEVICE_SESSION']) {
      assert.deepEqual(
        manifest.permission
          .filter((p) => p.$['android:name'] === name)
          .map((p) => p.$['android:protectionLevel']),
        ['signature'],
        `${name} is declared once, at signature level`,
      );
      assert.equal(
        manifest['uses-permission'].filter((p) => p.$['android:name'] === name).length,
        1,
        `${name} is requested`,
      );
    }
    const authorities = manifest.queries[0].provider.map((p) => p.$['android:authorities']);
    for (const authority of [
      'so.oxy.commons.identity',
      'so.oxy.commons.dev.identity',
      'so.oxy.commons.devicesession',
      'so.oxy.commons.dev.devicesession',
      'so.oxy.accounts.devicesession',
      'so.oxy.accounts.dev.devicesession',
    ]) {
      assert.ok(authorities.includes(authority), `<queries> has ${authority}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the removed sharedUserId and sharedIdentityReader options throw', () => {
  const config = { name: 'app', _internal: { projectRoot: join(tmpdir(), 'no-such-app') } };
  assert.throws(
    () => withOxyAppPreset(config, { sharedUserId: 'so.oxy.shared' }),
    /`sharedUserId` option was removed/,
  );
  assert.throws(
    () => withOxyAppPreset(config, { sharedUserId: false }),
    /`sharedUserId` option was removed/,
  );
  assert.throws(
    () => withOxyAppPreset(config, { sharedIdentityReader: false }),
    /`sharedIdentityReader` option was removed/,
  );
});

test('the preset no longer ships a withSharedUserId plugin', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.exports['./plugin/withSharedUserId'], undefined);
  assert.throws(() => require('../plugin/withSharedUserId'), /Cannot find module/);
});

/** Give the fake app a `react-native-webgpu` whose config plugin marks the config. */
function installFakeWebGPU(root) {
  const dir = join(root, 'node_modules', 'react-native-webgpu');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'react-native-webgpu', version: '0.13.0' }),
  );
  writeFileSync(
    join(dir, 'app.plugin.js'),
    'module.exports = (config) => ({ ...config, webgpuPluginApplied: true });\n',
  );
}

test('react-native-webgpu is opt-in: applied with `webgpu: true`, never by default', () => {
  const root = fakeApp();
  try {
    installFakeWebGPU(root);
    const base = { name: 'app', _internal: { projectRoot: root } };
    const off = withOxyAppPreset(base, { ios: false, android: false });
    assert.equal(off.webgpuPluginApplied, undefined);
    const on = withOxyAppPreset(base, { ios: false, android: false, webgpu: true });
    assert.equal(on.webgpuPluginApplied, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('`webgpu: true` without react-native-webgpu installed says what to install', () => {
  const root = fakeApp();
  try {
    assert.throws(
      () =>
        withOxyAppPreset(
          { name: 'app', _internal: { projectRoot: root } },
          { ios: false, android: false, webgpu: true },
        ),
      /`webgpu: true` needs 'react-native-webgpu' installed in the app/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Noxcturnal is on in development only, and an app can opt out or set it itself', () => {
  const root = fakeApp();
  const saved = process.env.NODE_ENV;
  try {
    const base = { name: 'app', _internal: { projectRoot: root } };
    const flag = (config, options = {}) =>
      withOxyAppPreset(config, { ios: false, android: false, ...options }).experiments
        ?.noxcturnalTransformWorker;

    process.env.NODE_ENV = 'development';
    assert.equal(flag(base), true);
    assert.equal(flag(base, { noxcturnal: false }), undefined);
    assert.equal(flag({ ...base, experiments: { noxcturnalTransformWorker: false } }), false);

    process.env.NODE_ENV = 'production';
    assert.equal(flag(base), false);
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

const SDK58_BUILD_GRADLE = readFileSync(
  resolve(__dirname, '../../services/__tests__/plugins/fixtures/expo-58-app-build.gradle'),
  'utf8',
);

/** Run the app/build.gradle mods the preset registered, over `contents`. */
async function runAppBuildGradleMods(config, contents) {
  const mod = config.mods?.android?.appBuildGradle;
  assert.equal(typeof mod, 'function', 'the preset registers an app/build.gradle mod');
  const result = await mod({
    ...config,
    modResults: { contents, language: 'groovy' },
    modRequest: {
      platform: 'android',
      modName: 'appBuildGradle',
      projectRoot: config._internal.projectRoot,
    },
  });
  return result.modResults.contents;
}

test('the preset signs every release with the ecosystem key and fails one without it', async () => {
  const root = fakeApp();
  try {
    const config = withOxyAppPreset(
      { name: 'app', _internal: { projectRoot: root } },
      { ios: false, android: false },
    );
    const gradle = await runAppBuildGradleMods(config, SDK58_BUILD_GRADLE);
    const releaseBuildType = gradle.slice(
      gradle.indexOf('release {', gradle.indexOf('buildTypes {')),
    );
    assert.match(releaseBuildType, /^release \{[\s\S]*?signingConfig signingConfigs\.release\n/);
    assert.match(gradle, /tasks\.register\('oxyVerifyReleaseSigning'\)/);
    assert.match(
      gradle,
      /def expected = 'b8ab3746466ce4569d7a6a0ffa1eed91bc375174d503613987ca09cb33d6a58d'/,
    );
    assert.ok(gradle.includes('proguard-android-optimize.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('on Expo SDK 56/57 the preset swaps in the R8 -optimize ProGuard file', async () => {
  const root = fakeApp();
  try {
    const config = withOxyAppPreset(
      { name: 'app', _internal: { projectRoot: root } },
      { ios: false, android: false },
    );
    const sdk57 = SDK58_BUILD_GRADLE.replace(
      'getDefaultProguardFile("proguard-android-optimize.txt")',
      'getDefaultProguardFile("proguard-android.txt")',
    );
    const gradle = await runAppBuildGradleMods(config, sdk57);
    assert.ok(gradle.includes('getDefaultProguardFile("proguard-android-optimize.txt")'));
    assert.ok(!gradle.includes('getDefaultProguardFile("proguard-android.txt")'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Services without release signing (older than 13.4.0) is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'oxy-preset-old-services-'));
  try {
    const plugins = join(root, 'node_modules', '@oxy.so', 'services', 'plugins');
    mkdirSync(plugins, { recursive: true });
    writeFileSync(
      join(root, 'node_modules', '@oxy.so', 'services', 'package.json'),
      JSON.stringify({ name: '@oxy.so/services', version: '13.3.0' }),
    );
    writeFileSync(join(plugins, 'withOxySharedPermissions.js'), 'module.exports = (c) => c;\n');
    assert.throws(
      () =>
        withOxyAppPreset(
          { name: 'app', _internal: { projectRoot: root } },
          { ios: false, android: false },
        ),
      /needs '@oxy\.so\/services' 13\.4\.0 or later/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin/withOxyAndroidRelease is gone and says what replaced it', () => {
  const withOxyAndroidRelease = require('../plugin/withOxyAndroidRelease');
  assert.throws(
    () => withOxyAndroidRelease({ name: 'app' }),
    /removed in 5\.0\.0\. Delete it from the app config: release signing is applied by @oxy\.so\/services\/plugins\/withOxySharedPermissions/,
  );
});
