const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = function withOwnedIdentityObserver(config) {
  if (config.android?.package !== 'so.oxy.commons.dev') throw new Error('Owned fixture package required');
  const manifest = withAndroidManifest(config, (mod) => {
    mod.modResults.manifest.instrumentation = [{ $: {
      'android:name': 'so.oxy.fixture.identity.ObserverInstrumentation',
      'android:targetPackage': 'so.oxy.commons.dev',
      'android:functionalTest': 'true',
    } }];
    return mod;
  });
  return withDangerousMod(manifest, ['android', async (mod) => {
    const target = path.join(mod.modRequest.platformProjectRoot, 'app/src/debug/java/so/oxy/fixture/identity');
    await fs.mkdir(target, { recursive: true });
    await fs.copyFile(path.join(mod.modRequest.projectRoot, 'acceptance/ObserverInstrumentation.kt'), path.join(target, 'ObserverInstrumentation.kt'));
    return mod;
  }]);
};
