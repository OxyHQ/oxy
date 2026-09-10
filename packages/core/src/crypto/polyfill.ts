/**
 * Crypto Polyfills
 *
 * Ensures Buffer and crypto.getRandomValues are available
 * across all platforms (Node.js, Browser, React Native).
 *
 * Guard order when installing a `getRandomValues` shim (see bottom of file and
 * {@link cryptoPolyfill}):
 *
 *   1. A REAL `globalThis.crypto.getRandomValues` — used as-is (browser, Node
 *      >= 20, modern Hermes). The shim below is only installed when the host is
 *      missing it, so this branch is the install-time gate.
 *   2. Node — backed by the built-in `node:crypto` module (`webcrypto`, else
 *      `randomFillSync`). This is what a Node runtime WITHOUT a global WebCrypto
 *      (Node 18 script entrypoints, some embedded hosts) falls back to.
 *   3. React Native — `expo-crypto.getRandomBytes` (statically imported via the
 *      per-platform `platform/crypto` module in `@oxy.so/protocol`).
 *
 * Historically step (2) delegated to `@oxy.so/protocol`'s RN-only
 * `getRandomBytesRN`, which THROWS on Node — so any Node host lacking a global
 * WebCrypto crashed here instead of getting randomness. It is now a proper
 * Node-backed implementation.
 */

import { Buffer } from 'buffer';
import { getRandomBytesRN, isNodeJS } from '@oxy.so/protocol';

const getGlobalObject = (): typeof globalThis => {
  if (typeof globalThis !== 'undefined') return globalThis;
  if (typeof global !== 'undefined') return global;
  if (typeof window !== 'undefined') return window as unknown as typeof globalThis;
  if (typeof self !== 'undefined') return self as unknown as typeof globalThis;
  return {} as typeof globalThis;
};

const globalObject = getGlobalObject();

// Make Buffer available globally for libraries that depend on it
if (!globalObject.Buffer) {
  (globalObject as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

type CryptoLike = {
  getRandomValues: <T extends ArrayBufferView>(array: T) => T;
};

/** Minimal structural shape of the parts of `node:crypto` this polyfill uses. */
interface NodeCryptoLike {
  webcrypto?: {
    getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
  };
  randomFillSync?: <T extends ArrayBufferView>(buffer: T) => T;
}

/**
 * Lazily-resolved `node:crypto` module, cached after the first attempt.
 * `undefined` = not tried yet; `null` = tried and unavailable (non-Node host).
 */
let cachedNodeCrypto: NodeCryptoLike | null | undefined;

/**
 * Synchronously load `node:crypto` on a Node runtime, or `null` elsewhere.
 *
 * Uses a guarded, Node-only `require`. Every runtime that actually reaches this
 * branch has a working CommonJS `require`: `@oxy.so/core` publishes no
 * `"type": "module"`, so Node loads it as CommonJS and the `require` free
 * variable is present. Browsers never reach here (they own `globalThis.crypto`,
 * so this polyfill is never installed) and React Native takes the
 * `getRandomBytesRN` branch — so the `node:crypto` reference is dead code in
 * those bundles, and Expo's Metro resolver shims `node:*` builtins, keeping
 * web/native bundles green.
 */
function loadNodeCryptoSync(): NodeCryptoLike | null {
  if (cachedNodeCrypto !== undefined) {
    return cachedNodeCrypto;
  }
  if (typeof require !== 'function') {
    cachedNodeCrypto = null;
    return cachedNodeCrypto;
  }
  try {
    cachedNodeCrypto = require('node:crypto') as NodeCryptoLike;
  } catch {
    // No Node crypto (unexpected on a real Node host) — degrade to the next
    // mechanism rather than crash.
    cachedNodeCrypto = null;
  }
  return cachedNodeCrypto;
}

/**
 * Fill `array` with cryptographically-secure random bytes from `node:crypto`.
 * Prefers `webcrypto.getRandomValues`; falls back to `randomFillSync`. Returns
 * `false` when Node crypto is unavailable so the caller can try the next
 * mechanism.
 */
function fillFromNodeCrypto(array: ArrayBufferView): boolean {
  const nodeCrypto = loadNodeCryptoSync();
  if (!nodeCrypto) {
    return false;
  }
  const webcrypto = nodeCrypto.webcrypto;
  if (webcrypto && typeof webcrypto.getRandomValues === 'function') {
    try {
      webcrypto.getRandomValues(array);
      return true;
    } catch {
      // `webcrypto.getRandomValues` rejects non-integer views (Float*Array,
      // DataView); fall through to `randomFillSync`, which accepts any view.
    }
  }
  if (typeof nodeCrypto.randomFillSync === 'function') {
    nodeCrypto.randomFillSync(array);
    return true;
  }
  return false;
}

const cryptoPolyfill: CryptoLike = {
  getRandomValues<T extends ArrayBufferView>(array: T): T {
    // Node: back the CSPRNG with `node:crypto`. This is the path that matters on
    // Node runtimes shipping WITHOUT a global WebCrypto — where delegating to
    // the RN-only expo-crypto stub would throw.
    if (isNodeJS() && fillFromNodeCrypto(array)) {
      return array;
    }
    // React Native (and any non-Node host without WebCrypto): synchronous
    // expo-crypto via @oxy.so/protocol's RN `platform/crypto` variant.
    const bytes = getRandomBytesRN(array.byteLength);
    const uint8View = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    uint8View.set(bytes);
    return array;
  },
};

// Only polyfill if crypto or crypto.getRandomValues is not available
if (typeof globalObject.crypto === 'undefined') {
  (globalObject as unknown as { crypto: CryptoLike }).crypto = cryptoPolyfill;
} else if (typeof globalObject.crypto.getRandomValues !== 'function') {
  (globalObject.crypto as CryptoLike).getRandomValues = cryptoPolyfill.getRandomValues;
}

export { Buffer };
