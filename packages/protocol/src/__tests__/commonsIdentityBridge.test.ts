/**
 * The Commons identity bridge narrows every native answer to its exact shape.
 *
 * What `OxyIdentity` returns crossed a process boundary (a ContentProvider call
 * into Commons), so a partial or malformed answer must read as "Commons could
 * not help" (`null`), never as a half-filled value a caller then signs in with.
 */

const PUBLIC_KEY = `04${'ab'.repeat(64)}`;

function mockNative(native: unknown): void {
  jest.doMock('expo-modules-core', () => ({ requireOptionalNativeModule: () => native }), {
    virtual: true,
  });
}

async function loadBridge() {
  const mod = await import('../platform/crypto.native');
  return mod.loadCommonsIdentityBridge();
}

describe('loadCommonsIdentityBridge (native)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('null when the module is not linked', async () => {
    mockNative(null);
    await expect(loadBridge()).resolves.toBeNull();
  });

  test('null when the module predates the Commons methods', async () => {
    mockNative({ getShared: async () => null });
    await expect(loadBridge()).resolves.toBeNull();
  });

  test('passes well-formed answers through', async () => {
    const calls: unknown[][] = [];
    mockNative({
      describe: async () => ({ v: 2, publicKey: PUBLIC_KEY }),
      proveIdentity: async (challenge: string) => {
        calls.push(['proveIdentity', challenge]);
        return { publicKey: PUBLIC_KEY, signature: '3044aa', timestamp: 1_700_000_000_000 };
      },
      deriveScopedSeed: async (info: string) => {
        calls.push(['deriveScopedSeed', info]);
        return 'cd'.repeat(32);
      },
      signSocialReceive: async (index: number, digest: string) => {
        calls.push(['signSocialReceive', index, digest]);
        return { signature: '3045bb', publicKey: `02${'ef'.repeat(32)}` };
      },
    });
    const bridge = await loadBridge();
    expect(bridge).not.toBeNull();
    await expect(bridge?.describe()).resolves.toEqual({ v: 2, publicKey: PUBLIC_KEY });
    await expect(bridge?.proveIdentity('00'.repeat(32))).resolves.toEqual({
      publicKey: PUBLIC_KEY,
      signature: '3044aa',
      timestamp: 1_700_000_000_000,
    });
    await expect(bridge?.deriveScopedSeed('peable/faircoin/v1')).resolves.toBe('cd'.repeat(32));
    await expect(bridge?.signSocialReceive(3, '11'.repeat(32))).resolves.toEqual({
      signature: '3045bb',
      publicKey: `02${'ef'.repeat(32)}`,
    });
    expect(calls).toEqual([
      ['proveIdentity', '00'.repeat(32)],
      ['deriveScopedSeed', 'peable/faircoin/v1'],
      ['signSocialReceive', 3, '11'.repeat(32)],
    ]);
  });

  test('malformed or partial answers, and rejections, are null', async () => {
    mockNative({
      describe: async () => ({ v: 2, publicKey: 'not-hex' }),
      proveIdentity: async () => ({ publicKey: PUBLIC_KEY, signature: '3044aa' }),
      deriveScopedSeed: async () => 'cd'.repeat(16),
      signSocialReceive: async () => {
        throw new Error('refused');
      },
    });
    const bridge = await loadBridge();
    await expect(bridge?.describe()).resolves.toBeNull();
    await expect(bridge?.proveIdentity('00'.repeat(32))).resolves.toBeNull();
    await expect(bridge?.deriveScopedSeed('x')).resolves.toBeNull();
    await expect(bridge?.signSocialReceive(0, '11'.repeat(32))).resolves.toBeNull();
  });

  test('the web / Node variant never has a bridge', async () => {
    const mod = await import('../platform/crypto');
    await expect(mod.loadCommonsIdentityBridge()).resolves.toBeNull();
  });
});

describe('tweakAddSecp256k1PrivateKey', () => {
  test('adds modulo the curve order and rejects invalid children', async () => {
    const { tweakAddSecp256k1PrivateKey } = await import('../secp256k1');
    expect(tweakAddSecp256k1PrivateKey('01', `${'0'.repeat(63)}2`)).toBe(`${'0'.repeat(63)}3`);
    const nMinusOne = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140';
    // (n - 1) + 2 wraps to 1.
    expect(tweakAddSecp256k1PrivateKey(nMinusOne, `${'0'.repeat(63)}2`)).toBe(`${'0'.repeat(63)}1`);
    // (n - 1) + 1 is zero: an invalid child.
    expect(() => tweakAddSecp256k1PrivateKey(nMinusOne, `${'0'.repeat(63)}1`)).toThrow('zero');
    // A tweak at or above n is invalid.
    expect(() =>
      tweakAddSecp256k1PrivateKey(
        '01',
        'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
      ),
    ).toThrow('curve order');
    expect(() => tweakAddSecp256k1PrivateKey('01', 'zz')).toThrow();
  });
});
