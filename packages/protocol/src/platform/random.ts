/**
 * Synchronous CSPRNG source — default variant (Node.js, browsers, bundlers).
 *
 * Companion to `./random.native.ts`, which Metro substitutes on iOS / Android.
 * Node and browsers own a native CSPRNG (`node:crypto`, `globalThis.crypto`),
 * so `getRandomBytesRN` only exists here to keep both variants' surfaces
 * identical, and throws if anything reaches it outside React Native.
 *
 * Like its sibling, this module imports nothing: it is part of the
 * `@oxy.so/protocol/random` entry that `@oxy.so/core`'s crypto polyfill loads
 * BEFORE any crypto library is evaluated.
 */

export function getRandomBytesRN(_byteCount: number): Uint8Array {
  throw new Error(
    "[oxy.protocol.crypto] Tried to load 'expo-crypto.getRandomBytes (sync)' outside React Native. This module is only available in a React Native runtime; bundling routed this consumer to the default (Node/web) variant. This indicates a missing platform gate (`isReactNative()`) in the calling code.",
  );
}
