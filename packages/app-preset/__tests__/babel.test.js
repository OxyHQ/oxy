const assert = require('node:assert/strict');
const { test } = require('node:test');

const oxyBabelPreset = require('../babel');

const api = { cache: { using: (read) => read() } };
const workletsPlugin = (config) => config.plugins[config.plugins.length - 1];

/** Evaluate `create` with NODE_ENV set, as the Expo CLI sets it before Babel runs. */
function withNodeEnv(nodeEnv, create) {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try {
    return create();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

test('development is the bare Expo preset, so an explicit Noxcturnal opt-in can run; production adds the build id', () => {
  const development = withNodeEnv('development', () => oxyBabelPreset(api));
  assert.deepEqual(development, { presets: ['babel-preset-expo'], plugins: [] });
  assert.deepEqual(
    withNodeEnv('development', () => oxyBabelPreset.createOxyBabelConfig()(api)),
    development,
  );

  const production = withNodeEnv('production', () => oxyBabelPreset(api));
  assert.deepEqual(production.presets, ['babel-preset-expo']);
  assert.deepEqual(production.plugins, [require.resolve('../babel/inline-oxy-build-id')]);
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
  assert.deepEqual(config.presets, [['babel-preset-expo', { worklets: false }]]);
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

test('default Expo Babel preserves derived private fields and methods (Nilo observer regression)', () => {
  const { createRequire } = require('node:module');
  const { runInNewContext } = require('node:vm');
  const expoRequire = createRequire(require.resolve('expo/package.json'));
  const babel = expoRequire('@babel/core');
  // Noxcturnal 0.1.11 shadows the lowered #result key with a constructor local
  // for this shape; the private method is necessary to reproduce the collision.
  const source = `class Base {}
    var Observer = class extends Base {
      #result;
      constructor() { super(); this.#result = []; }
      #read() { return this.#result; }
      read() { return this.#read(); }
    };
    globalThis.observed = new Observer().read();`;
  for (const platform of ['web', 'android', 'ios']) {
    const config = withNodeEnv('development', () => oxyBabelPreset(api));
    const result = babel.transformSync(source, {
      ...config,
      presets: config.presets.map((preset) => [
        expoRequire.resolve(preset),
        { enableBabelRuntime: false },
      ]),
      babelrc: false,
      configFile: false,
      filename: '/tmp/observer-fixture.js',
      caller: { name: 'metro', platform, isDev: true, engine: 'hermes' },
    });
    const context = {};
    runInNewContext(result.code, context);
    assert.ok(Array.isArray(context.observed), platform);
    assert.equal(context.observed.length, 0, platform);
  }
});
