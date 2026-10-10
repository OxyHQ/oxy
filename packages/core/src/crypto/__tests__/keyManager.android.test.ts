/**
 * Android: Commons is the only holder of the identity private key.
 *
 * - Inside Commons, `KeyManager` keeps the identity signer store (the native
 *   copy Commons' identity host signs with) in step with the primary identity:
 *   every persist writes it, every delete clears it, `syncSharedIdentity`
 *   repairs it, and it is a recovery rung.
 * - In every other app there is no key at all: the public key, scoped seeds and
 *   social-receive signatures come from Commons over IPC, and
 *   `getSharedPrivateKey` is always null.
 */

import type { CommonsIdentityBridge } from '@oxy.so/protocol';
import { setPlatformOS } from '../../utils/platform';
import type { IdentitySignerStore } from '../identitySigner';
import { deriveScopedSeedFromKey, signSocialReceiveDigest } from '../identityDerivations';

jest.mock(
  'expo-secure-store',
  () => {
    const { createSecureStoreMock } = require('./identityMocks');
    return createSecureStoreMock();
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

const mockBridge: { current: CommonsIdentityBridge | null } = { current: null };
jest.mock('@oxy.so/protocol', () => ({
  __esModule: true,
  ...jest.requireActual('@oxy.so/protocol'),
  loadExpoCrypto: async () => require('expo-crypto'),
  loadSecureStore: async () => require('expo-secure-store'),
  loadNodeCrypto: async () => require('node:crypto'),
  loadAsyncStorage: async () => ({ default: mockAsyncStorage }),
  loadCommonsIdentityBridge: async () => mockBridge.current,
}));
const mockAsyncStorage = require('./identityMocks').createAsyncStorageMock();

const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);
const DIGEST = '5c'.repeat(32);
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

function memorySigner(): IdentitySignerStore & {
  pair: { privateKey: string; publicKey: string } | null;
} {
  const signer = {
    name: 'memory-signer',
    pair: null as { privateKey: string; publicKey: string } | null,
    read: jest.fn(async () => signer.pair),
    write: jest.fn(async (privateKey: string, publicKey: string) => {
      signer.pair = { privateKey, publicKey };
      return true;
    }),
    clear: jest.fn(async () => {
      signer.pair = null;
    }),
  };
  return signer;
}

let KeyManager: typeof import('../keyManager').KeyManager;

interface SecureStoreTestHandle {
  __resetStore__: () => void;
  __simulateKeystoreDeath__: (service: string) => void;
}

beforeAll(() => {
  (globalThis as unknown as { navigator: unknown }).navigator = { product: 'ReactNative' };
});

beforeEach(async () => {
  jest.resetModules();
  setPlatformOS('android');
  mockBridge.current = null;
  mockAsyncStorage.__reset__();
  const secureStore = (await import(
    'expo-secure-store' as string
  )) as unknown as SecureStoreTestHandle;
  secureStore.__resetStore__();
  ({ KeyManager } = await import('../keyManager'));
});

/** Drop every in-memory identity verdict, as a fresh launch would. */
function resetCaches(): void {
  const km = KeyManager as unknown as Record<string, unknown>;
  km.cachedPublicKey = null;
  km.cachedHasIdentity = null;
  km.cachedPublicKeyResolved = false;
  km.cachedSharedPublicKey = null;
  km.cachedHasSharedIdentity = null;
}

afterAll(() => {
  setPlatformOS('web');
});

describe('Commons (registers the identity signer store)', () => {
  it('every persist writes the signer store, and the shared key is read from it', async () => {
    const signer = memorySigner();
    KeyManager.setIdentitySignerStore(signer);

    await KeyManager.importKeyPair(KEY_A);

    const publicA = KeyManager.derivePublicKey(KEY_A);
    expect(signer.pair).toEqual({ privateKey: KEY_A, publicKey: publicA });
    await expect(KeyManager.getSharedPublicKey()).resolves.toBe(publicA);
    await expect(KeyManager.hasSharedIdentity()).resolves.toBe(true);
    // The key never comes back out through the "shared" API on Android.
    await expect(KeyManager.getSharedPrivateKey()).resolves.toBeNull();
  });

  it('a non-forced delete clears the signer store, so Commons stops answering for it', async () => {
    const signer = memorySigner();
    KeyManager.setIdentitySignerStore(signer);
    await KeyManager.importKeyPair(KEY_A);

    await KeyManager.deleteIdentity(true, false, true);

    expect(signer.clear).toHaveBeenCalled();
    expect(signer.pair).toBeNull();
    await expect(KeyManager.getSharedPublicKey()).resolves.toBeNull();
  });

  it('syncSharedIdentity repairs a signer store holding a different key', async () => {
    const signer = memorySigner();
    KeyManager.setIdentitySignerStore(signer);
    await KeyManager.importKeyPair(KEY_B);
    signer.pair = { privateKey: KEY_A, publicKey: KeyManager.derivePublicKey(KEY_A) };

    await expect(KeyManager.syncSharedIdentity()).resolves.toBe(true);

    expect(signer.pair?.privateKey).toBe(KEY_B);
    const state = await KeyManager.getIdentityKeyState();
    expect(state.inSync).toBe(true);
    // Android derives from the primary first.
    expect(state.activePublicKey).toBe(KeyManager.derivePublicKey(KEY_B));
  });

  it('syncSharedIdentity fills an empty signer store', async () => {
    const signer = memorySigner();
    KeyManager.setIdentitySignerStore(signer);
    await KeyManager.importKeyPair(KEY_A);
    signer.pair = null; // e.g. a mirror write that did not land

    await expect(KeyManager.syncSharedIdentity()).resolves.toBe(true);
    expect(signer.pair?.privateKey).toBe(KEY_A);
  });

  it('finishes an interrupted rotation from the signer store instead of reverting it', async () => {
    const signer = memorySigner();
    KeyManager.setIdentitySignerStore(signer);
    await KeyManager.importKeyPair(KEY_A);
    const publicB = KeyManager.derivePublicKey(KEY_B);
    // A rotation: the server now holds B, the signer store was written, and
    // the primary write failed.
    await KeyManager.beginKeyRotation(publicB);
    await KeyManager.importSharedIdentity(KEY_B);
    resetCaches();

    await expect(KeyManager.syncSharedIdentity()).resolves.toBe(true);

    expect(signer.pair?.privateKey).toBe(KEY_B);
    await expect(KeyManager.getPrivateKey()).resolves.toBe(KEY_B);
    // The marker is gone, so a later genuine disagreement repairs as usual.
    signer.pair = { privateKey: KEY_A, publicKey: KeyManager.derivePublicKey(KEY_A) };
    await expect(KeyManager.syncSharedIdentity()).resolves.toBe(true);
    expect(signer.pair?.privateKey).toBe(KEY_B);
  });

  it('recovers a lost identity from the signer store', async () => {
    const signer = memorySigner();
    KeyManager.setIdentitySignerStore(signer);
    await KeyManager.importKeyPair(KEY_A);
    const secureStore = (await import(
      'expo-secure-store' as string
    )) as unknown as SecureStoreTestHandle;
    secureStore.__simulateKeystoreDeath__('oxy_identity');
    secureStore.__simulateKeystoreDeath__('oxy_identity_backup');
    resetCaches();
    expect((await KeyManager.getIdentityStatus()).state).toBe('lost');
    resetCaches();

    const result = await KeyManager.attemptIdentityRecovery();

    expect(result).toEqual({
      recovered: true,
      source: 'shared',
      publicKey: KeyManager.derivePublicKey(KEY_A),
    });
    await expect(KeyManager.getPrivateKey()).resolves.toBe(KEY_A);
  });

  it('derives seeds and social-receive signatures from its own key, never asking itself over IPC', async () => {
    const bridge: CommonsIdentityBridge = {
      describe: jest.fn(async () => null),
      proveIdentity: jest.fn(async () => null),
      deriveScopedSeed: jest.fn(async () => null),
      signSocialReceive: jest.fn(async () => null),
    };
    mockBridge.current = bridge;
    KeyManager.setIdentitySignerStore(memorySigner());
    await KeyManager.importKeyPair(KEY_A);

    const seed = await KeyManager.deriveScopedSeed('peable/faircoin/v1');
    expect(seed && toHex(seed)).toBe(toHex(deriveScopedSeedFromKey(KEY_A, 'peable/faircoin/v1')));
    await expect(KeyManager.signSocialReceive(3, DIGEST)).resolves.toEqual(
      signSocialReceiveDigest(KEY_A, 3, DIGEST),
    );
    expect(bridge.deriveScopedSeed).not.toHaveBeenCalled();
    expect(bridge.signSocialReceive).not.toHaveBeenCalled();
  });
});

describe('every other app (no signer store, no key)', () => {
  it('asks Commons for the public key, the seed and the social-receive signature', async () => {
    const publicA = KeyManager.derivePublicKey(KEY_A);
    const seedHex = toHex(deriveScopedSeedFromKey(KEY_A, 'peable/faircoin/v1'));
    const socialSig = signSocialReceiveDigest(KEY_A, 7, DIGEST);
    const bridge: CommonsIdentityBridge = {
      describe: jest.fn(async () => ({ v: 2, publicKey: publicA })),
      proveIdentity: jest.fn(async () => null),
      deriveScopedSeed: jest.fn(async () => seedHex),
      signSocialReceive: jest.fn(async () => socialSig),
    };
    mockBridge.current = bridge;

    await expect(KeyManager.getSharedPublicKey()).resolves.toBe(publicA);
    await expect(KeyManager.hasSharedIdentity()).resolves.toBe(true);
    await expect(KeyManager.getSharedPrivateKey()).resolves.toBeNull();
    const seed = await KeyManager.deriveScopedSeed('peable/faircoin/v1');
    expect(seed && toHex(seed)).toBe(seedHex);
    expect(bridge.deriveScopedSeed).toHaveBeenCalledWith('peable/faircoin/v1');
    await expect(KeyManager.signSocialReceive(7, DIGEST)).resolves.toEqual(socialSig);
    expect(bridge.signSocialReceive).toHaveBeenCalledWith(7, DIGEST);
    const state = await KeyManager.getIdentityKeyState();
    expect(state).toEqual({
      primaryPublicKey: null,
      sharedPublicKey: publicA,
      activePublicKey: publicA,
      inSync: true,
    });
  });

  it('never caches the public key: a rotation in Commons is seen at once', async () => {
    const publicA = KeyManager.derivePublicKey(KEY_A);
    const publicB = KeyManager.derivePublicKey(KEY_B);
    let current = publicA;
    mockBridge.current = {
      describe: jest.fn(async () => ({ v: 2, publicKey: current })),
      proveIdentity: jest.fn(async () => null),
      deriveScopedSeed: jest.fn(async () => null),
      signSocialReceive: jest.fn(async () => null),
    };
    await expect(KeyManager.getSharedPublicKey()).resolves.toBe(publicA);
    current = publicB;
    await expect(KeyManager.getSharedPublicKey()).resolves.toBe(publicB);
    expect((await KeyManager.getIdentityKeyState()).activePublicKey).toBe(publicB);
    current = '';
    mockBridge.current.describe = jest.fn(async () => null);
    await expect(KeyManager.hasSharedIdentity()).resolves.toBe(false);
  });

  it('cannot hold an identity, and never derives from a local key', async () => {
    await expect(KeyManager.importKeyPair(KEY_A)).rejects.toThrow(
      'only Commons holds the Oxy identity',
    );
    await expect(KeyManager.createIdentity()).rejects.toThrow(
      'only Commons holds the Oxy identity',
    );

    // Even with a key left in its storage (written while it had a store), an
    // app without a signer store asks Commons.
    const signer = memorySigner();
    KeyManager.setIdentitySignerStore(signer);
    await KeyManager.importKeyPair(KEY_A);
    KeyManager.setIdentitySignerStore(null);
    const bridge: CommonsIdentityBridge = {
      describe: jest.fn(async () => null),
      proveIdentity: jest.fn(async () => null),
      deriveScopedSeed: jest.fn(async () => null),
      signSocialReceive: jest.fn(async () => null),
    };
    mockBridge.current = bridge;
    await expect(KeyManager.deriveScopedSeed('peable/faircoin/v1')).resolves.toBeNull();
    await expect(KeyManager.signSocialReceive(0, DIGEST)).resolves.toBeNull();
    expect(bridge.deriveScopedSeed).toHaveBeenCalled();
    expect(bridge.signSocialReceive).toHaveBeenCalled();
  });

  it('has nothing when Commons is absent or refuses', async () => {
    await expect(KeyManager.getSharedPublicKey()).resolves.toBeNull();
    await expect(KeyManager.deriveScopedSeed('peable/faircoin/v1')).resolves.toBeNull();
    await expect(KeyManager.signSocialReceive(0, DIGEST)).resolves.toBeNull();
  });

  it('cannot write the shared identity, and syncSharedIdentity is a no-op', async () => {
    await expect(KeyManager.importSharedIdentity(KEY_A)).rejects.toThrow(
      'only Commons holds the Oxy identity',
    );
    await expect(KeyManager.createSharedIdentity()).rejects.toThrow(
      'only Commons holds the Oxy identity',
    );
    await expect(KeyManager.syncSharedIdentity()).resolves.toBe(false);
  });
});
