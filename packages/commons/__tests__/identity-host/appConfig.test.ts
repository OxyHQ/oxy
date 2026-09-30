/**
 * Commons' Android manifest wiring (OxyHQ/oxy#1388): no shared UID; the shared
 * permissions every Oxy app declares; and the two providers Commons hosts, the
 * identity host and the device-session host.
 */
type PluginEntry = string | [string, unknown] | ((config: unknown) => unknown);

function pluginNames(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const appConfig = require('../../app.config.js') as { expo: { plugins: PluginEntry[] } };
  return appConfig.expo.plugins
    .map((entry) => (typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : null))
    .filter((name): name is string => typeof name === 'string');
}

describe('Commons app config', () => {
  test('never joins a shared UID', () => {
    const names = pluginNames();
    expect(names.length).toBeGreaterThan(5);
    expect(names.some((name) => /sharedUserId/i.test(name))).toBe(false);
  });

  test('declares the shared permissions and hosts both providers', () => {
    expect(pluginNames()).toEqual(
      expect.arrayContaining([
        '@oxy.so/services/plugins/withOxySharedPermissions',
        './plugins/withOxyIdentityHost',
        '@oxy.so/services/plugins/withSharedDeviceSessionProvider',
      ]),
    );
  });

  test('no longer hosts the raw-key identity provider', () => {
    expect(pluginNames()).not.toContain('@oxy.so/services/plugins/withSharedIdentityProvider');
  });
});
