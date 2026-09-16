const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const withOxyBuildProperties = require('../plugin/withOxyBuildProperties');

/** A throwaway app directory whose node_modules holds a fake `expo-build-properties`. */
function fakeApp() {
  const root = mkdtempSync(join(tmpdir(), 'oxy-preset-app-'));
  const pkg = join(root, 'node_modules', 'expo-build-properties');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'expo-build-properties', main: 'index.js' }));
  writeFileSync(
    join(pkg, 'index.js'),
    'module.exports = function withBuildProperties(config, props) { return { ...config, appliedBuildProperties: props }; };',
  );
  return root;
}

test('resolves expo-build-properties from the app project root, where the peer is installed', () => {
  const root = fakeApp();
  try {
    const result = withOxyBuildProperties({ name: 'app', _internal: { projectRoot: root } });
    assert.equal(result.name, 'app');
    assert.deepEqual(result.appliedBuildProperties.ios, withOxyBuildProperties.DEFAULTS.ios);
    assert.deepEqual(result.appliedBuildProperties.android, withOxyBuildProperties.DEFAULTS.android);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merges caller overrides over the defaults', () => {
  const root = fakeApp();
  try {
    const result = withOxyBuildProperties(
      { name: 'app', _internal: { projectRoot: root } },
      { ios: { deploymentTarget: '17.0' }, android: false },
    );
    assert.equal(result.appliedBuildProperties.ios.deploymentTarget, '17.0');
    assert.equal(result.appliedBuildProperties.android, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('does nothing — and needs no peer — when both platforms are disabled', () => {
  const config = { name: 'app', _internal: { projectRoot: join(tmpdir(), 'no-such-app') } };
  assert.equal(withOxyBuildProperties(config, { ios: false, android: false }), config);
});
