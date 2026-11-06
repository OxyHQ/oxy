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

  test('organization requests go to the organization methods and must echo the account', async () => {
    const ORG = '0123456789abcdef01234567';
    const calls: unknown[][] = [];
    mockNative({
      describe: async () => ({ v: 2, publicKey: PUBLIC_KEY }),
      proveIdentity: async () => null,
      deriveScopedSeed: async () => 'cd'.repeat(32),
      signSocialReceive: async () => ({ signature: '3045bb', publicKey: `02${'ef'.repeat(32)}` }),
      describeOrganization: async (accountId: string) => {
        calls.push(['describeOrganization', accountId]);
        return { v: 3, publicKey: PUBLIC_KEY, accountId };
      },
      deriveOrganizationScopedSeed: async (info: string, accountId: string) => {
        calls.push(['deriveOrganizationScopedSeed', info, accountId]);
        return { seed: 'ee'.repeat(32), accountId };
      },
      signOrganizationSocialReceive: async (index: number, digest: string, accountId: string) => {
        calls.push(['signOrganizationSocialReceive', index, digest, accountId]);
        return { signature: '3046cc', publicKey: `03${'aa'.repeat(32)}`, accountId };
      },
    });
    const bridge = await loadBridge();
    await expect(bridge?.describe(ORG)).resolves.toEqual({
      v: 3,
      publicKey: PUBLIC_KEY,
      accountId: ORG,
    });
    await expect(bridge?.deriveScopedSeed('peable/faircoin/v1', ORG)).resolves.toBe(
      'ee'.repeat(32),
    );
    await expect(bridge?.signSocialReceive(4, '11'.repeat(32), ORG)).resolves.toEqual({
      signature: '3046cc',
      publicKey: `03${'aa'.repeat(32)}`,
    });
    // The personal path is untouched.
    await expect(bridge?.describe()).resolves.toEqual({ v: 2, publicKey: PUBLIC_KEY });
    expect(calls).toEqual([
      ['describeOrganization', ORG],
      ['deriveOrganizationScopedSeed', 'peable/faircoin/v1', ORG],
      ['signOrganizationSocialReceive', 4, '11'.repeat(32), ORG],
    ]);
  });

  test('an organization answer without the echo, or for another account, is null', async () => {
    const ORG = '0123456789abcdef01234567';
    mockNative({
      describe: async () => ({ v: 2, publicKey: PUBLIC_KEY }),
      proveIdentity: async () => null,
      deriveScopedSeed: async () => 'cd'.repeat(32),
      signSocialReceive: async () => null,
      // An old Commons ignored the extra and answered for the personal key.
      describeOrganization: async () => ({ v: 2, publicKey: PUBLIC_KEY }),
      deriveOrganizationScopedSeed: async () => ({ seed: 'ee'.repeat(32), accountId: 'other' }),
      signOrganizationSocialReceive: async () => ({
        signature: '3046cc',
        publicKey: `03${'aa'.repeat(32)}`,
      }),
    });
    const bridge = await loadBridge();
    await expect(bridge?.describe(ORG)).resolves.toBeNull();
    await expect(bridge?.deriveScopedSeed('peable/faircoin/v1', ORG)).resolves.toBeNull();
    await expect(bridge?.signSocialReceive(0, '11'.repeat(32), ORG)).resolves.toBeNull();
  });

  test('a native module without the organization methods answers no organization', async () => {
    mockNative({
      describe: async () => ({ v: 2, publicKey: PUBLIC_KEY }),
      proveIdentity: async () => null,
      deriveScopedSeed: async () => 'cd'.repeat(32),
      signSocialReceive: async () => ({ signature: '3045bb', publicKey: `02${'ef'.repeat(32)}` }),
    });
    const bridge = await loadBridge();
    await expect(bridge?.describe('0123456789abcdef01234567')).resolves.toBeNull();
    await expect(bridge?.deriveScopedSeed('x', '0123456789abcdef01234567')).resolves.toBeNull();
    await expect(
      bridge?.signSocialReceive(0, '11'.repeat(32), '0123456789abcdef01234567'),
    ).resolves.toBeNull();
  });

  describe('retired keys', () => {
    const ORG = '0123456789abcdef01234567';
    const RETIRED = `04${'cd'.repeat(64)}`;
    const OTHER = `04${'ef'.repeat(64)}`;
    const base = {
      describe: async () => ({ v: 4, publicKey: PUBLIC_KEY }),
      proveIdentity: async () => null,
      deriveScopedSeed: async () => 'cd'.repeat(32),
      signSocialReceive: async () => ({ signature: '3045bb', publicKey: `02${'ef'.repeat(32)}` }),
    };

    test('requests carry the key and the scope, and well-formed echoed answers pass', async () => {
      const calls: unknown[][] = [];
      mockNative({
        ...base,
        listRetiredKeys: async (accountId: string | null) => {
          calls.push(['listRetiredKeys', accountId]);
          return accountId === null
            ? { publicKeys: [RETIRED, OTHER, RETIRED] }
            : { publicKeys: [OTHER], accountId };
        },
        deriveRetiredScopedSeed: async (
          info: string,
          publicKey: string,
          accountId: string | null,
        ) => {
          calls.push(['deriveRetiredScopedSeed', info, publicKey, accountId]);
          return accountId === null
            ? { seed: 'aa'.repeat(32), keyPublicKey: publicKey }
            : { seed: 'bb'.repeat(32), keyPublicKey: publicKey, accountId };
        },
        signRetiredSocialReceive: async (
          index: number,
          digest: string,
          publicKey: string,
          accountId: string | null,
        ) => {
          calls.push(['signRetiredSocialReceive', index, digest, publicKey, accountId]);
          return {
            signature: '3046cc',
            publicKey: `03${'aa'.repeat(32)}`,
            keyPublicKey: publicKey,
          };
        },
      });
      const bridge = await loadBridge();
      // De-duplicated, in Commons' order.
      await expect(bridge?.listRetiredKeys()).resolves.toEqual([RETIRED, OTHER]);
      await expect(bridge?.listRetiredKeys(ORG)).resolves.toEqual([OTHER]);
      await expect(bridge?.deriveRetiredScopedSeed('peable/faircoin/v1', RETIRED)).resolves.toBe(
        'aa'.repeat(32),
      );
      await expect(bridge?.deriveRetiredScopedSeed('peable/faircoin/v1', OTHER, ORG)).resolves.toBe(
        'bb'.repeat(32),
      );
      await expect(bridge?.signRetiredSocialReceive(7, '11'.repeat(32), RETIRED)).resolves.toEqual({
        signature: '3046cc',
        publicKey: `03${'aa'.repeat(32)}`,
      });
      expect(calls).toEqual([
        ['listRetiredKeys', null],
        ['listRetiredKeys', ORG],
        ['deriveRetiredScopedSeed', 'peable/faircoin/v1', RETIRED, null],
        ['deriveRetiredScopedSeed', 'peable/faircoin/v1', OTHER, ORG],
        ['signRetiredSocialReceive', 7, '11'.repeat(32), RETIRED, null],
      ]);
    });

    test('an answer without the key echo, or for another key or scope, is null', async () => {
      mockNative({
        ...base,
        // An older Commons ignored keyPublicKey and answered with the CURRENT key.
        deriveRetiredScopedSeed: async (
          _info: string,
          publicKey: string,
          accountId: string | null,
        ) =>
          accountId === null
            ? { seed: 'aa'.repeat(32) }
            : { seed: 'bb'.repeat(32), keyPublicKey: publicKey },
        signRetiredSocialReceive: async (
          _index: number,
          _digest: string,
          _publicKey: string,
          accountId: string | null,
        ) =>
          accountId === null
            ? { signature: '3046cc', publicKey: `03${'aa'.repeat(32)}`, keyPublicKey: OTHER }
            : {
                signature: '3046cc',
                publicKey: `03${'aa'.repeat(32)}`,
                keyPublicKey: RETIRED,
                accountId: 'fedcba9876543210fedcba98',
              },
        // A personal answer for an organization request, and vice versa.
        listRetiredKeys: async (accountId: string | null) =>
          accountId === null
            ? { publicKeys: [RETIRED], accountId: ORG }
            : { publicKeys: [RETIRED] },
      });
      const bridge = await loadBridge();
      await expect(
        bridge?.deriveRetiredScopedSeed('peable/faircoin/v1', RETIRED),
      ).resolves.toBeNull();
      // The key echo is there but the account echo is missing.
      await expect(
        bridge?.deriveRetiredScopedSeed('peable/faircoin/v1', RETIRED, ORG),
      ).resolves.toBeNull();
      await expect(
        bridge?.signRetiredSocialReceive(0, '11'.repeat(32), RETIRED),
      ).resolves.toBeNull();
      await expect(
        bridge?.signRetiredSocialReceive(0, '11'.repeat(32), RETIRED, ORG),
      ).resolves.toBeNull();
      await expect(bridge?.listRetiredKeys()).resolves.toBeNull();
      await expect(bridge?.listRetiredKeys(ORG)).resolves.toBeNull();
    });

    test('a list with a malformed entry is refused whole; an empty list is an answer', async () => {
      const answers: unknown[] = [
        { publicKeys: [RETIRED, `04${'CD'.repeat(64)}`] },
        { publicKeys: [RETIRED, `02${'aa'.repeat(32)}`] },
        { publicKeys: [RETIRED, 7] },
        { publicKeys: RETIRED },
        { publicKeys: [] },
      ];
      mockNative({ ...base, listRetiredKeys: async () => answers.shift() });
      const bridge = await loadBridge();
      await expect(bridge?.listRetiredKeys()).resolves.toBeNull();
      await expect(bridge?.listRetiredKeys()).resolves.toBeNull();
      await expect(bridge?.listRetiredKeys()).resolves.toBeNull();
      await expect(bridge?.listRetiredKeys()).resolves.toBeNull();
      await expect(bridge?.listRetiredKeys()).resolves.toEqual([]);
    });

    test('a malformed public key is never sent to Commons', async () => {
      const derive = jest.fn(async () => ({ seed: 'aa'.repeat(32), keyPublicKey: 'x' }));
      const sign = jest.fn(async () => null);
      mockNative({ ...base, deriveRetiredScopedSeed: derive, signRetiredSocialReceive: sign });
      const bridge = await loadBridge();
      await expect(bridge?.deriveRetiredScopedSeed('peable/faircoin/v1', 'x')).resolves.toBeNull();
      await expect(
        bridge?.deriveRetiredScopedSeed('peable/faircoin/v1', RETIRED.toUpperCase()),
      ).resolves.toBeNull();
      await expect(
        bridge?.signRetiredSocialReceive(0, '11'.repeat(32), `02${'aa'.repeat(32)}`),
      ).resolves.toBeNull();
      expect(derive).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    });

    test('a native module without the retired functions answers null, never the current key', async () => {
      const derive = jest.fn(base.deriveScopedSeed);
      const sign = jest.fn(base.signSocialReceive);
      mockNative({ ...base, deriveScopedSeed: derive, signSocialReceive: sign });
      const bridge = await loadBridge();
      expect(bridge).not.toBeNull();
      await expect(bridge?.listRetiredKeys()).resolves.toBeNull();
      await expect(
        bridge?.deriveRetiredScopedSeed('peable/faircoin/v1', RETIRED),
      ).resolves.toBeNull();
      await expect(
        bridge?.signRetiredSocialReceive(0, '11'.repeat(32), RETIRED, ORG),
      ).resolves.toBeNull();
      expect(derive).not.toHaveBeenCalled();
      expect(sign).not.toHaveBeenCalled();
    });
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
