/**
 * The identity host provider is declared once, behind the shared signature
 * permission, and this plugin never declares or requests that permission itself
 * (`withOxySharedPermissions` in `@oxy.so/services` owns every declaration).
 */
jest.mock(
  'expo/config-plugins',
  () => ({
    withAndroidManifest: (config: unknown, action: (c: unknown) => unknown) => action(config),
  }),
  { virtual: true },
);

const withOxyIdentityHost = require('../../plugins/withOxyIdentityHost') as (config: unknown) => {
  modResults: { manifest: Manifest };
};

interface Manifest {
  permission?: unknown[];
  'uses-permission'?: unknown[];
  application?: { provider?: { $: Record<string, string> }[] }[];
}

function run(manifest: Manifest) {
  return withOxyIdentityHost({ modResults: { manifest } }).modResults.manifest;
}

describe('withOxyIdentityHost', () => {
  test('declares the provider at ${applicationId}.identity behind so.oxy.permission.IDENTITY', () => {
    const manifest = run({ application: [{}] });
    expect(manifest.application?.[0].provider).toEqual([
      {
        $: {
          'android:name': 'so.oxy.commons.identityhost.OxyIdentityHostProvider',
          'android:authorities': '${applicationId}.identity',
          'android:exported': 'true',
          'android:permission': 'so.oxy.permission.IDENTITY',
        },
      },
    ]);
  });

  test('is idempotent', () => {
    const manifest = run(run({ application: [{}] }));
    expect(manifest.application?.[0].provider).toHaveLength(1);
  });

  test('declares and requests no permission of its own', () => {
    const manifest = run({ application: [{}] });
    expect(manifest.permission).toBeUndefined();
    expect(manifest['uses-permission']).toBeUndefined();
  });

  test('fails loudly without an <application>', () => {
    expect(() => run({})).toThrow('no <application>');
  });
});
