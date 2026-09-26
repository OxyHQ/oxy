/**
 * Crypto Polyfills
 *
 * Ensures Buffer and crypto.getRandomValues are available
 * across all platforms (Node.js, Browser, React Native).
 *
 * Guard order when installing a `getRandomValues` shim (see bottom of file and
 * {@link cryptoPolyfill}):
 *
 *   1. A REAL `globalThis.crypto.getRandomValues` — used as-is (browsers, Node
 *      >= 20, modern Hermes). The shim below is only installed when the host is
 *      missing it, so this branch is the install-time gate.
 *   2. React Native — `expo-crypto.getRandomBytes`, through the dependency-free
 *      `@oxy.so/protocol/random` entry.
 *
 * There is deliberately no `node:crypto` branch: every supported Node has a
 * global WebCrypto, and a `require('node:crypto')` here made web bundlers ship
 * Node's crypto, stream and buffer polyfills (~600 KB) to every browser.
 *
 * # Evaluation order — this module must import NOTHING that can capture the global
 *
 * `@noble/hashes` 1.x reads `globalThis.crypto` exactly once, when its
 * `crypto.js` is evaluated, and `randomBytes` uses that captured binding for
 * the lifetime of the app. ES imports are evaluated before the importing
 * module's body, so every module this file imports runs BEFORE the shim below
 * is installed. This file used to import `@oxy.so/protocol`'s root entry,
 * which reaches `@noble/curves` → `@noble/hashes` through the envelope signer:
 * on Hermes (no `globalThis.crypto` at startup) noble captured `undefined`
 * before the shim existed, and every identity creation on Android failed with
 * `crypto.getRandomValues must be defined`. Its imports are therefore limited
 * to `buffer` and `@oxy.so/protocol/random`, both free of crypto libraries,
 * and `index.ts` imports this file first. `__tests__/polyfillOrder.test.ts`
 * guards both halves.
 *
 */

import { Buffer } from 'buffer';
import { getRandomBytesRN } from '@oxy.so/protocol/random';

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
const cryptoPolyfill: CryptoLike = {
  getRandomValues<T extends ArrayBufferView>(array: T): T {
    // React Native / Hermes (the one supported host without WebCrypto):
    // synchronous expo-crypto via @oxy.so/protocol's RN `platform/random`.
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
