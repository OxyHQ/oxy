/**
 * Every Oxy app declares AND requests both signature permissions, sees every
 * host authority, and never declares a shared UID.
 */
jest.mock('@expo/config-plugins', () => ({
  withAndroidManifest: (config: unknown, action: (c: unknown) => unknown) => action(config),
}));

const withOxySharedPermissions = require('../../plugins/withOxySharedPermissions') as ((
  config: unknown,
) => {
  modResults: { manifest: Manifest };
}) & { HOST_AUTHORITIES: string[] };
const withSharedDeviceSessionProvider =
  require('../../plugins/withSharedDeviceSessionProvider') as (config: unknown) => {
    modResults: { manifest: Manifest };
  };

interface Node {
  $: Record<string, string>;
}
interface Manifest {
  $?: Record<string, string>;
  permission?: Node[];
  'uses-permission'?: Node[];
  queries?: { provider?: Node[] }[];
  application?: { provider?: Node[] }[];
}

const run = (manifest: Manifest) =>
  withOxySharedPermissions({ modResults: { manifest } }).modResults.manifest;

describe('withOxySharedPermissions', () => {
  test('declares both permissions at signature level and requests both', () => {
    const manifest = run({ application: [{}] });
    expect(manifest.permission).toEqual([
      {
        $: { 'android:name': 'so.oxy.permission.IDENTITY', 'android:protectionLevel': 'signature' },
      },
      {
        $: {
          'android:name': 'so.oxy.permission.DEVICE_SESSION',
          'android:protectionLevel': 'signature',
        },
      },
    ]);
    expect(manifest['uses-permission']).toEqual([
      { $: { 'android:name': 'so.oxy.permission.IDENTITY' } },
      { $: { 'android:name': 'so.oxy.permission.DEVICE_SESSION' } },
    ]);
  });

  test('adds <queries> for every Commons and Accounts host authority', () => {
    const manifest = run({});
    expect(manifest.queries?.[0].provider?.map((p) => p.$['android:authorities'])).toEqual([
      'so.oxy.commons.identity',
      'so.oxy.commons.dev.identity',
      'so.oxy.commons.devicesession',
      'so.oxy.commons.dev.devicesession',
      'so.oxy.accounts.devicesession',
      'so.oxy.accounts.dev.devicesession',
    ]);
  });

  test('is idempotent and keeps what the app already declared', () => {
    const existing: Manifest = {
      'uses-permission': [{ $: { 'android:name': 'android.permission.CAMERA' } }],
      queries: [{ provider: [{ $: { 'android:authorities': 'so.oxy.commons.identity' } }] }],
    };
    const twice = run(run(existing));
    expect(twice.permission).toHaveLength(2);
    expect(twice['uses-permission']?.map((p) => p.$['android:name'])).toEqual([
      'android.permission.CAMERA',
      'so.oxy.permission.IDENTITY',
      'so.oxy.permission.DEVICE_SESSION',
    ]);
    expect(twice.queries?.[0].provider).toHaveLength(
      withOxySharedPermissions.HOST_AUTHORITIES.length,
    );
  });

  test('never writes a shared user id', () => {
    const manifest = run({ $: {} });
    expect(JSON.stringify(manifest)).not.toContain('sharedUser');
  });
});

describe('withSharedDeviceSessionProvider', () => {
  test('hosts the provider behind DEVICE_SESSION and declares no permission itself', () => {
    const manifest = withSharedDeviceSessionProvider({
      modResults: { manifest: { application: [{}] } },
    }).modResults.manifest;
    expect(manifest.application?.[0].provider).toEqual([
      {
        $: {
          'android:name': 'so.oxy.devicesession.OxyDeviceSessionProvider',
          'android:authorities': '${applicationId}.devicesession',
          'android:exported': 'true',
          'android:permission': 'so.oxy.permission.DEVICE_SESSION',
        },
      },
    ]);
    expect(manifest.permission).toBeUndefined();
    expect(manifest['uses-permission']).toBeUndefined();
  });

  test('refuses a manifest without <application>', () => {
    expect(() => withSharedDeviceSessionProvider({ modResults: { manifest: {} } })).toThrow(
      'no <application>',
    );
  });
});
