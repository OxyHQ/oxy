/**
 * The two identity slots must never disagree, because the disagreement is
 * silent and it is money.
 *
 * Cross-app readers take the SHARED slot first — `deriveScopedSeed`, which is
 * where Peable's FairCoin wallet comes from — while signing and the server take
 * the PRIMARY. A key rotation used to write only the primary, so the shared slot
 * kept the replaced key: the recipient's wallet watched addresses derived from a
 * key the DID no longer published, and payers sent to addresses it never
 * watched. Nothing errored on either side.
 */

import { setPlatformOS } from '../../utils/platform';

jest.mock(
  'expo-secure-store',
  () => {
    const store = new Map<string, string>();
    return {
      __esModule: true,
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
      WHEN_UNLOCKED: 'WHEN_UNLOCKED',
      setItemAsync: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
      getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
      deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
      __resetStore__: () => store.clear(),
    };
  },
  { virtual: true },
);

jest.mock(
  'expo-crypto',
  () => ({
    __esModule: true,
    getRandomBytes: (length: number) => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) out[i] = (Math.random() * 256) & 0xff;
      return out;
    },
    digestStringAsync: async () => '0'.repeat(64),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  }),
  { virtual: true },
);

jest.mock('@oxy.so/protocol', () => ({
  __esModule: true,
  ...jest.requireActual('@oxy.so/protocol'),
  loadExpoCrypto: async () => require('expo-crypto'),
  loadSecureStore: async () => require('expo-secure-store'),
  loadNodeCrypto: async () => require('node:crypto'),
  loadSharedIdentityBridge: async () => null,
}));

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('identity slots stay in sync', () => {
  let KeyManager: typeof import('../keyManager').KeyManager;

  beforeEach(async () => {
    jest.resetModules();
    setPlatformOS('ios');
    const secureStore = (await import('expo-secure-store' as string)) as unknown as {
      __resetStore__: () => void;
    };
    secureStore.__resetStore__();
    ({ KeyManager } = await import('../keyManager'));
  });

  /** The shape a rotation used to leave behind: each slot on a different key. */
  async function makeSlotsDisagree(): Promise<{ publicA: string; publicB: string }> {
    const publicA = await KeyManager.importSharedIdentity(KEY_A);
    await KeyManager.importKeyPair(KEY_B, { overwrite: true });
    const publicB = KeyManager.derivePublicKey(KEY_B);
    return { publicA, publicB };
  }

  it('reports both slots, and which one money derives from', async () => {
    const { publicA, publicB } = await makeSlotsDisagree();

    const state = await KeyManager.getIdentityKeyState();

    expect(state.sharedPublicKey).toBe(KeyManager.canonicalPublicKey(publicA));
    expect(state.primaryPublicKey).toBe(KeyManager.canonicalPublicKey(publicB));
    // The shared slot wins, which is exactly why a disagreement is dangerous.
    expect(state.activePublicKey).toBe(state.sharedPublicKey);
    expect(state.inSync).toBe(false);
  });

  it('is in sync when both slots hold the same key', async () => {
    await KeyManager.importSharedIdentity(KEY_A);
    await KeyManager.importKeyPair(KEY_A, { overwrite: true });

    const state = await KeyManager.getIdentityKeyState();

    expect(state.inSync).toBe(true);
    expect(state.activePublicKey).toBe(state.primaryPublicKey);
  });

  // A device with one slot populated has nothing to contradict, so it must not
  // read as a disagreement — otherwise every fresh install would report one.
  it('is in sync when only one slot is populated', async () => {
    await KeyManager.importKeyPair(KEY_A, { overwrite: true });

    const state = await KeyManager.getIdentityKeyState();

    expect(state.sharedPublicKey).toBeNull();
    expect(state.activePublicKey).toBe(state.primaryPublicKey);
    expect(state.inSync).toBe(true);
  });

  it('repairs a disagreeing shared slot from the primary instead of skipping', async () => {
    const { publicB } = await makeSlotsDisagree();

    const migrated = await KeyManager.syncSharedIdentity();

    expect(migrated).toBe(true);
    const state = await KeyManager.getIdentityKeyState();
    expect(state.inSync).toBe(true);
    expect(state.sharedPublicKey).toBe(KeyManager.canonicalPublicKey(publicB));
  });

  // The wallet is the reason any of this matters: the seed must follow the
  // repaired key, not the one the stale slot was still handing out.
  it('moves the derived wallet seed onto the repaired key', async () => {
    await makeSlotsDisagree();
    const strandedSeed = await KeyManager.deriveScopedSeed('peable/faircoin/v1');

    await KeyManager.syncSharedIdentity();
    const repairedSeed = await KeyManager.deriveScopedSeed('peable/faircoin/v1');

    if (!strandedSeed || !repairedSeed) throw new Error('expected seeds');
    expect(toHex(repairedSeed)).not.toBe(toHex(strandedSeed));

    // And it is the seed a device holding only that one key would derive.
    jest.resetModules();
    const secureStore = (await import('expo-secure-store' as string)) as unknown as {
      __resetStore__: () => void;
    };
    secureStore.__resetStore__();
    const { KeyManager: Fresh } = await import('../keyManager');
    await Fresh.importSharedIdentity(KEY_B);
    const expected = await Fresh.deriveScopedSeed('peable/faircoin/v1');
    if (!expected) throw new Error('expected a seed');
    expect(toHex(repairedSeed)).toBe(toHex(expected));
  });
});
