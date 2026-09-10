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
  loadNodeCrypto: async () => require('crypto'),
  loadSharedIdentityBridge: async () => null,
}));

const FIXED_PRIV = 'aa'.repeat(32);
const EXPECTED_FAIR = '4b90d900a11b0a1737ed643db3446e5f28035d86f1a4fda92474ea8ab152adf5';
const EXPECTED_OTHER = 'cdedf1f076b0f4766c769e55bc1e90c5bf44d8630f6e5fb147615ee7c330c905';
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('KeyManager.deriveScopedSeed', () => {
  let KeyManager: typeof import('../keyManager').KeyManager;

  beforeEach(async () => {
    jest.resetModules();
    setPlatformOS('ios');
    const secureStore = (await import('expo-secure-store' as string)) as unknown as {
      __resetStore__: () => void;
    };
    secureStore.__resetStore__();
    const km = await import('../keyManager');
    KeyManager = km.KeyManager;
    // Store a known shared identity key so derivation is deterministic.
    await KeyManager.importSharedIdentity(FIXED_PRIV);
  });

  it('derives the pinned 32-byte seed for a fixed identity + info', async () => {
    const seed = await KeyManager.deriveScopedSeed('oxypay/faircoin/v1');
    if (!seed) throw new Error('expected a seed');
    expect(seed).toHaveLength(32);
    expect(toHex(seed)).toBe(EXPECTED_FAIR);
  });

  it('is deterministic (same identity + info → identical seed)', async () => {
    const a = await KeyManager.deriveScopedSeed('oxypay/faircoin/v1');
    const b = await KeyManager.deriveScopedSeed('oxypay/faircoin/v1');
    if (!a || !b) throw new Error('expected seeds');
    expect(toHex(a)).toBe(toHex(b));
  });

  it('domain-separates by info (different info → different seed)', async () => {
    const fair = await KeyManager.deriveScopedSeed('oxypay/faircoin/v1');
    const other = await KeyManager.deriveScopedSeed('oxypay/other/v1');
    if (!fair || !other) throw new Error('expected seeds');
    expect(toHex(other)).toBe(EXPECTED_OTHER);
    expect(toHex(fair)).not.toBe(toHex(other));
  });

  it('never returns the raw private key (no leak)', async () => {
    const seed = await KeyManager.deriveScopedSeed('oxypay/faircoin/v1');
    if (!seed) throw new Error('expected a seed');
    expect(toHex(seed)).not.toBe(FIXED_PRIV);
  });

  it('returns null on web (no identity key available)', async () => {
    // `jest.resetModules()` gives KeyManager its own bound instance of
    // `utils/platform` (its cached OS locks in as soon as `beforeEach`'s
    // `importSharedIdentity` first checks it). The file-level `setPlatformOS`
    // import above is bound to a different, earlier instance, so mutating it
    // here would not be observed by the already-imported `KeyManager`. Reset
    // again and re-import both from the same fresh module graph so the
    // platform flip actually reaches the KeyManager instance under test.
    //
    // `jest.resetModules()` also re-runs the virtual `expo-secure-store`
    // mock factory, handing this fresh KeyManager a brand-new empty
    // in-memory store — the identity `beforeEach` imported lives only in the
    // pre-reset store instance. Without re-storing an identity here, a
    // `null` result would be ambiguous between the web gate and the
    // no-identity fallback. Re-import the identity on THIS fresh instance
    // (while still native — `importSharedIdentity` itself is native-gated
    // and throws on web) BEFORE flipping to web, so the later `null` can
    // only be explained by the web gate, not a missing identity.
    jest.resetModules();
    const platform = await import('../../utils/platform');
    const km = await import('../keyManager');
    await km.KeyManager.importSharedIdentity(FIXED_PRIV);
    platform.setPlatformOS('web');
    expect(await km.KeyManager.deriveScopedSeed('oxypay/faircoin/v1')).toBeNull();
  });

  it('returns null when no identity exists on the device', async () => {
    const secureStore = (await import('expo-secure-store' as string)) as unknown as {
      __resetStore__: () => void;
    };
    secureStore.__resetStore__();
    expect(await KeyManager.deriveScopedSeed('oxypay/faircoin/v1')).toBeNull();
  });
});
