/**
 * Crypto polyfill — `getRandomValues` install + platform routing.
 *
 * Regression coverage for the latent Node crash: when a Node runtime ships
 * WITHOUT a global WebCrypto (Node 18 script entrypoints, some embedded hosts),
 * the installed `getRandomValues` shim must be backed by `node:crypto` and MUST
 * NOT fall through to `@oxy.so/protocol`'s RN-only `getRandomBytesRN` stub (which
 * throws `Tried to load 'expo-crypto...' outside React Native`).
 */

// Controllable stand-ins for `@oxy.so/protocol`'s platform predicates. Names are
// `mock`-prefixed so the (hoisted) `jest.mock` factory may reference them.
const mockGetRandomBytesRN = jest.fn<Uint8Array, [number]>();
const mockState = { isNodeJS: true };

jest.mock('@oxy.so/protocol', () => ({
  isNodeJS: () => mockState.isNodeJS,
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
  mockState.isNodeJS = true;
});

describe('crypto polyfill getRandomValues', () => {
  it('on Node without global WebCrypto, fills from node:crypto and never calls the RN stub', () => {
    mockState.isNodeJS = true;
    // If the shim ever fell through to the RN path on Node, this would throw —
    // exactly the latent crash we are guarding against.
    mockGetRandomBytesRN.mockImplementation(() => {
      throw new Error('RN getRandomBytesRN must not be called on Node');
    });

    const shim = installShimWithoutHostCrypto();
    const array = new Uint8Array(16);

    expect(() => shim.getRandomValues(array)).not.toThrow();
    // Backed by a real CSPRNG: all-zero output is cryptographically impossible.
    expect(array.some((byte) => byte !== 0)).toBe(true);
    expect(mockGetRandomBytesRN).not.toHaveBeenCalled();
  });

  it('on Node, routes a non-integer view (DataView) through randomFillSync', () => {
    mockState.isNodeJS = true;
    mockGetRandomBytesRN.mockImplementation(() => {
      throw new Error('RN getRandomBytesRN must not be called on Node');
    });

    const shim = installShimWithoutHostCrypto();
    const view = new DataView(new ArrayBuffer(16));

    expect(() => shim.getRandomValues(view)).not.toThrow();
    let anyNonZero = false;
    for (let i = 0; i < view.byteLength; i += 1) {
      if (view.getUint8(i) !== 0) anyNonZero = true;
    }
    expect(anyNonZero).toBe(true);
    expect(mockGetRandomBytesRN).not.toHaveBeenCalled();
  });

  it('on React Native, delegates to expo-crypto via getRandomBytesRN (path unchanged)', () => {
    mockState.isNodeJS = false;
    const rnBytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    mockGetRandomBytesRN.mockReturnValue(rnBytes);

    const shim = installShimWithoutHostCrypto();
    const array = new Uint8Array(8);
    const result = shim.getRandomValues(array);

    expect(mockGetRandomBytesRN).toHaveBeenCalledWith(8);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
