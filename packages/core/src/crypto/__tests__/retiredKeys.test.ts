/**
 * Retired identity keys (ADR 0061 D7 as amended 2026-11-06): the key an account
 * had before a rotation or replacement stays on the device for spending only,
 * reached by the `publicKey` selector of `deriveScopedSeed` / `signSocialReceive`
 * exactly as the current key is — never exported, never in place of another.
 */

import type { CommonsIdentityBridge } from '@oxy.so/protocol';
import { deriveSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
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
/** The signed-in person (R5-2: the personal ring is bound to its owner). */
const ME = { ownerAccountId: 'aaaaaaaaaaaaaaaaaaaaaaaa' };
const NEXT_PERSON = { ownerAccountId: 'bbbbbbbbbbbbbbbbbbbbbbbb' };
const CURRENT_KEY = 'c1'.repeat(32);
const RETIRED_KEY = 'a7'.repeat(32);
const OTHER_KEY = 'd3'.repeat(32);
const ORG_KEY = 'e5'.repeat(32);
const ORG_RETIRED_KEY = 'f9'.repeat(32);
const INFO = 'peable/faircoin/v1';
const DIGEST = '5c'.repeat(32);
// BIP-39 test vector: 16 zero bytes of entropy.
const PHRASE_12 = `${'abandon '.repeat(11)}about`;
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

type RetiredKeys = typeof import('../retiredKeys');
let ring: RetiredKeys;
let KeyManager: typeof import('../keyManager').KeyManager;
let orgKeys: typeof import('../organizationKeys');
let secureStore: { __resetStore__: () => void };

type Pair = { privateKey: string; publicKey: string };

function memorySigner(withRetired = true): IdentitySignerStore & { retired: Map<string, Pair> } {
  const retired = new Map<string, Pair>();
  const organizations = new Map<string, Pair>();
  let pair: Pair | null = null;
  const base = {
    name: 'memory-signer',
    retired,
    read: jest.fn(async () => pair),
    write: jest.fn(async (privateKey: string, publicKey: string) => {
      pair = { privateKey, publicKey };
      return true;
    }),
    clear: jest.fn(async () => {
      pair = null;
    }),
    readOrganization: jest.fn(async (id: string) => organizations.get(id) ?? null),
    writeOrganization: jest.fn(async (id: string, privateKey: string, publicKey: string) => {
      organizations.set(id, { privateKey, publicKey });
      return true;
    }),
    clearOrganization: jest.fn(async (id: string) => {
      organizations.delete(id);
    }),
  };
  if (!withRetired) return base;
  return {
    ...base,
    readRetired: jest.fn(
      async (scope: string, publicKey: string) => retired.get(`${scope}.${publicKey}`) ?? null,
    ),
    writeRetired: jest.fn(async (scope: string, privateKey: string, publicKey: string) => {
      retired.set(`${scope}.${publicKey}`, { privateKey, publicKey });
      return true;
    }),
    listRetired: jest.fn(async (scope: string) =>
      [...retired.keys()]
        .filter((k) => k.startsWith(`${scope}.`))
        .map((k) => k.slice(scope.length + 1)),
    ),
    clearRetired: jest.fn(async (scope: string, publicKey: string) => {
      retired.delete(`${scope}.${publicKey}`);
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
  ({ KeyManager } = await import('../keyManager'));
  ring = await import('../retiredKeys');
  orgKeys = await import('../organizationKeys');
}

afterAll(() => {
  setPlatformOS('web');
});

describe('iOS: the keychain group', () => {
  beforeEach(() => load('ios'));

  it('keeps a retired key, lists it, and derives and signs with it by its public key', async () => {
    await KeyManager.importKeyPair(CURRENT_KEY);
    const retiredPublic = KeyManager.derivePublicKey(RETIRED_KEY);
    await ring.retireIdentityKey({ privateKey: RETIRED_KEY, publicKey: retiredPublic }, ME);

    const listed = await ring.listRetiredIdentityKeys(ME);
    expect(listed.map((k) => k.publicKey)).toEqual([retiredPublic]);
    expect(listed[0]?.accountId).toBeUndefined();

    const seed = await KeyManager.deriveScopedSeed(INFO, { publicKey: retiredPublic, ...ME });
    expect(seed && toHex(seed)).toBe(toHex(deriveScopedSeedFromKey(RETIRED_KEY, INFO)));
    await expect(
      KeyManager.signSocialReceive(3, DIGEST, { publicKey: retiredPublic, ...ME }),
    ).resolves.toEqual(signSocialReceiveDigest(RETIRED_KEY, 3, DIGEST));

    // No selector: still the current key.
    const current = await KeyManager.deriveScopedSeed(INFO);
    expect(current && toHex(current)).toBe(toHex(deriveScopedSeedFromKey(CURRENT_KEY, INFO)));
  });

  it('the selector naming the current key answers with the current key', async () => {
    await KeyManager.importKeyPair(CURRENT_KEY);
    const seed = await KeyManager.deriveScopedSeed(INFO, {
      publicKey: KeyManager.derivePublicKey(CURRENT_KEY),
    });
    expect(seed && toHex(seed)).toBe(toHex(deriveScopedSeedFromKey(CURRENT_KEY, INFO)));
  });

  it('a key the ring does not hold is null, never another key', async () => {
    await KeyManager.importKeyPair(CURRENT_KEY);
    await ring.retireIdentityKey(
      {
        privateKey: RETIRED_KEY,
        publicKey: KeyManager.derivePublicKey(RETIRED_KEY),
      },
      ME,
    );
    const unknown = KeyManager.derivePublicKey(OTHER_KEY);
    await expect(
      KeyManager.deriveScopedSeed(INFO, { publicKey: unknown, ...ME }),
    ).resolves.toBeNull();
    await expect(
      KeyManager.signSocialReceive(0, DIGEST, { publicKey: unknown, ...ME }),
    ).resolves.toBeNull();
    await expect(
      KeyManager.deriveScopedSeed(INFO, { publicKey: 'not-a-key', ...ME }),
    ).resolves.toBeNull();
  });

  it('keeps personal and organization rings apart', async () => {
    await KeyManager.importKeyPair(CURRENT_KEY);
    const orgPublic = KeyManager.derivePublicKey(ORG_KEY);
    await orgKeys.storeOrganizationKey(ORG, { privateKey: ORG_KEY, publicKey: orgPublic });
    const personalRetired = KeyManager.derivePublicKey(RETIRED_KEY);
    const orgRetired = KeyManager.derivePublicKey(ORG_RETIRED_KEY);
    await ring.retireIdentityKey({ privateKey: RETIRED_KEY, publicKey: personalRetired }, ME);
    await ring.retireIdentityKey(
      { privateKey: ORG_RETIRED_KEY, publicKey: orgRetired },
      { accountId: ORG },
    );

    expect((await ring.listRetiredIdentityKeys(ME)).map((k) => k.publicKey)).toEqual([
      personalRetired,
    ]);
    expect(await ring.listRetiredIdentityKeys({ accountId: ORG })).toEqual([
      expect.objectContaining({ publicKey: orgRetired, accountId: ORG }),
    ]);

    const orgSeed = await KeyManager.deriveScopedSeed(INFO, {
      accountId: ORG,
      publicKey: orgRetired,
    });
    expect(orgSeed && toHex(orgSeed)).toBe(toHex(deriveScopedSeedFromKey(ORG_RETIRED_KEY, INFO)));
    // The organization's retired key is not reachable as a personal one, and vice versa.
    await expect(
      KeyManager.deriveScopedSeed(INFO, { publicKey: orgRetired, ...ME }),
    ).resolves.toBeNull();
    await expect(
      KeyManager.deriveScopedSeed(INFO, { accountId: ORG, publicKey: personalRetired }),
    ).resolves.toBeNull();
    // The organization's current key through the selector.
    const orgCurrent = await KeyManager.deriveScopedSeed(INFO, {
      accountId: ORG,
      publicKey: orgPublic,
    });
    expect(orgCurrent && toHex(orgCurrent)).toBe(toHex(deriveScopedSeedFromKey(ORG_KEY, INFO)));
  });

  it('is idempotent and keeps the first date', async () => {
    const publicKey = KeyManager.derivePublicKey(RETIRED_KEY);
    await ring.retireIdentityKey({ privateKey: RETIRED_KEY, publicKey }, ME);
    const [first] = await ring.listRetiredIdentityKeys(ME);
    await ring.retireIdentityKey({ privateKey: RETIRED_KEY, publicKey }, ME);
    const listed = await ring.listRetiredIdentityKeys(ME);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.retiredAt).toBe(first?.retiredAt);
  });

  it('refuses a mismatched pair and a malformed account id', async () => {
    await expect(
      ring.retireIdentityKey(
        {
          privateKey: RETIRED_KEY,
          publicKey: KeyManager.derivePublicKey(OTHER_KEY),
        },
        ME,
      ),
    ).rejects.toThrow('does not derive');
    await expect(
      ring.retireIdentityKey(
        { privateKey: RETIRED_KEY, publicKey: KeyManager.derivePublicKey(RETIRED_KEY) },
        { accountId: 'nope' },
      ),
    ).rejects.toThrow('accountId');
    await expect(ring.listRetiredIdentityKeys(ME)).resolves.toEqual([]);
  });

  it('forgets one key on request; a forced identity delete ("Start over") keeps every ring (R4-4)', async () => {
    await KeyManager.importKeyPair(CURRENT_KEY);
    const a = KeyManager.derivePublicKey(RETIRED_KEY);
    const b = KeyManager.derivePublicKey(OTHER_KEY);
    const o = KeyManager.derivePublicKey(ORG_RETIRED_KEY);
    await ring.retireIdentityKey({ privateKey: RETIRED_KEY, publicKey: a }, ME);
    await ring.retireIdentityKey({ privateKey: OTHER_KEY, publicKey: b }, ME);
    await ring.retireIdentityKey({ privateKey: ORG_RETIRED_KEY, publicKey: o }, { accountId: ORG });

    await ring.forgetRetiredIdentityKey(a, ME);
    expect((await ring.listRetiredIdentityKeys(ME)).map((k) => k.publicKey)).toEqual([b]);
    await expect(KeyManager.deriveScopedSeed(INFO, { publicKey: a, ...ME })).resolves.toBeNull();

    await KeyManager.deleteIdentity(true, true, true);
    expect((await ring.listRetiredIdentityKeys(ME)).map((k) => k.publicKey)).toEqual([b]);
    const seed = await KeyManager.deriveScopedSeed(INFO, { publicKey: b, ...ME });
    expect(seed && toHex(seed)).toBe(toHex(deriveScopedSeedFromKey(OTHER_KEY, INFO)));
    expect(
      (await ring.listRetiredIdentityKeys({ accountId: ORG })).map((k) => k.publicKey),
    ).toEqual([o]);
    // Deleting the ACCOUNT is what forgets a ring, explicitly.
    await ring.forgetRetiredIdentityKeys(ME);
    await expect(ring.listRetiredIdentityKeys(ME)).resolves.toEqual([]);
  });

  it('a previous key imported as a raw private key can be added back (R4-4)', async () => {
    const pair = ring.retiredKeyFromPrivateKey(`0x${RETIRED_KEY.toUpperCase()}`);
    expect(pair).toEqual({
      privateKey: RETIRED_KEY,
      publicKey: KeyManager.derivePublicKey(RETIRED_KEY),
    });
    expect(() => ring.retiredKeyFromPrivateKey('00'.repeat(32))).toThrow('private key');
    expect(() => ring.retiredKeyFromPrivateKey('zz')).toThrow('private key');
    await ring.retireIdentityKey(pair, ME);
    const exported = await ring.exportRetiredIdentityKeys(ME);
    expect(exported.map(({ privateKey, publicKey }) => ({ privateKey, publicKey }))).toEqual([
      pair,
    ]);
  });

  it('derives a previous phrase the personal-root way, storing nothing', async () => {
    const pair = await ring.retiredKeyFromPhrase(PHRASE_12);
    expect(pair.publicKey).toBe(KeyManager.derivePublicKey(pair.privateKey));
    await expect(ring.retiredKeyFromPhrase('abandon abandon')).rejects.toThrow('recovery phrase');
    await expect(ring.listRetiredIdentityKeys(ME)).resolves.toEqual([]);
  });
});

describe('Android, Commons (registers the signer store)', () => {
  beforeEach(() => load('android'));

  it('mirrors a retired key into the signer store the identity host answers from', async () => {
    const signer = memorySigner();
    KeyManager.setIdentitySignerStore(signer);
    const publicKey = KeyManager.derivePublicKey(RETIRED_KEY);
    await ring.retireIdentityKey({ privateKey: RETIRED_KEY, publicKey }, ME);
    expect(signer.retired.get(`personal.${publicKey}`)).toEqual({
      privateKey: RETIRED_KEY,
      publicKey,
    });
    const seed = await KeyManager.deriveScopedSeed(INFO, { publicKey, ...ME });
    expect(seed && toHex(seed)).toBe(toHex(deriveScopedSeedFromKey(RETIRED_KEY, INFO)));
  });

  it('refuses to keep a retired key without a signer store that holds them', async () => {
    KeyManager.setIdentitySignerStore(memorySigner(false));
    await expect(
      ring.retireIdentityKey(
        {
          privateKey: RETIRED_KEY,
          publicKey: KeyManager.derivePublicKey(RETIRED_KEY),
        },
        ME,
      ),
    ).rejects.toThrow('signer store');
  });

  it('syncRetiredKeys refills an emptied signer store', async () => {
    const signer = memorySigner();
    KeyManager.setIdentitySignerStore(signer);
    const publicKey = KeyManager.derivePublicKey(RETIRED_KEY);
    await ring.retireIdentityKey({ privateKey: RETIRED_KEY, publicKey }, { accountId: ORG });
    signer.retired.clear();
    await expect(ring.syncRetiredKeys()).resolves.toBe(1);
    expect(signer.retired.get(`${ORG}.${publicKey}`)?.publicKey).toBe(publicKey);
    await expect(ring.syncRetiredKeys()).resolves.toBe(0);
  });
});

describe('the personal ring is bound to its owner (R5-2)', () => {
  const retiredPublic = () => KeyManager.derivePublicKey(RETIRED_KEY);

  describe('iOS', () => {
    beforeEach(() => load('ios'));

    it("the next person on the phone never lists, derives from or signs with a previous person's key", async () => {
      await KeyManager.importKeyPair(CURRENT_KEY);
      await ring.retireIdentityKey({ privateKey: RETIRED_KEY, publicKey: retiredPublic() }, ME);
      // "Start over": the identity goes, the ring stays (money, R4-4).
      await KeyManager.deleteIdentity(true, true, true);
      await KeyManager.importKeyPair(OTHER_KEY);

      await expect(ring.listRetiredIdentityKeys(NEXT_PERSON)).resolves.toEqual([]);
      await expect(ring.listRetiredIdentityKeys()).resolves.toEqual([]);
      for (const owner of [NEXT_PERSON, {}]) {
        await expect(
          KeyManager.deriveScopedSeed(INFO, { publicKey: retiredPublic(), ...owner }),
        ).resolves.toBeNull();
        await expect(
          KeyManager.signSocialReceive(0, DIGEST, { publicKey: retiredPublic(), ...owner }),
        ).resolves.toBeNull();
      }
      await expect(ring.exportRetiredIdentityKeys(NEXT_PERSON)).resolves.toEqual([]);
      await expect(ring.forgetRetiredIdentityKeys(NEXT_PERSON)).resolves.toBe(0);
      await expect(ring.forgetRetiredIdentityKey(retiredPublic(), NEXT_PERSON)).rejects.toThrow(
        'not a key of this account',
      );
      await expect(
        ring.retireIdentityKey(
          { privateKey: RETIRED_KEY, publicKey: retiredPublic() },
          NEXT_PERSON,
        ),
      ).rejects.toThrow('different account');

      // Its owner still reaches it.
      expect((await ring.listRetiredIdentityKeys(ME)).map((k) => k.publicKey)).toEqual([
        retiredPublic(),
      ]);
      const seed = await KeyManager.deriveScopedSeed(INFO, { publicKey: retiredPublic(), ...ME });
      expect(seed && toHex(seed)).toBe(toHex(deriveScopedSeedFromKey(RETIRED_KEY, INFO)));
    });

    it('a personal key cannot be kept without its owner', async () => {
      await expect(
        ring.retireIdentityKey({ privateKey: RETIRED_KEY, publicKey: retiredPublic() }),
      ).rejects.toThrow('ownerAccountId');
    });

    it("a quarantined key is reached by nobody until the account's key history claims it", async () => {
      await ring.retireIdentityKeyDuringMigration({
        privateKey: RETIRED_KEY,
        publicKey: retiredPublic(),
      });
      await expect(ring.countQuarantinedRetiredKeys()).resolves.toBe(1);
      await expect(ring.listRetiredIdentityKeys(ME)).resolves.toEqual([]);
      await expect(
        KeyManager.deriveScopedSeed(INFO, { publicKey: retiredPublic(), ...ME }),
      ).resolves.toBeNull();

      // A history that does not name it binds nothing.
      await expect(
        ring.claimRetiredIdentityKeys(NEXT_PERSON.ownerAccountId, [
          KeyManager.derivePublicKey(OTHER_KEY),
        ]),
      ).resolves.toBe(0);
      await expect(
        ring.claimRetiredIdentityKeys(ME.ownerAccountId, [retiredPublic()]),
      ).resolves.toBe(1);
      await expect(ring.countQuarantinedRetiredKeys()).resolves.toBe(0);
      expect((await ring.listRetiredIdentityKeys(ME)).map((k) => k.publicKey)).toEqual([
        retiredPublic(),
      ]);
      await expect(ring.listRetiredIdentityKeys(NEXT_PERSON)).resolves.toEqual([]);
      // Bound once: another account's history cannot take it.
      await expect(
        ring.claimRetiredIdentityKeys(NEXT_PERSON.ownerAccountId, [retiredPublic()]),
      ).resolves.toBe(0);
    });

    it('an index that does not parse is refused, never overwritten (R5-9)', async () => {
      const store = (await import('expo-secure-store' as string)) as unknown as {
        setItemAsync(k: string, v: string, o?: object): Promise<void>;
      };
      await store.setItemAsync('oxy_retired_identity_index_v1', '{not json', {});
      await expect(ring.listRetiredIdentityKeys(ME)).rejects.toThrow('retired key ring');
      await expect(
        ring.retireIdentityKey({ privateKey: RETIRED_KEY, publicKey: retiredPublic() }, ME),
      ).rejects.toThrow('retired key ring');
      await expect(ring.exportRetiredIdentityKeys(ME)).rejects.toThrow('retired key ring');
    });
  });

  describe('Android, Commons', () => {
    beforeEach(() => load('android'));

    it('the identity host holds only the signed-in person\'s entries; "Start over" withdraws them', async () => {
      const signer = memorySigner();
      KeyManager.setIdentitySignerStore(signer);
      await KeyManager.importKeyPair(CURRENT_KEY);
      await ring.retireIdentityKey({ privateKey: RETIRED_KEY, publicKey: retiredPublic() }, ME);
      const orgPublic = KeyManager.derivePublicKey(ORG_RETIRED_KEY);
      await ring.retireIdentityKey(
        { privateKey: ORG_RETIRED_KEY, publicKey: orgPublic },
        { accountId: ORG },
      );
      expect(signer.retired.has(`personal.${retiredPublic()}`)).toBe(true);

      await KeyManager.deleteIdentity(true, true, true);
      expect(signer.retired.has(`personal.${retiredPublic()}`)).toBe(false);
      expect(signer.retired.has(`${ORG}.${orgPublic}`)).toBe(true);

      // The next person signs in: nothing of the previous person's is mirrored.
      await ring.syncRetiredKeys(NEXT_PERSON.ownerAccountId);
      expect(signer.retired.has(`personal.${retiredPublic()}`)).toBe(false);
      // Commons' own ring still holds it for its owner, who gets it back.
      await expect(ring.syncRetiredKeys(ME.ownerAccountId)).resolves.toBe(1);
      expect(signer.retired.has(`personal.${retiredPublic()}`)).toBe(true);
      // Without an owner nothing personal is mirrored.
      await ring.syncRetiredKeys();
      expect(signer.retired.has(`personal.${retiredPublic()}`)).toBe(false);
    });
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
      listRetiredKeys: jest.fn(async () => null),
      deriveRetiredScopedSeed: jest.fn(async () => null),
      signRetiredSocialReceive: jest.fn(async () => null),
      ...answers,
    } as jest.Mocked<CommonsIdentityBridge>;
  }

  it('lists, derives and signs through the identity host with the selector', async () => {
    const publicKey = KeyManager.derivePublicKey(RETIRED_KEY);
    const seedHex = toHex(deriveScopedSeedFromKey(RETIRED_KEY, INFO));
    const signature = signSocialReceiveDigest(RETIRED_KEY, 2, DIGEST);
    const b = bridge({
      listRetiredKeys: jest.fn(async (accountId?: string) =>
        accountId === undefined ? [publicKey] : null,
      ),
      deriveRetiredScopedSeed: jest.fn(async (_info: string, key: string) =>
        key === publicKey ? seedHex : null,
      ),
      signRetiredSocialReceive: jest.fn(async (_i: number, _d: string, key: string) =>
        key === publicKey ? signature : null,
      ),
    });
    mockBridge.current = b;

    expect((await ring.listRetiredIdentityKeys(ME)).map((k) => k.publicKey)).toEqual([publicKey]);
    const seed = await KeyManager.deriveScopedSeed(INFO, { publicKey, ...ME });
    expect(seed && toHex(seed)).toBe(seedHex);
    await expect(KeyManager.signSocialReceive(2, DIGEST, { publicKey, ...ME })).resolves.toEqual(
      signature,
    );
    expect(b.deriveRetiredScopedSeed).toHaveBeenCalledWith(INFO, publicKey, undefined);
    expect(b.signRetiredSocialReceive).toHaveBeenCalledWith(2, DIGEST, publicKey, undefined);
    // The selector never reaches the current-key methods.
    expect(b.deriveScopedSeed).not.toHaveBeenCalled();
    expect(b.signSocialReceive).not.toHaveBeenCalled();
  });

  it('passes the organization account id with the selector', async () => {
    const publicKey = KeyManager.derivePublicKey(ORG_RETIRED_KEY);
    const b = bridge({});
    mockBridge.current = b;
    await KeyManager.deriveScopedSeed(INFO, { accountId: ORG, publicKey });
    await KeyManager.signSocialReceive(0, DIGEST, { accountId: ORG, publicKey });
    expect(b.deriveRetiredScopedSeed).toHaveBeenCalledWith(INFO, publicKey, ORG);
    expect(b.signRetiredSocialReceive).toHaveBeenCalledWith(0, DIGEST, publicKey, ORG);
  });

  it('canonicalizes a compressed selector (a DID or gateway encoding) before asking', async () => {
    const uncompressed = KeyManager.derivePublicKey(RETIRED_KEY);
    const compressed = deriveSecp256k1PublicKey(RETIRED_KEY, true);
    const b = bridge({});
    mockBridge.current = b;
    await KeyManager.deriveScopedSeed(INFO, { publicKey: compressed, ...ME });
    expect(b.deriveRetiredScopedSeed).toHaveBeenCalledWith(INFO, uncompressed, undefined);
    await expect(
      KeyManager.signSocialReceive(0, DIGEST, { publicKey: 'zz', ...ME }),
    ).resolves.toBeNull();
    expect(b.signRetiredSocialReceive).not.toHaveBeenCalled();
  });

  it('an app cannot keep a retired key itself', async () => {
    await expect(
      ring.retireIdentityKey(
        {
          privateKey: RETIRED_KEY,
          publicKey: KeyManager.derivePublicKey(RETIRED_KEY),
        },
        ME,
      ),
    ).rejects.toThrow('signer store');
  });
});
