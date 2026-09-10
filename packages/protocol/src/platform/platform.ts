/**
 * Platform Detection — runtime predicates.
 *
 * Detects the host runtime WITHOUT importing from 'react-native', so the
 * protocol's crypto modules can be used in web / Node.js / React Native
 * environments without bundlers failing on react-native imports.
 *
 * Only the two predicates the protocol's platform-crypto loaders need live
 * here. Richer platform detection (`getPlatformOS`, `isWeb`, `isNative`, …)
 * is an SDK concern and stays in `@oxy.so/core`.
 */

/**
 * Check if running in React Native.
 *
 * Selects the React Native crypto variant (`expo-crypto` /
 * `expo-secure-store` / async-storage) over the Node/web variant.
 */
export function isReactNative(): boolean {
  return typeof navigator !== 'undefined' && navigator.product === 'ReactNative';
}

/**
 * Check if running in Node.js.
 *
 * Gates use of Node's built-in `crypto` (the synchronous SHA-256 path and
 * `randomBytes`) and the `await import('node:crypto')` loader.
 */
export function isNodeJS(): boolean {
  return typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
}
