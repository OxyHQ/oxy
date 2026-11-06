/**
 * The iOS keychain probe (docs/identity/ios-keychain-access-groups.md): its
 * answer crossed the native boundary, so only a `<prefix>.<group>` string is a
 * group; a thrown probe is `unavailable` and asked again, never cached.
 */
function mockNative(native: unknown): void {
  jest.doMock('expo-modules-core', () => ({ requireOptionalNativeModule: () => native }), {
    virtual: true,
  });
}

async function probe() {
  const mod = await import('../platform/crypto.native');
  return mod.loadKeychainDefaultAccessGroup();
}

describe('loadKeychainDefaultAccessGroup (native)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('a native module without the probe is unsupported', async () => {
    mockNative({ describe: async () => null });
    await expect(probe()).resolves.toEqual({ state: 'unsupported' });
    jest.resetModules();
    mockNative(null);
    await expect(probe()).resolves.toEqual({ state: 'unsupported' });
  });

  test('passes a team-prefixed group through, and remembers it', async () => {
    const keychainDefaultAccessGroup = jest.fn(async () => 'ABCDE12345.so.oxy.identity');
    mockNative({ keychainDefaultAccessGroup });
    const mod = await import('../platform/crypto.native');
    await expect(mod.loadKeychainDefaultAccessGroup()).resolves.toEqual({
      state: 'resolved',
      accessGroup: 'ABCDE12345.so.oxy.identity',
    });
    await mod.loadKeychainDefaultAccessGroup();
    expect(keychainDefaultAccessGroup).toHaveBeenCalledTimes(1);
  });

  test('a throw is unavailable and asked again; junk is unavailable', async () => {
    let locked = true;
    mockNative({
      keychainDefaultAccessGroup: async () => {
        if (locked) throw new Error('errSecInteractionNotAllowed');
        return 'ABCDE12345.group.so.oxy.shared';
      },
    });
    const mod = await import('../platform/crypto.native');
    expect((await mod.loadKeychainDefaultAccessGroup()).state).toBe('unavailable');
    locked = false;
    expect((await mod.loadKeychainDefaultAccessGroup()).state).toBe('resolved');
    for (const junk of [42, 'nodot', '.leading', { group: 'x' }]) {
      jest.resetModules();
      mockNative({ keychainDefaultAccessGroup: async () => junk });
      expect((await probe()).state).toBe('unavailable');
    }
  });

  test('the web / Node variant is unsupported', async () => {
    const mod = await import('../platform/crypto');
    await expect(mod.loadKeychainDefaultAccessGroup()).resolves.toEqual({ state: 'unsupported' });
  });
});
