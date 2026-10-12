const assert = require('node:assert/strict');
const { test } = require('node:test');

const oxyBabelPreset = require('../babel');

const api = { cache() {} };
const workletsPlugin = (config) => config.plugins[config.plugins.length - 1];

test('the one-line config is unchanged: worklets plugin last, preset-expo untouched', () => {
  const config = oxyBabelPreset(api);
  assert.deepEqual(config.presets, [['babel-preset-expo', { unstable_transformImportMeta: true }]]);
  assert.equal(workletsPlugin(config), 'react-native-worklets/plugin');
  assert.deepEqual(oxyBabelPreset.createOxyBabelConfig()(api), config);
});

test('workletsBundleMode passes Bundle Mode and import forwarding to the one worklets plugin', () => {
  const config = oxyBabelPreset.createOxyBabelConfig({
    workletsBundleMode: {
      importForwarding: { relativePaths: ['components/map/engine/city3d'], moduleNames: ['pbf'] },
    },
  })(api);
  assert.deepEqual(workletsPlugin(config), [
    'react-native-worklets/plugin',
    {
      bundleMode: true,
      importForwarding: { relativePaths: ['components/map/engine/city3d'], moduleNames: ['pbf'] },
    },
  ]);
  // babel-preset-expo would otherwise add a second worklets plugin without the options.
  assert.deepEqual(config.presets, [
    ['babel-preset-expo', { unstable_transformImportMeta: true, worklets: false }],
  ]);
  assert.equal(config.plugins.filter((p) => JSON.stringify(p).includes('worklets')).length, 1);
});

test('workletsBundleMode: true needs no forwarding list', () => {
  const config = oxyBabelPreset.createOxyBabelConfig({ workletsBundleMode: true })(api);
  assert.deepEqual(workletsPlugin(config), ['react-native-worklets/plugin', { bundleMode: true }]);
});

test('a misspelt option fails loudly instead of being ignored', () => {
  const create = oxyBabelPreset.createOxyBabelConfig;
  assert.throws(
    () => create({ workletsBundleMode: { importFowarding: {} } }),
    /Unknown `workletsBundleMode.importFowarding`/,
  );
  assert.throws(
    () => create({ workletsBundleMode: { importForwarding: { relativePath: ['a'] } } }),
    /Unknown `importForwarding.relativePath`/,
  );
  assert.throws(
    () => create({ workletsBundleMode: { importForwarding: { moduleNames: 'pbf' } } }),
    /is a list of strings/,
  );
  assert.throws(() => create({ workletsBundleMode: 'yes' }), /is a boolean or an object/);
});
