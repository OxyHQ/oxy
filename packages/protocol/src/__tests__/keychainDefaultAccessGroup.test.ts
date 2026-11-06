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

describe('loadKeychainApplicationAccessGroup (native, ADR 0062 D6)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  const load = async (prefix = 'ABCDE12345.') =>
    (await import('../platform/crypto.native')).loadKeychainApplicationAccessGroup(prefix);

  test('a native module without the probe, or a refused group, is unsupported', async () => {
    mockNative({ keychainDefaultAccessGroup: async () => 'ABCDE12345.group.so.oxy.shared' });
    await expect(load()).resolves.toEqual({ state: 'unsupported' });
    jest.resetModules();
    mockNative({ keychainApplicationAccessGroup: async () => null });
    await expect(load()).resolves.toEqual({ state: 'unsupported' });
  });

  test('passes this team’s group through with the prefix, and remembers it', async () => {
    const keychainApplicationAccessGroup = jest.fn(async () => 'ABCDE12345.so.oxy.mention');
    mockNative({ keychainApplicationAccessGroup });
    const mod = await import('../platform/crypto.native');
    await expect(mod.loadKeychainApplicationAccessGroup('ABCDE12345.')).resolves.toEqual({
      state: 'resolved',
      accessGroup: 'ABCDE12345.so.oxy.mention',
    });
    await mod.loadKeychainApplicationAccessGroup('ABCDE12345.');
    expect(keychainApplicationAccessGroup).toHaveBeenCalledTimes(1);
    expect(keychainApplicationAccessGroup).toHaveBeenCalledWith('ABCDE12345.');
  });

  test('a throw is unavailable and asked again; a bad prefix is never sent', async () => {
    let locked = true;
    const keychainApplicationAccessGroup = jest.fn(async () => {
      if (locked) throw new Error('errSecInteractionNotAllowed');
      return 'ABCDE12345.so.oxy.mention';
    });
    mockNative({ keychainApplicationAccessGroup });
    const mod = await import('../platform/crypto.native');
    expect((await mod.loadKeychainApplicationAccessGroup('ABCDE12345.')).state).toBe('unavailable');
    locked = false;
    expect((await mod.loadKeychainApplicationAccessGroup('ABCDE12345.')).state).toBe('resolved');
    jest.resetModules();
    mockNative({ keychainApplicationAccessGroup });
    keychainApplicationAccessGroup.mockClear();
    for (const prefix of ['', 'ABCDE12345', 'A.B.']) {
      expect((await load(prefix)).state).toBe('unavailable');
    }
    expect(keychainApplicationAccessGroup).not.toHaveBeenCalled();
  });

  test('another team’s group or junk is unsupported: the earlier placement, never no storage', async () => {
    for (const junk of [42, 'XYZ.so.oxy.mention', 'ABCDE12345.', { group: 'x' }]) {
      jest.resetModules();
      mockNative({ keychainApplicationAccessGroup: async () => junk });
      expect((await load()).state).toBe('unsupported');
    }
  });

  test('the web / Node variant is unsupported', async () => {
    const mod = await import('../platform/crypto');
    await expect(mod.loadKeychainApplicationAccessGroup('ABCDE12345.')).resolves.toEqual({
      state: 'unsupported',
    });
  });
});
