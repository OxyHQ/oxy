/**
 * Organization keys on the device (ADR 0061 D6): generated from a 24-word
 * phrase without touching the personal identity, kept by Commons under the
 * organization's account id, and reached by every other app only through
 * derivations — never falling back to the personal key.
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

const ORG = '0123456789abcdef01234567';
const ORG_UUID = 'e3d486b7-e529-4ba5-bf2f-63a20c6b948a';
const ORG_KEY = 'aa'.repeat(32);
const PERSONAL_KEY = 'bb'.repeat(32);
const INFO = 'peable/faircoin/v1';
const DIGEST = '5c'.repeat(32);
// The BIP-39 test vector for 32 zero bytes of entropy.
const PHRASE_24 = `${'abandon '.repeat(23)}art`;
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

type OrganizationKeys = typeof import('../organizationKeys');
let keys: OrganizationKeys;
let KeyManager: typeof import('../keyManager').KeyManager;
let secureStore: { setItemAsync: jest.Mock; __resetStore__: () => void };

function memorySigner(withOrganizations = true): IdentitySignerStore & {
  organizations: Map<string, { privateKey: string; publicKey: string }>;
} {
  const organizations = new Map<string, { privateKey: string; publicKey: string }>();
  let pair: { privateKey: string; publicKey: string } | null = null;
  const base = {
    name: 'memory-signer',
    organizations,
    read: jest.fn(async () => pair),
    write: jest.fn(async (privateKey: string, publicKey: string) => {
      pair = { privateKey, publicKey };
      return true;
    }),
    clear: jest.fn(async () => {
      pair = null;
    }),
  };
  if (!withOrganizations) return base;
  return {
    ...base,
    readOrganization: jest.fn(async (accountId: string) => organizations.get(accountId) ?? null),
    writeOrganization: jest.fn(async (accountId: string, privateKey: string, publicKey: string) => {
      organizations.set(accountId, { privateKey, publicKey });
      return true;
    }),
    clearOrganization: jest.fn(async (accountId: string) => {
      organizations.delete(accountId);
    }),
  };
}

beforeAll(() => {
  (globalThis as unknown as { navigator: unknown }).navigator = { product: 'ReactNative' };
});

async function load(os: 'ios' | 'android'): Promise<void> {
  jest.resetModules();
  setPlatformOS(os);
  mockBridge.current = null;
  mockAsyncStorage.__reset__();
  secureStore = (await import('expo-secure-store' as string)) as unknown as typeof secureStore;
  secureStore.__resetStore__();
  secureStore.setItemAsync.mockClear();
  ({ KeyManager } = await import('../keyManager'));
  keys = await import('../organizationKeys');
}

afterAll(() => {
  setPlatformOS('web');
});

describe('generating and deriving', () => {
  beforeEach(() => load('ios'));

  it('generates a 24-word phrase and its seed[0:32] key, and stores nothing', async () => {
    const generated = await keys.generateOrganizationKey();
    expect(generated.mnemonic.split(' ')).toHaveLength(24);
    expect(generated.publicKey).toMatch(/^04[0-9a-f]{128}$/);
    await expect(keys.organizationKeyFromPhrase(generated.mnemonic)).resolves.toEqual({
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
    });
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
    await expect(KeyManager.hasIdentity()).resolves.toBe(false);
  });

  it('derives the personal-root way from a 24-word phrase and refuses anything else', async () => {
    const pair = await keys.organizationKeyFromPhrase(`  ${PHRASE_24.toUpperCase()} `);
    expect(pair.publicKey).toBe(KeyManager.derivePublicKey(pair.privateKey));
    await expect(keys.organizationKeyFromPhrase(`${'abandon '.repeat(11)}about`)).rejects.toThrow(
      '24-word',
    );
    await expect(keys.organizationKeyFromPhrase(`${'abandon '.repeat(24)}`)).rejects.toThrow();
  });

  it('accepts legacy and uuid account ids only', () => {
    expect(keys.isOrganizationAccountId(ORG)).toBe(true);
    expect(keys.isOrganizationAccountId(ORG_UUID)).toBe(true);
    expect(keys.isOrganizationAccountId('ORG')).toBe(false);
    expect(keys.isOrganizationAccountId(`${ORG}.priv`)).toBe(false);
    expect(keys.isOrganizationAccountId(ORG.toUpperCase())).toBe(false);
  });
});

describe('iOS: the keychain group', () => {
  beforeEach(() => load('ios'));

  it('stores, reads back, lists and derives from an organization key', async () => {
    const publicKey = KeyManager.derivePublicKey(ORG_KEY);
    await keys.storeOrganizationKey(ORG, { privateKey: ORG_KEY, publicKey });

    await expect(keys.getOrganizationPublicKey(ORG)).resolves.toBe(publicKey);
    await expect(keys.getOrganizationPrivateKey(ORG)).resolves.toBe(ORG_KEY);
    await expect(keys.getOrganizationRecoveryPhrase(ORG)).resolves.toBeNull();
    await expect(keys.listOrganizationKeys()).resolves.toEqual([ORG]);

    const seed = await KeyManager.deriveScopedSeed(INFO, { accountId: ORG });
    expect(seed && toHex(seed)).toBe(toHex(deriveScopedSeedFromKey(ORG_KEY, INFO)));
    await expect(KeyManager.signSocialReceive(2, DIGEST, { accountId: ORG })).resolves.toEqual(
      signSocialReceiveDigest(ORG_KEY, 2, DIGEST),
    );
  });

  it('never answers an organization request with the personal key', async () => {
    await KeyManager.importKeyPair(PERSONAL_KEY);
    await expect(KeyManager.deriveScopedSeed(INFO, { accountId: ORG })).resolves.toBeNull();
    await expect(KeyManager.signSocialReceive(0, DIGEST, { accountId: ORG })).resolves.toBeNull();
    await expect(KeyManager.deriveScopedSeed(INFO, { accountId: 'nope' })).resolves.toBeNull();

    // …and the personal path is unchanged by an organization key on the device.
    await keys.storeOrganizationKey(ORG, {
      privateKey: ORG_KEY,
      publicKey: KeyManager.derivePublicKey(ORG_KEY),
    });
    const personal = await KeyManager.deriveScopedSeed(INFO);
    expect(personal && toHex(personal)).toBe(toHex(deriveScopedSeedFromKey(PERSONAL_KEY, INFO)));
  });

  it('keeps the phrase, refusing one that derives another key', async () => {
    const pair = await keys.organizationKeyFromPhrase(PHRASE_24);
    await expect(
      keys.storeOrganizationKey(ORG, {
        privateKey: ORG_KEY,
        publicKey: KeyManager.derivePublicKey(ORG_KEY),
        mnemonic: PHRASE_24,
      }),
    ).rejects.toThrow('different key');
    await keys.storeOrganizationKey(ORG, { ...pair, mnemonic: PHRASE_24 });
    await expect(keys.getOrganizationRecoveryPhrase(ORG)).resolves.toBe(PHRASE_24);
  });

  it('refuses a mismatched pair and a malformed account id', async () => {
    await expect(
      keys.storeOrganizationKey(ORG, {
        privateKey: ORG_KEY,
        publicKey: KeyManager.derivePublicKey(PERSONAL_KEY),
      }),
    ).rejects.toThrow('does not derive');
    await expect(
      keys.storeOrganizationKey('../x', {
        privateKey: ORG_KEY,
        publicKey: KeyManager.derivePublicKey(ORG_KEY),
      }),
    ).rejects.toThrow('accountId');
    await expect(keys.listOrganizationKeys()).resolves.toEqual([]);
  });

  it('replacing a held key keeps the old one in the organization ring first (R4-12)', async () => {
    const replaced = KeyManager.derivePublicKey(PERSONAL_KEY);
    await keys.storeOrganizationKey(ORG, { privateKey: PERSONAL_KEY, publicKey: replaced });
    const publicKey = KeyManager.derivePublicKey(ORG_KEY);
    await keys.storeOrganizationKey(ORG, { privateKey: ORG_KEY, publicKey });
    await expect(keys.getOrganizationPrivateKey(ORG)).resolves.toBe(ORG_KEY);
    const ring = await import('../retiredKeys');
    expect(
      (await ring.listRetiredIdentityKeys({ accountId: ORG })).map((k) => k.publicKey),
    ).toEqual([replaced]);
    // Storing the same key again retires nothing.
    await keys.storeOrganizationKey(ORG, { privateKey: ORG_KEY, publicKey });
    expect(await ring.listRetiredIdentityKeys({ accountId: ORG })).toHaveLength(1);
  });

  it('refuses to replace a held key it cannot keep, and changes nothing (R4-12)', async () => {
    const replaced = KeyManager.derivePublicKey(PERSONAL_KEY);
    await keys.storeOrganizationKey(ORG, { privateKey: PERSONAL_KEY, publicKey: replaced });
    const original = secureStore.setItemAsync.getMockImplementation();
    secureStore.setItemAsync.mockImplementation(async (key: string, ...rest: unknown[]) => {
      if (key.startsWith('oxy_retired_identity_private_key')) throw new Error('errSecIO');
      return original?.(key, ...rest);
    });
    const publicKey = KeyManager.derivePublicKey(ORG_KEY);
    await expect(
      keys.storeOrganizationKey(ORG, { privateKey: ORG_KEY, publicKey }),
    ).rejects.toThrow('could not be kept');
    secureStore.setItemAsync.mockImplementation(original);
    await expect(keys.getOrganizationPrivateKey(ORG)).resolves.toBe(PERSONAL_KEY);
  });

  it('forgets one organization and keeps the others', async () => {
    const publicKey = KeyManager.derivePublicKey(ORG_KEY);
    await keys.storeOrganizationKey(ORG, { privateKey: ORG_KEY, publicKey });
    await keys.storeOrganizationKey(ORG_UUID, { privateKey: ORG_KEY, publicKey });
    await keys.deleteOrganizationKey(ORG);
    await expect(keys.getOrganizationPublicKey(ORG)).resolves.toBeNull();
    await expect(keys.listOrganizationKeys()).resolves.toEqual([ORG_UUID]);
  });
});

describe('Android, Commons (registers the signer store)', () => {
  beforeEach(() => load('android'));

  it('writes the signer store entry the identity host answers from', async () => {
    const signer = memorySigner();
    KeyManager.setIdentitySignerStore(signer);
    const publicKey = KeyManager.derivePublicKey(ORG_KEY);
    await keys.storeOrganizationKey(ORG, { privateKey: ORG_KEY, publicKey });

    expect(signer.organizations.get(ORG)).toEqual({ privateKey: ORG_KEY, publicKey });
    await expect(keys.getOrganizationPublicKey(ORG)).resolves.toBe(publicKey);
    const seed = await KeyManager.deriveScopedSeed(INFO, { accountId: ORG });
    expect(seed && toHex(seed)).toBe(toHex(deriveScopedSeedFromKey(ORG_KEY, INFO)));

    await keys.deleteOrganizationKey(ORG);
    expect(signer.organizations.has(ORG)).toBe(false);
  });

  it('refuses to store without a signer store that holds organizations', async () => {
    KeyManager.setIdentitySignerStore(memorySigner(false));
    await expect(
      keys.storeOrganizationKey(ORG, {
        privateKey: ORG_KEY,
        publicKey: KeyManager.derivePublicKey(ORG_KEY),
      }),
    ).rejects.toThrow('signer store');
    await expect(keys.listOrganizationKeys()).resolves.toEqual([]);
  });

  it('syncOrganizationKeys refills an emptied signer store', async () => {
    const signer = memorySigner();
    KeyManager.setIdentitySignerStore(signer);
    const publicKey = KeyManager.derivePublicKey(ORG_KEY);
    await keys.storeOrganizationKey(ORG, { privateKey: ORG_KEY, publicKey });
    signer.organizations.clear(); // the native file's self-heal

    await expect(keys.syncOrganizationKeys()).resolves.toBe(1);
    expect(signer.organizations.get(ORG)).toEqual({ privateKey: ORG_KEY, publicKey });
    await expect(keys.syncOrganizationKeys()).resolves.toBe(0);
  });
});

describe('Android, every other app (asks Commons)', () => {
  beforeEach(() => load('android'));

  function bridge(answers: Partial<CommonsIdentityBridge>): jest.Mocked<CommonsIdentityBridge> {
    return {
      describe: jest.fn(async () => null),
      proveIdentity: jest.fn(async () => null),
      deriveScopedSeed: jest.fn(async () => null),
      signSocialReceive: jest.fn(async () => null),
      ...answers,
    } as jest.Mocked<CommonsIdentityBridge>;
  }

  it('reaches the organization key through the bridge with its account id', async () => {
    const publicKey = KeyManager.derivePublicKey(ORG_KEY);
    const seedHex = toHex(deriveScopedSeedFromKey(ORG_KEY, INFO));
    const signature = signSocialReceiveDigest(ORG_KEY, 1, DIGEST);
    const b = bridge({
      describe: jest.fn(async (accountId?: string) =>
        accountId === ORG ? { v: 3, publicKey, accountId } : null,
      ),
      deriveScopedSeed: jest.fn(async (_info: string, accountId?: string) =>
        accountId === ORG ? seedHex : null,
      ),
      signSocialReceive: jest.fn(async (_index: number, _digest: string, accountId?: string) =>
        accountId === ORG ? signature : null,
      ),
    });
    mockBridge.current = b;

    await expect(keys.getOrganizationPublicKey(ORG)).resolves.toBe(publicKey);
    const seed = await KeyManager.deriveScopedSeed(INFO, { accountId: ORG });
    expect(seed && toHex(seed)).toBe(seedHex);
    await expect(KeyManager.signSocialReceive(1, DIGEST, { accountId: ORG })).resolves.toEqual(
      signature,
    );
    expect(b.deriveScopedSeed).toHaveBeenCalledWith(INFO, ORG);
    expect(b.signSocialReceive).toHaveBeenCalledWith(1, DIGEST, ORG);
    // No key here, whatever Commons holds.
    await expect(keys.getOrganizationPrivateKey(ORG)).resolves.toBeNull();
  });

  it('takes a description only when it names the organization asked for', async () => {
    mockBridge.current = bridge({
      describe: jest.fn(async () => ({
        v: 2,
        publicKey: KeyManager.derivePublicKey(PERSONAL_KEY),
      })),
    });
    await expect(keys.getOrganizationPublicKey(ORG)).resolves.toBeNull();
  });

  it('the personal path still asks without an account id', async () => {
    const b = bridge({ deriveScopedSeed: jest.fn(async () => 'cd'.repeat(32)) });
    mockBridge.current = b;
    await KeyManager.deriveScopedSeed(INFO);
    expect(b.deriveScopedSeed).toHaveBeenCalledWith(INFO);
  });
});
