/**
 * Synchronous CSPRNG source — React Native variant.
 *
 * Companion to `./random.ts`; Metro substitutes this file on iOS / Android
 * (see `./crypto.ts` for how the `.native` split works).
 *
 * This module is deliberately tiny and imports NOTHING but `expo-crypto`: it
 * backs `@oxy.so/core`'s `globalThis.crypto.getRandomValues` polyfill, which
 * must be fully installed before any module that captures `globalThis.crypto`
 * at evaluation time (`@noble/hashes` 1.x's `crypto.js` does exactly that) is
 * evaluated. Reaching a crypto library from here would let that library
 * capture the missing global first and throw
 * `crypto.getRandomValues must be defined` for the lifetime of the app.
 *
 * `expo-crypto` is an OPTIONAL peer, so it is resolved with a string-literal
 * `require` inside a `try` (Metro's optional-dependency form; see
 * `./crypto.native.ts`), and the load stays synchronous because
 * `getRandomValues` cannot await.
 */

import type { ExpoCryptoLike } from './expoTypes';
import { missingOptionalPeerError } from './optionalPeer';

declare const require: (moduleName: string) => unknown;

let expoCryptoModule: ExpoCryptoLike | null = null;
let expoCryptoError: unknown;
try {
  expoCryptoModule = require('expo-crypto') as ExpoCryptoLike;
} catch (error) {
  expoCryptoError = error;
}

/**
 * The resolved `expo-crypto` module, or an actionable error naming the missing
 * peer and the capability that needed it. Shared with `./crypto.native.ts` so
 * the optional peer is resolved in exactly one place.
 */
export function requireExpoCrypto(capability: string): ExpoCryptoLike {
  if (!expoCryptoModule) {
    throw missingOptionalPeerError('expo-crypto', capability, expoCryptoError);
  }
  return expoCryptoModule;
}

/**
 * Synchronous random bytes via `expo-crypto.getRandomBytes`.
 *
 * Synchronous by contract: `@oxy.so/core`'s crypto polyfill uses this to back
 * `globalThis.crypto.getRandomValues`, which cannot await.
 */
export function getRandomBytesRN(byteCount: number): Uint8Array {
  return requireExpoCrypto('the React Native CSPRNG (crypto.getRandomValues)').getRandomBytes(
    byteCount,
  );
}
