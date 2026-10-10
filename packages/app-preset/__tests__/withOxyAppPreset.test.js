const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = require('node:fs');
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
