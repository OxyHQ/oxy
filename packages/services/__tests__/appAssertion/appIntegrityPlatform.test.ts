/**
 * Which proof a build uses (ADR 0045): the web build loads nothing; a native
 * build loads `@expo/app-integrity` lazily, and a binary without its native
 * module (an over-the-air update onto an older build) reads as having none
 * instead of failing to boot.
 */
afterEach(() => {
  jest.resetModules();
  jest.dontMock('@expo/app-integrity');
});

/** The native module as a build for `os` evaluates it. */
function nativePlatform(os: 'ios' | 'android' | 'web') {
  let loaded: typeof import('../../src/ui/appAssertion/appIntegrityPlatform.native') | undefined;
  jest.isolateModules(() => {
    require('react-native').Platform.OS = os;
    loaded = require('../../src/ui/appAssertion/appIntegrityPlatform.native');
  });
  return (loaded as NonNullable<typeof loaded>).appIntegrityPlatform;
}

describe('appIntegrityPlatform', () => {
  it('web proves with the browser Origin and loads nothing', async () => {
    const { appIntegrityPlatform } = require('../../src/ui/appAssertion/appIntegrityPlatform');
    expect(appIntegrityPlatform.platform).toBe('web');
    await expect(appIntegrityPlatform.loadIntegrity()).resolves.toBeNull();
  });

  it.each(['ios', 'android'] as const)('%s loads @expo/app-integrity', async (os) => {
    const integrity = { isSupported: true, generateKeyAsync: jest.fn() };
    jest.doMock('@expo/app-integrity', () => integrity);
    const platform = nativePlatform(os);
    expect(platform.platform).toBe(os);
    await expect(platform.loadIntegrity()).resolves.toMatchObject({ isSupported: true });
  });

  it('a binary without the native module has no integrity, and does not throw', async () => {
    jest.doMock('@expo/app-integrity', () => {
      throw new Error("Cannot find native module 'ExpoAppIntegrity'");
    });
    await expect(nativePlatform('ios').loadIntegrity()).resolves.toBeNull();
  });

  it('react-native-web on a native build proves as web', async () => {
    const platform = nativePlatform('web');
    expect(platform.platform).toBe('web');
    await expect(platform.loadIntegrity()).resolves.toBeNull();
  });
});
