/**
 * Crypto polyfill — the `getRandomValues` shim a host without WebCrypto (React
 * Native / Hermes) gets, backed by expo-crypto. Every supported Node and browser
 * has a real one, which the polyfill leaves alone.
 */

// Controllable stand-ins for `@oxy.so/protocol`'s platform predicates. Names are
// `mock`-prefixed so the (hoisted) `jest.mock` factory may reference them.
const mockGetRandomBytesRN = jest.fn<Uint8Array, [number]>();

jest.mock('@oxy.so/protocol/random', () => ({
  getRandomBytesRN: (byteCount: number) => mockGetRandomBytesRN(byteCount),
}));

type CryptoLike = {
  getRandomValues: <T extends ArrayBufferView>(array: T) => T;
};

const ORIGINAL_CRYPTO_DESCRIPTOR = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

/**
 * Re-run the polyfill module with NO host `globalThis.crypto`, returning the
 * `getRandomValues` shim it installs. Restores the real global afterwards so
 * the manipulation never leaks into other tests.
 */
function installShimWithoutHostCrypto(): CryptoLike {
  Object.defineProperty(globalThis, 'crypto', {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    jest.isolateModules(() => {
      require('../polyfill');
    });
    const installed = (globalThis as { crypto?: CryptoLike }).crypto;
    if (!installed || typeof installed.getRandomValues !== 'function') {
      throw new Error('polyfill did not install a getRandomValues shim');
    }
    return installed;
  } finally {
    Object.defineProperty(
      globalThis,
      'crypto',
      ORIGINAL_CRYPTO_DESCRIPTOR ?? { value: undefined, configurable: true, writable: true },
    );
  }
}

beforeEach(() => {
  mockGetRandomBytesRN.mockReset();
});

describe('crypto polyfill getRandomValues', () => {
  it('on React Native, delegates to expo-crypto via getRandomBytesRN ', () => {
    const rnBytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    mockGetRandomBytesRN.mockReturnValue(rnBytes);

    const shim = installShimWithoutHostCrypto();
    const array = new Uint8Array(8);
    const result = shim.getRandomValues(array);

    expect(mockGetRandomBytesRN).toHaveBeenCalledWith(8);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('crypto polyfill on a host with WebCrypto', () => {
  it('leaves a real getRandomValues alone', () => {
    const real = globalThis.crypto.getRandomValues;
    jest.isolateModules(() => {
      require('../polyfill');
    });
    expect(globalThis.crypto.getRandomValues).toBe(real);
  });
});
