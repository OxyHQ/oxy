/**
 * Accounts' Android manifest wiring (OxyHQ/oxy#1388): no shared UID in any
 * variant, the shared permissions every Oxy app declares, and the
 * device-session host.
 */
type PluginEntry = string | [string, unknown] | ((config: unknown) => unknown);

function pluginNames(variant?: string): string[] {
  const previous = process.env.APP_VARIANT;
  if (variant === undefined) delete process.env.APP_VARIANT;
  else process.env.APP_VARIANT = variant;
  try {
    let names: string[] = [];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const appConfig = require('../../app.config.js') as { expo: { plugins: PluginEntry[] } };
      names = appConfig.expo.plugins
        .map((entry) => (typeof entry === 'string' ? entry : Array.isArray(entry) ? entry[0] : null))
        .filter((name): name is string => typeof name === 'string');
    });
    return names;
  } finally {
    if (previous === undefined) delete process.env.APP_VARIANT;
    else process.env.APP_VARIANT = previous;
  }
}

describe.each([undefined, 'development'])('Accounts app config (APP_VARIANT=%s)', (variant) => {
  test('never joins a shared UID', () => {
    const names = pluginNames(variant);
    expect(names.length).toBeGreaterThan(3);
    expect(names.some((name) => /sharedUserId/i.test(name))).toBe(false);
  });

  test('declares the shared permissions and hosts the device session', () => {
    expect(pluginNames(variant)).toEqual(
      expect.arrayContaining([
        '@oxy.so/services/plugins/withOxySharedPermissions',
        '@oxy.so/services/plugins/withSharedDeviceSessionProvider',
      ]),
    );
    expect(pluginNames(variant)).not.toContain('@oxy.so/services/plugins/withSharedIdentityReader');
  });
});
