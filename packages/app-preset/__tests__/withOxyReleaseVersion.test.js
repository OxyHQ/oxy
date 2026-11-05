const { test } = require('node:test');
const assert = require('node:assert/strict');

const withOxyReleaseVersion = require('../plugin/withOxyReleaseVersion');
const { releaseBuildNumber } = withOxyReleaseVersion;

test('the build number is major·1e6 + minor·1e3 + patch', () => {
  assert.equal(releaseBuildNumber('0.1.0'), 1_000);
  assert.equal(releaseBuildNumber('1.0.0'), 1_000_000);
  assert.equal(releaseBuildNumber('1.2.3'), 1_002_003);
  assert.equal(releaseBuildNumber('2099.999.999'), 2_099_999_999);
});

test('every later version gets a strictly higher build number', () => {
  const ordered = ['0.0.1', '0.0.999', '0.1.0', '0.999.999', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
  const numbers = ordered.map(releaseBuildNumber);
  for (let i = 1; i < numbers.length; i++) {
    assert.ok(numbers[i] > numbers[i - 1], `${ordered[i]} > ${ordered[i - 1]}`);
  }
});

test('Android versionCode and iOS buildNumber both follow the version', () => {
  const config = withOxyReleaseVersion({
    name: 'app',
    version: '1.4.2',
    android: { package: 'so.oxy.app' },
    ios: { bundleIdentifier: 'so.oxy.app' },
  });
  assert.equal(config.android.versionCode, 1_004_002);
  assert.equal(config.android.package, 'so.oxy.app');
  assert.equal(config.ios.buildNumber, '1004002');
  assert.equal(config.ios.bundleIdentifier, 'so.oxy.app');
});

test('applying it twice is harmless (the preset and withOxyUpdates both apply it)', () => {
  const once = withOxyReleaseVersion({ name: 'app', version: '1.4.2' });
  assert.deepEqual(withOxyReleaseVersion(once), once);
});

test('a hand-kept build number is refused, not silently overridden', () => {
  assert.throws(
    () => withOxyReleaseVersion({ name: 'app', version: '1.0.0', android: { versionCode: 7 } }),
    /Remove `android.versionCode`/,
  );
  assert.throws(
    () => withOxyReleaseVersion({ name: 'app', version: '1.0.0', ios: { buildNumber: '7' } }),
    /Remove `ios.buildNumber`/,
  );
});

test('a version that is not MAJOR.MINOR.PATCH, or out of range, is refused', () => {
  for (const version of ['1.0', '1.0.0-beta.1', 'v1.0.0', '', '1.0.0.0']) {
    assert.throws(() => releaseBuildNumber(version), /MAJOR\.MINOR\.PATCH/, version);
  }
  for (const version of ['2100.0.0', '1.1000.0', '1.0.1000']) {
    assert.throws(() => releaseBuildNumber(version), /out of range/, version);
  }
  assert.throws(() => withOxyReleaseVersion({ name: 'app' }), /needs a `version`/);
});
